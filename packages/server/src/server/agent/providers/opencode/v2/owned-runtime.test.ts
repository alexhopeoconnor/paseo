import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { OpenCodeBridge } from "../bridge.js";
import { provisionLocalBridge } from "./bridge-provisioning.js";
import { V2Runtime } from "./runtime.js";

test("an owned helper uses an installed bridge once and survives catalog refresh", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-owned-opencode-"));
  const config = path.join(root, "config", "opencode");
  const script = path.join(root, "server.cjs");
  const record = path.join(root, "env.json");
  const bridge = new OpenCodeBridge({ paseoHome: root, logger: createTestLogger() });
  await bridge.start();
  const artifact = fileURLToPath(await bridge.materializeV2Plugin());
  await provisionLocalBridge({
    configDirectory: config,
    artifact: path.join(artifact, "server.js"),
  });
  await writeFile(
    script,
    `
    const http = require('node:http');
    require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({
      config: process.env.OPENCODE_CONFIG_CONTENT,
      xdgDataHome: process.env.XDG_DATA_HOME,
      xdgConfigHome: process.env.XDG_CONFIG_HOME,
      xdgStateHome: process.env.XDG_STATE_HOME,
      home: process.env.HOME,
    }));
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '2.0.10', pid: process.pid, urls: [], paths: { tmp: '/tmp' } }));
    });
    server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));
  `,
  );
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    bridge,
    selection: { kind: "owned" },
    settings: {
      command: { mode: "replace", argv: [process.execPath, script] },
      env: { XDG_CONFIG_HOME: path.join(root, "config"), OPENCODE_CONFIG_CONTENT: "{}" },
    },
  });
  try {
    const first = await runtime.acquire();
    const pid = (await first.client.server.info()).pid;
    expect(JSON.parse(await readFile(record, "utf8"))).toMatchObject({
      config: "{}",
      xdgConfigHome: path.join(root, "config"),
      home: process.env.HOME,
    });
    await first.release();
    const refreshed = await runtime.acquire({ fresh: true });
    expect((await refreshed.client.server.info()).pid).toBe(pid);
    await refreshed.release();

    const historyEnv = { XDG_DATA_HOME: path.join(root, "history-data") };
    const history = await runtime.acquire({ purpose: "history", env: historyEnv });
    const historyPid = (await history.client.server.info()).pid;
    expect(historyPid).not.toBe(pid);
    expect(JSON.parse(await readFile(record, "utf8"))).toMatchObject({
      xdgDataHome: historyEnv.XDG_DATA_HOME,
      xdgConfigHome: path.join(root, "config"),
      home: process.env.HOME,
    });
    expect(history.serviceIdentity).toBe(await runtime.getServiceIdentity({ env: historyEnv }));
    expect(history.canReleaseWithoutStoppingService?.()).toBe(true);
    await history.release();
    const reread = await runtime.acquire({ purpose: "history", env: historyEnv });
    expect((await reread.client.server.info()).pid).toBe(historyPid);
    await reread.release();
    const defaultRead = await runtime.acquire({
      purpose: "history",
      env: { PASEO_AGENT_ID: "reader" },
    });
    expect((await defaultRead.client.server.info()).pid).toBe(pid);
    await defaultRead.release();
  } finally {
    await runtime.shutdown();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("reports a bridge port change that has not been applied", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-port-"));
  const bridge = new OpenCodeBridge({ paseoHome: root, logger: createTestLogger() });
  await bridge.start();
  const actual = Number(new URL(bridge.sharedV2Connection().baseUrl).port);
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    bridge,
    selection: { kind: "explicit", server: { url: "http://127.0.0.1:1" } },
    settings: { env: { PASEO_OPENCODE_BRIDGE_PORT: actual === 1 ? "2" : "1" } },
  });
  try {
    await expect(runtime.acquire()).rejects.toThrow("restart Paseo to apply the bridge port");
  } finally {
    await runtime.shutdown();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves stored-stop identity from effective data-home settings without launching a helper", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-identity-"));
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    selection: { kind: "owned" },
    settings: {
      // This command would fail if identity lookup attempted to launch it.
      command: { mode: "replace", argv: [path.join(root, "not-an-opencode-binary")] },
      env: {
        PASEO_HOME: path.join(root, "paseo-home"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_STATE_HOME: path.join(root, "state"),
      },
    },
  });
  try {
    const storedIdentity = await runtime.getServiceIdentity();
    const differentDataHome = await new V2Runtime({
      logger: createTestLogger(),
      selection: { kind: "owned" },
      settings: { env: { PASEO_HOME: path.join(root, "other-paseo-home") } },
    }).getServiceIdentity();

    expect(storedIdentity).toMatch(/^opencode-v2-service-v1:/);
    expect(storedIdentity).not.toBe(differentDataHome);
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("a wrapped caller gets its own helper behind the wrap, and other callers keep the shared one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-wrap-"));
  const script = path.join(root, "server.cjs");
  const launcher = path.join(root, "launcher.cjs");
  const record = path.join(root, "argv.json");
  await writeFile(
    script,
    `
    const http = require('node:http');
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '2.0.10', pid: process.pid, urls: [], paths: { tmp: '/tmp' } }));
    });
    server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));
  `,
  );
  await writeFile(
    launcher,
    `
    const [, , ...argv] = process.argv;
    // A launcher that needs its profile from the open hook's environment.
    if (!process.env.SANDBOX_PROFILE) process.exit(17);
    require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, profile: process.env.SANDBOX_PROFILE, xdgDataHome: process.env.XDG_DATA_HOME }));
    const child = require('node:child_process').spawn(argv[1], argv.slice(2), { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 1));
  `,
  );
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    selection: { kind: "owned" },
    settings: { command: { mode: "replace", argv: [process.execPath, script] } },
  });
  const wrappedEnv = {
    SANDBOX_PROFILE: "agent",
    XDG_DATA_HOME: path.join(root, "wrapped-data"),
  };
  try {
    const shared = await runtime.acquire();
    const wrapped = await runtime.acquire({
      dedicated: {
        wrap: [process.execPath, launcher, "--profile"],
        env: wrappedEnv,
      },
    });
    const sharedAgain = await runtime.acquire();

    const sharedPid = (await shared.client.server.info()).pid;
    expect((await wrapped.client.server.info()).pid).not.toBe(sharedPid);
    expect((await sharedAgain.client.server.info()).pid).toBe(sharedPid);
    const launched = JSON.parse(await readFile(record, "utf8"));
    expect(launched.profile).toBe("agent");
    expect(launched.xdgDataHome).toBe(wrappedEnv.XDG_DATA_HOME);
    expect(launched.argv.slice(0, 4)).toEqual(["--profile", process.execPath, script, "serve"]);
    expect(wrapped.serviceIdentity).not.toBe(shared.serviceIdentity);
    const retained = wrapped.retain();
    expect(retained.serviceIdentity).toBe(wrapped.serviceIdentity);
    await retained.release();

    await wrapped.release();
    await expect(wrapped.exited).resolves.toBeInstanceOf(Error);
    await shared.release();
    await sharedAgain.release();
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("a wrapped caller overriding a discovered service is identified as the owned helper it launches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-discovered-wrap-"));
  const script = path.join(root, "server.cjs");
  const launcher = path.join(root, "launcher.cjs");
  const record = path.join(root, "launch.json");
  await writeFile(
    script,
    `
    const http = require('node:http');
    require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({
      profile: process.env.SANDBOX_PROFILE,
      xdgDataHome: process.env.XDG_DATA_HOME,
      xdgConfigHome: process.env.XDG_CONFIG_HOME,
    }));
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '2.0.10', pid: process.pid, urls: [], paths: { tmp: '/tmp' } }));
    });
    server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));
  `,
  );
  await writeFile(
    launcher,
    `
    const [, , ...argv] = process.argv;
    if (!process.env.SANDBOX_PROFILE) process.exit(17);
    const child = require('node:child_process').spawn(argv[1], argv.slice(2), { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 1));
  `,
  );
  const dedicatedEnv = {
    SANDBOX_PROFILE: "agent",
    XDG_DATA_HOME: path.join(root, "wrapped-data"),
    XDG_CONFIG_HOME: path.join(root, "wrapped-config"),
  };
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    selection: { kind: "discovered", server: { url: "http://127.0.0.1:1" } },
    settings: { command: { mode: "replace", argv: [process.execPath, script] } },
  });
  const ownedBaseline = new V2Runtime({
    logger: createTestLogger(),
    selection: { kind: "owned" },
    settings: { command: { mode: "replace", argv: [process.execPath, script] } },
  });
  try {
    const expectedOwnedIdentity = await ownedBaseline.getServiceIdentity({ env: dedicatedEnv });
    const unrelatedIdentity = await ownedBaseline.getServiceIdentity({
      env: { ...dedicatedEnv, XDG_DATA_HOME: path.join(root, "other-data") },
    });
    const discoveredIdentity = await runtime.getServiceIdentity();
    expect(expectedOwnedIdentity).not.toBe(discoveredIdentity);
    expect(unrelatedIdentity).not.toBe(expectedOwnedIdentity);

    const wrapped = await runtime.acquire({
      dedicated: { wrap: [process.execPath, launcher, "--profile"], env: dedicatedEnv },
    });
    expect(wrapped.serviceIdentity).toBe(expectedOwnedIdentity);
    expect(wrapped.serviceIdentity).not.toBe(discoveredIdentity);
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual({
      profile: "agent",
      xdgDataHome: dedicatedEnv.XDG_DATA_HOME,
      xdgConfigHome: dedicatedEnv.XDG_CONFIG_HOME,
    });
    const retained = wrapped.retain();
    expect(retained.serviceIdentity).toBe(expectedOwnedIdentity);
    await wrapped.release();
    expect(retained.serviceIdentity).toBe(expectedOwnedIdentity);
    await retained.release();
  } finally {
    await runtime.shutdown();
    await ownedBaseline.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("refuses to wrap a configured existing server", async () => {
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    selection: { kind: "explicit", server: { url: "http://127.0.0.1:1" } },
  });
  try {
    await expect(
      runtime.acquire({ dedicated: { wrap: ["/opt/sandbox/bin/run"], env: {} } }),
    ).rejects.toThrow("cannot start it behind a launch wrap");
  } finally {
    await runtime.shutdown();
  }
});

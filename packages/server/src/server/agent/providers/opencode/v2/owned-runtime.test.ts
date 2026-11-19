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
    require('node:fs').writeFileSync(${JSON.stringify(record)}, process.env.OPENCODE_CONFIG_CONTENT);
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
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual({});
    await first.release();
    const refreshed = await runtime.acquire({ fresh: true });
    expect((await refreshed.client.server.info()).pid).toBe(pid);
    await refreshed.release();

    const historyEnv = { XDG_DATA_HOME: path.join(root, "history-data") };
    const history = await runtime.acquire({ purpose: "history", env: historyEnv });
    const historyPid = (await history.client.server.info()).pid;
    expect(historyPid).not.toBe(pid);
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

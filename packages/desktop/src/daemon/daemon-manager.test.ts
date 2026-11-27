import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import type { DaemonInstance } from "@getpaseo/server/daemon-control";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings";
import { ExternalCliCommandError } from "./cli/external";
import {
  createDaemonCommandHandlers,
  keepsTerminalsOnStop,
  stopCapturedDaemon,
  type DesktopDaemonStopReason,
} from "./daemon-manager";

const mocks = vi.hoisted(() => ({
  paseoHome: "",
  settingsError: null as Error | null,
  settings: {
    releaseChannel: "stable" as "stable" | "beta",
    updates: {
      mode: "automatic" as "automatic" | "notify" | "off",
    },
    notifications: {
      playSound: true,
    },
    daemon: {
      manageBuiltInDaemon: true,
      keepRunningAfterQuit: true,
    },
  },
  checkForAppUpdate: vi.fn(),
  downloadAndInstallUpdate: vi.fn(),
  runExternalCliJsonCommand: vi.fn(),
  runExternalCliTextCommand: vi.fn(),
  readDaemonInstance: vi.fn(),
  realReadDaemonInstance: null as null | ((home: string) => Promise<DaemonInstance | null>),
  createNodeEntrypointInvocation: vi.fn(() => ({
    command: "node",
    args: [],
    env: {},
  })),
  spawnProcess: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  appLogPath: "",
  getElectronLogFile: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => mocks.paseoHome),
    getVersion: vi.fn(() => "1.2.3"),
    isPackaged: true,
  },
  autoUpdater: undefined,
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  powerMonitor: { getSystemIdleTime: vi.fn(() => 0) },
}));

vi.mock("electron-log/main", () => ({
  default: {
    info: mocks.logInfo,
    error: mocks.logError,
    transports: {
      file: {
        getFile: mocks.getElectronLogFile,
      },
    },
  },
}));

vi.mock("@getpaseo/server/daemon-control", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@getpaseo/server/daemon-control")>();
  mocks.realReadDaemonInstance = actual.readDaemonInstance;
  return {
    ...actual,
    resolvePaseoHome: () => mocks.paseoHome,
    spawnProcess: mocks.spawnProcess,
    readDaemonInstance: mocks.readDaemonInstance,
  };
});

vi.mock("../settings/desktop-settings-electron.js", () => ({
  getDesktopSettingsStore: () => ({
    get: async () => {
      if (mocks.settingsError) {
        throw mocks.settingsError;
      }
      return mocks.settings;
    },
    patch: vi.fn(),
    migrateLegacyRendererSettings: vi.fn(),
  }),
}));

vi.mock("./runtime-paths.js", () => ({
  createNodeEntrypointInvocation: mocks.createNodeEntrypointInvocation,
  resolveDaemonRunnerEntrypoint: vi.fn(() => ({
    entryPath: path.join(mocks.paseoHome, "daemon.js"),
    execArgv: [],
  })),
}));

vi.mock("../features/auto-updater.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkForAppUpdate: mocks.checkForAppUpdate,
  downloadAndInstallUpdate: mocks.downloadAndInstallUpdate,
}));

vi.mock("./cli/external.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runExternalCliJsonCommand: mocks.runExternalCliJsonCommand,
  runExternalCliTextCommand: mocks.runExternalCliTextCommand,
}));

describe("daemon-manager commands", () => {
  let fixtureRoot: string;

  function writeLiveDaemonLock(): { lock: Record<string, unknown>; lockPath: string } {
    mkdirSync(mocks.paseoHome, { recursive: true });
    const lock = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      listen: null,
      desktopManaged: true,
    };
    const lockPath = path.join(mocks.paseoHome, "paseo.pid");
    writeFileSync(lockPath, JSON.stringify(lock));
    return { lock, lockPath };
  }

  function readyInstance(
    startedAt: string,
    overrides: Partial<DaemonInstance> = {},
  ): DaemonInstance {
    return {
      pid: 4242,
      startedAt,
      hostname: "daemon-host",
      uid: 501,
      listen: "127.0.0.1:6799",
      desktopManaged: true,
      ...overrides,
    };
  }

  function readyPayload(
    instance: DaemonInstance,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      home: mocks.paseoHome,
      pid: instance.pid,
      startedAt: instance.startedAt,
      listen: instance.listen,
      hostname: instance.hostname,
      serverId: "srv_ready",
      daemonVersion: "0.17.6",
      localDaemon: "running",
      desktopManaged: true,
      connectedDaemon: "reachable",
      ...overrides,
    };
  }

  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
  } {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function probeSignal(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  }

  function queueProbe() {
    const result = deferred<unknown>();
    const started = probeSignal();
    mocks.runExternalCliJsonCommand.mockImplementationOnce(() => {
      started.resolve();
      return result.promise;
    });
    return { result, started: started.promise };
  }

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "paseo daemon manager "));
    mocks.paseoHome = path.join(fixtureRoot, "home");
    mocks.appLogPath = path.join(fixtureRoot, "main.log");
    mocks.settings = DEFAULT_DESKTOP_SETTINGS;
    mocks.checkForAppUpdate.mockReset();
    mocks.downloadAndInstallUpdate.mockReset();
    mocks.runExternalCliJsonCommand.mockReset();
    mocks.runExternalCliTextCommand.mockReset();
    mocks.readDaemonInstance.mockReset();
    if (!mocks.realReadDaemonInstance) {
      throw new Error("daemon-control readDaemonInstance was not loaded");
    }
    mocks.readDaemonInstance.mockImplementation(mocks.realReadDaemonInstance);
    mocks.createNodeEntrypointInvocation.mockReset();
    mocks.createNodeEntrypointInvocation.mockReturnValue({ command: "node", args: [], env: {} });
    mocks.spawnProcess.mockReset();
    mocks.logInfo.mockReset();
    mocks.logError.mockReset();
    mocks.getElectronLogFile.mockReset();
    mocks.getElectronLogFile.mockReturnValue({ path: mocks.appLogPath });
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("returns the Electron main-process log tail from electron-log", () => {
    writeFileSync(
      mocks.appLogPath,
      Array.from({ length: 105 }, (_value, index) => `main log line ${index + 1}`).join("\n"),
    );
    const handlers = createDaemonCommandHandlers();

    expect(handlers.desktop_app_logs()).toEqual({
      logPath: mocks.appLogPath,
      contents: Array.from({ length: 100 }, (_value, index) => `main log line ${index + 6}`).join(
        "\n",
      ),
    });
  });

  it("exposes updater diagnostics through the desktop command boundary", () => {
    const diagnostics = createDaemonCommandHandlers().desktop_update_diagnostics();

    expect(diagnostics).toMatchObject({
      platform: process.platform,
      currentVersion: "1.2.3",
    });
  });

  it("reports a stopped daemon without launching the CLI when no local daemon runs", async () => {
    mkdirSync(mocks.paseoHome);
    writeFileSync(path.join(mocks.paseoHome, "server-id"), "srv_existing\n");
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      home: mocks.paseoHome,
      pid: null,
      startedAt: null,
      listen: null,
      hostname: null,
      localDaemon: "stopped",
      desktopManaged: false,
      connectedDaemon: "not_probed",
    });

    const status = await createDaemonCommandHandlers().desktop_daemon_status();

    expect(status).toMatchObject({ serverId: "", status: "stopped", pid: null });
    expect(mocks.runExternalCliJsonCommand).not.toHaveBeenCalled();
  });

  it("reports a live daemon without a published endpoint as starting without running the CLI", async () => {
    const { lock } = writeLiveDaemonLock();
    mocks.runExternalCliJsonCommand.mockRejectedValue(
      new Error("CLI status must not run before the daemon publishes its endpoint"),
    );

    const status = await createDaemonCommandHandlers().desktop_daemon_status();

    expect(status).toEqual({
      serverId: "",
      status: "starting",
      listen: null,
      hostname: null,
      pid: process.pid,
      home: mocks.paseoHome,
      version: null,
      desktopManaged: true,
      ownedByDesktop: false,
      startedAt: lock.startedAt,
      error: null,
    });
    expect(mocks.runExternalCliJsonCommand).not.toHaveBeenCalled();
  });

  it("uses the normal CLI probe once a live daemon publishes its endpoint", async () => {
    const { lock, lockPath } = writeLiveDaemonLock();
    mocks.runExternalCliJsonCommand.mockRejectedValue(
      new Error("CLI status must not run before the daemon publishes its endpoint"),
    );
    const handler = createDaemonCommandHandlers();

    expect(await handler.desktop_daemon_status()).toMatchObject({
      status: "starting",
      listen: null,
      pid: process.pid,
      startedAt: lock.startedAt,
      desktopManaged: true,
    });
    expect(mocks.runExternalCliJsonCommand).not.toHaveBeenCalled();

    const listen = "127.0.0.1:6799";
    const serverId = "srv_ready";
    writeFileSync(lockPath, JSON.stringify({ ...lock, listen, serverId }));
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      home: mocks.paseoHome,
      pid: process.pid,
      startedAt: lock.startedAt,
      listen,
      hostname: "daemon-host",
      serverId,
      daemonVersion: "0.17.6",
      localDaemon: "running",
      desktopManaged: true,
      connectedDaemon: "reachable",
    });

    const running = await handler.desktop_daemon_status();

    expect(running).toEqual({
      serverId,
      status: "running",
      listen,
      hostname: "daemon-host",
      pid: process.pid,
      home: mocks.paseoHome,
      version: "0.17.6",
      desktopManaged: true,
      ownedByDesktop: false,
      startedAt: lock.startedAt,
      error: null,
    });
    expect(mocks.runExternalCliJsonCommand).toHaveBeenCalledTimes(1);
    expect(mocks.runExternalCliJsonCommand).toHaveBeenCalledWith(
      ["daemon", "status", "--home", mocks.paseoHome, "--json"],
      { timeoutMs: 30_000 },
    );
  });

  it("coalesces overlapping ready-status probes for the same live instance", async () => {
    const instance = readyInstance("2026-11-27T00:00:00.000Z");
    mocks.readDaemonInstance.mockResolvedValue(instance);
    const probe = queueProbe();
    const handler = createDaemonCommandHandlers();

    const first = handler.desktop_daemon_status();
    const second = handler.desktop_daemon_status();

    await probe.started;
    await Promise.resolve();
    expect(mocks.runExternalCliJsonCommand).toHaveBeenCalledTimes(1);
    expect(mocks.runExternalCliJsonCommand).toHaveBeenCalledWith(
      ["daemon", "status", "--home", mocks.paseoHome, "--json"],
      { timeoutMs: 30_000 },
    );

    probe.result.resolve(readyPayload(instance));
    await expect(first).resolves.toMatchObject({
      status: "running",
      pid: instance.pid,
      startedAt: instance.startedAt,
    });
    await expect(second).resolves.toMatchObject({
      status: "running",
      pid: instance.pid,
      startedAt: instance.startedAt,
    });
    expect(mocks.runExternalCliJsonCommand).toHaveBeenCalledTimes(1);

    mocks.runExternalCliJsonCommand.mockResolvedValueOnce(
      readyPayload(instance, { serverId: "srv_next" }),
    );
    await expect(handler.desktop_daemon_status()).resolves.toMatchObject({
      status: "running",
      serverId: "srv_next",
    });
    expect(mocks.runExternalCliJsonCommand).toHaveBeenCalledTimes(2);
  });

  it("returns errored and clears a timed-out ready probe", async () => {
    const instance = readyInstance("2026-11-27T00:00:00.000Z");
    mocks.readDaemonInstance.mockResolvedValue(instance);
    const probe = queueProbe();
    const handler = createDaemonCommandHandlers();
    const timeoutError = new Error("CLI command timed out after 30000ms: daemon status --json");

    const first = handler.desktop_daemon_status();
    const second = handler.desktop_daemon_status();

    await probe.started;
    await Promise.resolve();
    probe.result.reject(timeoutError);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({
      status: "errored",
      pid: null,
      startedAt: null,
      error: timeoutError.message,
    });
    expect(secondResult).toMatchObject({
      status: "errored",
      pid: null,
      startedAt: null,
      error: timeoutError.message,
    });
    expect(mocks.runExternalCliJsonCommand).toHaveBeenCalledTimes(1);

    mocks.runExternalCliJsonCommand.mockResolvedValueOnce(
      readyPayload(instance, { serverId: "srv_recovered" }),
    );
    await expect(handler.desktop_daemon_status()).resolves.toMatchObject({
      status: "running",
      serverId: "srv_recovered",
    });
    expect(mocks.runExternalCliJsonCommand).toHaveBeenCalledTimes(2);
  });

  it("does not join a ready probe after the live owner changes", async () => {
    const firstInstance = readyInstance("2026-11-27T00:00:00.000Z");
    const secondInstance = readyInstance("2026-11-27T00:01:00.000Z");
    mocks.readDaemonInstance
      .mockResolvedValueOnce(firstInstance)
      .mockResolvedValueOnce(secondInstance);
    const firstProbe = queueProbe();
    const secondProbe = queueProbe();
    const handler = createDaemonCommandHandlers();

    const first = handler.desktop_daemon_status();
    await firstProbe.started;
    const second = handler.desktop_daemon_status();
    await Promise.resolve();
    expect(mocks.runExternalCliJsonCommand).toHaveBeenCalledTimes(2);

    firstProbe.result.resolve(readyPayload(firstInstance, { serverId: "srv_owner_a" }));
    secondProbe.result.resolve(readyPayload(secondInstance, { serverId: "srv_owner_b" }));

    await expect(first).resolves.toMatchObject({
      status: "running",
      serverId: "srv_owner_a",
      pid: firstInstance.pid,
      startedAt: firstInstance.startedAt,
    });
    await expect(second).resolves.toMatchObject({
      status: "running",
      serverId: "srv_owner_b",
      pid: secondInstance.pid,
      startedAt: secondInstance.startedAt,
    });
  });

  it("does not join a ready probe after the published listen changes", async () => {
    const firstInstance = readyInstance("2026-11-27T00:00:00.000Z", {
      listen: "127.0.0.1:6799",
    });
    const secondInstance = readyInstance("2026-11-27T00:00:00.000Z", {
      listen: "127.0.0.1:6800",
    });
    mocks.readDaemonInstance
      .mockResolvedValueOnce(firstInstance)
      .mockResolvedValueOnce(secondInstance);
    const firstProbe = queueProbe();
    const secondProbe = queueProbe();
    const handler = createDaemonCommandHandlers();

    const first = handler.desktop_daemon_status();
    await firstProbe.started;
    const second = handler.desktop_daemon_status();
    await Promise.resolve();
    expect(mocks.runExternalCliJsonCommand).toHaveBeenCalledTimes(2);

    firstProbe.result.resolve(readyPayload(firstInstance, { serverId: "srv_endpoint_a" }));
    secondProbe.result.resolve(readyPayload(secondInstance, { serverId: "srv_endpoint_b" }));

    await expect(first).resolves.toMatchObject({
      status: "running",
      listen: firstInstance.listen,
      serverId: "srv_endpoint_a",
      pid: firstInstance.pid,
      startedAt: firstInstance.startedAt,
    });
    await expect(second).resolves.toMatchObject({
      status: "running",
      listen: secondInstance.listen,
      serverId: "srv_endpoint_b",
      pid: secondInstance.pid,
      startedAt: secondInstance.startedAt,
    });
  });

  it("does not join a ready probe after the home changes", async () => {
    const instance = readyInstance("2026-11-27T00:00:00.000Z");
    const firstHome = mocks.paseoHome;
    const secondHome = path.join(fixtureRoot, "other-home");
    mocks.readDaemonInstance.mockResolvedValue(instance);
    const firstProbe = queueProbe();
    const secondProbe = queueProbe();
    const handler = createDaemonCommandHandlers();

    const first = handler.desktop_daemon_status();
    await firstProbe.started;
    mocks.paseoHome = secondHome;
    const second = handler.desktop_daemon_status();
    await Promise.resolve();
    expect(mocks.runExternalCliJsonCommand).toHaveBeenCalledTimes(2);

    firstProbe.result.resolve(readyPayload(instance, { home: firstHome, serverId: "srv_home_a" }));
    secondProbe.result.resolve(
      readyPayload(instance, { home: secondHome, serverId: "srv_home_b" }),
    );

    await expect(first).resolves.toMatchObject({
      home: firstHome,
      status: "running",
      serverId: "srv_home_a",
    });
    await expect(second).resolves.toMatchObject({
      home: secondHome,
      status: "running",
      serverId: "srv_home_b",
    });
  });

  it("reports an errored daemon when the local daemon state cannot be read", async () => {
    mkdirSync(mocks.paseoHome);
    writeFileSync(path.join(mocks.paseoHome, "paseo.pid"), "garbage");

    const status = await createDaemonCommandHandlers().desktop_daemon_status();

    expect(status).toMatchObject({ serverId: "", status: "errored", pid: null });
    expect(status.error).toBeTruthy();
  });

  it("returns a local credential only for its live managed daemon listen", async () => {
    mkdirSync(mocks.paseoHome);
    const token = "a".repeat(43);
    writeFileSync(path.join(mocks.paseoHome, "local-credential"), `${token}\n`, { mode: 0o600 });
    const lock = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6799",
      desktopManaged: true,
    };
    const lockPath = path.join(mocks.paseoHome, "paseo.pid");
    writeFileSync(lockPath, JSON.stringify(lock));
    const handler = createDaemonCommandHandlers().desktop_local_credential;
    expect(await handler({ listen: "localhost:6799" })).toBe(token);
    expect(await handler({ listen: "remote:6799" })).toBeNull();
    writeFileSync(lockPath, JSON.stringify({ ...lock, desktopManaged: false }));
    expect(await handler({ listen: "localhost:6799" })).toBeNull();
  });

  it("delegates update checks to checkForAppUpdate even when desktop-settings.json cannot be read", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.checkForAppUpdate.mockResolvedValue({
      hasUpdate: true,
      readyToInstall: false,
      downloading: true,
      currentVersion: "1.2.3",
      latestVersion: "1.2.4",
      body: null,
      date: null,
      errorMessage: null,
    });
    mocks.downloadAndInstallUpdate.mockResolvedValue({
      installed: true,
      version: "1.2.4",
      message: "Update downloaded.",
    });

    mocks.settingsError = new SyntaxError("Unexpected token } in JSON");
    try {
      await createDaemonCommandHandlers().check_app_update({
        intent: "manual",
        releaseChannel: "beta",
      });
      expect(mocks.checkForAppUpdate).toHaveBeenLastCalledWith({
        currentVersion: "1.2.3",
        releaseChannel: "beta",
        intent: "manual",
      });

      await createDaemonCommandHandlers().check_app_update({ intent: "automatic" });
      expect(mocks.checkForAppUpdate).toHaveBeenLastCalledWith({
        currentVersion: "1.2.3",
        releaseChannel: "stable",
        intent: "automatic",
      });

      await createDaemonCommandHandlers().install_app_update({});
      expect(mocks.downloadAndInstallUpdate).toHaveBeenLastCalledWith(
        { currentVersion: "1.2.3", releaseChannel: "stable" },
        expect.any(Function),
      );
    } finally {
      mocks.settingsError = null;
      consoleWarn.mockRestore();
    }
  });
});

describe("desktop stops and terminals", () => {
  const reasons: DesktopDaemonStopReason[] = [
    "manual_ipc",
    "settings",
    "host_remove",
    "quit",
    "app_update",
    "version_mismatch",
    "restart",
  ];

  it("keeps terminals only for an app update or version-mismatch restart, never on Windows", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(reasons.filter((reason) => keepsTerminalsOnStop(reason, platform))).toEqual([
        "app_update",
        "version_mismatch",
      ]);
    }
    expect(reasons.filter((reason) => keepsTerminalsOnStop(reason, "win32"))).toEqual([]);
  });

  function stopHarness(runCliJson: (args: string[]) => Promise<unknown>) {
    const stops: Array<{ keepTerminals: boolean | undefined }> = [];
    const logged: string[] = [];
    const instance = {
      pid: 4242,
      startedAt: "2026-10-21T00:00:00.000Z",
      hostname: "host",
      uid: 501,
      listen: "127.0.0.1:6799",
    };
    const stopInstance = (async (
      _home: string,
      options: {
        keepTerminals?: boolean;
        requestShutdown?: (ready: { listen: string }) => Promise<void>;
      },
    ) => {
      stops.push({ keepTerminals: options.keepTerminals });
      await options.requestShutdown?.({ listen: instance.listen });
      return { action: "stopped", pid: instance.pid, forced: false, usedLifecycleRpc: true };
    }) as unknown as NonNullable<Parameters<typeof stopCapturedDaemon>[0]["stopInstance"]>;
    return {
      stops,
      logged,
      input: {
        home: "/tmp/paseo-home",
        instance,
        stopInstance,
        runCliJson,
        log: (message: string) => logged.push(message),
      } as Omit<Parameters<typeof stopCapturedDaemon>[0], "reason" | "keepTerminals">,
    };
  }

  it("asks the daemon to keep its terminals on an app update", async () => {
    const calls: string[][] = [];
    const harness = stopHarness(async (args) => {
      calls.push(args);
      return { action: "shutdown_requested" };
    });

    await stopCapturedDaemon({ ...harness.input, reason: "app_update", keepTerminals: true });

    expect(harness.stops).toEqual([{ keepTerminals: true }]);
    expect(calls).toEqual([
      ["daemon", "stop", "--host", "127.0.0.1:6799", "--keep-terminals", "--json"],
    ]);
  });

  it("stops a daemon without the capability with its terminals closed, and says so", async () => {
    const calls: string[][] = [];
    const harness = stopHarness(async (args) => {
      calls.push(args);
      if (args.includes("--keep-terminals")) {
        throw new ExternalCliCommandError("refused", {
          code: "TERMINALS_KEEP_UNSUPPORTED",
          version: "0.11.0",
        });
      }
      return { action: "shutdown_requested" };
    });

    await stopCapturedDaemon({ ...harness.input, reason: "app_update", keepTerminals: true });

    expect(harness.stops).toEqual([{ keepTerminals: true }, { keepTerminals: false }]);
    expect(calls[1]).toEqual(["daemon", "stop", "--host", "127.0.0.1:6799", "--json"]);
    expect(harness.logged).toContain(
      "daemon v0.11.0 cannot keep terminals; stopping it and closing them",
    );
  });

  it("does not retry a keep stop that failed for another reason", async () => {
    const harness = stopHarness(async () => {
      throw new ExternalCliCommandError("unreachable", { code: "DAEMON_UNREACHABLE" });
    });

    await expect(
      stopCapturedDaemon({ ...harness.input, reason: "app_update", keepTerminals: true }),
    ).rejects.toThrow("unreachable");
    expect(harness.stops).toEqual([{ keepTerminals: true }]);
  });
});

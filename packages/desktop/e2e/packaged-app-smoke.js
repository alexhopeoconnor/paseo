const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium } = require("playwright");
const { extractFile } = require("@electron/asar");
const { WebSocket } = require("ws");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");

const EXECUTABLE_NAME = "Paseo";
const SMOKE_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 10_000;
const TERMINAL_CAPTURE_ATTEMPTS = 20;
const TERMINAL_CAPTURE_INTERVAL_MS = 500;
const COMPOSER_SMOKE_WORKSPACE_TITLE = "Composer smoke workspace";
const COMPOSER_SMOKE_PROMPT = "composer repeat acceptance";
const COMPOSER_SMOKE_TIMEOUT_MS = 30_000;
const HOPLITE_SMOKE_FIXTURE = path.resolve(
  __dirname,
  "../../server/src/server/daemon-e2e/hoplite-fixture.cjs",
);
const REQUIRED_DESKTOP_BRIDGE_KEYS = [
  "platform",
  "invoke",
  "getPendingOpenProject",
  "events",
  "window",
  "dialog",
  "notification",
  "opener",
  "editor",
  "webUtils",
  "menu",
  "browser",
];

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function assertBuiltinPluginsStarted(listen) {
  const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");
  const { builtinPlugins } =
    await import("../../server/dist/server/server/plugins/builtin/index.js");
  const client = new DaemonClient({
    url: `ws://${listen}/ws`,
    clientId: "packaged-builtin-smoke",
    webSocketFactory: (url, options) =>
      new WebSocket(url, options?.protocols, { headers: options?.headers }),
  });
  try {
    await client.connect();
    const catalog = await client.getPluginCatalog();
    assert.deepEqual(
      catalog.map(({ id }) => id).sort(),
      [...builtinPlugins].sort(),
      "Every built-in plugin must start in the packaged desktop daemon",
    );
  } finally {
    await client.close();
  }
}

function assertExecutable(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} does not exist: ${filePath}`);
  }
  if (process.platform !== "win32") {
    fs.accessSync(filePath, fs.constants.X_OK);
  }
}

// The build user owns staging, but native packages install as root. accessSync
// alone would let owner-only files pass smoke and fail after installation.
function assertLinuxRuntimePermissions(appPath) {
  if (process.platform !== "linux") return;
  function visit(directory) {
    for (const entry of fs.readdirSync(directory)) {
      const target = path.join(directory, entry);
      const metadata = fs.lstatSync(target);
      if (metadata.isSymbolicLink()) continue;
      const required = metadata.isDirectory() ? 0o005 : 0o004 | (metadata.mode & 0o100 ? 1 : 0);
      if ((metadata.mode & required) !== required) {
        throw new Error(`Packaged runtime is inaccessible to non-owner users: ${target}`);
      }
      if (metadata.isDirectory()) visit(target);
    }
  }
  visit(appPath);
}

function getExecutablePath(appPath) {
  if (process.platform === "darwin") {
    return path.join(appPath, "Contents", "MacOS", EXECUTABLE_NAME);
  }

  if (process.platform === "win32") {
    return path.join(appPath, `${EXECUTABLE_NAME}.exe`);
  }

  return path.join(appPath, EXECUTABLE_NAME);
}

function getCliShimPath(appPath) {
  if (process.platform === "darwin") {
    return path.join(appPath, "Contents", "Resources", "bin", "paseo");
  }

  if (process.platform === "win32") {
    return path.join(appPath, "resources", "bin", "paseo.cmd");
  }

  return path.join(appPath, "resources", "bin", "paseo");
}

function getMacMainExecutablePath(appPath) {
  return path.join(appPath, "Contents", "MacOS", EXECUTABLE_NAME);
}

function getLaunchCommand(executablePath, args) {
  if (process.platform !== "linux") {
    return {
      command: executablePath,
      args,
    };
  }

  return {
    command: "xvfb-run",
    args: ["-a", "--server-args=-screen 0 1280x800x24", executablePath, ...args],
  };
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellQuoteCliArg(value) {
  if (process.platform === "win32") {
    return `"${String(value).replace(/"/g, '""')}"`;
  }

  return shellQuote(String(value));
}

function getTerminalHookSmokeCommand(marker) {
  if (process.platform === "win32") {
    const script = [
      "& $env:PASEO_HOOK_CLI hooks codex Stop",
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
      `Write-Output '${marker}'`,
    ].join("; ");
    const encodedScript = Buffer.from(script, "utf16le").toString("base64");
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodedScript}`;
  }

  return `"$PASEO_HOOK_CLI" hooks codex Stop && echo ${marker}`;
}

function getShellCommand(script) {
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/c", script],
    };
  }

  return {
    command: "/bin/sh",
    args: ["-lc", script],
  };
}

function createDefaultDaemonEnv(extraEnv) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_"))),
    ...extraEnv,
  };
}

function createIsolatedDesktopEnv({ home, listen, userData, cdpPort }) {
  const runtime = path.join(home, "runtime");
  fs.mkdirSync(runtime, { mode: 0o700 });
  return {
    ...createDefaultDaemonEnv({ HOME: home, USERPROFILE: home }),
    XDG_RUNTIME_DIR: runtime,
    PASEO_HOME: home,
    PASEO_LISTEN: listen,
    PASEO_ELECTRON_USER_DATA_DIR: userData,
    PASEO_ELECTRON_FLAGS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort}`,
  };
}

function configureIsolatedDaemonHome(home, listen, { webUi = false, providers } = {}) {
  fs.writeFileSync(
    path.join(home, "config.json"),
    `${JSON.stringify(
      {
        version: 1,
        daemon: {
          listen,
          relay: { enabled: false },
          mcp: { enabled: false, injectIntoAgents: false },
        },
        ...(providers ? { agents: { providers } } : {}),
        ...(webUi ? { features: { webUi: { enabled: true } } } : {}),
      },
      null,
      2,
    )}\n`,
  );
}

function reserveLocalTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve a TCP port for smoke test")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function reserveDistinctPackagedPorts() {
  const daemonPort = await reserveLocalTcpPort();
  let cdpPort = await reserveLocalTcpPort();
  for (let attempt = 0; cdpPort === daemonPort && attempt < 10; attempt += 1) {
    cdpPort = await reserveLocalTcpPort();
  }
  if (cdpPort === daemonPort) {
    throw new Error("Failed to reserve distinct TCP ports for the daemon and CDP");
  }
  return { daemonPort, cdpPort };
}

async function waitForFile(filePath, label) {
  const deadline = Date.now() + SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const contents = fs.readFileSync(filePath, "utf8");
      if (contents.trim().length > 0) {
        return contents;
      }
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}: ${filePath}`);
}

async function waitForChildPids(parentPid) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const childPids = listChildPids(parentPid);
    if (childPids.length > 0) {
      return childPids;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for daemon worker child of supervisor PID ${parentPid}`);
}

function listChildPids(parentPid) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`ps failed while listing child processes: ${result.stderr.trim()}`);
  }

  const children = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (Number.isInteger(pid) && ppid === parentPid) {
      children.push(pid);
    }
  }
  return children;
}

function listDarwinTextExecutables(pid) {
  const result = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], {
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `lsof failed while inspecting PID ${pid}: ${
        result.stderr.trim() || result.stdout.trim() || "<empty>"
      }`,
    );
  }

  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
}

function assertDarwinProcessDoesNotUseMainAppExecutable({ appPath, pid, label }) {
  const mainExecutablePath = getMacMainExecutablePath(appPath);
  assertExecutable(mainExecutablePath, "Packaged app executable");

  const textExecutables = listDarwinTextExecutables(pid);
  if (textExecutables.includes(mainExecutablePath)) {
    throw new Error(
      `${label} PID ${pid} launched through the main app executable ${mainExecutablePath}.\nText executables:\n${textExecutables.join(
        "\n",
      )}`,
    );
  }
}

function readIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

function formatLogs({ stdout, stderr, userData, daemonHome }) {
  const desktopLog = readIfExists(path.join(userData, "logs", "main.log"));
  const daemonLog = readIfExists(path.join(daemonHome, "daemon.log"));
  return [
    `App stdout:\n${stdout.join("").trim() || "<empty>"}`,
    `App stderr:\n${stderr.join("").trim() || "<empty>"}`,
    `Desktop log:\n${desktopLog?.trim() || "<missing>"}`,
    `Daemon log:\n${daemonLog?.trim() || "<missing>"}`,
  ].join("\n\n");
}

async function writeSmokeArtifacts({ page, stdout, stderr, userData, daemonHome, error }) {
  const artifactDir = process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR?.trim();
  if (!artifactDir) {
    return;
  }

  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, error ? "failure.txt" : "success.txt"),
    `${error instanceof Error ? (error.stack ?? error.message) : String(error ?? "Packaged desktop smoke passed")}\n\n${formatLogs(
      {
        stdout,
        stderr,
        userData,
        daemonHome,
      },
    )}\n`,
  );

  const desktopLog = readIfExists(path.join(userData, "logs", "main.log"));
  if (desktopLog !== null) {
    fs.writeFileSync(path.join(artifactDir, "desktop-main.log"), desktopLog);
  }
  const daemonLog = readIfExists(path.join(daemonHome, "daemon.log"));
  if (daemonLog !== null) {
    fs.writeFileSync(path.join(artifactDir, "daemon.log"), daemonLog);
  }

  if (page) {
    const renderer = await page
      .evaluate(() => ({
        url: window.location.href,
        title: document.title,
        rootChildCount: document.querySelector("#root")?.childElementCount ?? 0,
        rootText: document.querySelector("#root")?.textContent?.trim().slice(0, 2_000) ?? "",
        bridgeKeys:
          typeof window.paseoDesktop === "object" && window.paseoDesktop !== null
            ? Object.keys(window.paseoDesktop)
            : [],
      }))
      .catch((evaluationError) => ({ evaluationError: String(evaluationError) }));
    fs.writeFileSync(
      path.join(artifactDir, "renderer.json"),
      `${JSON.stringify(renderer, null, 2)}\n`,
    );
    await page
      .screenshot({ path: path.join(artifactDir, "renderer.png"), fullPage: true })
      .catch(() => undefined);
  }
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function terminateChild(child, signal = "SIGTERM") {
  if (!isRunning(child)) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }

  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }

  child.kill(signal);
}

function waitForChildExit(child, timeoutMs = EXIT_TIMEOUT_MS) {
  if (!isRunning(child)) {
    return Promise.resolve(true);
  }

  let onExit;
  const exitPromise = new Promise((resolve) => {
    onExit = () => resolve(true);
    child.once("exit", onExit);
  });

  return Promise.race([exitPromise, delay(timeoutMs, false)]).finally(() => {
    child.off("exit", onExit);
  });
}

function releaseChildHandles(child) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

async function removeTempDir(tempDir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code) || attempt === 4) {
        console.warn(`Packaged desktop smoke: failed to remove temp dir ${tempDir}: ${error}`);
        return;
      }
      await delay(250);
    }
  }
}

function remainingTime(deadline) {
  return Math.max(1, deadline - Date.now());
}

async function connectToPackagedApp({
  child,
  cdpPort,
  stdout,
  stderr,
  userData,
  daemonHome,
  deadline,
}) {
  let lastError = null;

  while (Date.now() < deadline) {
    if (!isRunning(child)) {
      throw new Error(
        `Packaged app exited before opening its debugging endpoint (code ${child.exitCode}, signal ${
          child.signalCode ?? "none"
        }).\n${formatLogs({ stdout, stderr, userData, daemonHome })}`,
      );
    }

    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }

  throw new Error(
    `Timed out connecting to the packaged app over CDP: ${lastError}.\n${formatLogs({
      stdout,
      stderr,
      userData,
      daemonHome,
    })}`,
  );
}

async function waitForPackagedAppPage(browser, deadline) {
  while (Date.now() < deadline) {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("paseo://app/"));
    if (page) {
      return page;
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the packaged paseo://app/ renderer");
}

async function assertPackagedRendererLoaded(page, deadline) {
  await page.waitForFunction(
    () => {
      const root = document.querySelector("#root");
      return root instanceof HTMLElement && root.childElementCount > 0;
    },
    undefined,
    { timeout: remainingTime(deadline) },
  );

  const bridgeKeys = await page.evaluate(() =>
    typeof window.paseoDesktop === "object" && window.paseoDesktop !== null
      ? Object.keys(window.paseoDesktop)
      : [],
  );
  const missingBridgeKeys = REQUIRED_DESKTOP_BRIDGE_KEYS.filter((key) => !bridgeKeys.includes(key));
  if (missingBridgeKeys.length > 0) {
    throw new Error(
      `Packaged renderer is missing desktop preload bridge keys: ${missingBridgeKeys.join(", ")}. Present keys: ${bridgeKeys.join(", ") || "<none>"}`,
    );
  }
}

async function waitForRendererStartedDaemon({
  page,
  daemonHome,
  listen,
  stdout,
  stderr,
  userData,
  deadline,
}) {
  let lastStatus = null;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      lastStatus = await page.evaluate(() => window.paseoDesktop.invoke("desktop_daemon_status"));
      if (
        lastStatus?.status === "running" &&
        lastStatus.desktopManaged === true &&
        typeof lastStatus.pid === "number" &&
        typeof lastStatus.serverId === "string" &&
        lastStatus.serverId.length > 0 &&
        lastStatus.listen === listen &&
        path.resolve(lastStatus.home) === path.resolve(daemonHome)
      ) {
        return lastStatus;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }

  throw new Error(
    `Packaged renderer did not start its desktop-managed daemon. Last status: ${JSON.stringify(lastStatus)}. Last error: ${lastError}.\n${formatLogs({ stdout, stderr, userData, daemonHome })}`,
  );
}

function runShellCommand({ script, env, label }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const shell = getShellCommand(script);
    const child = spawn(shell.command, shell.args, {
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: process.platform === "win32",
    });
    const stdout = [];
    const stderr = [];

    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      releaseChildHandles(child);
      callback(value);
    };

    const timer = setTimeout(() => {
      terminateChild(child);
      finish(
        reject,
        new Error(
          `${label} timed out.\nStdout:\n${stdout.join("").trim() || "<empty>"}\n\nStderr:\n${
            stderr.join("").trim() || "<empty>"
          }`,
        ),
      );
    }, SMOKE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        finish(resolve, {
          stdout: stdout.join(""),
          stderr: stderr.join(""),
        });
        return;
      }

      finish(
        reject,
        new Error(
          `${label} failed (code ${code}, signal ${signal ?? "none"}).\nStdout:\n${
            stdout.join("").trim() || "<empty>"
          }\n\nStderr:\n${stderr.join("").trim() || "<empty>"}`,
        ),
      );
    });
  });
}

function getCliShimScript(cliShimPath, args) {
  const commandArgs = args.map(shellQuoteCliArg).join(" ");
  if (process.platform === "win32") {
    return `call "${cliShimPath}" ${commandArgs}`;
  }

  return `${shellQuote(cliShimPath)} ${commandArgs}`;
}

async function runCliShimCommand({ appPath, env, args, label }) {
  const cliShimPath = getCliShimPath(appPath);
  assertExecutable(cliShimPath, "Bundled CLI shim");

  return await runShellCommand({
    script: getCliShimScript(cliShimPath, args),
    env,
    label,
  });
}

async function runCliShimJsonCommand({ appPath, env, args, label }) {
  const result = await runCliShimCommand({
    appPath,
    env,
    args: [...args, "--json"],
    label,
  });
  const output = result.stdout.trim();
  if (!output) {
    throw new Error(`${label} produced empty JSON output`);
  }

  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} produced invalid JSON: ${output}`, { cause: error });
  }
}

async function smokeCliShim({ appPath, env }) {
  console.log("Packaged desktop smoke: running bundled CLI shim daemon status");
  const result = await runCliShimCommand({
    appPath,
    env,
    args: ["daemon", "status"],
    label: "Bundled CLI shim daemon status",
  });
  assertCleanDaemonStatusOutput(`${result.stdout}\n${result.stderr}`);
}

async function smokeColdCliDaemonStart({ appPath }) {
  const home = createTempDir("paseo-smoke-cli-daemon-home-");
  const pidPath = path.join(home, "paseo.pid");
  const port = await reserveLocalTcpPort();
  const listen = `127.0.0.1:${port}`;
  const env = createDefaultDaemonEnv({ HOME: home, USERPROFILE: home });
  configureIsolatedDaemonHome(home, listen);

  try {
    console.log("Packaged desktop smoke: cold-starting daemon through bundled CLI shim");
    await runCliShimCommand({
      appPath,
      env,
      args: ["daemon", "start", "--home", home],
      label: "Bundled CLI shim cold daemon start",
    });

    const pidInfo = JSON.parse(await waitForFile(pidPath, "cold CLI daemon pid file"));
    if (!pidInfo || typeof pidInfo.pid !== "number") {
      throw new Error(`Cold CLI daemon wrote invalid pid file: ${JSON.stringify(pidInfo)}`);
    }

    if (process.platform === "darwin") {
      assertDarwinProcessDoesNotUseMainAppExecutable({
        appPath,
        pid: pidInfo.pid,
        label: "Cold CLI daemon supervisor",
      });
      const childPids = await waitForChildPids(pidInfo.pid);
      for (const childPid of childPids) {
        assertDarwinProcessDoesNotUseMainAppExecutable({
          appPath,
          pid: childPid,
          label: "Cold CLI daemon worker",
        });
      }
    }
  } finally {
    if (fs.existsSync(pidPath)) {
      await runCliShimCommand({
        appPath,
        env,
        args: ["daemon", "stop", "--home", home, "--force"],
        label: "Bundled CLI shim cold daemon stop",
      }).catch((error) => {
        console.warn(`Packaged desktop smoke: failed to stop cold CLI daemon: ${error}`);
      });
    }
    await removeTempDir(home);
  }
}

function assertCleanDaemonStatusOutput(output) {
  const failureNeedles = [
    "Get-CimInstance",
    "Get-Process :",
    "Cannot bind parameter",
    "wmic failed",
  ];
  const failure = failureNeedles.find((needle) => output.includes(needle));
  if (failure) {
    throw new Error(`Bundled CLI shim daemon status included process lookup failure: ${failure}`);
  }
}

async function smokeCliTerminal({ appPath, env }) {
  const cwd = createTempDir("paseo-smoke-terminal-cwd-");
  const marker = `paseo-packaged-terminal-smoke-${Date.now()}`;
  const name = `packaged-smoke-${process.pid}-${Date.now()}`;
  let terminalId = null;

  try {
    console.log("Packaged desktop smoke: creating terminal through bundled CLI shim");
    const created = await runCliShimJsonCommand({
      appPath,
      env,
      args: ["terminal", "create", "--cwd", cwd, "--name", name],
      label: "Bundled CLI shim terminal create",
    });
    if (!created || typeof created.id !== "string" || created.id.length === 0) {
      throw new Error(`Terminal create returned unexpected payload: ${JSON.stringify(created)}`);
    }
    terminalId = created.id;

    const terminals = await runCliShimJsonCommand({
      appPath,
      env,
      args: ["terminal", "ls", "--all"],
      label: "Bundled CLI shim terminal ls",
    });
    if (!Array.isArray(terminals) || !terminals.some((terminal) => terminal.id === terminalId)) {
      throw new Error(`Terminal ${terminalId} was not listed after create`);
    }

    await runCliShimJsonCommand({
      appPath,
      env,
      args: ["terminal", "send-keys", terminalId, getTerminalHookSmokeCommand(marker), "Enter"],
      label: "Bundled CLI shim terminal hook command",
    });

    for (let attempt = 1; attempt <= TERMINAL_CAPTURE_ATTEMPTS; attempt += 1) {
      const capture = await runCliShimJsonCommand({
        appPath,
        env,
        args: ["terminal", "capture", terminalId, "--scrollback"],
        label: "Bundled CLI shim terminal capture",
      });
      const lines = Array.isArray(capture?.lines) ? capture.lines : [];
      if (lines.join("\n").includes(marker)) {
        console.log("Packaged desktop smoke: terminal hook command completed");
        return;
      }

      if (attempt < TERMINAL_CAPTURE_ATTEMPTS) {
        await delay(TERMINAL_CAPTURE_INTERVAL_MS);
      }
    }

    throw new Error(`Timed out waiting for terminal capture marker ${marker}`);
  } finally {
    if (terminalId) {
      await runCliShimJsonCommand({
        appPath,
        env,
        args: ["terminal", "kill", terminalId],
        label: "Bundled CLI shim terminal kill",
      }).catch((error) => {
        console.warn(`Packaged desktop smoke: failed to kill terminal ${terminalId}: ${error}`);
      });
    }
    await removeTempDir(cwd);
  }
}

async function stopCliDaemon({ appPath, env }) {
  console.log("Packaged desktop smoke: stopping daemon through bundled CLI shim");
  await runCliShimCommand({
    appPath,
    env,
    args: ["daemon", "stop", "--force"],
    label: "Bundled CLI shim daemon stop",
  });
}

async function openSmokeWorkspace({ appPath, env, page, daemonHome, focusComposer = true }) {
  const projectPath = path.join(daemonHome, "sandbox-smoke-project");
  fs.mkdirSync(projectPath);
  fs.writeFileSync(path.join(projectPath, "README.md"), "Packaged Linux sandbox smoke\n");
  const workspace = await runCliShimJsonCommand({
    appPath,
    env,
    args: [
      "workspace",
      "create",
      "--isolation",
      "local",
      "--path",
      projectPath,
      "--title",
      "Sandbox smoke workspace",
    ],
    label: "Create packaged smoke workspace",
  });
  // The fresh daemon had no projects at launch, so first-run setup is open over the sidebar.
  await page.evaluate(() =>
    localStorage.setItem("@paseo:onboarding", JSON.stringify({ completedAt: "1970-01-01" })),
  );
  await page.reload();
  await page.getByRole("button", { name: "Sandbox smoke workspace", exact: true }).click();
  await page.waitForURL((url) => url.pathname.endsWith(`/workspace/${workspace.workspaceId}`));
  if (focusComposer) {
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await page.getByRole("textbox", { name: "Message agent..." }).click();
  }
  console.log(`Packaged desktop smoke: renderer opened workspace ${workspace.workspaceId}`);
  return workspace.workspaceId;
}

async function openPackagedBrowserWorkspace({
  page,
  listen,
  workspaceId,
  workspaceTitle = "Sandbox smoke workspace",
  agentId,
}) {
  const response = await page.goto(`http://${listen}/`);
  assert.equal(response?.status(), 200, "Packaged daemon must serve its bundled browser UI");
  const bootstrap = await page.evaluate(() => ({
    desktopBridge: typeof window.paseoDesktop !== "undefined",
    hint: window.__PASEO_INITIAL_DAEMON_CONNECTION__,
  }));
  assert.equal(bootstrap.desktopBridge, false, "Browser smoke must not use the Electron bridge");
  assert.equal(bootstrap.hint?.listen, listen, "Served UI must bootstrap its actual daemon");
  assert.equal(bootstrap.hint?.useTls, false);
  // The real server hint hydrates this clean browser. Do not seed its host registry.
  await page.getByRole("button", { name: workspaceTitle, exact: true }).click();
  await page.waitForURL((url) => url.pathname.endsWith(`/workspace/${workspaceId}`));
  if (agentId) {
    const agentTab = page
      .getByTestId(`workspace-tab-agent_${agentId}`)
      .filter({ visible: true })
      .first();
    await agentTab.waitFor({ state: "visible", timeout: COMPOSER_SMOKE_TIMEOUT_MS });
    await agentTab.click();
    await page
      .getByRole("textbox", { name: "Message agent..." })
      .first()
      .waitFor({ state: "visible", timeout: COMPOSER_SMOKE_TIMEOUT_MS });
  }
  console.log(`Packaged browser smoke: served UI opened workspace ${workspaceId}`);
}

async function connectPackagedSmokeClient(listen, clientId) {
  const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");
  const client = new DaemonClient({
    url: `ws://${listen}/ws`,
    clientId,
    webSocketFactory: (url, options) =>
      new WebSocket(url, options?.protocols, { headers: options?.headers }),
  });
  await client.connect();
  return client;
}

async function waitForCondition({ label, condition, timeoutMs = COMPOSER_SMOKE_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await condition()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`${label}: condition not met${lastError ? `; last error: ${lastError}` : ""}`);
}

async function waitForBrowserPaint(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
  );
}

async function waitForComposerRecoveryReady(page) {
  const deadline = Date.now() + COMPOSER_SMOKE_TIMEOUT_MS;
  const composerRoot = page.getByTestId("composer-root").filter({ visible: true }).first();
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await composerRoot.getAttribute("data-submission-recovery-state").catch(() => null);
    if (lastState === "ready") {
      return;
    }
    if (lastState === "error") {
      throw new Error("Composer recovery inspection entered error state");
    }
    await delay(100);
  }
  throw new Error(`Composer recovery inspection did not become ready; last state ${lastState}`);
}

async function readComposerClientMessageIds({ client, agentId, text }) {
  const timeline = await client.fetchAgentTimeline(agentId, { direction: "tail", limit: 100 });
  return timeline.entries
    .map(({ item }) => item)
    .filter((item) => item.type === "user_message" && item.text === text)
    .map((item) => item.clientMessageId)
    .filter((id) => typeof id === "string" && id.length > 0);
}

async function createComposerSmokeWorkspace({ appPath, env, projectPath }) {
  const workspace = await runCliShimJsonCommand({
    appPath,
    env,
    args: [
      "workspace",
      "create",
      "--isolation",
      "local",
      "--path",
      projectPath,
      "--title",
      COMPOSER_SMOKE_WORKSPACE_TITLE,
    ],
    label: "Create packaged composer workspace",
  });
  if (
    !workspace ||
    typeof workspace.workspaceId !== "string" ||
    workspace.workspaceId.length === 0
  ) {
    throw new Error(
      `Composer workspace create returned unexpected payload: ${JSON.stringify(workspace)}`,
    );
  }
  return workspace.workspaceId;
}

async function createComposerSmokeAgent({ client, workspaceId, cwd }) {
  const agent = await client.createAgent({
    provider: "hoplite",
    cwd,
    workspaceId,
    model: "fixture-model",
    title: "Packaged repeat acceptance",
  });
  if (!agent || typeof agent.id !== "string" || agent.id.length === 0) {
    throw new Error(`Composer agent create returned unexpected payload: ${JSON.stringify(agent)}`);
  }
  return agent.id;
}

async function smokeComposerRepeatAcceptance({
  page,
  client,
  listen,
  workspaceId,
  workspaceTitle,
  agentId,
}) {
  const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
  await composer.waitFor({ state: "visible", timeout: COMPOSER_SMOKE_TIMEOUT_MS });
  await waitForCondition({
    label: "initial composer editable",
    condition: () => composer.isEditable().catch(() => false),
  });
  await waitForComposerRecoveryReady(page);

  const messages = page.getByTestId("user-message").filter({ hasText: COMPOSER_SMOKE_PROMPT });
  const recoveryPill = page.getByTestId("composer-submission-needs-review");

  await composer.fill(COMPOSER_SMOKE_PROMPT);
  await composer.press("Enter");
  await waitForCondition({
    label: "first accepted message",
    condition: async () => (await messages.count()) === 1,
  });
  await waitForCondition({
    label: "first accepted message acknowledged",
    condition: async () =>
      (await messages
        .first()
        .getAttribute("aria-busy")
        .catch(() => null)) === "false",
  });
  await waitForCondition({
    label: "composer cleared after first send",
    condition: async () => (await composer.inputValue().catch(() => null)) === "",
  });
  const firstFinish = await client.waitForFinish(agentId, COMPOSER_SMOKE_TIMEOUT_MS);
  if (firstFinish.status !== "idle") {
    throw new Error(`First composer smoke turn did not finish idle: ${firstFinish.status}`);
  }

  await composer.fill(COMPOSER_SMOKE_PROMPT);
  await waitForCondition({
    label: "identical draft retyped",
    condition: async () =>
      (await composer.inputValue().catch(() => null)) === COMPOSER_SMOKE_PROMPT,
  });
  await waitForBrowserPaint(page);
  assert.equal(
    await recoveryPill.count(),
    0,
    "identical retyped text must not show an accepted notice",
  );
  await waitForCondition({
    label: "retyped draft must not submit",
    condition: async () => (await messages.count()) === 1,
  });
  await waitForCondition({
    label: "retyped draft timeline",
    condition: async () =>
      (
        await readComposerClientMessageIds({
          client,
          agentId,
          text: COMPOSER_SMOKE_PROMPT,
        })
      ).length === 1,
  });

  await composer.fill(`${COMPOSER_SMOKE_PROMPT} edited`);
  await waitForCondition({
    label: "edited draft",
    condition: async () =>
      (await composer.inputValue().catch(() => null)) === `${COMPOSER_SMOKE_PROMPT} edited`,
  });
  await waitForBrowserPaint(page);
  assert.equal(await recoveryPill.count(), 0, "edited draft must not show an accepted notice");
  await composer.fill(COMPOSER_SMOKE_PROMPT);
  await waitForCondition({
    label: "original draft restored",
    condition: async () =>
      (await composer.inputValue().catch(() => null)) === COMPOSER_SMOKE_PROMPT,
  });
  await waitForBrowserPaint(page);
  assert.equal(await recoveryPill.count(), 0, "edited-back draft must not show an accepted notice");
  await waitForCondition({
    label: "edited-back draft must not submit",
    condition: async () => (await messages.count()) === 1,
  });
  await waitForCondition({
    label: "edited-back draft timeline",
    condition: async () =>
      (
        await readComposerClientMessageIds({
          client,
          agentId,
          text: COMPOSER_SMOKE_PROMPT,
        })
      ).length === 1,
  });

  await composer.press("Enter");
  await waitForCondition({
    label: "second explicit send",
    condition: async () => (await messages.count()) === 2,
  });
  await waitForCondition({
    label: "second accepted message acknowledged",
    condition: async () =>
      (await messages
        .last()
        .getAttribute("aria-busy")
        .catch(() => null)) === "false",
  });
  await waitForCondition({
    label: "composer cleared after second send",
    condition: async () => (await composer.inputValue().catch(() => null)) === "",
  });
  const secondFinish = await client.waitForFinish(agentId, COMPOSER_SMOKE_TIMEOUT_MS);
  if (secondFinish.status !== "idle") {
    throw new Error(`Second composer smoke turn did not finish idle: ${secondFinish.status}`);
  }
  await waitForCondition({
    label: "two distinct composer clientMessageIds",
    condition: async () => {
      const ids = await readComposerClientMessageIds({
        client,
        agentId,
        text: COMPOSER_SMOKE_PROMPT,
      });
      return ids.length === 2 && new Set(ids).size === 2;
    },
  });

  await openPackagedBrowserWorkspace({ page, listen, workspaceId, workspaceTitle, agentId });
  await composer.waitFor({ state: "visible", timeout: COMPOSER_SMOKE_TIMEOUT_MS });
  await waitForCondition({
    label: "reloaded composer editable",
    condition: () => composer.isEditable().catch(() => false),
  });
  await waitForCondition({
    label: "accepted messages after reload",
    condition: async () => (await messages.count()) === 2,
  });
  await waitForComposerRecoveryReady(page);
  await composer.fill(COMPOSER_SMOKE_PROMPT);
  await waitForCondition({
    label: "reloaded fresh draft",
    condition: async () =>
      (await composer.inputValue().catch(() => null)) === COMPOSER_SMOKE_PROMPT,
  });
  await waitForBrowserPaint(page);
  assert.equal(
    await recoveryPill.count(),
    0,
    "reloaded fresh draft must not associate with the old accepted checkpoint",
  );
  await waitForCondition({
    label: "reloaded fresh draft must not submit",
    condition: async () => (await messages.count()) === 2,
  });
  await waitForCondition({
    label: "reloaded fresh draft timeline",
    condition: async () =>
      (
        await readComposerClientMessageIds({
          client,
          agentId,
          text: COMPOSER_SMOKE_PROMPT,
        })
      ).length === 2,
  });

  console.log("Packaged composer checkpoint smoke passed: two distinct fresh submissions");
}

function readPluginIdentity(pluginDir) {
  const manifestPath = path.join(pluginDir, "paseo-plugin.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Codium plugin directory needs a readable paseo-plugin.json: ${manifestPath}`, {
      cause: error,
    });
  }
  assert.equal(manifest?.id, "codium", "Codium plugin manifest must declare id codium");
  assert.ok(
    typeof manifest?.name === "string" && manifest.name.trim().length > 0,
    "Codium plugin manifest must declare a name",
  );

  let version = null;
  const packageJsonPath = path.join(pluginDir, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    const metadata = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    if (typeof metadata?.version === "string" && metadata.version.length > 0) {
      version = metadata.version;
    }
  }
  return { id: manifest.id, name: manifest.name, version };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function readCodiumSmokeFixture(env = process.env) {
  if (env.PASEO_DESKTOP_SMOKE_CODIUM_ARTIFACT) {
    throw new Error(
      "PASEO_DESKTOP_SMOKE_CODIUM_ARTIFACT is no longer supported. Set PASEO_DESKTOP_SMOKE_CODIUM_PLUGIN_DIR to a prepared plugin directory and pass PASEO_DESKTOP_SMOKE_CODIUM_EXPECT_RUNTIME_VERSION and PASEO_DESKTOP_SMOKE_CODIUM_EXPECT_PACKAGE_SHA256 explicitly.",
    );
  }

  const pluginDir = env.PASEO_DESKTOP_SMOKE_CODIUM_PLUGIN_DIR?.trim();
  const deb = env.PASEO_DESKTOP_SMOKE_CODIUM_DEB?.trim();
  const mode = env.PASEO_DESKTOP_SMOKE_CODIUM_MODE?.trim();
  const expectedRuntimeVersion = env.PASEO_DESKTOP_SMOKE_CODIUM_EXPECT_RUNTIME_VERSION?.trim();
  const expectedPackageSha256 = env.PASEO_DESKTOP_SMOKE_CODIUM_EXPECT_PACKAGE_SHA256?.trim();
  const inputs = [pluginDir, deb, mode, expectedRuntimeVersion, expectedPackageSha256];
  if (inputs.every((value) => !value)) return null;

  assert.ok(
    pluginDir && deb && (mode === "stock" || mode === "fork"),
    "Codium smoke needs PLUGIN_DIR, DEB and MODE=stock|fork",
  );
  assert.match(
    expectedRuntimeVersion ?? "",
    /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/,
    "Set PASEO_DESKTOP_SMOKE_CODIUM_EXPECT_RUNTIME_VERSION to the tested daemon version",
  );
  assert.match(
    expectedPackageSha256 ?? "",
    /^[a-f0-9]{64}$/,
    "Set PASEO_DESKTOP_SMOKE_CODIUM_EXPECT_PACKAGE_SHA256 to the exact tested package SHA256",
  );
  assert.ok(
    fs.existsSync(pluginDir) && fs.statSync(pluginDir).isDirectory(),
    `Codium plugin directory is not a directory: ${pluginDir}`,
  );

  const identity = readPluginIdentity(pluginDir);
  const packageSha256 = await sha256File(deb);
  assert.equal(
    packageSha256,
    expectedPackageSha256,
    "Tested package SHA256 differs from PASEO_DESKTOP_SMOKE_CODIUM_EXPECT_PACKAGE_SHA256",
  );
  return {
    pluginDir,
    identity,
    expectedRuntimeVersion,
    packageSha256,
    mode,
  };
}

function codiumSmokeResponse(requestUrl, parentOrigin) {
  if (new URL(requestUrl).pathname !== "/_paseo/ready") {
    return "<!doctype html><title>Isolated editor frame</title>";
  }
  // Simulate access readiness only. Authentication and companion pairing are
  // deliberately outside this package fixture; their live checks remain required.
  const targetOrigin = JSON.stringify(new URL(parentOrigin).origin).replace(/</g, "\\u003c");
  return `<!doctype html><title>Simulated editor access</title><script>
    const match = /^#nonce=([0-9a-f]{32})$/.exec(window.location.hash);
    if (match && window.parent !== window) {
      window.parent.postMessage({
        type: "paseo-codium-access-ready", version: 1, nonce: match[1]
      }, ${targetOrigin});
    }
  </script>`;
}

async function smokeCodiumPlugin({ fixture, page, listen, daemonHome }) {
  const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");
  const client = new DaemonClient({
    url: `ws://${listen}/ws`,
    clientId: "packaged-codium-smoke",
    webSocketFactory: (url, options) =>
      new WebSocket(url, options?.protocols, { headers: options?.headers }),
  });
  const payload = path.join(daemonHome, "codium-plugin");
  fs.cpSync(fixture.pluginDir, payload, { recursive: true });
  // Both old plugins (no probe) and new plugins use this fixture. The editor
  // stays inert after the simulated readiness handshake.
  const fixtureUrl = "https://codium-smoke.invalid/**";
  let simulatedAccessProbes = 0;
  const inertEditor = (route) => {
    const requestUrl = route.request().url();
    if (new URL(requestUrl).pathname === "/_paseo/ready") simulatedAccessProbes += 1;
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: { "Cache-Control": "no-store" },
      body: codiumSmokeResponse(requestUrl, new URL(page.url()).origin),
    });
  };
  await page.context().route(fixtureUrl, inertEditor);
  try {
    await client.connect();
    const status = await client.getDaemonStatus();
    assert.equal(
      status.version,
      fixture.expectedRuntimeVersion,
      "Packaged daemon must match PASEO_DESKTOP_SMOKE_CODIUM_EXPECT_RUNTIME_VERSION",
    );
    await client.patchDaemonConfig({ pluginsEnabled: true });
    const installed = await client.installDirectoryPlugin(payload);
    assert.equal(installed.id, "codium");
    assert.equal(installed.status, "running");
    const catalog = await client.getPluginCatalog();
    assert.ok(
      catalog.some((plugin) => plugin.id === "codium" && plugin.clientBundle),
      "Real Codium client bundle must be served by the packaged daemon",
    );
    const settings = await client.invokePluginRpc("codium", "settings.connection.read", {});
    assert.equal(settings.status, "ready");
    const saved = await client.invokePluginRpc("codium", "settings.connection.write", {
      revision: settings.revision,
      values: { codiumBaseUrl: "https://codium-smoke.invalid", openMode: "embedded" },
    });
    assert.equal(saved.status, "saved");
    await page.reload();
    const explorer = page.getByTestId("workspace-explorer-sidebar").filter({ visible: true });
    if (!(await explorer.count()))
      await page.getByTestId("workspace-explorer-toggle").first().click();
    await explorer.getByTestId("workspace-tab-files").click({ position: { x: 12, y: 13 } });
    await page
      .getByTestId("file-explorer-tree-scroll")
      .getByText("README.md", { exact: true })
      .click();
    const choice = page.getByRole("radio", { name: "VSCodium — codium", exact: true });
    await choice.waitFor({ state: "visible" });
    await choice.click();
    const frame = page.locator('iframe[title="VSCodium"]');
    if (fixture.mode === "fork") {
      assert.equal(
        await frame.count(),
        0,
        "Selecting Codium must not mount it before confirmation",
      );
      assert.equal(
        await page.getByTestId("workspace-tab-file_README.md").count(),
        0,
        "Unconfirmed fork opens must not construct a file tab",
      );
    }
    await page.getByRole("button", { name: "Use", exact: true }).click();
    await frame.waitFor({ state: "visible" });
    assert.equal(
      await frame.count(),
      1,
      "One confirmed file intent must mount one workspace editor",
    );
    const fileTabs = await page.getByTestId("workspace-tab-file_README.md").count();
    if (fixture.mode === "fork")
      assert.equal(fileTabs, 0, "Fork must dispatch directly without an intermediate file tab");
    else assert.ok(fileTabs > 0, "Stock client must use the existing file-panel fallback");
    const connectionControl = page.getByTestId("codium-connection-status");
    const directControl = page.getByRole("button", { name: "Open directly", exact: true });
    const settingsControl = page.getByTestId("codium-settings");
    await connectionControl.waitFor({ state: "visible" });
    await directControl.waitFor({ state: "visible" });
    await settingsControl.waitFor({ state: "visible" });
    assert.equal(await page.getByText("Sign in in browser", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Open in browser", { exact: true }).count(), 0);
    await directControl.hover();
    await directControl
      .locator("..")
      .getByText("Open directly", { exact: true })
      .waitFor({ state: "visible" });
    await settingsControl.focus();
    await settingsControl
      .locator("..")
      .getByText("Settings", { exact: true })
      .waitFor({ state: "visible" });
    await frame.hover();
    const [directPage] = await Promise.all([
      page.context().waitForEvent("page"),
      directControl.click(),
    ]);
    try {
      await directPage.waitForURL((url) => url.hostname === "codium-smoke.invalid");
      const directUrl = new URL(directPage.url());
      const frameUrl = new URL(await frame.getAttribute("src"));
      assert.equal(directUrl.searchParams.get("folder"), frameUrl.searchParams.get("folder"));
      assert.equal(
        directUrl.searchParams.has("payload"),
        false,
        "Direct opening must not reuse iframe pairing credentials",
      );
    } finally {
      await directPage.close();
    }
    const evidence = {
      inputOrigin: "prepared-plugin-directory",
      plugin: fixture.identity,
      packageSha256: fixture.packageSha256,
      runtimeVersion: status.version,
      mode: fixture.mode,
      rendererKind: "browser",
      rendererOrigin: new URL(page.url()).origin,
      pluginRunning: true,
      editorFrames: 1,
      intermediateFileTab: fileTabs > 0,
      iconToolbar: true,
      accessProbe: simulatedAccessProbes > 0 ? "simulated" : "not-requested",
      simulatedAccessProbes,
      authenticatedEditingVerified: false,
      companionPairingVerified: false,
    };
    const artifactDir = process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR;
    if (artifactDir) {
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(
        path.join(artifactDir, "codium-plugin.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
      await page.screenshot({ path: path.join(artifactDir, "codium-toolbar.png") });
    }
    console.log(
      `Packaged Codium plugin smoke passed: ${fixture.identity.id}${fixture.identity.version ? `@${fixture.identity.version}` : ""}; ${status.version}; ${fixture.mode}`,
    );
  } finally {
    await client.close();
    await page.context().unroute(fixtureUrl, inertEditor);
  }
}

async function assertSandboxState({ browser, page, expectedSandbox, stdout, stderr }) {
  const diagnostics = await page.evaluate(() =>
    window.paseoDesktop.invoke("desktop_sandbox_diagnostics"),
  );
  if (diagnostics.enabled !== expectedSandbox) {
    throw new Error(
      `Unexpected sandbox decision: ${JSON.stringify(diagnostics)}; expected enabled=${expectedSandbox}`,
    );
  }
  if (!stdout.join("").includes("[desktop] app startup")) {
    throw new Error("Missing production app startup log");
  }
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  await session.detach();
  const renderers = processInfo.filter((info) => info.type === "renderer");
  if (renderers.length === 0) throw new Error("No renderer process found");
  for (const renderer of renderers) {
    const status = fs.readFileSync(`/proc/${renderer.id}/status`, "utf8");
    const security = status
      .split("\n")
      .filter((line) => /^(NoNewPrivs|Seccomp|Uid|Gid):/.test(line))
      .join("; ");
    const report = `Sandbox evidence: enabled=${expectedSandbox}; ${diagnostics.reason}; renderer ${renderer.id}: ${security}`;
    console.log(report);
    stdout.push(`${report}\n`);
    if (
      expectedSandbox &&
      (!/^NoNewPrivs:\s+1$/m.test(status) || !/^Seccomp:\s+2$/m.test(status))
    ) {
      throw new Error(`Renderer lacks OS sandbox: ${report}\n${stderr.join("")}`);
    }
  }
}

function assertLinuxDesktopIdentity(appPath) {
  if (process.platform === "linux") {
    assert.deepEqual(
      fs.readFileSync(path.join(appPath, "resources", "icon.png")),
      fs.readFileSync(path.join(__dirname, "..", "assets", "icon.png")),
      "Packaged Linux windows must have the Paseo icon at their runtime lookup path",
    );
    const metadata = JSON.parse(
      extractFile(path.join(appPath, "resources", "app.asar"), "package.json").toString(),
    );
    if (metadata.desktopName !== `${EXECUTABLE_NAME}.desktop`) {
      throw new Error(
        `Packaged Linux desktop identity ${JSON.stringify(metadata.desktopName)} does not match ${EXECUTABLE_NAME}.desktop`,
      );
    }
  }
}

function resolveForkComposerCheckpoint(value) {
  return value === true || process.env.PASEO_DESKTOP_SMOKE_EXPECT_FORK_COMPOSER_CHECKPOINT === "1";
}

function preparePackagedComposerConfig({ daemonHome, forkComposerCheckpoint, codiumFixture }) {
  const webUi = Boolean(codiumFixture) || forkComposerCheckpoint;
  if (!forkComposerCheckpoint) {
    return { composerProjectCwd: null, webUi };
  }
  const composerProjectPath = path.join(daemonHome, "composer-smoke-project");
  fs.mkdirSync(composerProjectPath);
  fs.writeFileSync(path.join(composerProjectPath, "README.md"), "Packaged composer smoke\n");
  const composerProjectCwd = fs.realpathSync(composerProjectPath);
  return {
    composerProjectCwd,
    webUi,
    providers: {
      hoplite: {
        enabled: true,
        command: [process.execPath, HOPLITE_SMOKE_FIXTURE],
        env: {
          HOPLITE_TEST_RECORD: path.join(daemonHome, "hoplite-fixture.log"),
          HOPLITE_TEST_CWD: composerProjectCwd,
        },
      },
    },
  };
}

async function runForkComposerCheckpointSmoke({
  appPath,
  env,
  listen,
  composerProjectCwd,
  stderr,
  state,
}) {
  const webBrowser = await ensurePackagedBrowser(state);
  const composerWorkspaceId = await createComposerSmokeWorkspace({
    appPath,
    env,
    projectPath: composerProjectCwd,
  });
  const composerClient = await connectPackagedSmokeClient(
    listen,
    `packaged-composer-checkpoint-${process.pid}`,
  );
  try {
    await waitForCondition({
      label: "hoplite provider ready",
      timeoutMs: SMOKE_TIMEOUT_MS,
      condition: async () => {
        const snapshot = await composerClient.getProvidersSnapshot({
          cwd: composerProjectCwd,
        });
        return snapshot.entries.find((entry) => entry.provider === "hoplite")?.status === "ready";
      },
    });
    const composerModels = await composerClient.listProviderModels("hoplite", {
      cwd: composerProjectCwd,
    });
    if (composerModels.error) {
      throw new Error(`Composer fixture provider catalog failed: ${composerModels.error}`);
    }
    if (
      !Array.isArray(composerModels.models) ||
      !composerModels.models.some((model) => model.id === "fixture-model")
    ) {
      throw new Error(
        `Composer fixture provider is missing fixture-model: ` +
          JSON.stringify(composerModels.models),
      );
    }
    const composerAgentId = await createComposerSmokeAgent({
      client: composerClient,
      workspaceId: composerWorkspaceId,
      cwd: composerProjectCwd,
    });
    const composerPage = await webBrowser.newPage();
    state.composerPage = composerPage;
    state.artifactPage = state.artifactPage ?? composerPage;
    composerPage.on("pageerror", (error) =>
      stderr.push(`Composer browser renderer: ${error.stack ?? error}\n`),
    );
    await openPackagedBrowserWorkspace({
      page: composerPage,
      listen,
      workspaceId: composerWorkspaceId,
      workspaceTitle: COMPOSER_SMOKE_WORKSPACE_TITLE,
      agentId: composerAgentId,
    });
    await smokeComposerRepeatAcceptance({
      page: composerPage,
      client: composerClient,
      listen,
      workspaceId: composerWorkspaceId,
      workspaceTitle: COMPOSER_SMOKE_WORKSPACE_TITLE,
      agentId: composerAgentId,
    });
  } finally {
    await composerClient.close().catch(() => undefined);
  }
}

async function ensurePackagedBrowser(state) {
  if (!state.webBrowser) {
    state.webBrowser = await chromium.launch({ headless: true });
  }
  return state.webBrowser;
}

async function smokePackagedDesktopApp({
  appPath,
  executablePath = getExecutablePath(appPath),
  launchArgs = [],
  expectedSandbox,
  expectForkComposerCheckpoint,
}) {
  const forkComposerCheckpoint = resolveForkComposerCheckpoint(expectForkComposerCheckpoint);
  console.log(
    `Packaged desktop smoke: fork composer checkpoint regression ${
      forkComposerCheckpoint ? "enabled" : "disabled"
    }`,
  );
  assertLinuxRuntimePermissions(appPath);
  assertExecutable(executablePath, "Packaged app executable");
  assertLinuxDesktopIdentity(appPath);
  const codiumFixture = await readCodiumSmokeFixture();
  await smokeColdCliDaemonStart({ appPath });

  const userData = createTempDir("paseo-smoke-user-data-");
  const daemonHome = createTempDir("paseo-smoke-daemon-home-");
  const { daemonPort, cdpPort } = await reserveDistinctPackagedPorts();
  const listen = `127.0.0.1:${daemonPort}`;
  const { composerProjectCwd, providers, webUi } = preparePackagedComposerConfig({
    daemonHome,
    forkComposerCheckpoint,
    codiumFixture,
  });
  // No distDir override: the daemon must resolve its packaged resources/app-dist.
  configureIsolatedDaemonHome(daemonHome, listen, { webUi, providers });
  const env = createIsolatedDesktopEnv({
    home: daemonHome,
    listen,
    userData,
    cdpPort,
  });

  const stdout = [];
  const stderr = [];
  const launch = getLaunchCommand(executablePath, launchArgs);
  console.log(`Packaged desktop smoke: launching ${launch.command} ${launch.args.join(" ")}`);
  const child = spawn(launch.command, launch.args, {
    detached: process.platform !== "win32",
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  child.once("error", (error) =>
    stderr.push(`Packaged app launch error: ${error.stack ?? error}\n`),
  );
  const deadline = Date.now() + SMOKE_TIMEOUT_MS;

  let browser = null;
  let page = null;
  const browserSmoke = {
    webBrowser: null,
    webPage: null,
    composerPage: null,
    artifactPage: null,
  };
  let daemonStopped = false;

  const stopDaemonForCleanup = async () => {
    if (daemonStopped) {
      return;
    }

    await stopCliDaemon({ appPath, env });
    daemonStopped = true;
  };

  try {
    browser = await connectToPackagedApp({
      child,
      cdpPort,
      stdout,
      stderr,
      userData,
      daemonHome,
      deadline,
    });
    page = await waitForPackagedAppPage(browser, deadline);
    await assertPackagedRendererLoaded(page, deadline);
    console.log("Packaged desktop smoke: real app renderer and preload bridge loaded");
    const status = await waitForRendererStartedDaemon({
      page,
      daemonHome,
      listen,
      stdout,
      stderr,
      userData,
      deadline,
    });
    console.log("Packaged desktop smoke: renderer-started desktop daemon reported running");
    await assertBuiltinPluginsStarted(listen);
    console.log("Packaged desktop smoke: every built-in plugin started");
    await smokeCliShim({ appPath, env });
    await smokeCliTerminal({ appPath, env });
    if (expectedSandbox !== undefined) {
      await assertSandboxState({ browser, page, expectedSandbox, stdout, stderr });
    }
    let workspaceId;
    if (expectedSandbox !== undefined || codiumFixture) {
      workspaceId = await openSmokeWorkspace({
        appPath,
        env,
        page,
        daemonHome,
        focusComposer: !codiumFixture,
      });
    }
    if (codiumFixture) {
      const webBrowser = await ensurePackagedBrowser(browserSmoke);
      browserSmoke.webPage = await webBrowser.newPage();
      browserSmoke.artifactPage = browserSmoke.webPage;
      browserSmoke.webPage.on("pageerror", (error) =>
        stderr.push(`Browser renderer: ${error.stack ?? error}\n`),
      );
      await openPackagedBrowserWorkspace({ page: browserSmoke.webPage, listen, workspaceId });
      await smokeCodiumPlugin({
        fixture: codiumFixture,
        page: browserSmoke.webPage,
        listen,
        daemonHome,
      });
    }
    if (forkComposerCheckpoint) {
      await runForkComposerCheckpointSmoke({
        appPath,
        env,
        listen,
        composerProjectCwd,
        stderr,
        state: browserSmoke,
      });
      console.log("Packaged desktop smoke: fork composer checkpoint regression passed");
    } else {
      console.log("Packaged desktop smoke: fork composer checkpoint regression skipped");
    }
    await writeSmokeArtifacts({
      page: browserSmoke.artifactPage ?? page,
      stdout,
      stderr,
      userData,
      daemonHome,
    });
    await stopDaemonForCleanup();
    console.log(
      `Packaged desktop smoke passed: real renderer and preload loaded; renderer-started desktop daemon pid ${status.pid}, listen ${status.listen}; CLI shim daemon status and terminal smoke succeeded`,
    );
  } catch (error) {
    await writeSmokeArtifacts({
      page: browserSmoke.artifactPage ?? page,
      stdout,
      stderr,
      userData,
      daemonHome,
      error,
    }).catch((artifactError) => {
      console.warn(`Packaged desktop smoke: failed to write failure artifacts: ${artifactError}`);
    });
    if (!daemonStopped) {
      try {
        await stopDaemonForCleanup();
      } catch {}
    }
    throw error;
  } finally {
    await browserSmoke.webBrowser?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (isRunning(child)) {
      terminateChild(child);
      if (!(await waitForChildExit(child))) {
        terminateChild(child, "SIGKILL");
        await waitForChildExit(child);
      }
    }
    releaseChildHandles(child);
    await removeTempDir(userData);
    await removeTempDir(daemonHome);
  }
}

module.exports = {
  assertLinuxRuntimePermissions,
  codiumSmokeResponse,
  readCodiumSmokeFixture,
  smokePackagedDesktopApp,
};

if (require.main === module) {
  const appIndex = process.argv.indexOf("--app");
  const appPath = appIndex >= 0 ? process.argv[appIndex + 1] : null;
  if (!appPath) {
    process.stderr.write(
      "Usage: node smoke-packaged-desktop-app.js --app <Paseo.app> " +
        "[--expect-fork-composer-checkpoint]\n",
    );
    process.exit(2);
  }

  smokePackagedDesktopApp({
    appPath,
    expectForkComposerCheckpoint: process.argv.includes("--expect-fork-composer-checkpoint"),
  }).catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}

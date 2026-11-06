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

function configureIsolatedDaemonHome(home, listen, { webUi = false } = {}) {
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

async function openPackagedBrowserWorkspace({ page, listen, workspaceId }) {
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
  await page.getByRole("button", { name: "Sandbox smoke workspace", exact: true }).click();
  await page.waitForURL((url) => url.pathname.endsWith(`/workspace/${workspaceId}`));
  console.log(`Packaged browser smoke: served UI opened workspace ${workspaceId}`);
}

async function readCodiumSmokeFixture() {
  const artifact = process.env.PASEO_DESKTOP_SMOKE_CODIUM_ARTIFACT;
  const deb = process.env.PASEO_DESKTOP_SMOKE_CODIUM_DEB;
  const mode = process.env.PASEO_DESKTOP_SMOKE_CODIUM_MODE;
  if (!artifact && !deb && !mode) return null;
  assert.ok(
    artifact && deb && (mode === "stock" || mode === "fork"),
    "Codium smoke needs ARTIFACT, DEB and MODE=stock|fork",
  );
  const lockBytes = fs.readFileSync(path.join(artifact, "lock.json"));
  const lock = JSON.parse(lockBytes);
  const release = JSON.parse(fs.readFileSync(path.join(artifact, "release.json"), "utf8"));
  assert.equal(lock.schemaVersion, 4);
  assert.equal(lock.id, "codium");
  assert.match(release.artifactId, /^[0-9a-f]{64}$/);
  assert.equal(release.manifestSha256, createHash("sha256").update(lockBytes).digest("hex"));
  const packageHash = createHash("sha256");
  for await (const chunk of fs.createReadStream(deb)) packageHash.update(chunk);
  const packageSha256 = packageHash.digest("hex");
  const hosts = lock.validatedHosts.filter((host) => host.artifactSha256 === packageSha256);
  assert.equal(hosts.length, 1, "Tested package must be an exact validated host of this artifact");
  const host = hosts[0];
  assert.equal(host.distribution === "upstream", mode === "stock");
  // Full artifact validation belongs to the shared immutable-artifact validator.
  // This observer binds its result to that artifact and the actual tested .deb.
  return { artifact, artifactId: release.artifactId, packageSha256, host, mode };
}

async function smokeCodiumArtifact({ fixture, page, listen, daemonHome }) {
  const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");
  const client = new DaemonClient({
    url: `ws://${listen}/ws`,
    clientId: "packaged-codium-smoke",
    webSocketFactory: (url, options) =>
      new WebSocket(url, options?.protocols, { headers: options?.headers }),
  });
  const payload = path.join(daemonHome, "codium-artifact");
  fs.cpSync(path.join(fixture.artifact, "payload"), payload, { recursive: true });
  // The real plugin creates its editor frame; this inert response deliberately
  // does not emulate Codium, pairing or authenticated editor operation.
  const fixtureUrl = "https://codium-smoke.invalid/**";
  const inertEditor = (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Isolated editor frame</title>",
    });
  await page.context().route(fixtureUrl, inertEditor);
  try {
    await client.connect();
    const status = await client.getDaemonStatus();
    assert.equal(
      status.version,
      fixture.host.version,
      "Packaged daemon must match the reviewed host version",
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
    const evidence = {
      artifactId: fixture.artifactId,
      packageSha256: fixture.packageSha256,
      host: fixture.host,
      daemonVersion: status.version,
      mode: fixture.mode,
      rendererKind: "browser",
      origin: new URL(page.url()).origin,
      pluginRunning: true,
      editorFrames: 1,
      intermediateFileTab: fileTabs > 0,
    };
    const artifactDir = process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR;
    if (artifactDir) {
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(
        path.join(artifactDir, "codium-artifact.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
    }
    console.log(
      `Packaged Codium artifact smoke passed: ${fixture.artifactId}; ${fixture.host.version}; ${fixture.mode}`,
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

async function smokePackagedDesktopApp({
  appPath,
  executablePath = getExecutablePath(appPath),
  launchArgs = [],
  expectedSandbox,
}) {
  assertLinuxRuntimePermissions(appPath);
  assertExecutable(executablePath, "Packaged app executable");
  assertLinuxDesktopIdentity(appPath);
  const codiumFixture = await readCodiumSmokeFixture();
  await smokeColdCliDaemonStart({ appPath });

  const userData = createTempDir("paseo-smoke-user-data-");
  const daemonHome = createTempDir("paseo-smoke-daemon-home-");
  const daemonPort = await reserveLocalTcpPort();
  let cdpPort = await reserveLocalTcpPort();
  for (let attempt = 0; cdpPort === daemonPort && attempt < 10; attempt += 1) {
    cdpPort = await reserveLocalTcpPort();
  }
  if (cdpPort === daemonPort) {
    throw new Error("Failed to reserve distinct TCP ports for the daemon and CDP");
  }
  const listen = `127.0.0.1:${daemonPort}`;
  // No distDir override: the daemon must resolve its packaged resources/app-dist.
  configureIsolatedDaemonHome(daemonHome, listen, { webUi: Boolean(codiumFixture) });
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
  let webBrowser = null;
  let webPage = null;
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
      webBrowser = await chromium.launch({ headless: true });
      webPage = await webBrowser.newPage();
      webPage.on("pageerror", (error) =>
        stderr.push(`Browser renderer: ${error.stack ?? error}\n`),
      );
      await openPackagedBrowserWorkspace({ page: webPage, listen, workspaceId });
      await smokeCodiumArtifact({ fixture: codiumFixture, page: webPage, listen, daemonHome });
    }
    await writeSmokeArtifacts({ page: webPage ?? page, stdout, stderr, userData, daemonHome });
    await stopDaemonForCleanup();
    console.log(
      `Packaged desktop smoke passed: real renderer and preload loaded; renderer-started desktop daemon pid ${status.pid}, listen ${status.listen}; CLI shim daemon status and terminal smoke succeeded`,
    );
  } catch (error) {
    await writeSmokeArtifacts({
      page: webPage ?? page,
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
    await webBrowser?.close().catch(() => undefined);
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
  smokePackagedDesktopApp,
};

if (require.main === module) {
  const appIndex = process.argv.indexOf("--app");
  const appPath = appIndex >= 0 ? process.argv[appIndex + 1] : null;
  if (!appPath) {
    process.stderr.write("Usage: node smoke-packaged-desktop-app.js --app <Paseo.app>\n");
    process.exit(2);
  }

  smokePackagedDesktopApp({ appPath }).catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}

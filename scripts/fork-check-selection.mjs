import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, resolve, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function fail(message) {
  throw new Error(message);
}

function runCommand(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) fail(result.stderr || `${executable} failed`);
  return result.stdout.trim();
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parse() {
  const [action, ...rest] = process.argv.slice(2);
  if (!action || !["select", "run"].includes(action)) fail("Expected select or run");
  const options = { action, allLinux: false, base: "", result: "", custom: [] };
  while (rest.length) {
    const value = rest.shift();
    if (value === "--") {
      options.custom = rest.splice(0);
      break;
    }
    if (value === "--all-linux") options.allLinux = true;
    else if (value === "--base" || value === "--result") {
      const next = rest.shift();
      if (!next) fail(`Missing value for ${value}`);
      options[value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = next;
    } else fail(`Unknown option: ${value}`);
  }
  if (options.allLinux && options.base) fail("--all-linux does not accept --base");
  if (!options.allLinux && !options.base && options.custom.length === 0)
    fail("Relevant checks require --base FULL_BASE_COMMIT");
  if (action === "run" && !options.result) fail("run requires --result FILE");
  if (options.custom.length && (options.allLinux || options.base))
    fail("Custom commands cannot be combined with selection options");
  return options;
}

function sourceSnapshot() {
  const inventoryPath = ".fork-source-files.json";
  const files = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const digest = createHash("sha256");
  for (const relative of files.sort()) {
    const stat = lstatSync(relative);
    digest
      .update(relative)
      .update("\0")
      .update(String(stat.mode & 0o777))
      .update("\0");
    if (stat.isSymbolicLink()) digest.update("link\0").update(readlinkSync(relative));
    else if (stat.isFile()) digest.update("file\0").update(readFileSync(relative));
    else fail(`Source inventory contains an unsupported path: ${relative}`);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function changedFiles(base) {
  const files = new Set();
  let resolved = "HEAD";
  if (base) {
    resolved = runCommand("git", ["rev-parse", "--verify", `${base}^{commit}`]);
    const source = runCommand("git", ["rev-parse", "HEAD^{commit}"]);
    if (spawnSync("git", ["merge-base", "--is-ancestor", resolved, source]).status !== 0)
      fail("--base must name an ancestor of the staged source commit");
  }
  for (const file of runCommand("git", ["diff", "--name-only", "-z", resolved]).split("\0"))
    if (file) files.add(file);
  for (const file of runCommand("git", ["ls-files", "--others", "--exclude-standard", "-z"]).split(
    "\0",
  ))
    if (file) files.add(file);
  return [...files]
    .filter((file) => file !== ".fork-dependencies" && file !== ".fork-source-files.json")
    .sort();
}

const core = [
  ["build-app-dependencies", ["npm", "run", "build:app-deps"]],
  ["build-server", ["npm", "run", "build:server"]],
  ["typecheck-server", ["npm", "run", "typecheck:server"]],
  ["typecheck-app", ["npm", "run", "typecheck", "--workspace=@getpaseo/app"]],
  ["typecheck-desktop", ["npm", "run", "typecheck", "--workspace=@getpaseo/desktop"]],
  ["lint", ["npm", "run", "lint"]],
];

// oxlint-disable-next-line complexity -- the local selector mirrors each CI routing contract in one auditable table.
export function selectChecks(options, changed) {
  const docsOnly = changed.length > 0 && changed.every((file) => file.endsWith(".md"));
  const toolingPaths = new Set([
    ".github/workflows/ci.yml",
    ".github/ci-paths.yml",
    "scripts/ci-workflow.test.mjs",
    "scripts/fork-check-selection.mjs",
    "scripts/fork-build.sh",
    "scripts/fork-build.mjs",
  ]);
  const ciOnly =
    changed.some((file) => toolingPaths.has(file)) &&
    changed.every((file) => toolingPaths.has(file) || file.endsWith(".md"));
  const filters = {};
  let filter;
  for (const line of readFileSync(".github/ci-paths.yml", "utf8").split("\n")) {
    const key = /^([a-z_]+):\s*$/.exec(line);
    if (key) {
      filter = key[1];
      filters[filter] = [];
    }
    const pattern = /^  - "([^"]+)"\s*$/.exec(line);
    if (pattern && filter) filters[filter].push(pattern[1]);
  }
  const affected = (name) =>
    changed.some((file) => (filters[name] ?? []).some((pattern) => matchesGlob(file, pattern)));
  const full = options.allLinux || (!ciOnly && (affected("workspace") || affected("routing")));
  const has = (name) => full || affected(name);
  const checks = [];
  const add = (id, argv, tools = []) => {
    if (!checks.some((check) => check[0] === id)) checks.push([id, argv, tools]);
  };
  const workspace = (id, command, name, tools) =>
    add(id, ["npm", "run", command, `--workspace=@getpaseo/${name}`], tools);
  const skipped = [
    { id: "windows", reason: "Local Linux evidence does not establish Windows coverage." },
    { id: "macos", reason: "Local Linux evidence does not establish macOS coverage." },
    { id: "physical-devices", reason: "Physical-device acceptance remains a separate request." },
    {
      id: "live-providers-relay",
      reason:
        "Authenticated provider and live relay checks require a separate explicit run; production credentials are never mounted.",
    },
  ];
  if (options.custom.length) return { checks: [["custom", options.custom]], skipped: [] };
  if (!full && !changed.length) return { checks, skipped };
  if (full || ciOnly || affected("ci")) {
    add("workflow-contracts", [
      "node",
      "--test",
      "scripts/ci-workflow.test.mjs",
      "scripts/daemon-launch-contract.test.mjs",
      "scripts/sync-fdroid-changelogs.test.mjs",
      "scripts/upload-release-assets.test.mjs",
    ]);
  }
  if (full || docsOnly || ciOnly || affected("format"))
    add("format", ["npm", "run", "format:check"]);
  if (!full && (docsOnly || ciOnly)) return { checks, skipped };
  const product =
    full ||
    changed.some((file) => file.startsWith("packages/") && !file.startsWith("packages/website/")) ||
    affected("workspace");
  if (product) for (const check of core) add(...check);
  if (has("sdk")) {
    workspace("build-plugin", "build", "plugin");
    workspace("typecheck-plugin", "typecheck", "plugin");
    workspace("typecheck-highlight", "typecheck", "highlight");
    for (const name of ["plugin", "protocol", "client", "highlight"])
      workspace(`${name}-tests`, "test", name);
    workspace("typecheck-client-examples", "typecheck:examples", "client");
  }
  if (has("relay")) workspace("relay-tests", "test", "relay");
  if (has("server") || has("hub")) {
    workspace("server-tests", "test", "server", ["claude", "opencode"]);
    workspace("builtin-plugin-tests", "test", "builtin-plugins");
  }
  const needsChromium = has("app") || has("browser") || has("desktop") || has("website");
  const needsWebkit = has("website");
  if (needsChromium || needsWebkit)
    add("install-browser-binaries", [
      "npx",
      "--no-install",
      "playwright",
      "install",
      ...(needsChromium ? ["chromium"] : []),
      ...(needsWebkit ? ["webkit"] : []),
    ]);
  if (has("app")) workspace("app-tests", "test", "app");
  if (has("desktop")) {
    workspace("desktop-tests", "test", "desktop");
    add(
      "desktop-lifecycle",
      [
        "xvfb-run",
        "-a",
        "--server-args=-screen 0 1280x800x24",
        "npm",
        "run",
        "test:e2e:lifecycle",
        "--workspace=@getpaseo/desktop",
      ],
      ["xvfb-run"],
    );
    workspace("desktop-renderer", "test:e2e:renderer", "desktop");
    workspace("desktop-browser-tabs", "test:e2e:browser-tabs", "desktop");
  }
  if (has("browser")) workspace("app-browser", "test:e2e", "app", ["claude", "codex", "opencode"]);
  if (has("cli")) {
    workspace("cli-unit", "test:unit", "cli");
    workspace("cli-local", "test:local", "cli", ["claude", "codex", "opencode"]);
  }
  if (has("website")) {
    workspace("typecheck-website", "typecheck", "website");
    add("website-unit", [
      "npx",
      "--no-install",
      "vitest",
      "run",
      "packages/website/src",
      "--bail=1",
    ]);
    workspace("website-browser", "test:e2e", "website");
  }
  if (full) {
    add("dependency-patch-contract", ["node", "--test", "scripts/postinstall-patches.test.mjs"]);
    add("builtin-plugin-dist-contract", [
      "node",
      "--test",
      "scripts/builtin-plugins-dist.test.mjs",
    ]);
    add("lint-rule-tests", ["node", "--test", "scripts/oxlint/paseo-plugin.test.mjs"]);
    for (const name of ["protocol", "client", "server"])
      add(`package-${name}`, [
        "npm",
        "pack",
        "--dry-run",
        "--ignore-scripts",
        `--workspace=@getpaseo/${name}`,
      ]);
    skipped.push({
      id: "registry-audit",
      reason:
        "Registry signature and lockfile-lint checks need live registry access/tool resolution; run the hosted manual quality job or explicit custom commands when required.",
    });
  }
  return { checks, skipped };
}

function select(options) {
  const sourceCommit = runCommand("git", ["rev-parse", "HEAD^{commit}"]);
  const changed = options.custom.length ? [] : changedFiles(options.base);
  const { checks, skipped } = selectChecks(options, changed);
  const selected = checks.map(([id, argv, tools = []]) => ({ id, argv, tools }));
  const definition = sha(JSON.stringify({ selected, skipped }));
  const inputs = {
    sourceCommit,
    sourceSnapshot: sourceSnapshot(),
    dependencyInstallIdentity: runCommand("node", ["scripts/fork-build.mjs", "dependency-key"]),
    checkImage: process.env.PASEO_BUILD_IMAGE,
    checkDefinition: definition,
    resources: {
      cpus: process.env.PASEO_CHECK_CPUS,
      memoryMiB: process.env.PASEO_CHECK_MEMORY_MIB,
      workers: process.env.PASEO_CHECK_WORKERS,
      nodeOptions: process.env.NODE_OPTIONS,
    },
  };
  let mode = "relevant";
  if (options.allLinux) mode = "all-linux";
  else if (options.custom.length) mode = "custom";
  return {
    schemaVersion: 2,
    action: "check",
    mode,
    base: options.base || null,
    changedFiles: changed,
    inputs,
    requiresInstall: selected.some(({ id }) => id !== "workflow-contracts"),
    selected,
    skipped,
  };
}

export function execute(plan, resultPath) {
  const started = new Date().toISOString();
  const results = [];
  let status = "passed";
  for (const check of plan.selected) {
    const unavailable = check.tools.filter(
      (tool) => !process.env.PATH.split(":").some((directory) => existsSync(join(directory, tool))),
    );
    if (unavailable.length) {
      status = "incomplete";
      results.push({
        id: check.id,
        argv: check.argv,
        result: "unavailable",
        requiredTools: unavailable,
      });
      continue;
    }
    const begun = performance.now();
    const run = spawnSync(check.argv[0], check.argv.slice(1), {
      stdio: "inherit",
      env: {
        ...process.env,
        E2E_WORKERS: process.env.PASEO_CHECK_WORKERS,
        VITEST_MAX_WORKERS: process.env.PASEO_CHECK_WORKERS,
      },
    });
    const code = run.status ?? 1;
    results.push({
      id: check.id,
      argv: check.argv,
      result: code === 0 ? "passed" : "failed",
      durationMilliseconds: Math.round(performance.now() - begun),
    });
    if (code !== 0) {
      status = "failed";
      break;
    }
  }
  const record = {
    schemaVersion: 2,
    action: "check",
    result: status,
    startedAt: started,
    completedAt: new Date().toISOString(),
    inputs: plan.inputs,
    selected: results,
    skipped: plan.skipped,
  };
  writeFileSync(resultPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  if (status === "passed") return 0;
  return status === "incomplete" ? 2 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parse();
  const plan = select(options);
  if (options.action === "select") console.log(JSON.stringify(plan, null, 2));
  else process.exitCode = execute(plan, options.result);
}

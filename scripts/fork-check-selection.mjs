import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  if (base) {
    const resolved = runCommand("git", ["rev-parse", "--verify", `${base}^{commit}`]);
    const source = runCommand("git", ["rev-parse", "HEAD^{commit}"]);
    if (
      resolved === source ||
      spawnSync("git", ["merge-base", "--is-ancestor", resolved, source]).status !== 0
    )
      fail("--base must name an earlier ancestor of the staged source commit");
    for (const file of runCommand("git", ["diff", "--name-only", resolved]).split("\n"))
      if (file) files.add(file);
  }
  for (const file of runCommand("git", ["ls-files", "--others", "--exclude-standard"]).split("\n"))
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

function select(options) {
  const sourceCommit = runCommand("git", ["rev-parse", "HEAD^{commit}"]);
  const changed = options.custom.length ? [] : changedFiles(options.base);
  const docsOnly =
    changed.length > 0 &&
    changed.every(
      (file) => file === "README.md" || file.startsWith("docs/") || file.endsWith(".md"),
    );
  const ciOnly =
    changed.length > 0 &&
    changed.every(
      (file) =>
        file === ".github/workflows/ci.yml" ||
        file === ".github/ci-paths.yml" ||
        file === "scripts/ci-workflow.test.mjs" ||
        file === "scripts/fork-check-selection.mjs" ||
        file === "scripts/fork-build.sh" ||
        file === "scripts/fork-build.mjs",
    );
  const websiteOnly =
    changed.length > 0 &&
    changed.every(
      (file) =>
        file.startsWith("packages/website/") || file === "packages/website" || file.endsWith(".md"),
    );
  let checks;
  let skipped = [
    { id: "windows", reason: "Local Linux evidence does not establish Windows coverage." },
    { id: "macos", reason: "Local Linux evidence does not establish macOS coverage." },
    { id: "physical-devices", reason: "Physical-device acceptance remains a separate request." },
  ];
  if (options.custom.length) {
    checks = [["custom", options.custom]];
    skipped = [];
  } else if (options.allLinux) {
    checks = [
      ["workflow-contracts", ["node", "--test", "scripts/ci-workflow.test.mjs"]],
      ...core,
      ["typecheck-website", ["npm", "run", "typecheck", "--workspace=@getpaseo/website"]],
      ["build-website", ["npm", "run", "build", "--workspace=@getpaseo/website"]],
      ["format", ["npm", "run", "format:check"]],
      // The aggregate server suite includes provider-contract tests that run a
      // real Claude CLI. Keep the normal builder lean and make that optional
      // host prerequisite explicit in evidence rather than failing as though a
      // product assertion had failed.
      ["server-tests", ["npm", "run", "test", "--workspace=@getpaseo/server"], ["claude"]],
      ["app-tests", ["npm", "run", "test", "--workspace=@getpaseo/app"]],
      ["desktop-tests", ["npm", "run", "test", "--workspace=@getpaseo/desktop"]],
    ];
    skipped.push({
      id: "playwright-shards",
      reason:
        "The eight hosted browser shards are intentionally not reproduced locally; use explicit focused browser acceptance.",
    });
  } else if (docsOnly) {
    checks = [["format", ["npm", "run", "format:check"]]];
  } else if (ciOnly) {
    checks = [["workflow-contracts", ["node", "--test", "scripts/ci-workflow.test.mjs"]]];
  } else if (websiteOnly) {
    checks = [
      ["typecheck-website", ["npm", "run", "typecheck", "--workspace=@getpaseo/website"]],
      ["build-website", ["npm", "run", "build", "--workspace=@getpaseo/website"]],
    ];
  } else checks = core;

  const selected = checks.map(([id, argv, tools = []]) => ({ id, argv, tools }));
  const definition = sha(JSON.stringify({ selected, skipped }));
  const inputs = {
    sourceCommit,
    sourceSnapshot: sourceSnapshot(),
    dependencyInstallIdentity: runCommand("node", ["scripts/fork-build.mjs", "dependency-key"]),
    builderImage: process.env.PASEO_BUILD_IMAGE,
    checkDefinition: definition,
  };
  let mode = "relevant";
  if (options.allLinux) mode = "all-linux";
  else if (options.custom.length) mode = "custom";
  return {
    schemaVersion: 1,
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

function execute(plan, resultPath) {
  const started = new Date().toISOString();
  const results = [];
  let status = "passed";
  for (const check of plan.selected) {
    const unavailable = check.tools.filter(
      (tool) => !process.env.PATH.split(":").some((directory) => existsSync(join(directory, tool))),
    );
    if (unavailable.length) {
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
    schemaVersion: 1,
    action: "check",
    result: status,
    startedAt: started,
    completedAt: new Date().toISOString(),
    inputs: plan.inputs,
    selected: results,
    skipped: plan.skipped,
  };
  writeFileSync(resultPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  if (status !== "passed") process.exit(1);
}

const options = parse();
const plan = select(options);
if (options.action === "select") console.log(JSON.stringify(plan, null, 2));
else execute(plan, options.result);

import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, matchesGlob } from "node:path";
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
    if (relative === ".fork-dependencies") continue;
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
  // Reused staging can contain route declarations from the previous release.
  // Expo refreshes these locally without starting a development server.
  [
    "generate-app-route-types",
    ["npm", "exec", "--workspace=@getpaseo/app", "--", "expo", "customize", "tsconfig.json"],
  ],
  ["typecheck-app", ["npm", "run", "typecheck", "--workspace=@getpaseo/app"]],
  ["typecheck-desktop", ["npm", "run", "typecheck", "--workspace=@getpaseo/desktop"]],
  ["lint", ["npm", "run", "lint"]],
];
const coreChecks = new Map(core.map(([id, argv, tools = []]) => [id, { id, argv, tools }]));

const workflowToolingPaths = new Set([
  ".github/ci-paths.yml",
  ".github/workflows/ci.yml",
  "scripts/ci-workflow.test.mjs",
  "scripts/fork-check-selection.mjs",
  "scripts/fork-build.sh",
  "scripts/fork-build.mjs",
]);
const publicationPolicyPaths = new Set([
  ".dockerignore",
  ".gitleaks.toml",
  "lefthook.yml",
  "scripts/check-publication.py",
  "scripts/check-publication.sh",
  "scripts/install-publication-hook.sh",
  "scripts/publication-exceptions.json",
  "scripts/publication-pruned-files.json",
  "scripts/publication-scanner.json",
]);
const workflowInput = (file) =>
  workflowToolingPaths.has(file) || file.startsWith(".github/workflows/");
const publicationPolicyInput = (file) => publicationPolicyPaths.has(file);
const appUnitTest = (file) =>
  /^packages\/app\/(?:src|modules)\/.*\.(?:test|spec)\.(?:ts|tsx)$/.test(file) &&
  !file.includes(".browser.");
const appBrowserSpec = (file) => /^packages\/app\/e2e\/browser\/.*\.spec\.ts$/.test(file);
// The plugin SDK skill is routed as an SDK input by ci-paths.yml, so its
// Markdown examples must not collapse the plan to documentation-only.
const pluginSkillInput = (file) => file.startsWith("skills/paseo-plugin/");
const docsChange = (file) => file.endsWith(".md") && !pluginSkillInput(file);
const focusedSpecialBrowserChecks = new Map([
  [
    "e2e/browser/diff-performance.spec.ts",
    [
      "app-browser-diff-performance",
      ["npm", "run", "test:e2e:diff-performance", "--workspace=@getpaseo/app"],
    ],
  ],
  [
    "e2e/browser/agent-stream-smoothness.spec.ts",
    [
      "app-browser-stream-smoothness",
      ["npm", "run", "test:e2e:stream-smoothness", "--workspace=@getpaseo/app"],
    ],
  ],
  [
    "e2e/browser/relay-deployment-reconnect.real.spec.ts",
    [
      "app-browser-relay-deployment",
      ["npm", "run", "test:e2e:relay-deployment", "--workspace=@getpaseo/app"],
    ],
  ],
]);

// oxlint-disable-next-line complexity -- the local selector mirrors each CI routing contract in one auditable table.
export function selectChecks(options, changed) {
  const docsOnly = changed.length > 0 && changed.every(docsChange);
  const workflowChanged = changed.some(workflowInput);
  const policyChanged = changed.some(publicationPolicyInput);
  const ciOnly =
    workflowChanged && changed.every((file) => workflowInput(file) || docsChange(file));
  const policyOnly =
    (workflowChanged || policyChanged) &&
    changed.every(
      (file) => workflowInput(file) || publicationPolicyInput(file) || docsChange(file),
    );
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
  const affected = (name, files = changed) =>
    files.some((file) => (filters[name] ?? []).some((pattern) => matchesGlob(file, pattern)));
  // A policy or workflow edit must not fall through to every product suite merely
  // because scripts/** is a workspace input. Only non-policy, non-workflow paths
  // can broaden the plan.
  const routedChanges = changed.filter(
    (file) => !workflowInput(file) && !publicationPolicyInput(file),
  );
  const full =
    options.allLinux ||
    (!ciOnly &&
      !policyOnly &&
      (affected("workspace", routedChanges) || affected("routing", routedChanges)));
  const has = (name) => full || affected(name);
  const checks = [];
  const add = (id, argv, tools = []) => {
    if (!checks.some((check) => check[0] === id)) checks.push([id, argv, tools]);
  };
  const addCore = (id) => {
    const check = coreChecks.get(id);
    add(check.id, check.argv, check.tools);
  };
  const workspace = (id, command, name, tools) =>
    add(id, ["npm", "run", command, `--workspace=@getpaseo/${name}`], tools);
  const appRelative = (file) => file.replace(/^packages\/app\//, "");
  const addOptInBrowserChecks = (specs) => {
    for (const [spec, [id, argv]] of focusedSpecialBrowserChecks) {
      if (specs.includes(spec)) add(id, argv);
    }
    const realSpecs = specs.filter(
      (spec) => spec.endsWith(".real.spec.ts") && !focusedSpecialBrowserChecks.has(spec),
    );
    if (realSpecs.length) {
      add("app-browser-real", [
        "npm",
        "run",
        "test:e2e:real",
        "--workspace=@getpaseo/app",
        "--",
        ...realSpecs,
      ]);
    }
  };
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
  if (full || workflowChanged || policyChanged || affected("ci")) {
    add("workflow-contracts", [
      "node",
      "--test",
      "scripts/ci-workflow.test.mjs",
      "scripts/daemon-launch-contract.test.mjs",
      "scripts/changelog-utils.test.mjs",
      "scripts/release-version-utils.test.mjs",
      "scripts/publish-release-packages.test.mjs",
      "scripts/push-current-release-tag.test.mjs",
      "scripts/reconcile-release.test.mjs",
      "scripts/sync-fdroid-changelogs.test.mjs",
      "scripts/sync-release-notes-from-changelog.test.mjs",
      "scripts/upload-release-assets.test.mjs",
    ]);
  }
  if (full || policyChanged) {
    add("publication-policy", [
      "npx",
      "--no-install",
      "vitest",
      "run",
      "packages/desktop/src/daemon/desktop-packaging.test.ts",
      "-t",
      "bounds scanner resources|inspects nested package content|accepts an exported candidate",
    ]);
  }
  if (full || docsOnly || ciOnly || affected("format"))
    add("format", ["npm", "run", "format:check"]);
  if (!full && (docsOnly || ciOnly || policyOnly)) return { checks, skipped };

  // A changed test file selects its own project and real prerequisites. Any
  // shared helper, configuration, product source or lockfile change broadens
  // back to the package suites.
  const unitTests = changed.filter(appUnitTest).map(appRelative);
  const browserSpecs = changed.filter(appBrowserSpec).map(appRelative);
  const broadeningChanges = changed.filter(
    (file) =>
      !appUnitTest(file) &&
      !appBrowserSpec(file) &&
      !workflowInput(file) &&
      !publicationPolicyInput(file) &&
      !docsChange(file),
  );
  if (!full && (unitTests.length || browserSpecs.length) && broadeningChanges.length === 0) {
    addCore("build-app-dependencies");
    if (unitTests.length) {
      add("app-unit-tests", [
        "npm",
        "run",
        "test",
        "--workspace=@getpaseo/app",
        "--",
        "--project",
        "unit",
        ...unitTests,
        "--bail=1",
      ]);
    }
    if (browserSpecs.length) {
      addCore("build-server");
      const browser = process.env.E2E_BROWSER === "firefox" ? "firefox" : "chromium";
      add("install-browser-binaries", ["npx", "--no-install", "playwright", "install", browser]);
      addOptInBrowserChecks(browserSpecs);
      const ordinarySpecs = browserSpecs.filter(
        (spec) => !focusedSpecialBrowserChecks.has(spec) && !spec.endsWith(".real.spec.ts"),
      );
      if (ordinarySpecs.length) {
        add("app-browser-focused", [
          "npm",
          "run",
          "test:e2e",
          "--workspace=@getpaseo/app",
          "--",
          ...ordinarySpecs,
        ]);
      }
    }
    return { checks, skipped };
  }

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
  const needsFirefox = process.env.E2E_BROWSER === "firefox" && has("browser");
  if (needsChromium || needsWebkit || needsFirefox)
    add("install-browser-binaries", [
      "npx",
      "--no-install",
      "playwright",
      "install",
      ...(needsChromium ? ["chromium"] : []),
      ...(needsFirefox ? ["firefox"] : []),
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
  addOptInBrowserChecks(changed.filter(appBrowserSpec).map(appRelative));
  if (has("cli")) {
    workspace("cli-unit", "test:unit", "cli");
    workspace("cli-local", "test:local", "cli", ["claude", "codex", "opencode"]);
    add("cli-dev-watch", [
      "node",
      "--import",
      "tsx",
      "packages/cli/tests/23-daemon-sigint-supervisor.test.ts",
      "--dev-watch",
    ]);
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

const preparationOutputs = {
  "build-app-dependencies": [
    "packages/expo-two-way-audio/build",
    "packages/client/dist",
    "packages/highlight/dist",
    "packages/plugin/dist",
    "packages/protocol/dist",
    "packages/relay/dist",
  ],
  "build-plugin": ["packages/plugin/dist"],
  "build-server": [
    "packages/cli/dist",
    "packages/client/dist",
    "packages/highlight/dist",
    "packages/plugin/dist",
    "packages/protocol/dist",
    "packages/relay/dist",
    "packages/server/dist",
  ],
  "generate-app-route-types": ["packages/app/.expo/types", "packages/app/expo-env.d.ts"],
  "install-browser-binaries": ["/cache/playwright"],
};
const preparationRequirements = {
  "app-tests": ["build-app-dependencies", "install-browser-binaries"],
  "app-unit-tests": ["build-app-dependencies"],
  "app-browser": ["build-app-dependencies", "build-server", "install-browser-binaries"],
  "app-browser-focused": ["build-app-dependencies", "build-server", "install-browser-binaries"],
  "app-browser-real": ["build-app-dependencies", "build-server", "install-browser-binaries"],
  "app-browser-diff-performance": [
    "build-app-dependencies",
    "build-server",
    "install-browser-binaries",
  ],
  "app-browser-stream-smoothness": [
    "build-app-dependencies",
    "build-server",
    "install-browser-binaries",
  ],
  "app-browser-relay-deployment": [
    "build-app-dependencies",
    "build-server",
    "install-browser-binaries",
  ],
  "builtin-plugin-dist-contract": ["build-app-dependencies"],
  "builtin-plugin-tests": ["build-app-dependencies"],
  "cli-local": ["build-server"],
  "cli-unit": ["build-server"],
  "cli-dev-watch": ["build-server"],
  "desktop-lifecycle": ["build-app-dependencies", "build-server"],
  "desktop-renderer": ["build-app-dependencies", "build-server"],
  "desktop-browser-tabs": ["build-app-dependencies", "build-server"],
  "desktop-tests": ["build-app-dependencies", "build-server"],
  "package-client": ["build-app-dependencies"],
  "package-protocol": ["build-app-dependencies"],
  "package-server": ["build-server"],
  "server-tests": ["build-server"],
  "typecheck-app": ["build-app-dependencies", "generate-app-route-types"],
  "typecheck-desktop": ["build-server"],
  "typecheck-server": ["build-server"],
  "website-browser": ["install-browser-binaries"],
};
const preparationChecks = new Set([
  "build-app-dependencies",
  "build-plugin",
  "build-server",
  "generate-app-route-types",
  "install-browser-binaries",
]);

// Unknown checks are not cacheable. These read source and tooling only; every
// other reusable consumer must declare its generated prerequisites.
const sourceOnlyChecks = new Set([
  "dependency-patch-contract",
  "format",
  "lint",
  "lint-rule-tests",
  "typecheck-highlight",
  "workflow-contracts",
]);
// A chained/custom runner has no single owning machine report. Keep it visible
// but never present its exit status as cache-verified evidence.
const aggregateEvidenceChecks = new Map([
  ["cli-local", "custom sharded CLI runner has no single machine report; inspect the command log"],
  [
    "desktop-browser-tabs",
    "custom browser-tabs runner has no machine report; inspect the command log",
  ],
  ["desktop-lifecycle", "custom lifecycle runner has no machine report; inspect the command log"],
  [
    "desktop-tests",
    "install-electron plus Vitest chain has no single owning report; inspect the command log",
  ],
  [
    "server-tests",
    "chained unit/integration commands have no single owning report; inspect the command log",
  ],
]);
const reportFormats = new Map([
  ["app-browser", "playwright"],
  ["app-browser-diff-performance", "playwright"],
  ["app-browser-focused", "playwright"],
  ["app-browser-real", "playwright"],
  ["app-browser-relay-deployment", "playwright"],
  ["app-browser-stream-smoothness", "playwright"],
  ["app-tests", "vitest"],
  ["app-unit-tests", "vitest"],
  ["builtin-plugin-tests", "vitest"],
  ["cli-unit", "vitest"],
  ["client-tests", "vitest"],
  ["desktop-renderer", "playwright"],
  ["highlight-tests", "vitest"],
  ["plugin-tests", "vitest"],
  ["protocol-tests", "vitest"],
  ["publication-policy", "vitest"],
  ["relay-tests", "vitest"],
  ["website-browser", "playwright"],
  ["website-unit", "vitest"],
]);

function withTestReport(check, format, reportDirectory) {
  const path = join(reportDirectory, `${check.id}.json`);
  const reportArgs =
    format === "vitest" ? ["--reporter=json", "--outputFile", path] : ["--reporter=json"];
  const separator = check.argv.indexOf("--");
  let argv;
  if (separator !== -1) argv = [...check.argv, ...reportArgs];
  else if (check.argv[0] === "npm" && check.argv[1] === "run")
    argv = [...check.argv, "--", ...reportArgs];
  else argv = [...check.argv, ...reportArgs];
  if (format === "vitest") return { ...check, argv, report: { format, path } };
  return {
    ...check,
    argv,
    env: { PLAYWRIGHT_JSON_OUTPUT_NAME: path },
    report: { format, path },
  };
}

export function selectionMetadata(
  checks,
  reportDirectory = process.env.PASEO_CHECK_REPORT_DIR ?? "/out/check-reports",
) {
  return checks.map(([id, argv, tools = []]) => {
    let check = { id, argv, tools };
    if (preparationChecks.has(id)) check.preparation = true;
    if (preparationRequirements[id]) check.requires = preparationRequirements[id];
    if (preparationOutputs[id]) check.outputs = preparationOutputs[id];
    if (sourceOnlyChecks.has(id)) check.sourceOnly = true;
    if (aggregateEvidenceChecks.has(id)) check.uncachedReason = aggregateEvidenceChecks.get(id);
    const format = reportFormats.get(id);
    if (format) check = withTestReport(check, format, reportDirectory);
    return check;
  });
}

export function readDependencyInstallIdentity(inputKey, markerPath = ".fork-dependencies") {
  if (!existsSync(markerPath)) return null;
  const [recordedKey, generation] = readFileSync(markerPath, "utf8").trim().split("\n");
  if (recordedKey !== inputKey || !generation) return null;
  return sha(JSON.stringify({ inputKey, generation }));
}

function select(options) {
  const sourceCommit = runCommand("git", ["rev-parse", "HEAD^{commit}"]);
  const changed = options.custom.length ? [] : changedFiles(options.base);
  const { checks, skipped } = selectChecks(options, changed);
  const reportDirectory = process.env.PASEO_CHECK_REPORT_DIR ?? "/out/check-reports";
  const selected = selectionMetadata(checks, reportDirectory);
  const definition = sha(JSON.stringify({ selected, skipped }));
  const dependencyInputKey = runCommand("node", ["scripts/fork-build.mjs", "dependency-key"]);
  const inputs = {
    sourceCommit,
    sourceSnapshot: sourceSnapshot(),
    dependencyInputKey,
    dependencyInstallIdentity: readDependencyInstallIdentity(dependencyInputKey),
    checkImage: process.env.PASEO_BUILD_IMAGE,
    checkDefinition: definition,
    environment: {
      ci: process.env.CI ?? "",
      e2eBrowser: process.env.E2E_BROWSER ?? "chromium",
      lang: process.env.LANG ?? "",
      lcAll: process.env.LC_ALL ?? "",
      timezone: process.env.TZ ?? "",
    },
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
    schemaVersion: 3,
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

function atomicWriteJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

// A preparation block declares the files it must leave behind. Consumers may
// reuse a receipt only when these outputs are present and unchanged.
function outputInventory(paths) {
  const entries = [];
  function addPath(relative) {
    const stat = lstatSync(relative);
    const identity = `${relative}\0${stat.mode & 0o777}`;
    if (stat.isSymbolicLink()) {
      entries.push(`${identity}\0link:${readlinkSync(relative)}`);
      return;
    }
    if (stat.isFile()) {
      entries.push(`${identity}\0file:${sha(readFileSync(relative))}`);
      return;
    }
    if (!stat.isDirectory()) throw new Error(`Unsupported preparation output: ${relative}`);
    entries.push(`${identity}\0dir`);
    for (const entry of readdirSync(relative, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    ))
      addPath(join(relative, entry.name));
  }
  for (const relative of [...paths].sort()) {
    if (!existsSync(relative)) return null;
    addPath(relative);
  }
  return { digest: sha(entries.join("\n")), files: entries.length };
}

function blockKey(plan, check, environment, prerequisiteOutputs) {
  const {
    sourceSnapshot: snapshot,
    dependencyInstallIdentity,
    checkImage,
    resources,
  } = plan.inputs ?? {};
  return sha(
    JSON.stringify({
      schemaVersion: 4,
      sourceSnapshot: snapshot,
      dependencyInstallIdentity,
      checkImage,
      resources,
      check: {
        id: check.id,
        argv: check.argv,
        tools: check.tools,
        env: check.env,
        sourceOnly: check.sourceOnly === true,
        requires: check.requires ?? [],
        reportFormat: check.report?.format ?? null,
      },
      environment,
      prerequisiteOutputs,
    }),
  );
}

function validateTestReport(report, freshAfter = null) {
  if (!report?.path) return { ok: false, reason: "test report path is missing" };
  if (!existsSync(report.path))
    return { ok: false, reason: `test report is missing: ${report.path}` };
  try {
    const stat = statSync(report.path);
    if (freshAfter !== null && stat.mtimeMs + 1000 < freshAfter)
      return { ok: false, reason: `test report is stale: ${report.path}` };
  } catch {
    return { ok: false, reason: `test report is unreadable: ${report.path}` };
  }
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(report.path, "utf8"));
  } catch {
    return { ok: false, reason: `test report is unreadable: ${report.path}` };
  }
  if (report.format === "vitest") {
    if ((evidence.numPassedTests ?? 0) < 1)
      return { ok: false, reason: "no test case ran and passed" };
    if ((evidence.numFailedTests ?? 0) > 0)
      return { ok: false, reason: "the report contains failed test cases" };
    return { ok: true };
  }
  if (report.format === "playwright") {
    const stats = evidence.stats ?? {};
    if ((stats.expected ?? 0) < 1) return { ok: false, reason: "no test case ran and passed" };
    if ((stats.unexpected ?? 0) > 0)
      return { ok: false, reason: "the report contains unexpected test outcomes" };
    return { ok: true };
  }
  return { ok: false, reason: `unknown test report format: ${report.format}` };
}

function preservedReport(receipt, check) {
  if (!check.report) return null;
  const preserved = receipt.report;
  if (
    !preserved ||
    preserved.format !== check.report.format ||
    !preserved.path ||
    !preserved.sha256 ||
    !existsSync(preserved.path)
  )
    return null;
  if (sha(readFileSync(preserved.path)) !== preserved.sha256) return null;
  if (!validateTestReport({ format: check.report.format, path: preserved.path }).ok) return null;
  return preserved;
}

function readBlockReceipt(directory, key, check) {
  const file = join(directory, `${key}.json`);
  if (!existsSync(file)) return null;
  try {
    const receipt = JSON.parse(readFileSync(file, "utf8"));
    if (
      receipt.schemaVersion !== 4 ||
      receipt.result !== "passed" ||
      receipt.blockKey !== key ||
      receipt.check?.id !== check.id ||
      JSON.stringify(receipt.check.argv) !== JSON.stringify(check.argv) ||
      JSON.stringify(receipt.check.tools ?? []) !== JSON.stringify(check.tools ?? []) ||
      JSON.stringify(receipt.check.env ?? {}) !== JSON.stringify(check.env ?? {})
    )
      return null;
    if (check.report && !preservedReport(receipt, check)) return null;
    return receipt;
  } catch {
    return null;
  }
}

function executableOnPath(tool) {
  return process.env.PATH.split(":").some((directory) => {
    const candidate = join(directory, tool);
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function preserveReport(directory, key, bytes) {
  try {
    mkdirSync(directory, { recursive: true });
    const preservedPath = join(directory, `${key}.${sha(bytes)}.${randomUUID()}.report.json`);
    writeFileSync(preservedPath, bytes, { mode: 0o600, flag: "wx" });
    return preservedPath;
  } catch {
    return null;
  }
}

function acceptReport(check, key, cacheable, blockCache, freshAfter) {
  const validation = validateTestReport(check.report, freshAfter);
  if (!validation.ok) return { ok: false, reason: validation.reason };
  const bytes = readFileSync(check.report.path);
  const report = { format: check.report.format, path: check.report.path, sha256: sha(bytes) };
  if (!cacheable || !blockCache) return { ok: true, report };
  const preserved = preserveReport(blockCache, key, bytes);
  if (!preserved) return { ok: false, reason: "accepted test report could not be preserved" };
  report.preserved = preserved;
  return { ok: true, report };
}

// oxlint-disable-next-line complexity -- this is the single bounded executor for serial, persisted check stages.
export function execute(plan, resultPath, options = {}) {
  const started = new Date().toISOString();
  const environment = plan.inputs?.environment ?? {};
  const blockCache = options.blockCache ?? process.env.PASEO_CHECK_BLOCK_CACHE ?? "";
  const states = plan.selected.map((check) => ({
    id: check.id,
    argv: check.argv,
    tools: check.tools ?? [],
    ...(check.preparation ? { preparation: true } : {}),
    ...(check.requires ? { requires: check.requires } : {}),
    ...(check.outputs ? { outputs: check.outputs } : {}),
    ...(check.sourceOnly ? { sourceOnly: true } : {}),
    ...(check.uncachedReason ? { uncachedReason: check.uncachedReason } : {}),
    result: "not-run",
  }));
  const record = {
    schemaVersion: 4,
    action: "check",
    result: "incomplete",
    startedAt: started,
    completedAt: null,
    inputs: plan.inputs ?? {},
    selected: states,
    skipped: plan.skipped ?? [],
  };
  atomicWriteJson(resultPath, record);
  const byId = new Map(
    states.map((state, index) => [state.id, { state, check: plan.selected[index] }]),
  );
  let failed = false;
  let incomplete = false;
  if (!plan.selected.length) {
    record.completedAt = new Date().toISOString();
    atomicWriteJson(resultPath, record);
    return 2;
  }

  // Prerequisite execution and prerequisite output verification are separate.
  // A passed prerequisite lets its consumer run. Only freshly read, declared
  // outputs make the consumer eligible for cache reuse.
  function prerequisiteOutputs(requires) {
    const outputs = {};
    let cacheable = true;
    for (const id of requires) {
      const entry = byId.get(id);
      if (!entry || entry.state.result !== "passed") return { ok: false };
      if (entry.check.outputs?.length) {
        let inventory;
        try {
          inventory = outputInventory(entry.check.outputs);
        } catch {
          inventory = null;
        }
        if (!inventory) cacheable = false;
        else outputs[id] = inventory.digest;
      } else {
        cacheable = false;
      }
    }
    return { ok: true, cacheable, outputs };
  }

  for (const [index, check] of plan.selected.entries()) {
    const state = states[index];
    const unavailable = (check.tools ?? []).filter((tool) => !executableOnPath(tool));
    if (unavailable.length) {
      state.result = "unavailable";
      state.requiredTools = unavailable;
      incomplete = true;
      atomicWriteJson(resultPath, record);
      continue;
    }
    let prerequisites = { ok: true, cacheable: true, outputs: {} };
    if (check.requires?.length) {
      prerequisites = prerequisiteOutputs(check.requires);
      if (!prerequisites.ok) {
        state.result = "blocked";
        state.reason = "prerequisite preparation did not pass";
        incomplete = true;
        atomicWriteJson(resultPath, record);
        continue;
      }
    }
    const dependencyReady = plan.inputs?.dependencyInstallIdentity != null;
    const metadataCacheable = check.sourceOnly
      ? !check.requires?.length || prerequisites.cacheable
      : check.requires?.length > 0 && prerequisites.cacheable && dependencyReady;
    const cacheable =
      plan.mode !== "custom" && !check.preparation && !check.uncachedReason && metadataCacheable;
    if (check.uncachedReason) state.evidenceLimit = check.uncachedReason;
    const key = blockKey(plan, check, environment, prerequisites.outputs);
    if (cacheable && blockCache) {
      const cached = readBlockReceipt(blockCache, key, check);
      if (cached) {
        state.result = "passed";
        state.reusedFrom = join(blockCache, `${key}.json`);
        state.reusedAt = cached.completedAt;
        state.durationMilliseconds = 0;
        if (cached.report) state.report = cached.report;
        atomicWriteJson(resultPath, record);
        continue;
      }
    }
    state.result = "running";
    state.blockKey = key;
    atomicWriteJson(resultPath, record);
    if (check.report) {
      mkdirSync(dirname(check.report.path), { recursive: true });
      rmSync(check.report.path, { force: true });
    }
    const reportFreshAfter = check.report ? Date.now() : null;
    const begun = performance.now();
    const run = spawnSync(check.argv[0], check.argv.slice(1), {
      stdio: "inherit",
      env: {
        ...process.env,
        ...check.env,
        E2E_WORKERS: process.env.PASEO_CHECK_WORKERS,
        VITEST_MAX_WORKERS: process.env.PASEO_CHECK_WORKERS,
      },
    });
    const durationMilliseconds = Math.round(performance.now() - begun);
    state.durationMilliseconds = durationMilliseconds;
    let result;
    if (run.error) {
      result = "failed";
      state.error = run.error.message;
    } else if (run.signal) {
      result = "interrupted";
      state.signal = run.signal;
    } else {
      result = run.status === 0 ? "passed" : "failed";
    }
    if (result === "passed" && check.outputs?.length) {
      let inventory;
      try {
        inventory = outputInventory(check.outputs);
      } catch {
        inventory = null;
      }
      if (inventory) {
        state.outputInventory = { digest: inventory.digest, files: inventory.files };
        state.outputsVerified = true;
      } else {
        state.outputsVerified = false;
        incomplete = true;
      }
    }
    if (result === "passed" && check.report) {
      const accepted = acceptReport(check, key, cacheable, blockCache, reportFreshAfter);
      if (!accepted.ok) {
        result = "incomplete";
        state.reason = accepted.reason;
      } else {
        state.report = accepted.report;
      }
    }
    state.result = result;
    if (result === "passed") {
      if (cacheable && blockCache) {
        const preserved = state.report?.preserved
          ? {
              format: state.report.format,
              path: state.report.preserved,
              sha256: state.report.sha256,
            }
          : null;
        atomicWriteJson(join(blockCache, `${key}.json`), {
          schemaVersion: 4,
          blockKey: key,
          result: "passed",
          check: {
            id: check.id,
            argv: check.argv,
            tools: check.tools ?? [],
            env: check.env ?? {},
          },
          sourceCommit: plan.inputs?.sourceCommit ?? null,
          environment,
          prerequisiteOutputs: prerequisites.outputs,
          outputInventory: state.outputInventory ?? null,
          report: preserved,
          startedAt: new Date(Date.now() - durationMilliseconds).toISOString(),
          completedAt: new Date().toISOString(),
          durationMilliseconds,
        });
      }
    } else {
      if (result === "failed") failed = true;
      else incomplete = true;
      if (blockCache) {
        rmSync(join(blockCache, `${key}.json`), { force: true });
      }
    }
    atomicWriteJson(resultPath, record);
  }
  if (failed) record.result = "failed";
  else if (incomplete) record.result = "incomplete";
  else record.result = "passed";
  record.completedAt = new Date().toISOString();
  atomicWriteJson(resultPath, record);
  if (record.result === "passed") return 0;
  return record.result === "failed" ? 1 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parse();
  const plan = select(options);
  if (options.action === "select") console.log(JSON.stringify(plan, null, 2));
  else process.exitCode = execute(plan, options.result);
}

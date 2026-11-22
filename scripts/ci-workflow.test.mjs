import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative as relativePath } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  selectChecks,
  execute,
  selectionMetadata,
  readDependencyInstallIdentity,
} from "./fork-check-selection.mjs";
import { runInNewContext } from "node:vm";

const repoRoot = new URL("../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);
const dockerWorkflowPath = new URL(".github/workflows/docker.yml", repoRoot);
const nixWorkflowPath = new URL(".github/workflows/nix.yml", repoRoot);
const filtersPath = new URL(".github/ci-paths.yml", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);

const gatedCiJobs = new Map([
  ["quality", { name: "quality", contracts: ["format", "quality", "relay", "sdk"] }],
  ["typecheck", { name: "typecheck", contract: "typecheck" }],
  ["website-tests", { name: "website-tests", contract: "website" }],
  ["server-tests-ubuntu", { name: "server-tests (ubuntu-latest)", contracts: ["server", "hub"] }],
  ["server-tests-windows", { name: "server-tests (windows-latest)", contracts: ["server", "hub"] }],
  [
    "server-integration-windows",
    { name: "server-integration (windows-latest)", contract: "server" },
  ],
  [
    "server-tests-macos",
    { name: "server-tests (macos-latest, file observation)", contract: "server" },
  ],
  ["desktop-tests-ubuntu", { name: "desktop-tests (ubuntu-latest)", contract: "desktop" }],
  ["desktop-tests-windows", { name: "desktop-tests (windows-latest)", contract: "desktop" }],
  ["app-tests", { name: "app-tests", contract: "app" }],
  ["playwright-1", { name: "playwright (shard 1/8)", contract: "browser" }],
  ["playwright-2", { name: "playwright (shard 2/8)", contract: "browser" }],
  ["playwright-3", { name: "playwright (shard 3/8)", contract: "browser" }],
  ["playwright-4", { name: "playwright (shard 4/8)", contract: "browser" }],
  ["playwright-5", { name: "playwright (shard 5/8)", contract: "browser" }],
  ["playwright-6", { name: "playwright (shard 6/8)", contract: "browser" }],
  ["playwright-7", { name: "playwright (shard 7/8)", contract: "browser" }],
  ["playwright-8", { name: "playwright (shard 8/8)", contract: "browser" }],
  ["cli-tests-1", { name: "cli-tests (shard 1/3)", contract: "cli" }],
  ["cli-tests-2", { name: "cli-tests (shard 2/3)", contract: "cli" }],
  ["cli-tests-3", { name: "cli-tests (shard 3/3)", contract: "cli" }],
]);

function jobBlocks(source) {
  const jobs = new Map();
  let currentJob;

  for (const line of (source.split("\njobs:\n")[1] ?? source).split("\n")) {
    const jobMatch = /^  ([a-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs.set(currentJob, []);
      continue;
    }
    if (currentJob) jobs.get(currentJob).push(line);
  }
  return jobs;
}

function loadFilters(path) {
  const filters = {};
  let currentFilter;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const filterMatch = /^([a-z_]+):\s*$/.exec(line);
    if (filterMatch) {
      currentFilter = filterMatch[1];
      filters[currentFilter] = [];
      continue;
    }
    const patternMatch = /^  - "([^"]+)"\s*$/.exec(line);
    if (currentFilter && patternMatch) filters[currentFilter].push(patternMatch[1]);
  }
  return filters;
}

function filesUnder(relativeDirectory, predicate) {
  const directory = new URL(`${relativeDirectory}/`, repoRoot);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      [relativeDirectory, relativePath(directory.pathname, entry.parentPath), entry.name]
        .filter(Boolean)
        .join("/")
        .replaceAll("\\", "/"),
    )
    .filter(predicate)
    .sort();
}

test("publication checks run independently of changed-file routing without credentials", () => {
  const workflow = readFileSync(ciWorkflowPath, "utf8");
  const publication = jobBlocks(workflow).get("publication")?.join("\n");
  assert.ok(publication);
  assert.doesNotMatch(publication, /^    (?:if|needs):/m);
  assert.match(publication, /contents: read/);
  assert.match(publication, /fetch-depth: 0/);
  assert.match(publication, /persist-credentials: false/);
  assert.match(publication, /check-publication\.sh snapshot/);
  assert.match(publication, /check-publication\.sh history --all/);
  assert.doesNotMatch(publication, /secrets\.|npm (?:ci|install)/);
});

test("publication policy inputs stay wired to the real inspector", () => {
  const python = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      [
        "import importlib.util, json",
        'spec = importlib.util.spec_from_file_location("publication", "scripts/check-publication.py")',
        "publication = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(publication)",
        "print(json.dumps(publication.INSPECTION_FILES))",
      ].join("\n"),
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(python.status, 0, python.stderr);
  const inspectionFiles = JSON.parse(python.stdout);
  const driver = readFileSync(new URL("scripts/fork-build.mjs", repoRoot), "utf8");
  const driverBlock = /const inspectionPaths = \[([\s\S]*?)\]\.sort\(\);/.exec(driver)[1];
  const driverPaths = [...driverBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(driverPaths, [...inspectionFiles].sort());

  const gitleaks = readFileSync(new URL(".gitleaks.toml", repoRoot), "utf8");
  assert.match(gitleaks, /^minVersion = "v8\.30\.1"$/m);
  assert.match(gitleaks, /^useDefault = true$/m);

  const scanner = JSON.parse(
    readFileSync(new URL("scripts/publication-scanner.json", repoRoot), "utf8"),
  );
  assert.match(scanner.image, /^ghcr\.io\/gitleaks\/gitleaks@sha256:[a-f0-9]{64}$/);

  const dockerignore = readFileSync(new URL(".dockerignore", repoRoot), "utf8").split("\n");
  for (const pattern of [
    ".env*",
    "**/.env*",
    "**/.ssh",
    "**/.aws/credentials",
    "**/.docker/config.json",
    "**/.claude/.credentials.json",
  ])
    assert.ok(dockerignore.includes(pattern), pattern);

  const hook = readFileSync(new URL("lefthook.yml", repoRoot), "utf8");
  assert.match(hook, /scripts\/check-publication\.sh staged/);
  assert.match(hook, /format:check:files/);
  const installer = readFileSync(new URL("scripts/install-publication-hook.sh", repoRoot), "utf8");
  assert.match(installer, /exec bash scripts\/check-publication\.sh staged/);
});

test("inherited workflows cannot publish or deploy from the workstation fork", () => {
  for (const path of filesUnder(".github/workflows", (candidate) => candidate.endsWith(".yml"))) {
    if (path.endsWith("/ci.yml")) continue;
    for (const [jobId, lines] of jobBlocks(readFileSync(new URL(path, repoRoot), "utf8"))) {
      assert.match(
        lines.join("\n"),
        /^    if: \$\{\{ github\.repository == 'getpaseo\/paseo'(?: \}\}| && \()/m,
        `${path}: ${jobId} must be restricted to the upstream repository`,
      );
    }
  }
});

test("gated checks are statically named jobs with real job-level gating", () => {
  const workflowSource = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(workflowSource);
  const trigger = workflowSource.split("jobs:", 1)[0];

  assert.match(trigger, /^  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(trigger, /^  (?:push|pull_request|merge_group):/m);
  assert.doesNotMatch(workflowSource, /strategy:\s*\n\s+matrix:/);
  assert.doesNotMatch(workflowSource, /RUN_TESTS|Skip unaffected|No .* changes detected/);

  for (const [jobId, expected] of gatedCiJobs) {
    const job = jobs.get(jobId)?.join("\n");
    assert.ok(job, `missing static job ${jobId}`);
    assert.match(job, new RegExp(`^    name: ${expected.name.replace(/[()]/g, "\\$&")}$`, "m"));
    assert.match(job, /needs\.changes\.result == 'success'/);
    assert.match(job, /needs\.changes\.outputs\.full != 'false'/);
    for (const contract of expected.contracts ?? [expected.contract]) {
      assert.match(job, new RegExp(`needs\\.changes\\.outputs\\.${contract} != 'false'`));
    }
  }
});

test("the workstation CI definition is manual-only while inherited packaging keeps its own contract", () => {
  const ci = readFileSync(ciWorkflowPath, "utf8").split("jobs:", 1)[0];
  assert.match(ci, /^  workflow_dispatch:/m);
  assert.doesNotMatch(ci, /^  (?:push|pull_request|merge_group):/m);

  const trigger = readFileSync(
    new URL(".github/workflows/desktop-packages.yml", repoRoot),
    "utf8",
  ).split("jobs:", 1)[0];
  const pullRequest = trigger.match(/^  pull_request:\n((?:    .*\n)*)/m);
  assert.ok(pullRequest);
  assert.doesNotMatch(pullRequest[1], /branches/);
});

test("manual scopes are isolated without retaining automatic trigger semantics", () => {
  const ci = readFileSync(ciWorkflowPath, "utf8");
  assert.match(
    ci,
    /^concurrency:\n  group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}-\$\{\{ inputs\.scope \}\}\n  cancel-in-progress: true$/m,
  );
  for (const workflowPath of [ciWorkflowPath, dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    assert.doesNotMatch(
      source,
      /\$\{\{\s*always\(\)/,
      "always() keeps jobs alive after concurrency cancellation; use !cancelled() for fail-open gating",
    );
  }
});

test("published npm packages declare and ship the repository license", () => {
  const rootManifest = JSON.parse(readFileSync(new URL("package.json", repoRoot), "utf8"));
  const workspaceArgs = rootManifest.scripts["release:publish"].match(/--workspace=\S+/g);
  assert.notEqual(workspaceArgs, null, "release:publish must select public packages");
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json", ...workspaceArgs], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
  );
  const manifests = new Map(
    rootManifest.workspaces.map((workspace) => {
      const directory = new URL(`${workspace}/`, repoRoot);
      const manifest = JSON.parse(readFileSync(new URL("package.json", directory), "utf8"));
      return [manifest.name, { directory, manifest }];
    }),
  );
  const licenses = packed.map(({ name, files }) => ({
    name,
    license: manifests.get(name).manifest.license,
    files: files.filter((file) => file.path === "LICENSE").map((file) => file.path),
  }));
  assert.deepEqual(
    licenses,
    workspaceArgs.map((workspace) => ({
      name: workspace.slice("--workspace=".length),
      license: "Apache-2.0",
      files: ["LICENSE"],
    })),
  );
  const repositoryLicense = readFileSync(new URL("LICENSE", repoRoot), "utf8");
  for (const { name } of packed) {
    const { directory } = manifests.get(name);
    assert.equal(readFileSync(new URL("LICENSE", directory), "utf8"), repositoryLicense, name);
  }
});

test("focused contracts stay inside existing required checks", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const changes = jobs.get("changes")?.join("\n") ?? "";
  const server = jobs.get("server-tests-ubuntu")?.join("\n") ?? "";
  const desktop = jobs.get("desktop-tests-ubuntu")?.join("\n") ?? "";

  assert.match(changes, /scripts\/daemon-launch-contract\.test\.mjs/);
  assert.doesNotMatch(changes, /Install dependencies|npm run build/);

  assert.match(server, /test:hub-cli-contract/);
  assert.match(server, /npm run test --workspace=@getpaseo\/server/);
  assert.ok(!jobs.has("hub-cli-contract"));

  assert.match(desktop, /test:e2e:renderer/);
  assert.match(desktop, /test:e2e:browser-tabs/);
  assert.match(desktop, /npm run test --workspace=@getpaseo\/desktop/);
  assert.ok(!jobs.has("desktop-browser-bridge"));
  assert.ok(!jobs.has("playwright-desktop"));
});

test("manual CI scopes preserve Linux coverage and make other platforms opt-in", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const changes = jobs.get("changes").join("\n");
  const disabled = { routing: "false", ci: "false", workspace: "false", quality: "false" };
  function output(name, { scope = "", filters = disabled } = {}) {
    const expression = new RegExp(`^      ${name}: \\$\\{\\{ (.+) \\}\\}$`, "m").exec(changes)[1];
    return runInNewContext(expression, {
      inputs: { scope },
      github: {},
      steps: { filter: { outputs: filters } },
    });
  }
  const ciOnly = {
    ...disabled,
    ci: "true",
    ci_files: '[".github/workflows/ci.yml"]',
    workspace: "true",
    workspace_files: '["scripts/ci-workflow.test.mjs"]',
    quality: "true",
    quality_files: '["scripts/ci-workflow.test.mjs"]',
  };
  assert.equal(output("full", { filters: ciOnly }), false);
  assert.equal(output("typecheck", { filters: ciOnly }), false);
  assert.equal(output("full"), false);
  for (const scope of ["full-linux", "compatibility"]) {
    assert.equal(output("full", { scope }), true);
    assert.equal(output("compatibility", { scope }), scope === "compatibility");
  }
  for (const filters of [
    {},
    { ...disabled, routing: "true" },
    { ...ciOnly, ci_files: '[".github/actions/setup/action.yml"]' },
    { ...ciOnly, workspace_files: '["scripts/ci-workflow.test.mjs","scripts/npm-retry.mjs"]' },
  ]) {
    assert.equal(output("full", { filters }), true);
  }
  assert.equal(output("typecheck", { filters: {} }), true);
  assert.equal(
    output("typecheck", {
      filters: { ...ciOnly, quality_files: '["packages/app/src/workspace.tsx"]' },
    }),
    true,
  );
  for (const jobId of [
    "server-tests-windows",
    "server-integration-windows",
    "server-tests-macos",
    "desktop-tests-windows",
  ]) {
    const expression = /    if: \$\{\{ (.+) \}\}/.exec(jobs.get(jobId).join("\n"))[1];
    for (const compatibility of [undefined, "false", "true"]) {
      assert.equal(
        runInNewContext(expression, {
          needs: { changes: { result: "success", outputs: { full: "true", compatibility } } },
          cancelled: () => false,
        }),
        compatibility === "true",
        jobId,
      );
    }
  }
  assert.match(changes, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(changes, /list-files: json/);
});

test("manual affected CI requires and resolves an earlier comparison commit", () => {
  const workflow = readFileSync(ciWorkflowPath, "utf8");
  const script = workflow
    .match(/name: Resolve comparison base[\s\S]*?        run: \|\n([\s\S]*?)\n      - name:/)[1]
    .replace(/^          /gm, "");
  const scratch = mkdtempSync(join(tmpdir(), "paseo-ci-base-"));
  try {
    for (const [scope, base, accepted] of [
      ["affected", "", false],
      ["affected", "HEAD", false],
      ["affected", "not-a-real-comparison-ref", false],
      ["affected", "HEAD^", true],
      ["full-linux", "", true],
      ["compatibility", "", true],
      ["unknown", "", false],
    ]) {
      const output = join(scratch, "output");
      writeFileSync(output, "");
      const result = spawnSync("bash", ["-eu", "-c", script], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          EVENT_NAME: "workflow_dispatch",
          SCOPE: scope,
          REQUESTED_BASE: base,
          PUSH_BASE: "",
          DEFAULT_BASE: "workstation",
          GITHUB_OUTPUT: output,
        },
      });
      assert.equal(result.status === 0, accepted, `${scope} ${base}: ${result.stderr}`);
      if (base === "HEAD^") assert.match(readFileSync(output, "utf8"), /^base=[0-9a-f]{40}\n$/);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("ordinary CI keeps app tests without prebuilding Android modules", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const app = jobBlocks(source).get("app-tests").join("\n");
  assert.match(app, /npm run build:app-deps/);
  assert.match(app, /npm run test --workspace=@getpaseo\/app/);
  assert.doesNotMatch(source, /test:android|expo prebuild|gradlew|actions\/setup-java/);
});

test("server builds exclude test utilities at every domain depth", () => {
  const tsconfig = JSON.parse(readFileSync(serverTsconfigPath, "utf8"));
  assert.ok(tsconfig.exclude.includes("src/server/**/test-utils/**"));
  assert.ok(!tsconfig.exclude.includes("src/server/test-utils/**"));
});

test("PR routing declares stable behavior ownership", () => {
  const filters = loadFilters(filtersPath);
  assert.deepEqual(filters.routing, [".github/ci-paths.yml"]);
  for (const pattern of [
    ".mise.toml",
    "build/fork-linux/**",
    "fork-release.json",
    "package.json",
    "package-lock.json",
    "patches/**",
    "scripts/**",
    "vitest.config.ts",
  ])
    assert.ok(filters.workspace.includes(pattern), pattern);
  assert.ok(filters.ci.includes(".github/workflows/ci.yml"));
  assert.ok(filters.server.includes("packages/server/**"));
  assert.ok(filters.app.includes("packages/app/**"));
  assert.ok(filters.browser.includes("packages/app/e2e/browser/**"));
  assert.ok(filters.desktop.includes("packages/desktop/**"));
  assert.ok(filters.cli.includes("packages/cli/**"));
  assert.ok(filters.website.includes("packages/website/**"));

  const ids = (files) =>
    selectChecks({ custom: [], allLinux: false }, files).checks.map(([id]) => id);
  assert.ok(ids(["packages/app/src/chat/message.tsx"]).includes("app-tests"));
  assert.ok(ids([".github/ci-paths.yml"]).includes("workflow-contracts"));
  assert.ok(ids(["package-lock.json"]).includes("build-server"));
  assert.ok(ids(["packages/server/src/server/agent/agent-manager.ts"]).includes("server-tests"));
  assert.ok(ids(["packages/website/src/home.tsx"]).includes("website-browser"));
  assert.deepEqual(ids(["docs/release.md"]), ["format"]);
});

test("cross-package invariants live in the suite that owns them", () => {
  const cliTests = filesUnder("packages/cli", (path) => path.endsWith(".test.ts"));
  assert.ok(cliTests.length > 0);
  for (const path of cliTests) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /server\/src\/server\/test-utils/,
      path,
    );
  }

  const protocolWireCompatibility = new URL(
    "packages/protocol/src/messages.wire-compat.test.ts",
    repoRoot,
  );
  assert.match(readFileSync(protocolWireCompatibility, "utf8"), /wire schema compatibility/);
});

test("browser and desktop tests have exclusive, directory-owned suites", () => {
  const filters = loadFilters(filtersPath);
  const browserSpecs = filesUnder("packages/app/e2e", (path) => path.endsWith(".spec.ts"));
  const desktopSpecs = filesUnder("packages/desktop/e2e", (path) => path.endsWith(".spec.ts"));

  assert.ok(browserSpecs.length > 0);
  assert.ok(desktopSpecs.length > 0);
  assert.ok(browserSpecs.every((path) => path.startsWith("packages/app/e2e/browser/")));
  assert.ok(desktopSpecs.every((path) => path.startsWith("packages/desktop/e2e/")));

  const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
  assert.match(desktopPackage.scripts.test, /--exclude ["']e2e\/\*\*["']/);

  for (const path of browserSpecs) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /paseoDesktop|injectDesktopBridge/,
    );
  }
  for (const path of desktopSpecs) {
    assert.ok(path.startsWith("packages/desktop/e2e/"));
  }

  const routingSource = readFileSync(filtersPath, "utf8");
  assert.doesNotMatch(routingSource, /desktop_bridge|playwright_desktop|browser-\*|browser-\*\//);
  assert.deepEqual(filters.desktop, [
    "packages/desktop/**",
    "packages/app/src/desktop/**",
    "packages/app/src/**/*.electron.{ts,tsx}",
    "packages/server/src/server/browser-tools/**",
    "packages/app/e2e/support/**",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
  assert.deepEqual(filters.browser, [
    "packages/server/src/server/agent/provider-snapshot-manager.ts",
    "packages/server/src/server/session/provider/provider-catalog-session.ts",
    "packages/client/src/compat/normalize-provider-models.ts",
    "packages/protocol/src/client-capabilities.ts",
    "packages/server/src/server/agent/provider-registry.ts",
    "packages/server/src/server/agent/agent-sdk-types.ts",
    "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
    "packages/server/src/server/agent/providers/claude/agent.ts",
    "packages/server/src/server/agent/plugin-provider.ts",
    "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
    "packages/server/src/executable-resolution/**",
    "packages/plugin/src/server/provider.ts",
    "packages/app/src/!(desktop)/**",
    "packages/app/e2e/browser/**",
    "packages/app/e2e/support/**",
    "packages/app/assets/**",
    "packages/app/public/**",
    "packages/app/index.ts",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
});

test("packaging runs on main without allocating pull-request runners", () => {
  for (const workflowPath of [dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    const trigger = source.split("jobs:", 1)[0];
    assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
    assert.doesNotMatch(trigger, /pull_request/);
    assert.doesNotMatch(source, /dorny\/paths-filter/);
  }
});

test("desktop packaging smokes main pushes and only the pull requests that touch packaging", () => {
  const source = readFileSync(new URL(".github/workflows/desktop-packages.yml", repoRoot), "utf8");
  const trigger = source.split("jobs:", 1)[0];
  assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
  assert.match(trigger, /pull_request:\s*\n\s+paths:/);
  assert.match(trigger, /- "packages\/desktop\/\*\*"/);
  assert.doesNotMatch(source, /dorny\/paths-filter/);
  for (const action of ["actions/checkout", "actions/setup-node", "actions/upload-artifact"]) {
    assert.match(source, new RegExp(`${action}@[0-9a-f]{40} # v\\d+\\.\\d+\\.\\d+`));
  }
});

test("stable iOS releases upload once and distribute to external testers before App Store review", () => {
  const source = readFileSync(
    new URL("packages/app/.eas/workflows/release-mobile.yml", repoRoot),
    "utf8",
  );
  const jobs = jobBlocks(source);
  const uploads = [...jobs.entries()].filter(
    ([, lines]) =>
      lines.some((line) => /^    type: (submit|testflight)$/.test(line)) &&
      lines.some((line) => line.includes("needs.build_ios.outputs.build_id")),
  );
  assert.equal(uploads.length, 1, "the iOS binary must be uploaded exactly once");
  const [distributionId, distributionLines] = uploads[0];
  const distribution = distributionLines.join("\n");
  assert.match(distribution, /^    type: testflight$/m);
  assert.match(distribution, /external_groups:\s*\n\s+- Paseo Beta/);
  assert.match(distribution, /^      submit_beta_review: true$/m);

  const review = jobs.get("submit_ios_for_review").join("\n");
  assert.match(review, new RegExp(`needs: \\[build_ios, ${distributionId}\\]`));
  assert.match(review, /APP_VERSION="\$\{\{ needs\.build_ios\.outputs\.app_version \}\}"/);
  assert.match(
    review,
    /APP_BUILD_VERSION="\$\{\{ needs\.build_ios\.outputs\.app_build_version \}\}"/,
  );
  assert.match(review, /bundle exec fastlane ios submit_review/);
});

test("eight Playwright shards share one worker per private runner", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(source);
  for (const id of gatedCiJobs.keys()) assert.ok(jobs.has(id), id);
  for (let shard = 1; shard <= 8; shard++) {
    const job = jobs.get(`playwright-${shard}`).join("\n");
    assert.match(job, new RegExp(`PLAYWRIGHT_SHARD: "${shard}/8"`));
    assert.match(job, new RegExp(`PLAYWRIGHT_ARTIFACT: "${shard}"`));
    assert.match(
      job,
      shard === 1 ? /steps: &playwright_test_steps/ : /steps: \*playwright_test_steps/,
    );
  }
  const shared = jobs.get("playwright-1").join("\n");
  assert.match(shared, /E2E_WORKERS: "1"/);
  const weights = /PWTEST_SHARD_WEIGHTS: "([\d:]+)"/.exec(shared)[1].split(":").map(Number);
  assert.equal(weights.length, 8);
  assert.ok(weights.every((weight) => weight > 0));
  assert.match(shared, /npm run test:e2e --workspace=@getpaseo\/app -- --shard=/);

  // No fan-in result job: a gate needs its own runner and under contention it
  // queued 8m08s behind the last shard. Required checks name the shards directly.
  assert.equal(jobs.has("playwright"), false);
});

test("quality preserves commands and routes each domain independently after failures", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const quality = jobs.get("quality").join("\n");
  assert.doesNotMatch(quality, /^\s+continue-on-error:/m);
  const commands = {
    format: ["npm run format:check"],
    quality: [
      "npx --yes lockfile-lint --path package-lock.json --type npm --allowed-hosts npm --validate-https --validate-integrity",
      "npm audit signatures",
      "npm run lint",
      "node --test scripts/oxlint/paseo-plugin.test.mjs",
    ],
    relay: ["npm run build:relay", "npm run test --workspace=@getpaseo/relay"],
    sdk: [
      "npm run build:relay && npm run build:client",
      "npm run build:plugin",
      "npm run test --workspace=@getpaseo/plugin",
      "npm run test --workspace=@getpaseo/protocol",
      "npm run test --workspace=@getpaseo/client",
      "npm run test --workspace=@getpaseo/highlight",
      "npm run typecheck:examples --workspace=@getpaseo/client",
    ],
  };
  const checks = [...quality.matchAll(/        if: \$\{\{ (.+) \}\}\n        run: (.+)/g)];
  assert.deepEqual(
    checks.map(([, , command]) => command),
    Object.values(commands).flat(),
  );
  const domains = Object.keys(commands);
  function accepts(expression, outputs, { cancelled = false, installed = true } = {}) {
    // Prior checks have failed: success() is false. Explicit !cancelled() must
    // override Actions' default success condition so later domains still run.
    assert.match(expression, /!cancelled\(\)/);
    return runInNewContext(expression, {
      needs: { changes: { result: "success", outputs } },
      steps: { install: { outcome: installed ? "success" : "failure" } },
      cancelled: () => cancelled,
      success: () => false,
    });
  }
  const disabled = { full: "false", ...Object.fromEntries(domains.map((key) => [key, "false"])) };
  const jobCondition = /    if: \$\{\{ (.+) \}\}/.exec(quality)[1];
  assert.equal(accepts(jobCondition, disabled), false);
  for (const selected of domains) {
    const outputs = { ...disabled, [selected]: "true" };
    assert.equal(accepts(jobCondition, outputs), true);
    for (const [, expression, command] of checks) {
      assert.equal(accepts(expression, outputs), commands[selected].includes(command), command);
    }
  }
  for (const [, expression] of checks) {
    assert.equal(accepts(expression, { ...disabled, full: "true" }), true);
    assert.equal(accepts(expression, {}), true, "missing routing outputs fail open");
    assert.equal(accepts(expression, {}, { cancelled: true }), false);
    assert.equal(accepts(expression, {}, { installed: false }), false);
  }
  assert.equal(accepts(jobCondition, {}, { cancelled: true }), false);
});

test("Windows units and integration run independently with complete routed coverage", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(source);
  const ubuntu = jobs.get("server-tests-ubuntu").join("\n");
  const windows = jobs.get("server-tests-windows").join("\n");
  const integration = jobs.get("server-integration-windows").join("\n");
  assert.match(ubuntu, /run: npm run test --workspace=@getpaseo\/server/);
  assert.match(windows, /run: npm run test:unit --workspace=@getpaseo\/server/);
  assert.doesNotMatch(windows, /run: npm run test(?: |:integration)/);
  assert.match(integration, /run: npm run test:integration --workspace=@getpaseo\/server/);
  assert.doesNotMatch(integration, /test:unit|server_plugin_tests|server_hub_contract/);
  for (const job of [windows, integration]) {
    assert.match(job, /^    needs: changes$/m, "both phases become eligible independently");
    assert.match(job, /^    runs-on: windows-latest$/m);
    assert.doesNotMatch(job, /continue-on-error|maxWorkers|--exclude/);
    for (const step of [
      "server_capacity",
      "server_checkout",
      "server_node",
      "server_fetch",
      "server_install",
      "server_agent_clis",
      "server_build",
    ]) {
      assert.match(ubuntu, new RegExp(`&${step}\\b`));
      assert.match(job, new RegExp(`- \\*${step}\\b`));
    }
    assert.match(job, /env: \*server_test_env/);
  }
  assert.match(windows, /- \*server_plugin_tests/);
  assert.match(windows, /- \*server_hub_contract/);
  assert.match(ubuntu, /run: npm run test --workspace=@getpaseo\/builtin-plugins/);
  assert.match(ubuntu, /run: npm run test:hub-cli-contract --workspace=@getpaseo\/server/);

  const scripts = JSON.parse(
    readFileSync(new URL("packages/server/package.json", repoRoot), "utf8"),
  ).scripts;
  assert.equal(scripts.test, "npm run test:unit && npm run test:integration");
  assert.equal(scripts["test:unit"], 'vitest run --fileParallelism --exclude "**/*.e2e.test.ts"');
  const invocations = scripts["test:integration"].split(" && ");
  // Each vitest start costs about half a minute on Windows, so the
  // name-filtered files share one invocation and one combined filter.
  assert.equal(invocations.length, 2);
  assert.ok(invocations.every((command) => command.startsWith("vitest run --maxWorkers=1 ")));
  assert.doesNotMatch(invocations[0], / -t /);
  assert.equal(
    invocations[1],
    'vitest run --maxWorkers=1 src/server/agent/providers/omp/history.e2e.test.ts src/server/daemon-e2e/git-operations.e2e.test.ts src/server/session.create-agent-worktree-autoarchive.e2e.test.ts src/server/agent/providers/opencode-bridge.local.e2e.test.ts src/server/daemon-e2e/relay-transport.e2e.test.ts -t "merges into|creates a worktree and auto-archives both|versioned runtime|oversized attachments|connected hosts|password-protected daemon refuses|replays selected OMP history"',
  );
  const serverConfig = readFileSync(new URL("packages/server/vitest.config.ts", repoRoot), "utf8");
  assert.doesNotMatch(serverConfig, /maxWorkers/);

  function condition(job) {
    return /    if: \$\{\{ (.+) \}\}/.exec(job)[1];
  }
  function selected(expression, outputs, cancelled = false) {
    return runInNewContext(expression, {
      needs: { changes: { result: "success", outputs } },
      cancelled: () => cancelled,
    });
  }
  const unitCondition = condition(windows);
  const integrationCondition = condition(integration);
  const unitStep = /      - name: Run server unit tests\n        if: \$\{\{ (.+) \}\}/.exec(
    windows,
  )[1];
  const hubStep =
    /      - &server_hub_contract\n        name: Run Hub CLI\/daemon contract\n        if: \$\{\{ (.+) \}\}/.exec(
      ubuntu,
    )[1];
  const pluginStep =
    /      - &server_plugin_tests\n        name: Run built-in plugin tests\n        if: \$\{\{ (.+) \}\}/.exec(
      ubuntu,
    )[1];
  for (const [outputs, units, integrations, hub] of [
    [{ full: "true", server: "false", hub: "false" }, true, true, false],
    [{ full: "false", server: "true", hub: "false" }, true, true, false],
    [{ full: "false", server: "false", hub: "true" }, true, false, true],
    [{ full: "false", server: "false", hub: "false" }, false, false, false],
    [{}, true, true, false],
  ]) {
    assert.equal(selected(unitCondition, { ...outputs, compatibility: "true" }), units);
    assert.equal(
      selected(integrationCondition, { ...outputs, compatibility: "true" }),
      integrations,
    );
    assert.equal(selected(unitStep, outputs), integrations);
    assert.equal(selected(pluginStep, outputs), integrations);
    assert.equal(selected(hubStep, outputs), hub);
    assert.equal(selected(unitCondition, outputs, true), false);
    assert.equal(selected(integrationCondition, outputs, true), false);
  }
});

test("macOS release retries only transient stapling failures without rebuilding the signed app", async (t) => {
  const workflow = readFileSync(new URL(".github/workflows/desktop-release.yml", repoRoot), "utf8");
  const wrapper = workflow
    .match(/<<'STAPLER'\n([\s\S]*?)\n          STAPLER/)[1]
    .replace(/^          /gm, "");
  const networkError =
    'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."';
  const cases = [
    {
      name: "success",
      outcomes: [0],
      output: "stapled",
      command: "stapler",
      expected: 0,
      attempts: 1,
    },
    {
      name: "transient then success",
      outcomes: [68, 0],
      output: networkError,
      command: "stapler",
      expected: 0,
      attempts: 2,
    },
    {
      name: "exhausted network retries",
      outcomes: [68, 68, 68, 68, 0],
      output: networkError,
      command: "stapler",
      expected: 68,
      attempts: 4,
    },
    {
      name: "non-network staple error",
      outcomes: [68, 0],
      output: "ticket not found",
      command: "stapler",
      expected: 68,
      attempts: 1,
    },
    {
      name: "different exit code",
      outcomes: [1, 0],
      output: networkError,
      command: "stapler",
      expected: 1,
      attempts: 1,
    },
    {
      name: "notary submission is not retried",
      outcomes: [68, 0],
      output: networkError,
      command: "notarytool",
      expected: 68,
      attempts: 1,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const directory = mkdtempSync(join(tmpdir(), "stapler-retry-"));
      try {
        const statePath = join(directory, "state.json");
        const realXcrun = join(directory, "real-xcrun");
        const wrapperPath = join(directory, "xcrun");
        writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
        writeFileSync(join(directory, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        writeFileSync(
          statePath,
          JSON.stringify({ outcomes: scenario.outcomes, output: scenario.output, calls: [] }),
        );
        writeFileSync(
          realXcrun,
          `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.STAPLER_STATE, "utf8"));
state.calls.push(process.argv.slice(2));
const code = state.outcomes.shift();
fs.writeFileSync(process.env.STAPLER_STATE, JSON.stringify(state));
console.log(state.output);
process.exit(code);
`,
          { mode: 0o755 },
        );
        const args = [scenario.command, "staple", "-v", "Paseo signed.app"];
        const result = spawnSync("bash", [wrapperPath, ...args], {
          encoding: "utf8",
          env: {
            ...process.env,
            PASEO_REAL_XCRUN: realXcrun,
            STAPLER_STATE: statePath,
            PATH: `${directory}:${process.env.PATH}`,
          },
          timeout: 5000,
        });
        assert.equal(result.status, scenario.expected, result.stdout + result.stderr);
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        assert.deepEqual(
          state.calls,
          Array.from({ length: scenario.attempts }, () => args),
        );
        assert.match(result.stdout, /stapled|network connection was lost|ticket not found/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

// GitHub retires macOS 14 on 2026-11-02; brownouts already reject these jobs.
test("workflows avoid retired macOS 14 runners", () => {
  for (const path of filesUnder(".github/workflows", (candidate) => /\.ya?ml$/.test(candidate))) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /macos-14(?:-large|-xlarge)?\b/,
      path,
    );
  }
});

test("macOS jobs use latest runners while preserving release architectures", () => {
  for (const [workflow, jobId] of [
    [ciWorkflowPath, "server-tests-macos"],
    [nixWorkflowPath, "build-desktop-darwin"],
  ]) {
    assert.match(
      jobBlocks(readFileSync(workflow, "utf8")).get(jobId).join("\n"),
      /^    runs-on: macos-latest$/m,
    );
  }
  const release = readFileSync(new URL(".github/workflows/desktop-release.yml", repoRoot), "utf8");
  assert.match(release, /runner: macos-latest\n\s+electron_arch: arm64/);
  // GitHub has no standard macos-latest-intel alias; use the newest Intel image.
  assert.match(release, /runner: macos-26-intel\n\s+electron_arch: x64/);
});

test("Nix desktop packaging resolves the workspace-local builder", () => {
  const source = readFileSync(new URL("nix/desktop-package.nix", repoRoot), "utf8");
  const invocation = source.match(/^\s+([^\n]*electron-builder) \\\n/m)?.[1];
  assert.ok(invocation, "Nix invokes the desktop packaging tool");
  const directory = mkdtempSync(join(tmpdir(), "nix-builder-resolution-"));
  try {
    const desktop = join(directory, "packages/desktop");
    mkdirSync(join(desktop, "node_modules/.bin"), { recursive: true });
    mkdirSync(join(desktop, "node_modules/electron-builder"));
    writeFileSync(
      join(desktop, "node_modules/electron-builder/package.json"),
      JSON.stringify({
        name: "electron-builder",
        version: "1.0.0",
        bin: { "electron-builder": "../.bin/electron-builder" },
      }),
    );
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/desktop"] }),
    );
    writeFileSync(
      join(desktop, "package.json"),
      JSON.stringify({
        name: "desktop-fixture",
        private: true,
        devDependencies: { "electron-builder": "1.0.0" },
      }),
    );
    writeFileSync(
      join(desktop, "node_modules/.bin/electron-builder"),
      '#!/bin/sh\nprintf "workspace-builder\\n"\n',
      { mode: 0o755 },
    );
    const result = spawnSync("sh", ["-c", `${invocation} --version`], {
      cwd: desktop,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "workspace-builder");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("local selection reuses routed contracts and keeps website checks independent", () => {
  const options = { custom: [], allLinux: false };
  const ids = (files) => selectChecks(options, files).checks.map(([id]) => id);
  assert.ok(ids(["packages/app/src/chat/message.tsx"]).includes("app-tests"));
  assert.ok(ids(["packages/app/src/chat/message.tsx"]).includes("app-browser"));
  assert.ok(!ids(["packages/app/src/chat/message.tsx"]).includes("website-browser"));
  assert.ok(ids(["packages/website/src/home.tsx"]).includes("website-browser"));
  assert.ok(!ids(["packages/website/src/home.tsx"]).includes("build-server"));
  assert.deepEqual(ids(["docs/release.md"]), ["format"]);
  assert.deepEqual(ids([]), []);
  const appChecks = ids(["packages/app/src/chat/message.tsx"]);
  assert.ok(appChecks.indexOf("generate-app-route-types") < appChecks.indexOf("typecheck-app"));
  assert.ok(appChecks.includes("generate-app-route-types"));
  const all = new Set(selectChecks({ ...options, allLinux: true }, []).checks.map(([id]) => id));
  for (const id of [
    "relay-tests",
    "plugin-tests",
    "server-tests",
    "cli-local",
    "app-browser",
    "desktop-lifecycle",
    "website-unit",
    "website-browser",
  ])
    assert.ok(all.has(id), id);
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  assert.doesNotMatch(jobs.get("typecheck").join("\n"), /Run website tests|Verify website mockups/);
  assert.match(jobs.get("website-tests").join("\n"), /needs\.changes\.outputs\.website/);
});

test("local selection includes workflow contracts on mixed workflow/app edits", () => {
  const { checks } = selectChecks({ custom: [], allLinux: false }, [
    ".github/workflows/docker.yml",
    "packages/app/src/plugins/workspace-panels/panel.tsx",
  ]);
  const ids = new Set(checks.map(([id]) => id));
  assert.ok(ids.has("workflow-contracts"));
  assert.ok(ids.has("app-tests"));
  assert.ok(ids.has("app-browser"));
  assert.ok(!ids.has("website-browser"));
});

test("publication, ignore and hook policy inputs route without product fan-out", () => {
  for (const file of [
    ".dockerignore",
    ".gitleaks.toml",
    "lefthook.yml",
    "scripts/check-publication.py",
    "scripts/check-publication.sh",
    "scripts/install-publication-hook.sh",
    "scripts/publication-exceptions.json",
    "scripts/publication-pruned-files.json",
    "scripts/publication-scanner.json",
  ]) {
    const ids = new Set(
      selectChecks({ custom: [], allLinux: false }, [file]).checks.map(([id]) => id),
    );
    assert.ok(ids.has("workflow-contracts"), file);
    assert.ok(ids.has("publication-policy"), file);
    for (const unrelated of [
      "app-tests",
      "app-browser",
      "desktop-tests",
      "server-tests",
      "build-server",
    ])
      assert.ok(!ids.has(unrelated), `${file}: ${unrelated}`);
  }
  const mixedDocs = selectChecks({ custom: [], allLinux: false }, [
    ".github/workflows/nix.yml",
    "docs/testing.md",
  ]).checks.map(([id]) => id);
  assert.deepEqual(mixedDocs, ["workflow-contracts", "format"]);
});

test("one changed browser spec selects that spec and its real preparation", () => {
  const spec = "packages/app/e2e/browser/plugin-file-panel-picker.spec.ts";
  const { checks } = selectChecks({ custom: [], allLinux: false }, [spec]);
  const ids = new Set(checks.map(([id]) => id));
  assert.ok(ids.has("build-app-dependencies"));
  assert.ok(ids.has("build-server"));
  assert.ok(ids.has("install-browser-binaries"));
  assert.ok(ids.has("app-browser-focused"));
  assert.ok(!ids.has("app-tests"));
  assert.ok(!ids.has("app-browser"));
  assert.ok(!ids.has("typecheck-app"));
  assert.deepEqual(checks.find(([id]) => id === "app-browser-focused")[1], [
    "npm",
    "run",
    "test:e2e",
    "--workspace=@getpaseo/app",
    "--",
    "e2e/browser/plugin-file-panel-picker.spec.ts",
  ]);
});

test("one changed app unit test selects the unit project", () => {
  const file = "packages/app/src/stores/draft-store/persistence.test.ts";
  const { checks } = selectChecks({ custom: [], allLinux: false }, [file]);
  const ids = new Set(checks.map(([id]) => id));
  assert.ok(ids.has("build-app-dependencies"));
  assert.ok(ids.has("app-unit-tests"));
  assert.ok(!ids.has("app-tests"));
  assert.ok(!ids.has("app-browser"));
  assert.ok(!ids.has("typecheck-app"));
  assert.deepEqual(checks.find(([id]) => id === "app-unit-tests")[1], [
    "npm",
    "run",
    "test",
    "--workspace=@getpaseo/app",
    "--",
    "--project",
    "unit",
    "src/stores/draft-store/persistence.test.ts",
    "--bail=1",
  ]);
});

test("shared test inputs keep the broader browser and app suites", () => {
  const ids = new Set(
    selectChecks({ custom: [], allLinux: false }, [
      "packages/app/e2e/browser/plugin-file-panel-picker.spec.ts",
      "packages/app/e2e/support/fixtures.ts",
    ]).checks.map(([id]) => id),
  );
  assert.ok(ids.has("app-browser"));
  assert.ok(ids.has("app-tests"));
  assert.ok(!ids.has("app-browser-focused"));
});

test("opt-in browser specs use their dedicated entrypoints", () => {
  for (const [spec, id, script] of [
    [
      "packages/app/e2e/browser/plugin-file-panel-picker.real.spec.ts",
      "app-browser-real",
      "test:e2e:real",
    ],
    [
      "packages/app/e2e/browser/diff-performance.spec.ts",
      "app-browser-diff-performance",
      "test:e2e:diff-performance",
    ],
    [
      "packages/app/e2e/browser/agent-stream-smoothness.spec.ts",
      "app-browser-stream-smoothness",
      "test:e2e:stream-smoothness",
    ],
  ]) {
    const { checks } = selectChecks({ custom: [], allLinux: false }, [spec]);
    const ids = new Set(checks.map(([entry]) => entry));
    assert.ok(ids.has(id), spec);
    assert.ok(!ids.has("app-browser-focused"), spec);
    assert.ok(checks.find(([entry]) => entry === id)[1].includes(script), spec);
  }
});

test("selected metadata makes unknown checks uncached and completes reusable prerequisites", () => {
  const checks = selectChecks({ custom: [], allLinux: true }, []).checks;
  const metadata = selectionMetadata(checks, "reports");
  const byId = new Map(metadata.map((check) => [check.id, check]));

  for (const id of [
    "dependency-patch-contract",
    "format",
    "lint",
    "lint-rule-tests",
    "typecheck-highlight",
    "workflow-contracts",
  ])
    assert.equal(byId.get(id).sourceOnly, true, id);
  assert.equal(byId.get("typecheck-plugin").sourceOnly, undefined);
  assert.equal(byId.get("typecheck-plugin").requires, undefined);

  assert.deepEqual(byId.get("package-protocol").requires, ["build-app-dependencies"]);
  assert.deepEqual(byId.get("package-client").requires, ["build-app-dependencies"]);
  assert.deepEqual(byId.get("package-server").requires, ["build-server"]);
  assert.deepEqual(byId.get("typecheck-desktop").requires, ["build-server"]);
  assert.deepEqual(byId.get("builtin-plugin-dist-contract").requires, ["build-app-dependencies"]);
  assert.equal(byId.get("build-plugin").preparation, true);
  assert.deepEqual(byId.get("build-plugin").outputs, ["packages/plugin/dist"]);
  for (const output of [
    "packages/client/dist",
    "packages/highlight/dist",
    "packages/plugin/dist",
    "packages/server/dist",
  ])
    assert.ok(byId.get("build-server").outputs.includes(output), output);
  assert.deepEqual(byId.get("generate-app-route-types").outputs, [
    "packages/app/.expo/types",
    "packages/app/expo-env.d.ts",
  ]);
  assert.deepEqual(byId.get("install-browser-binaries").outputs, ["/cache/playwright"]);

  assert.match(byId.get("server-tests").uncachedReason, /chained unit\/integration/);
  assert.match(byId.get("desktop-tests").uncachedReason, /no single owning report/);
  assert.match(byId.get("cli-local").uncachedReason, /no single machine report/);

  assert.equal(byId.get("app-browser").report.format, "playwright");
  assert.ok(byId.get("app-browser").argv.includes("--reporter=json"));
  assert.equal(byId.get("app-tests").report.format, "vitest");
  assert.ok(byId.get("app-tests").argv.includes("--"));
  assert.ok(byId.get("app-tests").argv.includes("--reporter=json"));
  assert.equal(byId.get("relay-tests").report.format, "vitest");
  assert.equal(byId.get("server-tests").report, undefined);
});

test("desktop typechecking cannot reuse a pass after its declaration build fails", () => {
  const selected = selectionMetadata(selectChecks({ custom: [], allLinux: true }, []).checks);
  const build = selected.find((check) => check.id === "build-server");
  const desktop = selected.find((check) => check.id === "typecheck-desktop");
  const directory = mkdtempSync(join(tmpdir(), "desktop-declarations-"));
  try {
    const result = join(directory, "result.json");
    const plan = {
      mode: "relevant",
      inputs: { sourceSnapshot: "source", dependencyInstallIdentity: "installed" },
      selected: [
        { ...build, argv: [process.execPath, "-e", "process.exit(1)"] },
        { ...desktop, argv: [process.execPath, "-e", "process.exit(0)"] },
      ],
      skipped: [],
    };
    assert.equal(execute(plan, result, { blockCache: join(directory, "blocks") }), 1);
    const record = JSON.parse(readFileSync(result, "utf8"));
    assert.equal(record.selected.find((check) => check.id === desktop.id).result, "blocked");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mixed opt-in spec edits keep their dedicated runner beside the broad browser suite", () => {
  for (const [spec, id, script] of [
    [
      "packages/app/e2e/browser/plugin-file-panel-picker.real.spec.ts",
      "app-browser-real",
      "test:e2e:real",
    ],
    [
      "packages/app/e2e/browser/diff-performance.spec.ts",
      "app-browser-diff-performance",
      "test:e2e:diff-performance",
    ],
    [
      "packages/app/e2e/browser/agent-stream-smoothness.spec.ts",
      "app-browser-stream-smoothness",
      "test:e2e:stream-smoothness",
    ],
  ]) {
    const { checks } = selectChecks({ custom: [], allLinux: false }, [
      spec,
      "packages/app/e2e/support/fixtures.ts",
    ]);
    const ids = new Set(checks.map(([entry]) => entry));
    assert.ok(ids.has("app-browser"), spec);
    assert.ok(ids.has(id), spec);
    assert.ok(checks.find(([entry]) => entry === id)[1].includes(script), spec);
  }
});

test("broad Firefox selection installs Firefox plus Chromium, and website keeps WebKit", () => {
  const previous = process.env.E2E_BROWSER;
  process.env.E2E_BROWSER = "firefox";
  try {
    const appInstall = selectChecks({ custom: [], allLinux: false }, [
      "packages/app/src/chat/message.tsx",
    ]).checks.find(([id]) => id === "install-browser-binaries")[1];
    assert.ok(appInstall.includes("chromium"));
    assert.ok(appInstall.includes("firefox"));
    assert.ok(!appInstall.includes("webkit"));

    const websiteInstall = selectChecks({ custom: [], allLinux: false }, [
      "packages/website/src/home.tsx",
    ]).checks.find(([id]) => id === "install-browser-binaries")[1];
    assert.ok(websiteInstall.includes("chromium"));
    assert.ok(websiteInstall.includes("webkit"));
    assert.ok(!websiteInstall.includes("firefox"));

    const focusedInstall = selectChecks({ custom: [], allLinux: false }, [
      "packages/app/e2e/browser/plugin-file-panel-picker.spec.ts",
    ]).checks.find(([id]) => id === "install-browser-binaries")[1];
    assert.deepEqual(focusedInstall.slice(-1), ["firefox"]);
  } finally {
    if (previous === undefined) delete process.env.E2E_BROWSER;
    else process.env.E2E_BROWSER = previous;
  }
});

test("local full-Linux checks use the separately pinned check image", () => {
  const release = JSON.parse(readFileSync(new URL("fork-release.json", repoRoot), "utf8"));
  assert.match(release.builderImage, /^sha256:[0-9a-f]{64}$/);
  assert.match(release.checkBuilderImage, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(release.checkBuilderImage, release.builderImage);

  const dockerfile = readFileSync(new URL("build/fork-linux/Dockerfile", repoRoot), "utf8");
  const lockfile = JSON.parse(readFileSync(new URL("package-lock.json", repoRoot), "utf8"));
  const playwrightVersion = lockfile.packages["node_modules/playwright"].version;
  assert.match(dockerfile, /FROM package AS checks/);
  assert.match(dockerfile, /FROM package AS default/);
  assert.match(
    dockerfile,
    new RegExp(`io\\.paseo\\.check\\.playwright-version="${playwrightVersion}"`),
  );
  for (const input of [
    "@anthropic-ai/claude-code@2.1.322",
    "@openai/codex@0.105.0",
    "opencode-ai@1.19.5",
    "https://github.com/anomalyco/opencode/releases/download/v2.2.5/opencode-linux-x64.tar.gz",
    "09f44302c10fd036912f59c81fd1aef5df45dd06f649197f9dfc9bbe2a79614e",
    'io.paseo.check.opencode-v2-version="2.2.5"',
    "git-2.43.0.tar.xz",
    "gh_2.45.0_linux_amd64.deb",
    "libsoup-3.0-0",
    "libgtk-4-1",
    "libevent-2.1-7",
  ])
    assert.ok(dockerfile.includes(input), input);
  assert.match(
    dockerfile,
    /tar -xOf \/tmp\/opencode-v2\.tar\.gz opencode > \/opt\/paseo-opencode-v2\/opencode/,
  );
  assert.match(
    dockerfile,
    /ln -s \/opt\/paseo-opencode-v2\/opencode \/opt\/paseo-check-tools\/bin\/opencode-v2/,
  );
  assert.match(dockerfile, /test "\$\(opencode-v2 --version\)" = "opencode v2\.2\.5"/);

  const wrapper = readFileSync(new URL("scripts/fork-build.sh", repoRoot), "utf8");
  const buildDriver = readFileSync(new URL("scripts/fork-build.mjs", repoRoot), "utf8");
  assert.match(wrapper, /image_policy=checkBuilderImage/);
  assert.match(wrapper, /PASEO_BUILD_IMAGE_ROLE/);
  assert.match(buildDriver, /imageRole === "check"/);
  assert.match(buildDriver, /release\.checkBuilderImage/);

  const checks = selectChecks({ custom: [], allLinux: true }, []).checks;
  const browserInstalls = checks.filter(([id]) => id === "install-browser-binaries");
  assert.deepEqual(browserInstalls, [
    [
      "install-browser-binaries",
      ["npx", "--no-install", "playwright", "install", "chromium", "webkit"],
      [],
    ],
  ]);
  for (const changedFile of ["build/fork-linux/Dockerfile", "fork-release.json"])
    assert.ok(
      selectChecks({ custom: [], allLinux: false }, [changedFile]).checks.some(
        ([id]) => id === "build-server",
      ),
      changedFile,
    );

  const workflow = readFileSync(ciWorkflowPath, "utf8");
  for (const input of [
    "@anthropic-ai/claude-code@2.1.322",
    "@openai/codex@0.105.0",
    "opencode-ai@1.19.5",
  ])
    assert.ok(workflow.includes(input), input);
  const workflowJobs = jobBlocks(workflow);
  for (const provider of [
    "@anthropic-ai/claude-code@2.1.322",
    "@openai/codex@0.105.0",
    "opencode-ai@1.19.5",
  ])
    assert.ok(workflowJobs.get("playwright-1").join("\n").includes(provider), provider);
  for (const provider of ["@anthropic-ai/claude-code@2.1.322", "opencode-ai@1.19.5"])
    assert.ok(workflowJobs.get("server-tests-ubuntu").join("\n").includes(provider), provider);
  for (const provider of [
    "@anthropic-ai/claude-code@2.1.322",
    "@openai/codex@0.105.0",
    "opencode-ai@1.19.5",
  ])
    assert.ok(workflowJobs.get("cli-tests-1").join("\n").includes(provider), provider);
});

test("an unavailable selected check is incomplete and cannot masquerade as passing evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-check-result-"));
  try {
    const result = join(directory, "result.json");
    assert.equal(
      execute(
        {
          inputs: {},
          skipped: [],
          selected: [
            {
              id: "missing-tool",
              argv: ["unavailable-command"],
              tools: ["paseo-test-tool-that-does-not-exist"],
            },
            { id: "available", argv: [process.execPath, "-e", "process.exit(0)"], tools: [] },
          ],
        },
        result,
      ),
      2,
    );
    const evidence = JSON.parse(readFileSync(result, "utf8"));
    assert.equal(evidence.result, "incomplete");
    assert.deepEqual(
      evidence.selected.map((check) => check.result),
      ["unavailable", "passed"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("local evidence uses block receipts and never reuses arbitrary custom commands", () => {
  const wrapper = readFileSync(new URL("scripts/fork-build.sh", repoRoot), "utf8");
  const selection = readFileSync(new URL("scripts/fork-check-selection.mjs", repoRoot), "utf8");
  assert.match(wrapper, /PASEO_CHECK_BLOCK_CACHE=\/block-cache/);
  assert.match(wrapper, /state_root\/check-blocks/);
  assert.doesNotMatch(wrapper, /all\(\.selected\[\]; \.result == "passed"\)/);
  assert.match(selection, /plan\.mode !== "custom"/);
  assert.match(selection, /!check\.preparation/);
  for (const option of [
    "PASEO_CHECK_CPUS",
    "PASEO_CHECK_MEMORY_MIB",
    "PASEO_CHECK_WORKERS",
    "NODE_OPTIONS",
  ])
    assert.ok(selection.includes(option));
});

test("a failed preparation blocks its consumers without stopping independent work", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-check-blocked-"));
  try {
    const result = join(directory, "result.json");
    const blockCache = join(directory, "blocks");
    assert.equal(
      execute(
        {
          mode: "relevant",
          inputs: {
            sourceSnapshot: "source",
            dependencyInstallIdentity: "dependencies",
            checkImage: "image",
            environment: {},
            resources: { workers: "4" },
          },
          skipped: [],
          selected: [
            {
              id: "failed-preparation",
              argv: [process.execPath, "-e", "process.exit(1)"],
              tools: [],
              preparation: true,
            },
            {
              id: "blocked-consumer",
              argv: [process.execPath, "-e", "process.exit(0)"],
              tools: [],
              requires: ["failed-preparation"],
            },
            { id: "independent", argv: [process.execPath, "-e", "process.exit(0)"], tools: [] },
          ],
        },
        result,
        { blockCache },
      ),
      1,
    );
    const evidence = JSON.parse(readFileSync(result, "utf8"));
    assert.equal(evidence.result, "failed");
    assert.deepEqual(
      evidence.selected.map((check) => [check.id, check.result]),
      [
        ["failed-preparation", "failed"],
        ["blocked-consumer", "blocked"],
        ["independent", "passed"],
      ],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing declared preparation output reruns the consumer and stays incomplete", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-check-output-"));
  try {
    const result = join(directory, "result.json");
    const blockCache = join(directory, "blocks");
    const marker = join(directory, "executions.txt");
    const plan = {
      mode: "relevant",
      inputs: {},
      skipped: [],
      selected: [
        {
          id: "output-preparation",
          argv: [process.execPath, "-e", "process.exit(0)"],
          tools: [],
          preparation: true,
          outputs: [join(directory, "missing-output")],
        },
        {
          id: "output-consumer",
          argv: [
            process.execPath,
            "-e",
            "require('fs').appendFileSync(process.argv[1], 'x')",
            marker,
          ],
          tools: [],
          requires: ["output-preparation"],
        },
      ],
    };
    assert.equal(execute(plan, result, { blockCache }), 2);
    let evidence = JSON.parse(readFileSync(result, "utf8"));
    assert.equal(evidence.selected[0].result, "passed");
    assert.equal(evidence.selected[0].outputsVerified, false);
    assert.equal(evidence.selected[1].result, "passed");
    assert.equal(evidence.selected[1].reusedFrom, undefined);
    assert.equal(readFileSync(marker, "utf8").length, 1);

    assert.equal(execute(plan, result, { blockCache }), 2);
    evidence = JSON.parse(readFileSync(result, "utf8"));
    assert.equal(evidence.selected[1].reusedFrom, undefined);
    assert.equal(readFileSync(marker, "utf8").length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prerequisite without declared outputs reruns its consumer instead of caching it", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-check-no-output-"));
  try {
    const result = join(directory, "result.json");
    const blockCache = join(directory, "blocks");
    const marker = join(directory, "consumer-runs.txt");
    const plan = {
      mode: "relevant",
      inputs: {},
      skipped: [],
      selected: [
        {
          id: "uninventoried-preparation",
          argv: [process.execPath, "-e", "process.exit(0)"],
          tools: [],
          preparation: true,
        },
        {
          id: "uninventoried-consumer",
          argv: [
            process.execPath,
            "-e",
            "require('fs').appendFileSync(process.argv[1], 'x')",
            marker,
          ],
          tools: [],
          requires: ["uninventoried-preparation"],
        },
      ],
    };
    assert.equal(execute(plan, result, { blockCache }), 0);
    assert.equal(execute(plan, result, { blockCache }), 0);
    assert.equal(readFileSync(marker, "utf8").length, 2);
    assert.equal(JSON.parse(readFileSync(result, "utf8")).selected[1].reusedFrom, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("changed prerequisite output invalidates a consumer receipt at the reuse boundary", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-check-output-change-"));
  try {
    const result = join(directory, "result.json");
    const blockCache = join(directory, "blocks");
    const output = join(directory, "generated.txt");
    const control = join(directory, "control.txt");
    const marker = join(directory, "consumer-runs.txt");
    writeFileSync(control, "one");
    const plan = {
      mode: "relevant",
      inputs: {
        dependencyInstallIdentity: "install-generation-one",
      },
      skipped: [],
      selected: [
        {
          id: "mutable-preparation",
          argv: [
            process.execPath,
            "-e",
            "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(process.argv[2], 'utf8'))",
            output,
            control,
          ],
          tools: [],
          preparation: true,
          outputs: [output],
        },
        {
          id: "mutable-consumer",
          argv: [
            process.execPath,
            "-e",
            "require('fs').appendFileSync(process.argv[1], 'x')",
            marker,
          ],
          tools: [],
          requires: ["mutable-preparation"],
        },
      ],
    };
    assert.equal(execute(plan, result, { blockCache }), 0);
    assert.equal(readFileSync(marker, "utf8").length, 1);
    assert.equal(execute(plan, result, { blockCache }), 0);
    assert.equal(readFileSync(marker, "utf8").length, 1);
    assert.ok(JSON.parse(readFileSync(result, "utf8")).selected[1].reusedFrom);

    writeFileSync(control, "two");
    assert.equal(execute(plan, result, { blockCache }), 0);
    assert.equal(readFileSync(output, "utf8"), "two");
    assert.equal(readFileSync(marker, "utf8").length, 2);
    assert.equal(JSON.parse(readFileSync(result, "utf8")).selected[1].reusedFrom, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("zero executed or all-skipped runner reports remain incomplete", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-check-report-"));
  try {
    const result = join(directory, "result.json");
    const vitestReport = join(directory, "vitest.json");
    const playwrightReport = join(directory, "playwright.json");
    const writeJson = (path, value) =>
      `require('fs').writeFileSync(process.argv[1], ${JSON.stringify(JSON.stringify(value))})`;
    const plan = {
      mode: "relevant",
      inputs: {},
      skipped: [],
      selected: [
        {
          id: "all-skipped-vitest",
          argv: [
            process.execPath,
            "-e",
            writeJson(vitestReport, {
              numPassedTests: 0,
              numFailedTests: 0,
              numPendingTests: 2,
            }),
            vitestReport,
          ],
          tools: [],
          report: { format: "vitest", path: vitestReport },
        },
        {
          id: "zero-expected-playwright",
          argv: [
            process.execPath,
            "-e",
            writeJson(playwrightReport, { stats: { expected: 0, skipped: 1 } }),
            playwrightReport,
          ],
          tools: [],
          report: { format: "playwright", path: playwrightReport },
        },
      ],
    };
    assert.equal(execute(plan, result, { blockCache: join(directory, "blocks") }), 2);
    const evidence = JSON.parse(readFileSync(result, "utf8"));
    assert.deepEqual(
      evidence.selected.map((check) => [check.id, check.result]),
      [
        ["all-skipped-vitest", "incomplete"],
        ["zero-expected-playwright", "incomplete"],
      ],
    );
    assert.match(evidence.selected[0].reason, /no test case ran and passed/);
    assert.match(evidence.selected[1].reason, /no test case ran and passed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a stale passing report plus exit 0 does not count as a test result", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-check-stale-report-"));
  try {
    const result = join(directory, "result.json");
    const report = join(directory, "stale.json");
    writeFileSync(
      report,
      JSON.stringify({ numPassedTests: 4, numFailedTests: 0, numPendingTests: 0 }),
    );
    assert.equal(
      execute(
        {
          mode: "relevant",
          inputs: {},
          skipped: [],
          selected: [
            {
              id: "stale-report",
              argv: [process.execPath, "-e", "process.exit(0)"],
              tools: [],
              report: { format: "vitest", path: report },
            },
          ],
        },
        result,
        { blockCache: join(directory, "blocks") },
      ),
      2,
    );
    const evidence = JSON.parse(readFileSync(result, "utf8"));
    assert.equal(evidence.selected[0].result, "incomplete");
    assert.match(evidence.selected[0].reason, /test report is missing/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accepted report bytes survive working-report overwrite and reject tampering on reuse", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-check-report-reuse-"));
  try {
    const result = join(directory, "result.json");
    const report = join(directory, "report.json");
    const marker = join(directory, "executions.txt");
    const blockCache = join(directory, "blocks");
    const writeReport = (path, passed) =>
      `require('fs').writeFileSync(process.argv[1], ${JSON.stringify(
        JSON.stringify({ numPassedTests: passed, numFailedTests: 0, numPendingTests: 0 }),
      )})`;
    const plan = {
      mode: "relevant",
      inputs: { sourceSnapshot: "source" },
      skipped: [],
      selected: [
        {
          id: "reported",
          argv: [
            process.execPath,
            "-e",
            `require('fs').appendFileSync(process.argv[2], 'x'); ${writeReport(report, 1)}`,
            report,
            marker,
          ],
          tools: [],
          report: { format: "vitest", path: report },
          sourceOnly: true,
        },
      ],
    };
    assert.equal(execute(plan, result, { blockCache }), 0);
    assert.equal(readFileSync(marker, "utf8").length, 1);

    writeFileSync(
      report,
      JSON.stringify({ numPassedTests: 0, numFailedTests: 0, numPendingTests: 1 }),
    );
    assert.equal(execute(plan, result, { blockCache }), 0);
    assert.equal(readFileSync(marker, "utf8").length, 1);
    assert.ok(JSON.parse(readFileSync(result, "utf8")).selected[0].reusedFrom);

    const preserved = readdirSync(blockCache).find((name) => name.endsWith(".report.json"));
    assert.ok(preserved);
    writeFileSync(join(blockCache, preserved), JSON.stringify({ numPassedTests: 99 }));
    assert.equal(execute(plan, result, { blockCache }), 0);
    assert.equal(readFileSync(marker, "utf8").length, 2);
    assert.equal(JSON.parse(readFileSync(result, "utf8")).selected[0].reusedFrom, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fresh reports for one block preserve every previously referenced report", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-check-report-history-"));
  try {
    const result = join(directory, "result.json");
    const report = join(directory, "report.json");
    const counter = join(directory, "counter.txt");
    const blockCache = join(directory, "blocks");
    const plan = {
      mode: "relevant",
      inputs: { sourceSnapshot: "source" },
      skipped: [],
      selected: [
        {
          id: "reported",
          argv: [
            process.execPath,
            "-e",
            `
          const fs = require('fs');
          const count = fs.existsSync(process.argv[2]) ? Number(fs.readFileSync(process.argv[2], 'utf8')) + 1 : 1;
          fs.writeFileSync(process.argv[2], String(count));
          fs.writeFileSync(process.argv[1], JSON.stringify({ numPassedTests: count, numFailedTests: 0 }));
        `,
            report,
            counter,
          ],
          sourceOnly: true,
          report: { format: "vitest", path: report },
        },
      ],
    };
    assert.equal(execute(plan, result, { blockCache }), 0);
    const first = JSON.parse(readFileSync(result, "utf8")).selected[0];
    const firstBytes = readFileSync(first.report.preserved);
    rmSync(join(blockCache, `${first.blockKey}.json`));
    assert.equal(execute(plan, result, { blockCache }), 0);
    const second = JSON.parse(readFileSync(result, "utf8")).selected[0];
    assert.equal(second.blockKey, first.blockKey);
    assert.notEqual(second.report.preserved, first.report.preserved);
    assert.deepEqual(readFileSync(first.report.preserved), firstBytes);
    assert.equal(JSON.parse(readFileSync(second.report.preserved, "utf8")).numPassedTests, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed reinstall cannot retain an earlier successful install marker", () => {
  const wrapper = readFileSync(new URL("scripts/fork-build.sh", repoRoot), "utf8");
  const installers = new Map(
    [...wrapper.matchAll(/bash -euc '([\s\S]*?)'\s*(?:2>&1|bash)/g)]
      .map((match) => match[1])
      .filter((body) => body.includes("npm ci"))
      .map((body) => [body.includes("mode=$1") ? "package" : "check", body]),
  );
  for (const name of ["check", "package"]) {
    assert.ok(installers.has(name), `missing ${name} installer fixture`);
    const directory = mkdtempSync(join(tmpdir(), `failed-${name}-install-`));
    try {
      writeFileSync(join(directory, ".fork-dependencies"), "input-key\nold-generation\n");
      writeFileSync(join(directory, "fail-install"), "");
      const boundary = `
        node() { printf '%s\\n' input-key; }
        npm() {
          if [[ $1 == ci ]]; then
            mkdir -p node_modules
            printf '%s\\n' ci >> attempts
            [[ ! -f fail-install ]] || return 17
          fi
        }
      `;
      const run = () =>
        spawnSync("bash", ["-euc", boundary + installers.get(name), "bash", "baseline"], {
          cwd: directory,
          encoding: "utf8",
        });
      assert.equal(run().status, 17);
      assert.equal(existsSync(join(directory, "node_modules")), true);
      assert.equal(existsSync(join(directory, ".fork-dependencies")), false);
      rmSync(join(directory, "fail-install"));
      const retry = run();
      assert.equal(retry.status, 0, retry.stderr);
      const marker = readFileSync(join(directory, ".fork-dependencies"), "utf8").trim().split("\n");
      assert.equal(marker[0], "input-key");
      assert.notEqual(marker[1], "old-generation");
      assert.equal(run().status, 0);
      assert.equal(readFileSync(join(directory, "attempts"), "utf8"), "ci\nci\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("identical inputs reuse a passed block while changed inputs rerun it", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-check-reuse-"));
  try {
    const result = join(directory, "result.json");
    const marker = join(directory, "executions.txt");
    const blockCache = join(directory, "blocks");
    const plan = {
      mode: "relevant",
      inputs: {
        sourceSnapshot: "source",
        dependencyInstallIdentity: "dependencies",
        checkImage: "image",
        environment: {},
        resources: { workers: "4" },
      },
      skipped: [],
      selected: [
        {
          id: "reusable",
          argv: [
            process.execPath,
            "-e",
            "require('fs').appendFileSync(process.argv[1], 'x')",
            marker,
          ],
          tools: [],
          sourceOnly: true,
        },
      ],
    };
    assert.equal(execute(plan, result, { blockCache }), 0);
    assert.equal(execute(plan, result, { blockCache }), 0);
    assert.equal(readFileSync(marker, "utf8").length, 1);
    assert.ok(JSON.parse(readFileSync(result, "utf8")).selected[0].reusedFrom);
    const changed = {
      ...plan,
      inputs: { ...plan.inputs, resources: { workers: "8" } },
    };
    assert.equal(execute(changed, result, { blockCache }), 0);
    assert.equal(readFileSync(marker, "utf8").length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unknown checks without source-only metadata or prerequisites are not reused", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-check-unknown-"));
  try {
    const result = join(directory, "result.json");
    const marker = join(directory, "executions.txt");
    const blockCache = join(directory, "blocks");
    const plan = {
      mode: "relevant",
      inputs: {},
      skipped: [],
      selected: [
        {
          id: "unknown-check",
          argv: [
            process.execPath,
            "-e",
            "require('fs').appendFileSync(process.argv[1], 'x')",
            marker,
          ],
          tools: [],
        },
      ],
    };
    assert.equal(execute(plan, result, { blockCache }), 0);
    assert.equal(execute(plan, result, { blockCache }), 0);
    assert.equal(readFileSync(marker, "utf8").length, 2);
    assert.equal(JSON.parse(readFileSync(result, "utf8")).selected[0].reusedFrom, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dependency install identity requires a matching input key and generation", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-check-install-"));
  try {
    const marker = join(directory, "install");
    assert.equal(readDependencyInstallIdentity("key", marker), null);
    writeFileSync(marker, "key\ngeneration-one\n");
    const first = readDependencyInstallIdentity("key", marker);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(readDependencyInstallIdentity("other-key", marker), null);
    writeFileSync(marker, "key\n");
    assert.equal(readDependencyInstallIdentity("key", marker), null);
    writeFileSync(marker, "key\ngeneration-two\n");
    assert.notEqual(readDependencyInstallIdentity("key", marker), first);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dependent checks require a successful install identity and a new generation invalidates reuse", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-check-install-reuse-"));
  try {
    const result = join(directory, "result.json");
    const output = join(directory, "generated.txt");
    const marker = join(directory, "consumer-runs.txt");
    const blockCache = join(directory, "blocks");
    const plan = (dependencyInstallIdentity) => ({
      mode: "relevant",
      inputs: { sourceSnapshot: "source", dependencyInstallIdentity },
      skipped: [],
      selected: [
        {
          id: "install-preparation",
          argv: [
            process.execPath,
            "-e",
            "require('fs').writeFileSync(process.argv[1], 'built')",
            output,
          ],
          tools: [],
          preparation: true,
          outputs: [output],
        },
        {
          id: "install-consumer",
          argv: [
            process.execPath,
            "-e",
            "require('fs').appendFileSync(process.argv[1], 'x')",
            marker,
          ],
          tools: [],
          requires: ["install-preparation"],
        },
      ],
    });
    assert.equal(execute(plan(null), result, { blockCache }), 0);
    assert.equal(execute(plan(null), result, { blockCache }), 0);
    assert.equal(readFileSync(marker, "utf8").length, 2);
    assert.equal(JSON.parse(readFileSync(result, "utf8")).selected[1].reusedFrom, undefined);

    assert.equal(execute(plan("generation-one"), result, { blockCache }), 0);
    assert.equal(execute(plan("generation-one"), result, { blockCache }), 0);
    assert.equal(readFileSync(marker, "utf8").length, 3);
    assert.ok(JSON.parse(readFileSync(result, "utf8")).selected[1].reusedFrom);

    assert.equal(execute(plan("generation-two"), result, { blockCache }), 0);
    assert.equal(readFileSync(marker, "utf8").length, 4);
    assert.equal(JSON.parse(readFileSync(result, "utf8")).selected[1].reusedFrom, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("custom commands execute every time", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-check-custom-"));
  try {
    const result = join(directory, "result.json");
    const marker = join(directory, "executions.txt");
    const blockCache = join(directory, "blocks");
    const plan = {
      mode: "custom",
      inputs: {},
      skipped: [],
      selected: [
        {
          id: "custom",
          argv: [
            process.execPath,
            "-e",
            "require('fs').appendFileSync(process.argv[1], 'x')",
            marker,
          ],
          tools: [],
        },
      ],
    };
    assert.equal(execute(plan, result, { blockCache }), 0);
    assert.equal(execute(plan, result, { blockCache }), 0);
    assert.equal(readFileSync(marker, "utf8").length, 2);
    assert.ok(!JSON.parse(readFileSync(result, "utf8")).selected[0].reusedFrom);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("required tools are checked before a block receipt can be reused", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-check-tools-"));
  const previousPath = process.env.PATH;
  try {
    const result = join(directory, "result.json");
    const blockCache = join(directory, "blocks");
    const plan = {
      mode: "relevant",
      inputs: {},
      skipped: [],
      selected: [
        {
          id: "tool-check",
          argv: [process.execPath, "-e", "process.exit(0)"],
          tools: ["node"],
          sourceOnly: true,
        },
      ],
    };
    assert.equal(execute(plan, result, { blockCache }), 0);
    process.env.PATH = directory;
    assert.equal(execute(plan, result, { blockCache }), 2);
    const evidence = JSON.parse(readFileSync(result, "utf8"));
    assert.equal(evidence.selected[0].result, "unavailable");
  } finally {
    process.env.PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("interruption persists completed stages and leaves later work incomplete", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-check-interrupt-"));
  const runningPid = join(directory, "running.pid");
  const result = join(directory, "result.json");
  const blockCache = join(directory, "blocks");
  const script = join(directory, "execute-fixture.mjs");
  const plan = {
    mode: "relevant",
    inputs: { sourceSnapshot: "source", dependencyInstallIdentity: "dependencies" },
    skipped: [],
    selected: [
      {
        id: "saved-pass",
        argv: [process.execPath, "-e", "process.exit(0)"],
        tools: [],
        sourceOnly: true,
      },
      {
        id: "interrupted-stage",
        argv: [
          process.execPath,
          "-e",
          `require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)`,
          runningPid,
        ],
        tools: [],
      },
      { id: "later-stage", argv: [process.execPath, "-e", "process.exit(0)"], tools: [] },
    ],
  };
  let child;
  let fixturePid;
  try {
    writeFileSync(
      script,
      `import { execute } from ${JSON.stringify(
        pathToFileURL(new URL("scripts/fork-check-selection.mjs", repoRoot).pathname).href,
      )};\n` +
        `process.exitCode = execute(${JSON.stringify(plan)}, ${JSON.stringify(result)}, ` +
        `{ blockCache: ${JSON.stringify(blockCache)} });\n`,
    );
    child = spawn(process.execPath, [script], { cwd: repoRoot, stdio: "ignore" });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (existsSync(runningPid) && existsSync(result)) {
        const evidence = JSON.parse(readFileSync(result, "utf8"));
        if (evidence.selected[1].result === "running") break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const interrupted = JSON.parse(readFileSync(result, "utf8"));
    assert.equal(interrupted.selected[0].result, "passed");
    assert.equal(interrupted.selected[1].result, "running");
    assert.equal(interrupted.selected[2].result, "not-run");
    assert.equal(interrupted.result, "incomplete");
    assert.equal(interrupted.completedAt, null);

    fixturePid = Number(readFileSync(runningPid, "utf8"));
    child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    if (Number.isInteger(fixturePid) && fixturePid > 1 && fixturePid !== process.pid) {
      try {
        process.kill(fixturePid, "SIGKILL");
      } catch {
        // The owned fixture already exited.
      }
    }

    const retried = {
      ...plan,
      selected: [
        plan.selected[0],
        { id: "interrupted-stage", argv: [process.execPath, "-e", "process.exit(0)"], tools: [] },
        plan.selected[2],
      ],
    };
    assert.equal(execute(retried, result, { blockCache }), 0);
    const recovered = JSON.parse(readFileSync(result, "utf8"));
    assert.equal(recovered.result, "passed");
    assert.ok(recovered.selected[0].reusedFrom);
    assert.equal(recovered.selected[1].reusedFrom, undefined);
    assert.equal(recovered.selected[2].result, "passed");
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    if (Number.isInteger(fixturePid) && fixturePid > 1 && fixturePid !== process.pid) {
      try {
        process.kill(fixturePid, "SIGKILL");
      } catch {
        // The owned fixture already exited.
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Docker memory parsing matches bytes and binary unit suffixes before sizing the Node heap", () => {
  const wrapper = readFileSync(new URL("scripts/fork-build.sh", repoRoot), "utf8");
  const script = /<<'PY_MEMORY'\n([\s\S]*?)\nPY_MEMORY/.exec(wrapper)[1];
  for (const [value, expected] of [
    ["12g", "12288"],
    ["12GiB", "12288"],
    ["1073741824", "1024"],
    ["1048576k", "1024"],
  ]) {
    const result = spawnSync("python3", ["-c", script, value], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
  for (const value of ["2k", "32", "0g", "99999999999999999999999999g"])
    assert.notEqual(spawnSync("python3", ["-c", script, value]).status, 0);
});

test("the lightweight publication hook installer preserves existing hooks", () => {
  const directory = mkdtempSync(join(tmpdir(), "publication-hook-"));
  try {
    mkdirSync(join(directory, "scripts"));
    const installer = join(directory, "scripts/install-publication-hook.sh");
    writeFileSync(
      installer,
      readFileSync(new URL("scripts/install-publication-hook.sh", repoRoot)),
    );
    assert.equal(spawnSync("git", ["init", "--quiet", directory]).status, 0);
    const hook = join(directory, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho existing\n");
    assert.notEqual(spawnSync("bash", [installer]).status, 0);
    assert.equal(readFileSync(hook, "utf8"), "#!/bin/sh\necho existing\n");
    rmSync(hook);
    assert.equal(spawnSync("bash", [installer]).status, 0);
    assert.equal(spawnSync("bash", [installer]).status, 0);
    assert.match(readFileSync(hook, "utf8"), /exec bash scripts\/check-publication\.sh staged/);
    assert.doesNotMatch(readFileSync(hook, "utf8"), /npm|typecheck/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source staging removes stale test artifacts without following their symlink and preserves source inputs", () => {
  const wrapper = readFileSync(new URL("scripts/fork-build.sh", repoRoot), "utf8");
  const script = /python3 - "\$repo" "\$stage" <<'PY'\n([\s\S]*?)\nPY/.exec(wrapper)[1];
  const directory = mkdtempSync(join(tmpdir(), "check-source-snapshot-"));
  try {
    const source = join(directory, "source");
    const stage = join(directory, "stage");
    mkdirSync(source);
    mkdirSync(stage);
    assert.equal(spawnSync("git", ["init", "--quiet", source]).status, 0);
    for (const name of ["retained.txt", "deleted.txt"]) writeFileSync(join(source, name), name);
    assert.equal(
      spawnSync("git", ["add", "--", "retained.txt", "deleted.txt"], { cwd: source }).status,
      0,
    );
    rmSync(join(source, "deleted.txt"));
    mkdirSync(join(source, ".artifacts"), { recursive: true });
    writeFileSync(join(source, ".artifacts", "explicit-source-input.txt"), "source supplied");
    mkdirSync(join(source, "packages/app/.artifacts/evidence"), { recursive: true });
    writeFileSync(
      join(source, "packages/app/.artifacts/evidence/result.png"),
      "generated evidence",
    );
    mkdirSync(join(source, "packages/app/.vitest-attachments"), { recursive: true });
    writeFileSync(
      join(source, "packages/app/.vitest-attachments/stale.png"),
      "generated screenshot",
    );
    writeFileSync(join(stage, "deleted.txt"), "stale source");
    mkdirSync(join(stage, ".artifacts", "diff-subscription"), { recursive: true });
    writeFileSync(join(stage, ".artifacts", "diff-subscription", "metrics.json"), "stale test");
    mkdirSync(join(stage, "packages/app/.artifacts/evidence"), { recursive: true });
    writeFileSync(join(stage, "packages/app/.artifacts/evidence/result.png"), "stale evidence");
    mkdirSync(join(stage, "packages/app/.vitest-attachments"), { recursive: true });
    writeFileSync(join(stage, "packages/app/.vitest-attachments/stale.png"), "stale screenshot");
    writeFileSync(join(stage, ".fork-dependencies"), "preserved dependency key");
    const run = spawnSync("python3", ["-c", script, source, stage], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(stage, ".fork-source-files.json"))), [
      ".artifacts/explicit-source-input.txt",
      "retained.txt",
    ]);
    assert.equal(readFileSync(join(stage, "retained.txt"), "utf8"), "retained.txt");
    assert.throws(() => readFileSync(join(stage, "deleted.txt")), { code: "ENOENT" });
    assert.throws(() => readFileSync(join(stage, "packages/app/.artifacts/evidence/result.png")), {
      code: "ENOENT",
    });
    assert.throws(() => readFileSync(join(stage, "packages/app/.vitest-attachments/stale.png")), {
      code: "ENOENT",
    });
    assert.throws(
      () => readFileSync(join(stage, ".artifacts", "diff-subscription", "metrics.json")),
      {
        code: "ENOENT",
      },
    );
    assert.equal(
      readFileSync(join(stage, ".artifacts", "explicit-source-input.txt"), "utf8"),
      "source supplied",
    );
    assert.equal(
      readFileSync(join(stage, ".fork-dependencies"), "utf8"),
      "preserved dependency key",
    );

    const externalArtifacts = join(directory, "external-artifacts");
    mkdirSync(externalArtifacts);
    writeFileSync(join(externalArtifacts, "must-survive.txt"), "outside stage");
    rmSync(join(stage, ".artifacts"), { recursive: true, force: true });
    symlinkSync(externalArtifacts, join(stage, ".artifacts"));
    const symlinkRun = spawnSync("python3", ["-c", script, source, stage], { encoding: "utf8" });
    assert.equal(symlinkRun.status, 0, symlinkRun.stderr);
    assert.equal(
      readFileSync(join(externalArtifacts, "must-survive.txt"), "utf8"),
      "outside stage",
    );
    assert.equal(
      readFileSync(join(stage, ".artifacts", "explicit-source-input.txt"), "utf8"),
      "source supplied",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("local workflow-only changes select contracts without product builds", () => {
  for (const workflow of [
    "docker.yml",
    "nix.yml",
    "desktop-packages.yml",
    "deploy-app.yml",
    "android-apk-release.yml",
    "release-notes-sync.yml",
  ]) {
    const ids = selectChecks({ custom: [], allLinux: false }, [
      `.github/workflows/${workflow}`,
    ]).checks.map(([id]) => id);
    assert.ok(ids.includes("workflow-contracts"), workflow);
    assert.ok(!ids.some((id) => id.startsWith("build-")), workflow);
  }
});

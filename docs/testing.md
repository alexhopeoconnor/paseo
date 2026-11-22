# Testing

## Philosophy

Tests prove behavior, not structure. Every test should answer: "what user-visible or API-visible behavior does this verify?"

For this workstation fork, run Node/npm checks through the pinned Docker wrapper
described in [release.md](release.md#workstation-fork). Its staging checkout is
reused. A custom app check must rebuild `npm run build:app-deps` before importing
workspace packages; otherwise generated plugin/client output can belong to an
earlier source snapshot. Before a custom app typecheck, also run
`npm exec --workspace=@getpaseo/app -- expo customize tsconfig.json` in that
container to refresh ignored route declarations. The normal product selection
performs both prerequisites automatically.

## Test-driven development

Work in vertical slices: one test, one implementation, repeat. Each test responds to what you learned from the previous cycle.

```
RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3

WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5
```

Writing all tests first then all implementation produces bad tests — you end up testing imagined behavior instead of actual behavior.

## Fallible user actions

Every user action that can fail must expose the complete operation state in the UI:

- **Pending:** show immediate progress and prevent accidental duplicate submissions.
- **Success:** show the requested result, or a clear success acknowledgement when the result is not otherwise visible.
- **Failure:** keep an actionable error visible in the same context until the user retries or dismisses it.

Logs, console output, and a reset button are not user feedback. Neither is a platform API unless it is verified on every supported platform: React Native Web's `Alert.alert()` is a no-op, so browser and Electron failures must use rendered app UI such as the shared alert component.

Every fallible action needs behavioral coverage for success and failure. RPC-backed UI should use an app Playwright test with a real browser, network, and daemon whenever feasible. The failure test must assert what the user can see and do after the failure, not an internal response, state field, or log line. Add distinct timeout or disconnect cases when they produce distinct recovery behavior.

## Determinism first

Tests must produce the same result every run:

- No conditional assertions or branching paths
- No reliance on timing, randomness, or network jitter
- No weak assertions (`toBeTruthy`, `toBeDefined`)
- Assert the full intended behavior, not fragments

```typescript
// Bad: conditional and weak
it("creates a tool call", async () => {
  const result = await createToolCall(input);
  if (result.ok) {
    expect(result.id).toBeDefined();
  }
});

// Good: deterministic and explicit
it("returns timeout error when provider times out", async () => {
  const result = await createToolCall(input);
  expect(result).toEqual({
    ok: false,
    error: { code: "PROVIDER_TIMEOUT", waitedMs: 30000 },
  });
});
```

## Flaky tests are a bug

Never remove a test because it's flaky. Find the variance source (time, randomness, race condition, shared state, non-deterministic output, environment drift) and fix it.

## Real dependencies over mocks

Mocks are not the default. They require an explicit decision.

- **Database**: real test database, not a mock
- **APIs**: real APIs with test/sandbox credentials, not request mocks
- **File system**: temporary directory that gets cleaned up, not fs mocks

Ask: "will this still hold with real dependencies at runtime?" If no, don't mock.

### Use swappable adapters instead

When you need test isolation, design code so dependencies are injectable:

```typescript
interface EmailSender {
  send(to: string, body: string): Promise<void>;
}

// Production
const realSender: EmailSender = { send: sendgrid.send };

// Test: in-memory adapter
function createTestEmailSender() {
  const sent: Array<{ to: string; body: string }> = [];
  return {
    send: async (to: string, body: string) => {
      sent.push({ to, body });
    },
    sent,
  };
}
```

## End-to-end means end-to-end

When a test is labeled end-to-end, it calls the real service. No environment variable gates, no conditional skipping, no mocking the external dependency.

### Packaged desktop smoke

The local builder records the build, unpacked smoke and publication inspection. Release acceptance
also requires an installed-package smoke in a disposable Linux guest/root with the pinned builder's
dependencies. Install the exact candidate there, then run the existing observer as an unprivileged
user (never install a candidate on the live workstation merely to validate it):

```bash
# Inside the disposable guest/root only; package_file is the verified candidate .deb.
sudo dpkg --install "$package_file"
PASEO_DESKTOP_SMOKE_ARTIFACT_DIR=/out/installed-package \
  node packages/desktop/e2e/linux-artifact-smoke.js /inputs enabled --installed-only
```

Retain the candidate SHA256 with that receipt. The observer requires the installed sandbox helper
to be root-owned mode 4755 and verifies the actual sandboxed launch. An unpacked smoke alone does
not prove installation behavior. For the optional Codium smoke below, extract `--app` from the same
verified `.deb` named by `PASEO_DESKTOP_SMOKE_CODIUM_DEB`; its reported package hash is a caller
input, so the extraction command is part of the evidence binding.

### Release acceptance invocation

A release acceptance invocation records all of these together:

| Input                         | Codium smoke                                                                         | Overview package container                                            |
| ----------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Candidate package and SHA-256 | `PASEO_DESKTOP_SMOKE_CODIUM_DEB`, `PASEO_DESKTOP_SMOKE_CODIUM_EXPECT_PACKAGE_SHA256` | package at `/inputs/package.deb`, `OVERVIEW_EXPECT_PACKAGE_SHA256`    |
| Exact runtime                 | `PASEO_DESKTOP_SMOKE_CODIUM_EXPECT_RUNTIME_VERSION`                                  | `OVERVIEW_EXPECT_RUNTIME_VERSION`                                     |
| Plugin payload                | `PASEO_DESKTOP_SMOKE_CODIUM_PLUGIN_DIR`                                              | `OVERVIEW_TEST_PLUGIN_DIR`                                            |
| Runner revision               | checked-out smoke script and its commit                                              | checked-out `acceptance/package-container.sh` and its plugin revision |
| Expected host contract        | `PASEO_DESKTOP_SMOKE_CODIUM_MODE=fork` plus `--expect-fork-composer-checkpoint`      | `OVERVIEW_EXPECT_CHAT_PREVIEW_SETTINGS=required`                      |
| Result files                  | `codium-plugin.json` and the smoke artifact directory                                | Overview result JSON, logs and screenshots                            |

The Codium fixture treats all five environment inputs as one set: all absent skips
the plugin fixture, while a partial set fails. A generic smoke pass is not plugin
acceptance. Provide the extracted `--app` from the same `.deb` whose hash is
declared; a hash and an unrelated app directory do not make the receipt. Require
the plugin to load and the expected fork routing to be observed, not merely the
process to start. The simulated access probe does not prove authenticated editing
or companion pairing.

The Overview container has no scenario selector. Require
`OVERVIEW_EXPECT_CHAT_PREVIEW_SETTINGS=required` so a new version label cannot
silently disable configurable-preview checks. Record the plugin runner revision,
payload identity, package hash and runtime beside its result; an absent required
plugin result or a mismatched package/plugin pair fails acceptance.

Incomplete acceptance inputs, a wrong package/app binding and an absent required
plugin result are incomplete release evidence, not a pass with a note.

The packaged desktop smoke is an external observer of the production launch path. It must not add a smoke-only branch to Electron main or start the daemon itself.

The harness launches the packaged app with isolated user data and daemon state, connects to the real renderer over Chromium's debugging protocol, and requires all of these outcomes:

- the `paseo://app/` renderer mounts into `#root`;
- the sandboxed preload exposes the desktop bridge;
- the renderer starts a fresh desktop-managed daemon through the normal startup bootstrap;
- the bundled CLI can query that daemon and run a terminal command.

The inherited Desktop Packages workflow defines the Linux x64 smoke under Xvfb for main pushes and for pull requests that change `packages/desktop/**`, `nix/**`, or the workflow itself. This fork disables that workflow and runs its CI only on manual dispatch, so local acceptance uses the commands below. The Linux job is pinned to Ubuntu 24.04 and runs twice: with AppArmor user namespace restrictions enabled, then with user namespaces available. It installs the real `.deb`, launches the real AppImage via `--appimage-extract-and-run`, and launches the extracted tar archive. It also replaces the Debian installation with the generated RPM through `rpm --install --nodeps` and checks its sandboxed launch under restrictions. Ubuntu supplies the runtime libraries under Debian package names, so this verifies the RPM payload and postinstall rather than Fedora dependency resolution. Each launch verifies the reported sandbox decision; enabled renderers must also have `NoNewPrivs: 1` and `Seccomp: 2` in `/proc`. The desktop release matrix retains its host-native smokes. Linux release builds stay on Ubuntu 22.04 to preserve their native-library baseline; the restricted-host regression runs on Ubuntu 24.04 after merge.

Never repair `chrome-sandbox` in the smoke harness. The old unpacked smoke set its mode to 4755 and concealed a broken package installer. Run installer tests as root and launch tests as an ordinary user: a root-run namespace probe does not reproduce Ubuntu's AppArmor policy for desktop users. Preserve both restricted and unrestricted cases; either one alone permits another sandbox regression.

Smoke jobs upload renderer screenshots and desktop/daemon diagnostics, including successful Linux sandbox evidence.

To exercise the smoke locally on Linux:

```bash
PASEO_DESKTOP_SMOKE=1 \
PASEO_DESKTOP_SMOKE_ARTIFACT_DIR=/tmp/paseo-desktop-smoke \
npm run build:desktop -- --publish never --linux --x64 --dir
```

The workstation fork also accepts an optional prepared Codium plugin directory in
this same harness. Prepare a plain directory from the public Codium checkout at the
revision under test:

```bash
codium_source=/path/to/reviewed/paseo-codium
paseo_codium_plugin=$(mktemp -d /tmp/paseo-codium-plugin.XXXXXXXX)
git -C "$codium_source" archive HEAD | tar -xf - -C "$paseo_codium_plugin"
```

The directory must contain `paseo-plugin.json`, `package.json` and the plugin
entry sources, plus any production `node_modules` those sources import. Codium
takes its other runtime modules from the host. Do not stage `lock.json`,
`release.json` or `payload/` layouts; the smoke reads the plugin directory itself
and rejects `PASEO_DESKTOP_SMOKE_CODIUM_ARTIFACT` with a migration message.

Select the package, its runtime version and its mode, then run the following
**inside a pinned Linux builder** with the checkout's installed workspace
dependencies and built declarations, `dpkg-deb`, Xvfb and a Playwright Chromium:

```bash
package_file=/out/inputs/paseo.deb
package_sha256=$(sha256sum "$package_file" | awk '{print $1}')

export PASEO_DESKTOP_SMOKE_CODIUM_PLUGIN_DIR="$paseo_codium_plugin"
export PASEO_DESKTOP_SMOKE_CODIUM_DEB="$package_file"
export PASEO_DESKTOP_SMOKE_CODIUM_EXPECT_RUNTIME_VERSION="${SELECTED_RUNTIME_VERSION:?set the daemon version for this package}"
export PASEO_DESKTOP_SMOKE_CODIUM_EXPECT_PACKAGE_SHA256="$package_sha256"
export PASEO_DESKTOP_SMOKE_CODIUM_MODE="${SELECTED_MODE:?set stock or fork}"
export PASEO_DESKTOP_SMOKE_ARTIFACT_DIR=/out/codium-smoke
paseo_smoke_root=$(mktemp -d /tmp/paseo-package-smoke.XXXXXXXX)
trap 'rm -rf -- "$paseo_smoke_root"' EXIT
dpkg-deb --extract "$PASEO_DESKTOP_SMOKE_CODIUM_DEB" "$paseo_smoke_root"
node packages/desktop/e2e/packaged-app-smoke.js \
  --app "$paseo_smoke_root/opt/Paseo" --expect-fork-composer-checkpoint
```

`--expect-fork-composer-checkpoint` is part of fork acceptance, not optional
decoration: it requires the fork composer checkpoint behavior in addition to the
generic packaged smoke. Stock runs omit it and use `SELECTED_MODE=stock`.

Use the same plugin directory for each package you test. Set
`SELECTED_RUNTIME_VERSION` to the daemon version reported by that package and
`SELECTED_MODE` to `stock` for a retained upstream package or `fork` for a fork
package. The harness compares the `.deb` SHA256 with the computed value, reads the
ordinary `paseo-plugin.json` identity, copies the directory into disposable daemon state,
and requires the running daemon version to match. It opens the daemon's packaged
`resources/app-dist` in ordinary Playwright Chromium. The isolated daemon enables
its web UI without a distribution-directory override. A clean browser uses the
server's real connection hint, with no Electron bridge or seeded host registry.
The existing Electron renderer, CLI and terminal smoke still runs first. It
expects stock's intermediate file tab and the fork's confirmed direct editor
open. The fork must leave both the editor and file tab absent before
confirmation.

All daemon, user and runtime directories are temporary state owned by the run and
are removed by the existing cleanup. An intercepted HTTPS fixture simulates the
nonce-bound access-ready message when the plugin requests it, then serves an inert
editor frame. It does not contact Codium or use credentials. This proves
plugin loading, capability-dependent routing and frame creation; it does not
prove companion pairing, authenticated editing, long-lived retention or
installed-host sandbox policy. Those remain existing browser regression and live
acceptance checks. `codium-plugin.json` records the plugin manifest identity and
version, package hash, daemon version, ordinary-browser marker/origin, simulated
access probes and observed routing result beside the normal smoke evidence. Neither input implies managed
approval. The existing renderer screenshot captures this browser when the optional
fixture is enabled. Never mount live Paseo or Codium state or a host runtime socket
into these checks.

### Undeclared peer dependencies break app.asar

electron-builder packs `node_modules` by walking declared production `dependencies`. A package that imports something it only lists as a `peerDependency` resolves fine in this hoisted workspace, passes every test, and then throws `ERR_MODULE_NOT_FOUND` inside `app.asar` — killing the desktop daemon at startup. That shipped twice from `@replit/codemirror-lang-*` grammars, which are interactive editor extensions published as if they were bare parsers.

The packaged smoke catches it after merge. PRs need the fast dependency-closure test below because packaging runs on main.

`packages/highlight/src/__tests__/dependency-closure.test.ts` replicates the packer's traversal statically and runs with the normal unit tests. It is scoped to `@getpaseo/highlight` on purpose: that tree is small and pure, so the check is exact. Running the same walk over `@getpaseo/server` produces dozens of false positives from optional dependencies loaded behind `try`/`catch`.

Prefer a `@lezer/*` grammar. When a language only ships inside an editor extension, vendor the grammar into `packages/highlight/src/<lang>/` — see `svelte/`, `nix/`, and `csharp/`.

### Desktop browser regression

The desktop browser E2E launches an isolated real daemon, Metro, and Electron app. It forces workspace LRU eviction to reparent the original tab and replace its guest `WebContents`, then makes one MCP call each for tab listing, snapshot, and click against that original browser id. A final MCP wait proves the real target page received the click.

Run it locally with the same command owned by the Ubuntu `desktop-tests` required check:

```bash
npm run test:e2e:browser-tabs --workspace=@getpaseo/desktop
```

## Test organization

- Collocate tests with implementation: `thing.ts` + `thing.test.ts`
- Extract complex setup into reusable helpers
- Test bodies should read like plain English
- Build a vocabulary of test helpers that make complex flows simple

### File naming

Vitest picks up tests by suffix. The suffix tells the runner which category it belongs to.

| Suffix                | What it is                                                                                                    | Where it runs                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `*.test.ts(x)`        | Unit test — pure, fast, no daemon                                                                             | `npm run test:unit`                                                                  |
| `*.posix.test.ts`     | Unit test that needs POSIX-only behavior                                                                      | unit, skipped on Windows                                                             |
| `*.browser.test.ts`   | App test that needs a real browser (DOM)                                                                      | `npm run test:browser` (Vitest browser mode, Playwright provider, headless Chromium) |
| `*.e2e.test.ts`       | End-to-end against a real daemon                                                                              | `npm run test:e2e`                                                                   |
| `*.real.e2e.test.ts`  | E2E that hits a real provider (Claude/Codex/Copilot/OpenCode/Pi) — needs creds in `packages/server/.env.test` | `npm run test:integration:real` / `test:e2e:real`                                    |
| `*.local.e2e.test.ts` | E2E that needs a local-only resource                                                                          | `npm run test:integration:local` / `test:e2e:local`                                  |

Browser Playwright specs live in `packages/app/e2e/browser/`. Desktop Playwright and real-Electron E2E live in `packages/desktop/e2e/`. Harness code shared by both suites lives in `packages/app/e2e/support/`; neither suite may place specs there. App Playwright specs that hit real providers use `*.real.spec.ts` and run through `npm run test:e2e:real --workspace=@getpaseo/app`; the default browser project ignores that suffix so CI does not need provider credentials.

Live provider smoke tests belong in `*.real.e2e.test.ts`, not `*.test.ts`, even when guarded by environment variables. Default unit suites must use deterministic provider adapters/fakes so missing credits, auth outages, and upstream model drift do not block normal CI.

Codex MultiAgentV2 real tests use local Codex authentication rather than the OpenRouter-compatible test provider. OpenRouter does not accept Codex collaboration-history items on the parent follow-up request, so it cannot verify a complete native sub-agent turn.

### Test setup

- Server: `packages/server/src/test-utils/vitest-setup.ts` loads `.env.test`, sets `PASEO_SUPERVISED=0`, and disables Git/SSH prompts. Add new global env shims here, not in individual tests.
- App: `packages/app/vitest.setup.ts` provides `expo`/`__DEV__` shims and stubs a few native-only modules (`react-native-unistyles`, `react-native-svg`, `expo-linking`, `@xterm/addon-ligatures`). Stubbing here is for modules that have no meaningful Node behavior — not a license to mock app code.

## Running tests locally

Run JavaScript checks through the pinned fork wrapper. Start with the smallest
existing test or scenario that proves the changed behavior, plus affected
lint/type checks. Prepare the owning declarations first.

```bash
bash scripts/fork-build.sh check --base FULL_ANCESTOR_COMMIT --plan
bash scripts/fork-build.sh check --base FULL_ANCESTOR_COMMIT
bash scripts/fork-build.sh check --all-linux
```

- Use an actual file or test-name selector owned by the package. Zero matches, skipped cases and interrupted runs are not evidence.
- Changed unit or browser test files select their own project and real prerequisites. Shared helpers, configuration, lockfiles, protocol/persistence/provider and plugin API changes remain conservatively broader.
- Use `--all-linux` deliberately for a settled candidate. A broad sweep redirects output to a file and reads it afterwards when direct output is unwieldy.
- Reuse a passed receipt only when source, dependencies, tools, environment and required generated outputs still match. Another agent's green report alone is not that proof. A successful install generation is part of that identity, so a later `npm ci` invalidates dependent receipts.
- Report-backed checks require a fresh JSON report with at least one executed pass. Chained or custom aggregate runners have no single owning report; they remain uncached and their command log must be reviewed until the runner provides a receipt.
- Custom commands always execute; they can change the staged source and are never reused as cached evidence.
- Hosted CI is manual-only and is not a routine validation step.
- App Playwright shares one warmed Metro server per run and gives every Playwright worker its own isolated daemon and `PASEO_HOME`. Spec files run concurrently without exposing one file's projects, agents, terminals, history, or provider configuration to another worker; tests within a file remain together so file-level setup is not repeated.
- Playwright specs that exercise only the daemon import `daemonTest` from the shared fixtures so they do not create a browser context or page.
- Helpers that create projects or workspaces own those records until cleanup. Their clients remove the daemon project on close, and an automatic fixture fails any test that still leaks a project record. Deleting only the temporary directory is not cleanup. Agent helpers pass the intended `workspaceId` through to agent creation; they never infer ownership from `cwd`.
- Tests whose subject is daemon-global state, such as an empty history or daemon restart, start a dedicated host explicitly. Filenames and directories describe product behavior, never execution order or isolation mechanics.
- Global setup accepts Metro as ready only when `/status` returns `packager-status:running`, then fetches the document's scripts so the cold bundle compilation finishes before Playwright's per-test timeout starts. A generic TCP listener is not sufficient readiness evidence. The browser suite uses direct local daemon connections and does not start a relay. Automated Metro launches set `EXPO_UNSTABLE_HEADLESS=1` so Expo does not download the native DevTools shell into temporary test homes; its read-only cache breaks teardown. Browser fixtures and the standalone Electron browser runner share the developer-toast dismissal helper while retaining console logs. A pointer click moves hover away from the tested control and stalls behind app modal backdrops.
- The app Playwright harness boots on Windows as well as POSIX. Spawn Node entrypoints through `process.execPath`, not `npx` or `node_modules/.bin` shims: Node refuses to spawn `.cmd` or `.bat` without `shell: true`, and shell mode concatenates argv without escaping and sends kill signals to `cmd.exe` instead of the real child.
- Teardown kills the process tree, because a Windows signal reaches only the direct child and leaves forked workers holding the listening port.
- The `asdf`-backed local Elixir relay stays POSIX-only, so the `relay-deployment` Playwright project is unavailable on Windows.

## CI test routing

This fork runs CI by manual dispatch with `affected`, `full-linux`, or `compatibility` scope. The affected scope routes checks by the behavior each suite proves, using `.github/ci-paths.yml`. A package does not inherit every test suite of its runtime consumers: app changes do not run CLI or Electron-wrapper tests, and protocol changes do not run every package that imports the protocol. Cross-package static compatibility belongs to `typecheck`; choose explicit full Linux or cross-platform coverage through the [fork CI scopes](release.md#workstation-fork).

Required matrix legs are declared as statically named jobs. Their shared steps use YAML anchors, while job-level `if` conditions let GitHub report an unaffected leg as genuinely skipped without allocating a runner or losing the exact required-check name.

The smallest meaningful contract wins over package ownership. Tiny structural invariants such as daemon launch supervision run unconditionally in the always-running routing job instead of maintaining a transitive file list; this check reads source entrypoints and builds no product. Routed integration contracts use stable domain directories. Browser changes select the required Playwright shards; desktop changes select the existing required desktop jobs, with renderer and real-Electron coverage together in the Ubuntu leg. Publication scanner, ignore and hook policy changes select the workflow and publication-policy contracts instead of every browser suite. Upstream packaging runs on main in the Desktop Packages, Docker, and Nix workflows; those inherited workflows are guarded to `getpaseo/paseo` and do not package this fork. Use the local pinned builder and package acceptance commands instead. CLI-side Hub changes select one focused test inside the existing required server jobs. The CLI source suite runs once in the third required CLI job; only the separate local E2E runner is sharded, and that runner owns its dependency build. Other repository scripts and the shared Vitest configuration select the full applicable contract set because they affect the toolchain.

## Agent authentication in tests

Default suites use deterministic adapters and do not require production
credentials. Run explicitly selected provider/credential-publication acceptance
at its documented boundary; missing prerequisites are incomplete evidence.
Do not add environment-variable skips to default suites.

## Debugging with tests

Use the test as your debugging ground:

1. Add temporary logging to the code under test
2. Run the test, observe actual values
3. Trace the flow end-to-end through test output
4. Confirm each assumption with actual output
5. Remove logging when done

The test output is the source of truth, not your reading of the code.

## Design for testability

If code isn't testable, refactor it. Signs:

- You want to reach for a mock
- You can't inject a dependency
- You need to test private internals
- Setup requires too much global state

Aim for deep modules: small interface, deep implementation. Fewer methods = fewer tests needed, simpler params = simpler setup.

## Test boundaries

Each test names the observable contract, the real implementation exercised, and
the controlled boundary. Prefer existing injected adapters. A component mount,
narrow module substitute or local server fixture is acceptable when it exercises
the relevant real state/interaction and has explicit limits. Do not mock the
behavior being proved. Keep browser, real-adapter and exact-package acceptance
where the boundary test cannot establish that behavior. Refactor a production
seam when it improves the design, not solely to satisfy a test-category rule.

The default suites still aim for deterministic, fast tests. A real layout or
hydration regression may keep a mounted component test when a narrower substitute
would miss the failure; record the boundary and keep the assertion behavioral.

# AGENTS.md — Paseo Server Development Guide

For AI coding agents working in `packages/server`. Supplements [CLAUDE.md](../../CLAUDE.md) at the repo root.

## Project Overview

Paseo is a mobile + CLI app for monitoring and controlling local AI coding agents (Claude Code, Codex, GitHub Copilot, OpenCode, Pi). The daemon runs on your machine, manages agent processes, and streams their output over WebSocket to clients.

---

## Build / Lint / Test Commands

Run commands from the repository root through the pinned fork check wrapper:

```bash
bash scripts/fork-build.sh check -- COMMAND...
```

For a server unit file, use `npm run test:unit --workspace=@getpaseo/server --
src/server/agent/agent-manager.test.ts` inside that wrapper. Narrow by an actual
test name only after checking the file. Select integration/provider suites by the
behavior being changed; a unit filename passed to the aggregate `test` script
does not narrow every command chained by that script. Refresh `build:server`
when server/CLI generated dependencies are needed. Follow the root guide for
resource limits, formatting, signing and process ownership.

### Server package (`packages/server`), inside that wrapper

```bash
npm run build:server                     # Build relay, protocol, client, server, CLI
npm run typecheck:server                 # Typecheck the owning server stack
npm run test:unit --workspace=@getpaseo/server -- FILE
npm run test:integration --workspace=@getpaseo/server
npm run test:e2e --workspace=@getpaseo/server
```

Do not call `db:query`; it is not a root npm script. Use the CLI, daemon logs,
and the owning tests for diagnostics.

---

## Code Style

### oxfmt (formatting only, no linting)

```json
{
  "indentStyle": "space",
  "indentWidth": 2,
  "lineWidth": 100,
  "quoteStyle": "double",
  "trailingCommas": "all",
  "semicolons": "always"
}
```

Format affected files with `npm run format:files -- FILE...`; use repo-wide
`npm run format` only for deliberate normalization. Lint through `npm run lint`.
The check wrapper stages source, so formatting there changes only the staging
checkout. Copy the intended formatted files back deliberately and review them;
never copy generated files wholesale.

### TypeScript

- **Fully strict** — no `any`, no implicit `any`
- **`interface`** over `type`\*\* when possible
- **`function` declarations** over arrow function assignments
- **Named types** — no complex inline types in public signatures
- **Object parameters** — use single object param when >1 argument
- **Infer from Zod schemas** — `z.infer<typeof schema>` instead of hand-written types
- `noUnusedLocals: true`, `noUnusedParameters: true`, `noFallthroughCasesInSwitch: true`

### Imports

- Use relative `.js` paths for imports within shipped server code, including type imports. TypeScript preserves `@server/*` aliases in JavaScript and declarations, and production Node has no alias resolver. Vitest tests support the alias.
- No barrel `index.ts` re-exports — they create unnecessary indirection

### Naming

- Files: `kebab-case.ts` named after the main export (`create-tool-call.ts`)
- Tests: collocated with implementation (`thing.test.ts`)
- No prefixes like `RpcX`, `DbX`, `UiX` — keep one canonical type per concept

### Error Handling

- **Fail explicitly** — throw instead of silently returning defaults
- **Typed domain errors** — extend `Error` with structured metadata

```typescript
class TimeoutError extends Error {
  constructor(
    public readonly operation: string,
    public readonly waitedMs: number,
  ) {
    super(`${operation} timed out after ${waitedMs}ms`);
    this.name = "TimeoutError";
  }
}
```

### State Design

Discriminated unions over bags of booleans/optionals:

```typescript
// Bad
interface FetchState {
  isLoading: boolean;
  error?: Error;
  data?: Data;
}

// Good
type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "success"; data: Data };
```

---

## Testing Philosophy

Tests prove behavior, not structure. Every test should answer: "what user-visible or API-visible behavior does this verify?"

- **TDD**: Work in vertical slices — one test, one implementation, repeat
- **Determinism first**: No conditional assertions, no timing/randomness, no weak assertions
- **Prefer real dependencies**: Use existing injected adapters; name the one boundary the test controls
- **Do not mock the behavior being proved**
- **Flaky tests are a bug**: Never remove a test because it's flaky; fix the variance source

Default suites use deterministic adapters and do not require production
credentials. Run explicitly selected provider/credential-publication acceptance
at its documented boundary; missing prerequisites are incomplete evidence.

---

## Critical Rules

1. **Never restart the daemon on port 6767 from an agent session** — it kills your own process and interrupts other work. Live cutover is a separately authorized operation from an independent host path that survives it; explicit user authorization does not make an in-session restart safe.
2. **NEVER assume timeouts need a restart** — they can be transient
3. **Run focused checks through the pinned wrapper**; build owning declarations before diagnosing cross-package type errors
4. **Do not add production credentials to default suites**
5. **NEVER make breaking WebSocket/message schema changes** — always backward-compatible

---

## Architecture Quick Reference

```
packages/server/src/
├── server/
│   ├── index.ts              # Entry point
│   ├── bootstrap.ts           # Daemon initialization
│   ├── websocket-server.ts   # WS connection management
│   ├── session.ts             # Per-client session state
│   └── agent/
│       ├── agent-manager.ts  # Agent lifecycle state machine
│       └── agent-storage.ts  # File-backed JSON persistence
├── providers/                 # Claude, Codex, Copilot, OpenCode, Pi adapters
├── relay-transport.ts        # Outbound relay connection
```

Agent state persists to `$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json`  
Daemon logs: `$PASEO_HOME/daemon.log`

---

## Debugging

```bash
tail -f "$PASEO_HOME/daemon.log"           # Daemon logs
npm run test:ui --workspace=@getpaseo/server
npm run cli -- agent inspect <agent-id>    # Detailed agent info
```

---

## Relevant Docs

| File                                                             | What it covers                                   |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| [../../CLAUDE.md](../../CLAUDE.md)                               | Repository overview, critical rules, quick start |
| [../../docs/architecture.md](../../docs/architecture.md)         | System design, WebSocket protocol, data flow     |
| [../../docs/coding-standards.md](../../docs/coding-standards.md) | Type hygiene, error handling, React patterns     |
| [../../docs/testing.md](../../docs/testing.md)                   | TDD workflow, determinism, test boundaries       |
| [../../SECURITY.md](../../SECURITY.md)                           | Relay threat model, E2E encryption               |

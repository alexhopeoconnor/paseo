import { expect, test } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { AgentStorage, parseStoredAgentRecord } from "../agent-storage.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { readPersistedConfig } from "../../persisted-config.js";
import { createRestartRecovery } from "./index.js";

test("recovery saves intent before normalization, clears before dispatch, and resumes each agent independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    for (const [id, lastStatus] of [
      ["broken", "running"],
      ["stuck", "running"],
      ["working", "running"],
      ["idle", "idle"],
      ["initializing", "initializing"],
    ] as const) {
      await storage.upsert(
        parseStoredAgentRecord({
          id,
          lastStatus,
          provider: "codex",
          cwd: root,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
    }
    const dispatched: string[] = [];
    const recovery = createRestartRecovery({
      storage,
      settings: () => ({ enabled: true, prompt: "Continue verbatim.\n" }),
      eligible: async () => true,
      dispatch: async (id, prompt) => {
        expect((await storage.get(id))?.resumeOnStartup).toBe(false);
        if (id === "broken") throw new Error("unavailable");
        if (id === "stuck") return new Promise(() => {});
        dispatched.push(id + prompt);
      },
      report: () => {},
    });
    await recovery.prepareStartup();
    expect((await storage.get("working"))?.resumeOnStartup).toBe(true);
    expect((await storage.get("working"))?.lastStatus).toBe("closed");
    recovery.resumePending();
    const running = new AbortController().signal;
    await recovery.waitForResume("broken", running);
    await recovery.waitForResume("working", running);
    await recovery.waitForResume("idle", running);
    expect(dispatched).toEqual(["workingContinue verbatim.\n"]);
    const stopped = new AbortController();
    stopped.abort();
    await expect(recovery.waitForResume("stuck", stopped.signal)).rejects.toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-out consumes pending recovery and excludes archived, private, owned and archived-workspace agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    for (const extra of [
      { id: "running" },
      { id: "archived", archivedAt: "today" },
      { id: "private", internal: true },
      { id: "owned", owner: { kind: "daemon", daemonId: "hub", executionId: "run" } },
      { id: "workspace", workspaceId: "archived" },
    ]) {
      await storage.upsert(
        parseStoredAgentRecord({
          lastStatus: "running",
          provider: "codex",
          cwd: root,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...extra,
        }),
      );
    }
    let enabled = true;
    const dispatched: string[] = [];
    const recovery = createRestartRecovery({
      storage,
      settings: () => ({ enabled, prompt: "Resume working." }),
      eligible: async (record) => record.workspaceId !== "archived",
      dispatch: async (id) => {
        dispatched.push(id);
      },
      report: () => {},
    });
    await recovery.captureRunningAgents();
    expect((await storage.get("running"))?.resumeOnStartup).toBe(true);
    enabled = false;
    await recovery.prepareStartup();
    enabled = true;
    recovery.resumePending();
    expect(dispatched).toEqual([]);
    expect((await storage.listAll()).every((record) => !record.resumeOnStartup)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const bashAvailable =
  process.platform !== "win32" &&
  spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
for (const seeder of ["setup", "shell", "setup-bom"] as const) {
  test.skipIf(seeder === "shell" && !bashAvailable)(
    `${seeder} seed never dispatches copied running or pending agents and excludes automation`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "inert-seed-"));
      try {
        const source = join(root, "source");
        const targetRoot = join(root, "target");
        const target = join(targetRoot, ".dev/paseo-home");
        const storage = new AgentStorage(join(root, "source-records"), createTestLogger());
        for (const [id, lastStatus, resumeOnStartup] of [
          ["live", "running", false],
          ["crashed", "running", true],
          ["stopped", "closed", true],
        ] as const) {
          await storage.upsert(
            parseStoredAgentRecord({
              id,
              lastStatus,
              resumeOnStartup,
              provider: "codex",
              cwd: root,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }),
          );
        }
        await storage.flush();
        await mkdir(source, { recursive: true });
        await symlink(
          join(root, "source-records"),
          join(source, "agents"),
          process.platform === "win32" ? "junction" : "dir",
        );
        await mkdir(join(source, "schedules"), { recursive: true });
        await writeFile(join(source, "schedules", "schedule.json"), '{"kind":"scheduled"}');
        await writeFile(join(source, "schedules", "heartbeat.json"), '{"kind":"heartbeat"}');
        await writeFile(
          join(source, "config.json"),
          (seeder === "setup-bom" ? "\uFEFF" : "") +
            JSON.stringify({
              version: 1,
              agents: { resumeOnStartup: true, resumePrompt: "Continue" },
            }),
        );
        const repo = fileURLToPath(new URL("../../../../../../", import.meta.url));
        const env = {
          ...process.env,
          PASEO_SOURCE_CHECKOUT_PATH: join(root, "checkout"),
          PASEO_WORKTREE_PATH: targetRoot,
          PASEO_DEV_SEED_HOME: source,
          PASEO_HOME: target,
        };
        if (seeder !== "shell")
          execFileSync(process.execPath, [join(repo, "scripts/seed-worktree-dev-state.mjs")], {
            env,
          });
        else {
          const linkedRepo = join(root, "linked-checkout");
          await symlink(repo, linkedRepo, "dir");
          execFileSync("bash", [join(linkedRepo, "scripts/dev-home.sh")], { env });
        }
        expect((await readdir(target)).sort()).toEqual(["agents", "config.json"]);
        const config = readPersistedConfig(target);
        const copied = new AgentStorage(join(target, "agents"), createTestLogger());
        const dispatched: string[] = [];
        const recovery = createRestartRecovery({
          storage: copied,
          settings: () => ({
            enabled: config.agents?.resumeOnStartup === true,
            prompt: "Continue",
          }),
          eligible: async () => true,
          dispatch: async (id) => {
            dispatched.push(id);
          },
          report: () => {},
        });
        await recovery.prepareStartup();
        recovery.resumePending();
        for (const record of await copied.listAll())
          await recovery.waitForResume(record.id, new AbortController().signal);
        expect(dispatched).toEqual([]);
        expect((await copied.listAll()).map((r) => [r.lastStatus, r.resumeOnStartup])).toEqual([
          ["closed", false],
          ["closed", false],
          ["closed", false],
        ]);
        expect(readPersistedConfig(source).agents?.resumeOnStartup).toBe(true);
        const unchangedSource = new AgentStorage(join(root, "source-records"), createTestLogger());
        expect((await unchangedSource.get("live"))?.lastStatus).toBe("running");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

test("seeding skips an existing home without reading invalid source config", async () => {
  const root = await mkdtemp(join(tmpdir(), "seed-skip-"));
  try {
    const source = join(root, "source");
    const targetRoot = join(root, "target");
    const target = join(targetRoot, ".dev/paseo-home");
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, "config.json"), "invalid JSON");
    await writeFile(join(target, "keep.json"), "{}");
    const repo = fileURLToPath(new URL("../../../../../../", import.meta.url));
    execFileSync(process.execPath, [join(repo, "scripts/seed-worktree-dev-state.mjs")], {
      env: {
        ...process.env,
        PASEO_SOURCE_CHECKOUT_PATH: join(root, "checkout"),
        PASEO_WORKTREE_PATH: targetRoot,
        PASEO_DEV_SEED_HOME: source,
        PASEO_DEV_RESET_HOME: "0",
      },
    });
    expect(await readdir(target)).toEqual(["keep.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("never schedules a record carrying unresolved archive intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    const intent = {
      version: 1,
      operation: "archive",
      requestedAt: "2026-11-17T00:00:00.000Z",
    };
    await storage.upsert(
      parseStoredAgentRecord({
        id: "guarded",
        lastStatus: "running",
        resumeOnStartup: true,
        provider: "codex",
        cwd: root,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        paseoArchiveStopIntent: intent,
      }),
      { createArchiveStopIntent: true },
    );

    let eligibilityChecks = 0;
    const dispatched: string[] = [];
    const recovery = createRestartRecovery({
      storage,
      settings: () => ({ enabled: true, prompt: "Continue." }),
      eligible: async () => {
        eligibilityChecks += 1;
        return true;
      },
      dispatch: async (agentId) => {
        dispatched.push(agentId);
      },
      report: () => {},
    });

    await recovery.captureRunningAgents();
    await recovery.prepareStartup();
    recovery.resumePending();
    await recovery.waitForResume("guarded", new AbortController().signal);

    expect(eligibilityChecks).toBe(0);
    expect(dispatched).toEqual([]);
    expect((await storage.get("guarded"))?.paseoArchiveStopIntent).toEqual(intent);
    expect((await storage.get("guarded"))?.resumeOnStartup).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  {
    name: "valid",
    marker: {
      version: 1,
      operation: "archive",
      provider: "codex",
      sessionId: "native-session",
      nativeHandle: "native-handle",
      requestedAt: "2026-11-17T00:00:00.000Z",
    },
  },
  {
    name: "malformed-present",
    marker: { version: 99, operation: "unknown" },
  },
])("never schedules a $name persisted native-stop guard", async ({ marker }) => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    await storage.upsert(
      parseStoredAgentRecord({
        id: "native-guarded",
        lastStatus: "running",
        resumeOnStartup: true,
        provider: "codex",
        cwd: root,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        persistence: {
          provider: "codex",
          sessionId: "native-session",
          nativeHandle: "native-handle",
          metadata: { paseoArchiveStopPending: marker },
        },
      }),
      { createArchiveStopPending: true },
    );

    let eligibilityChecks = 0;
    const dispatched: string[] = [];
    const recovery = createRestartRecovery({
      storage,
      settings: () => ({ enabled: true, prompt: "Continue." }),
      eligible: async () => {
        eligibilityChecks += 1;
        return true;
      },
      dispatch: async (agentId) => {
        dispatched.push(agentId);
      },
      report: () => {},
    });

    await recovery.captureRunningAgents();
    await recovery.prepareStartup();
    recovery.resumePending();
    await recovery.waitForResume("native-guarded", new AbortController().signal);

    const guarded = await storage.get("native-guarded");
    expect(eligibilityChecks).toBe(0);
    expect(dispatched).toEqual([]);
    expect(guarded?.resumeOnStartup).toBe(true);
    expect(guarded?.persistence?.metadata?.paseoArchiveStopPending).toEqual(marker);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  {
    name: "valid root intent",
    kind: "intent" as const,
    marker: {
      version: 1,
      operation: "archive",
      requestedAt: "2026-11-18T00:00:00.000Z",
    },
  },
  {
    name: "malformed-present root intent",
    kind: "intent" as const,
    marker: { version: 99, operation: "unknown", preserved: true },
  },
  {
    name: "valid native pending marker",
    kind: "native" as const,
    marker: {
      version: 1,
      operation: "archive",
      provider: "codex",
      sessionId: "restart-native-session",
      nativeHandle: "restart-native-handle",
      requestedAt: "2026-11-18T00:00:00.000Z",
    },
  },
  {
    name: "malformed-present native pending marker",
    kind: "native" as const,
    marker: { version: 99, operation: "unknown", preserved: "raw-native-marker" },
  },
])(
  "does not consume a selected resume when a $name arrives before dispatch",
  async ({ kind, marker }) => {
    const root = await mkdtemp(join(tmpdir(), "restart-recovery-consume-race-"));
    try {
      const storage = new AgentStorage(root, createTestLogger());
      const agentId = `resume-guard-${kind}-${marker.version}`;
      await storage.upsert(
        parseStoredAgentRecord({
          id: agentId,
          lastStatus: "running",
          resumeOnStartup: true,
          provider: "codex",
          cwd: root,
          createdAt: "2026-11-18T00:00:00.000Z",
          updatedAt: "2026-11-18T00:00:00.000Z",
        }),
      );

      let eligibilityChecks = 0;
      const dispatched: string[] = [];
      const recovery = createRestartRecovery({
        storage,
        settings: () => ({ enabled: true, prompt: "Continue." }),
        eligible: async () => {
          eligibilityChecks += 1;
          return true;
        },
        dispatch: async (id) => {
          dispatched.push(id);
        },
        report: () => {},
      });

      // Startup selection intentionally happens before the guard is persisted.
      // The resume lane must consume its flag against the serialized current
      // record rather than the old selected snapshot.
      await recovery.prepareStartup();
      expect((await storage.get(agentId))?.resumeOnStartup).toBe(true);
      eligibilityChecks = 0;

      const selected = await storage.get(agentId);
      if (!selected) throw new Error("expected selected resume record");
      if (kind === "intent") {
        await storage.upsert(
          { ...selected, paseoArchiveStopIntent: marker },
          { createArchiveStopIntent: true },
        );
      } else {
        await storage.upsert(
          {
            ...selected,
            persistence: {
              provider: "codex",
              sessionId: "restart-native-session",
              nativeHandle: "restart-native-handle",
              metadata: { paseoArchiveStopPending: marker },
            },
          },
          { createArchiveStopPending: true },
        );
      }

      recovery.resumePending();
      await recovery.waitForResume(agentId, new AbortController().signal);

      const after = await storage.get(agentId);
      expect(eligibilityChecks).toBe(0);
      expect(dispatched).toEqual([]);
      expect(after?.resumeOnStartup).toBe(true);
      if (kind === "intent") {
        expect(after?.paseoArchiveStopIntent).toEqual(marker);
      } else {
        expect(after?.persistence?.metadata?.paseoArchiveStopPending).toEqual(marker);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

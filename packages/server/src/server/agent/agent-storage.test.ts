import { describe, expect, test, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { Session as InspectorSession } from "node:inspector/promises";
import type { HeapProfiler } from "node:inspector";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentStorage, type StoredAgentRecord } from "./agent-storage.js";
import { buildConfigOverrides, buildSessionConfig } from "../persistence-hooks.js";
import type { ManagedAgent } from "./agent-manager.js";
import type {
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";

type ManagedAgentOverrides = Omit<
  Partial<ManagedAgent>,
  "config" | "pendingPermissions" | "session" | "activeForegroundTurnId"
> & {
  config?: Partial<AgentSessionConfig>;
  pendingPermissions?: Map<string, AgentPermissionRequest>;
  session?: AgentSession | null;
  activeForegroundTurnId?: string | null;
  runtimeInfo?: ManagedAgent["runtimeInfo"];
  attention?: ManagedAgent["attention"];
};

function buildManagedAgentConfig(
  provider: AgentProvider,
  cwd: string,
  configOverrides: Partial<AgentSessionConfig>,
): AgentSessionConfig {
  const config: AgentSessionConfig = {
    provider,
    cwd,
    title: configOverrides.title,
    modeId: configOverrides.modeId ?? "plan",
    model: configOverrides.model ?? "gpt-5.1",
    thinkingOptionId: configOverrides.thinkingOptionId,
    providerOptions: configOverrides.providerOptions,
    toolPolicy: configOverrides.toolPolicy,
    systemPrompt: configOverrides.systemPrompt,
    mcpServers: configOverrides.mcpServers,
  };
  return config;
}

function buildDefaultCapabilities() {
  return {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  };
}

function buildDefaultRuntimeInfo(params: {
  provider: AgentProvider;
  config: AgentSessionConfig;
  sessionId: string;
}) {
  return {
    provider: params.provider,
    sessionId: params.sessionId,
    model: params.config.model ?? null,
    modeId: params.config.modeId ?? null,
  };
}

interface ManagedAgentCore {
  provider: AgentProvider;
  cwd: string;
  lifecycle: ManagedAgent["lifecycle"];
  config: AgentSessionConfig;
  session: AgentSession | null;
  activeForegroundTurnId: string | null;
  now: Date;
}

function resolveManagedAgentCore(overrides: ManagedAgentOverrides): ManagedAgentCore {
  const now = overrides.updatedAt ?? new Date("2025-01-01T00:00:00.000Z");
  const provider = overrides.provider ?? "claude";
  const cwd = overrides.cwd ?? "/tmp/project";
  const lifecycle = overrides.lifecycle ?? "idle";
  const config = buildManagedAgentConfig(provider, cwd, overrides.config ?? {});
  const session = lifecycle === "closed" ? null : (overrides.session ?? ({} as AgentSession));
  const activeForegroundTurnId =
    overrides.activeForegroundTurnId ?? (lifecycle === "running" ? "test-turn-id" : null);
  return { provider, cwd, lifecycle, config, session, activeForegroundTurnId, now };
}

function createManagedAgent(overrides: ManagedAgentOverrides = {}): ManagedAgent {
  const core = resolveManagedAgentCore(overrides);
  return {
    id: overrides.id ?? "agent-test",
    provider: core.provider,
    cwd: core.cwd,
    workspaceId: overrides.workspaceId,
    session: core.session,
    capabilities: overrides.capabilities ?? buildDefaultCapabilities(),
    config: core.config,
    lifecycle: core.lifecycle,
    createdAt: overrides.createdAt ?? core.now,
    updatedAt: overrides.updatedAt ?? core.now,
    availableModes: overrides.availableModes ?? [],
    currentModeId: overrides.currentModeId ?? core.config.modeId ?? null,
    pendingPermissions: overrides.pendingPermissions ?? new Map<string, AgentPermissionRequest>(),
    activeForegroundTurnId: core.activeForegroundTurnId,
    foregroundTurnWaiters: new Set(),
    unsubscribeSession: null,
    timeline: overrides.timeline ?? [],
    attention: overrides.attention ?? { requiresAttention: false },
    runtimeInfo:
      overrides.runtimeInfo ??
      buildDefaultRuntimeInfo({
        provider: core.provider,
        config: core.config,
        sessionId: overrides.sessionId ?? "session-123",
      }),
    persistence: overrides.persistence ?? null,
    historyPrimed: overrides.historyPrimed ?? true,
    lastUserMessageAt: overrides.lastUserMessageAt ?? core.now,
    lastUsage: overrides.lastUsage,
    lastError: overrides.lastError,
  };
}

function findRecordFile(baseDir: string, agentId: string): string {
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    const candidate = path.join(baseDir, entry.name, `${agentId}.json`);
    if (entry.isDirectory() && existsSync(candidate)) return candidate;
  }
  throw new Error(`No stored record for ${agentId}`);
}

describe("AgentStorage", () => {
  let tmpDir: string;
  let storagePath: string;
  let storage: AgentStorage;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-registry-"));
    storagePath = path.join(tmpDir, "agents");
    storage = new AgentStorage(storagePath, logger);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("workspace and active queries follow updates, removal, and reload", async () => {
    const base = {
      provider: "codex",
      cwd: tmpDir,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      labels: {},
    };
    await storage.upsert({
      ...base,
      id: "a",
      workspaceId: "one",
      lastUserMessageAt: base.createdAt,
    });
    await storage.upsert({ ...base, id: "b", workspaceId: "two", archivedAt: base.createdAt });
    expect((await storage.listActive()).map((r) => r.id)).toEqual(["a"]);
    await storage.upsert({
      ...base,
      id: "a",
      workspaceId: "two",
      lastUserMessageAt: base.updatedAt,
    });
    expect(await storage.listByWorkspaces(["one"])).toEqual([]);
    expect((await storage.listByWorkspaces(["two"])).map((r) => r.id)).toEqual(["a"]);
    expect(
      (await storage.listByWorkspaces(["two"], { includeArchived: true })).map((r) => r.id).sort(),
    ).toEqual(["a", "b"]);
    expect(await storage.lastUserMessageAtByWorkspace(["one", "two"])).toEqual(
      new Map([["two", base.createdAt]]),
    );
    await storage.flush();
    const reloaded = new AgentStorage(storagePath, createTestLogger());
    expect((await reloaded.listActive()).map((r) => r.id)).toEqual(["a"]);
    expect(
      await reloaded.lastUserMessageAtByWorkspace(["two"], { excludeAgentIds: ["a"] }),
    ).toEqual(new Map());
    await reloaded.remove("a");
    expect(await reloaded.listActive()).toEqual([]);
    expect(await reloaded.lastUserMessageAtByWorkspace(["two"])).toEqual(new Map());
  });

  test("single-agent lookups keep allocations bounded with a large stored history", async () => {
    await fs.mkdir(storagePath, { recursive: true });
    const record = {
      id: "history-0",
      provider: "codex",
      cwd: tmpDir,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      labels: {},
      lastStatus: "idle",
    };
    for (let offset = 0; offset < 2048; offset += 64) {
      await Promise.all(
        Array.from({ length: 64 }, (_, index) => {
          const id = `history-${offset + index}`;
          return fs.writeFile(
            path.join(storagePath, `${id}.json`),
            JSON.stringify({ ...record, id }),
          );
        }),
      );
    }
    await storage.initialize();
    expect(await storage.listAll()).toHaveLength(2048);
    const expected = await storage.get(record.id);
    expect(expected).toMatchObject(record);

    const inspector = new InspectorSession();
    inspector.connect();
    let allocatedBytes = 0;
    let matches = 0;
    try {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 16384,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      for (let index = 0; index < 1000; index++) {
        if ((await storage.get(record.id)) === expected) matches++;
      }
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
        node.selfSize + node.children.reduce((bytes, child) => bytes + sum(child), 0);
      allocatedBytes = sum(profile.head);
    } finally {
      inspector.disconnect();
    }

    expect(matches).toBe(1000);
    // Copying this history on every lookup allocates >16 MiB. Allow generous
    // sampling/runtime overhead without relying on the host's execution speed.
    expect(allocatedBytes).toBeLessThan(4 * 1024 * 1024);
  });

  test("applySnapshot persists configs and snapshot metadata", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-1",
        cwd: "/tmp/project",
        currentModeId: "coding",
        lifecycle: "idle",
        config: {
          title: "Initial title",
          modeId: "coding",
          model: "gpt-5.1",
          systemPrompt: "Be terse and explicit.",
          providerOptions: { allowedTools: ["Read"] },
          mcpServers: {
            paseo: {
              type: "stdio",
              command: "node",
              args: ["/tmp/mcp-stdio-socket-bridge-cli.mjs", "--socket", "/tmp/test.sock"],
            },
          },
        },
      }),
    );

    const records = await storage.listAll();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.provider).toBe("claude");
    expect(record.config?.modeId).toBe("coding");
    expect(record.config?.model).toBe("gpt-5.1");
    expect(record.config?.systemPrompt).toBe("Be terse and explicit.");
    expect(record.config?.mcpServers).toEqual({
      paseo: {
        type: "stdio",
        command: "node",
        args: ["/tmp/mcp-stdio-socket-bridge-cli.mjs", "--socket", "/tmp/test.sock"],
      },
    });
    expect(record.lastModeId).toBe("coding");
    expect(record.lastStatus).toBe("idle");

    const reloaded = new AgentStorage(storagePath, createTestLogger());
    const [persisted] = await reloaded.listAll();
    expect(persisted.cwd).toBe("/tmp/project");
    expect(persisted.config?.providerOptions).toEqual({ allowedTools: ["Read"] });
  });

  test("applySnapshot stores and reloads composer values as providerOptions", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-provider-options",
        config: { providerOptions: { fast_mode: true } },
      }),
    );

    const reloaded = new AgentStorage(storagePath, createTestLogger());
    const persisted = await reloaded.get("agent-provider-options");
    expect(persisted?.config?.providerOptions).toEqual({ fast_mode: true });
    expect(buildSessionConfig(persisted!).providerOptions).toEqual({ fast_mode: true });
    expect(buildConfigOverrides(persisted!)).toMatchObject({
      cwd: "/tmp/project",
      providerOptions: { fast_mode: true },
    });
  });

  test("a record stored with featureValues loads them in providerOptions", async () => {
    await storage.applySnapshot(createManagedAgent({ id: "agent-legacy" }));
    const file = findRecordFile(storagePath, "agent-legacy");
    const stored = JSON.parse(await fs.readFile(file, "utf8"));
    stored.config.providerOptions = { allowedTools: ["Read"], fast_mode: false };
    stored.config.featureValues = { fast_mode: true, service_tier: "fast" };
    delete stored.controls;
    stored.features = [
      { type: "toggle", id: "fast_mode", label: "Fast mode", value: true },
      {
        type: "select",
        id: "service_tier",
        label: "Speed",
        value: "fast",
        options: [
          { id: "default", label: "Normal", isDefault: true },
          { id: "fast", label: "Fast" },
        ],
      },
    ];
    await fs.writeFile(file, JSON.stringify(stored));

    const reloaded = new AgentStorage(storagePath, createTestLogger());
    const persisted = await reloaded.get("agent-legacy");

    // An explicit providerOptions key wins over the same featureValues key.
    expect(persisted?.config?.providerOptions).toEqual({
      allowedTools: ["Read"],
      fast_mode: false,
      service_tier: "fast",
    });
    expect(persisted?.config).not.toHaveProperty("featureValues");
    expect(persisted).not.toHaveProperty("features");
    expect(persisted?.controls).toEqual([
      { type: "toggle", key: "fast_mode", label: "Fast mode" },
      {
        type: "select",
        key: "service_tier",
        label: "Speed",
        defaultValue: "default",
        choices: [
          { value: "default", label: "Normal" },
          { value: "fast", label: "Fast" },
        ],
      },
    ]);

    await reloaded.applySnapshot(createManagedAgent({ id: "agent-legacy" }));
    const rewritten = JSON.parse(await fs.readFile(file, "utf8"));
    expect(rewritten.config).not.toHaveProperty("featureValues");
    expect(rewritten).not.toHaveProperty("features");
  });

  test("preserves future raw fields while folding legacy values and writing a snapshot", async () => {
    const agentId = "agent-future-fields";
    const persistence = {
      provider: "codex" as const,
      sessionId: "future-session",
      nativeHandle: "future-native",
      metadata: {},
    };
    await storage.applySnapshot(
      createManagedAgent({ id: agentId, provider: "codex", persistence, lifecycle: "idle" }),
    );
    const file = findRecordFile(storagePath, agentId);
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    raw.futureRoot = { retained: true };
    raw.config.futureConfig = { retained: true };
    raw.persistence.futurePersistence = { retained: true };
    raw.runtimeInfo.futureRuntime = { retained: true };
    raw.config.featureValues = { legacy_fast: true };
    delete raw.controls;
    raw.features = [{ type: "toggle", id: "legacy_fast", label: "Legacy fast", value: true }];
    await fs.writeFile(file, JSON.stringify(raw), "utf8");

    const reloaded = new AgentStorage(storagePath, createTestLogger());
    const parsed = await reloaded.get(agentId);
    expect(parsed?.config?.providerOptions).toMatchObject({ legacy_fast: true });
    expect(parsed).not.toHaveProperty("features");

    await reloaded.applySnapshot(
      createManagedAgent({
        id: agentId,
        provider: "codex",
        persistence,
        lifecycle: "idle",
        updatedAt: new Date("2025-01-04T00:00:00.000Z"),
      }),
    );
    const rewritten = JSON.parse(await fs.readFile(file, "utf8"));
    expect(rewritten).toMatchObject({ futureRoot: { retained: true } });
    expect(rewritten.config).toMatchObject({ futureConfig: { retained: true } });
    expect(rewritten.persistence).toMatchObject({ futurePersistence: { retained: true } });
    expect(rewritten.runtimeInfo).toMatchObject({ futureRuntime: { retained: true } });
    expect(rewritten.config).not.toHaveProperty("featureValues");
    expect(rewritten).not.toHaveProperty("features");
  });

  test("applySnapshot preserves original createdAt timestamp", async () => {
    const agentId = "agent-created-at";
    const firstTimestamp = new Date("2025-01-01T00:00:00.000Z");
    await storage.applySnapshot(createManagedAgent({ id: agentId, createdAt: firstTimestamp }));

    const initialRecord = await storage.get(agentId);
    expect(initialRecord?.createdAt).toBe(firstTimestamp.toISOString());

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        createdAt: new Date("2025-02-01T00:00:00.000Z"),
        updatedAt: new Date("2025-02-01T00:00:00.000Z"),
        lifecycle: "running",
      }),
    );

    const updatedRecord = await storage.get(agentId);
    expect(updatedRecord?.createdAt).toBe(firstTimestamp.toISOString());
    expect(updatedRecord?.lastStatus).toBe("running");
  });

  test("applySnapshot preserves archivedAt (soft-delete) status", async () => {
    const agentId = "agent-archived";
    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "idle",
      }),
    );

    const archivedAt = "2025-01-03T00:00:00.000Z";
    const recordBeforeArchive = await storage.get(agentId);
    expect(recordBeforeArchive).not.toBeNull();
    await storage.upsert({ ...recordBeforeArchive!, archivedAt });

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        updatedAt: new Date("2025-01-04T00:00:00.000Z"),
      }),
    );

    const recordAfterSnapshot = await storage.get(agentId);
    expect(recordAfterSnapshot?.archivedAt).toBe(archivedAt);
  });

  test("keeps archive intent guards through stale writes until an explicit terminal clear", async () => {
    const agentId = "agent-archive-intent";
    const intent = {
      version: 1,
      operation: "archive",
      requestedAt: "2025-01-03T00:00:00.000Z",
    };
    await storage.applySnapshot(createManagedAgent({ id: agentId, lifecycle: "idle" }));
    const initial = await storage.get(agentId);
    expect(initial).not.toBeNull();

    await storage.upsert(
      { ...initial!, paseoArchiveStopIntent: intent },
      { createArchiveStopIntent: true },
    );

    // Both an ordinary stale upsert and a new live snapshot lack the private
    // guard. Neither may make future load/admission look safe.
    await storage.upsert({ ...initial!, title: "stale title" });
    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        updatedAt: new Date("2025-01-04T00:00:00.000Z"),
      }),
    );
    expect((await storage.get(agentId))?.paseoArchiveStopIntent).toEqual(intent);

    const guarded = await storage.get(agentId);
    expect(guarded).not.toBeNull();
    await storage.upsert(
      { ...guarded!, title: "terminally released" },
      { clearArchiveStopIntent: true },
    );
    expect((await storage.get(agentId))?.paseoArchiveStopIntent).toBeUndefined();
  });

  for (const { label, pending, nativeHandleA, nativeHandleB } of [
    {
      label: "a valid native-stop receipt",
      pending: {
        version: 1,
        operation: "archive",
        provider: "codex",
        sessionId: "original-session",
        nativeHandle: "original-native",
        requestedAt: "2025-01-03T00:00:00.000Z",
      },
      nativeHandleA: "original-native",
      nativeHandleB: "stale-native",
    },
    {
      label: "a malformed-present receipt and malformed truthy native handle",
      pending: {
        version: 99,
        operation: { future: "archive" },
        rawReceipt: { retain: "exactly" },
      },
      nativeHandleA: { raw: "truthy-native-A" },
      nativeHandleB: { raw: "truthy-native-B" },
    },
  ]) {
    test(`keeps ${label} bound to persistence A across stale B writes`, async () => {
      const agentId = `agent-archive-pending-${nativeHandleA === "original-native" ? "valid" : "malformed"}`;
      const persistenceA = {
        provider: "codex",
        sessionId: "original-session",
        nativeHandle: nativeHandleA,
        metadata: {
          opaqueMetadata: { retain: "A" },
          paseoArchiveStopPending: pending,
        },
        futurePersistence: { retain: "A" },
      };
      const persistenceB = {
        provider: "codex",
        sessionId: "stale-session",
        nativeHandle: nativeHandleB,
        metadata: { staleMetadata: { value: "B" } },
        futurePersistence: { replace: "B" },
      };

      // Seed the marker through the supported writer, then restore an opaque
      // future persistence field from disk to exercise raw-byte preservation.
      await storage.applySnapshot(
        createManagedAgent({
          id: agentId,
          provider: "codex",
          persistence: persistenceA as unknown as AgentPersistenceHandle,
          lifecycle: "idle",
        }),
        { createArchiveStopPending: true },
      );
      const file = findRecordFile(storagePath, agentId);
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      raw.persistence = persistenceA;
      await fs.writeFile(file, JSON.stringify(raw), "utf8");
      storage = new AgentStorage(storagePath, logger);

      const guardedA = await storage.get(agentId);
      expect(guardedA?.persistence).toEqual(persistenceA);

      // An ordinary stored B write and a newer live B snapshot must both
      // retain every byte of guarded persistence A, rather than attaching A's
      // receipt to B's provider/session/native identity.
      await storage.upsert({
        ...guardedA!,
        title: "stale stored B",
        persistence: persistenceB as unknown as AgentPersistenceHandle,
      });
      expect((await storage.get(agentId))?.persistence).toEqual(persistenceA);

      await storage.applySnapshot(
        createManagedAgent({
          id: agentId,
          provider: "codex",
          persistence: persistenceB as unknown as AgentPersistenceHandle,
          lifecycle: "running",
          updatedAt: new Date("2025-01-04T00:00:00.000Z"),
        }),
      );
      const guardedAfterSnapshot = await storage.get(agentId);
      expect(guardedAfterSnapshot?.persistence).toEqual(persistenceA);

      // Only the explicitly authorized terminal release may replace A with B
      // and remove the private guard.
      await storage.upsert(
        {
          ...guardedAfterSnapshot!,
          title: "terminally released",
          persistence: persistenceB as unknown as AgentPersistenceHandle,
        },
        { clearArchiveStopPending: true },
      );
      const released = await storage.get(agentId);
      expect(released?.persistence).toMatchObject({
        provider: "codex",
        sessionId: "stale-session",
        nativeHandle: nativeHandleB,
        metadata: { staleMetadata: { value: "B" } },
      });
      expect(released?.persistence?.metadata).not.toHaveProperty("paseoArchiveStopPending");
    });
  }

  test("preserves malformed archive intent guards across snapshots", async () => {
    const agentId = "agent-malformed-archive-intent";
    const malformedIntent = { version: 99, operation: "unknown" };
    await storage.applySnapshot(createManagedAgent({ id: agentId, lifecycle: "idle" }));
    const initial = await storage.get(agentId);
    expect(initial).not.toBeNull();
    await storage.upsert(
      { ...initial!, paseoArchiveStopIntent: malformedIntent },
      { createArchiveStopIntent: true },
    );

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        updatedAt: new Date("2025-01-04T00:00:00.000Z"),
      }),
    );

    const reloaded = new AgentStorage(storagePath, logger);
    expect((await reloaded.get(agentId))?.paseoArchiveStopIntent).toEqual(malformedIntent);
  });

  test("does not let a stale guarded write roll back a terminal archive clear", async () => {
    const agentId = "agent-terminal-intent-clear";
    const archivedAt = "2025-01-04T00:00:00.000Z";
    const intent = {
      version: 1,
      operation: "archive",
      requestedAt: "2025-01-03T00:00:00.000Z",
    };
    await storage.applySnapshot(createManagedAgent({ id: agentId, lifecycle: "idle" }));
    const initial = await storage.get(agentId);
    expect(initial).not.toBeNull();
    await storage.upsert(
      {
        ...initial!,
        updatedAt: "2025-01-03T00:00:00.000Z",
        paseoArchiveStopIntent: intent,
      },
      { createArchiveStopIntent: true },
    );
    const staleGuardedRecord = await storage.get(agentId);
    expect(staleGuardedRecord).not.toBeNull();

    const storageInternals = storage as unknown as {
      writeRecord: (record: StoredAgentRecord) => Promise<void>;
    };
    const originalWriteRecord = storageInternals.writeRecord.bind(storage);
    let releaseTerminalWrite!: () => void;
    const terminalWriteAllowed = new Promise<void>((resolve) => {
      releaseTerminalWrite = resolve;
    });
    let terminalWriteStarted!: () => void;
    const terminalWriteStartedPromise = new Promise<void>((resolve) => {
      terminalWriteStarted = resolve;
    });
    storageInternals.writeRecord = async (record) => {
      if (record.id === agentId && record.archivedAt === archivedAt) {
        terminalWriteStarted();
        await terminalWriteAllowed;
      }
      await originalWriteRecord(record);
    };

    try {
      const terminal = storage.upsert(
        {
          ...staleGuardedRecord!,
          archivedAt,
          updatedAt: archivedAt,
        },
        { clearArchiveStopIntent: true },
      );
      await terminalWriteStartedPromise;

      // This record was read before the terminal transition. A caller can
      // stamp it later, but it still must not repopulate the guard or reopen
      // the archived record.
      const staleWrite = storage.upsert({
        ...staleGuardedRecord!,
        title: "stale guarded snapshot",
        updatedAt: "2025-01-05T00:00:00.000Z",
      });
      releaseTerminalWrite();
      await Promise.all([terminal, staleWrite]);

      const current = await storage.get(agentId);
      expect(current?.archivedAt).toBe(archivedAt);
      expect(current?.paseoArchiveStopIntent).toBeUndefined();
    } finally {
      releaseTerminalWrite();
      storageInternals.writeRecord = originalWriteRecord;
    }
  });

  test("rejects a stale newer-stamped intent after release but accepts a later archive intent", async () => {
    const agentId = "agent-terminal-release-intent";
    const firstIntent = {
      version: 1,
      operation: "archive",
      requestedAt: "2025-01-02T00:00:00.000Z",
    };
    await storage.applySnapshot(createManagedAgent({ id: agentId, lifecycle: "idle" }));
    const initial = await storage.get(agentId);
    expect(initial).not.toBeNull();
    await storage.upsert(
      {
        ...initial!,
        updatedAt: "2025-01-02T00:00:00.000Z",
        paseoArchiveStopIntent: firstIntent,
      },
      { createArchiveStopIntent: true },
    );
    const staleGuardedRecord = await storage.get(agentId);
    expect(staleGuardedRecord).not.toBeNull();

    await storage.upsert(
      {
        ...staleGuardedRecord!,
        updatedAt: "2025-01-03T00:00:00.000Z",
      },
      { clearArchiveStopIntent: true },
    );
    await storage.upsert({
      ...staleGuardedRecord!,
      title: "stale after release",
      updatedAt: "2025-01-04T00:00:00.000Z",
    });
    expect((await storage.get(agentId))?.paseoArchiveStopIntent).toBeUndefined();

    const released = await storage.get(agentId);
    expect(released).not.toBeNull();
    const secondIntent = {
      version: 1,
      operation: "archive",
      requestedAt: "2025-01-04T00:00:00.000Z",
    };
    await storage.upsert(
      {
        ...released!,
        updatedAt: "2025-01-05T00:00:00.000Z",
        paseoArchiveStopIntent: secondIntent,
      },
      { createArchiveStopIntent: true },
    );
    expect((await storage.get(agentId))?.paseoArchiveStopIntent).toEqual(secondIntent);
  });

  test("preserves archived state until an explicit unarchive", async () => {
    const agentId = "agent-explicit-unarchive";
    const archivedAt = "2025-01-03T00:00:00.000Z";
    await storage.applySnapshot(createManagedAgent({ id: agentId, lifecycle: "idle" }));
    const initial = await storage.get(agentId);
    expect(initial).not.toBeNull();
    await storage.upsert({ ...initial!, archivedAt, updatedAt: archivedAt });

    await storage.upsert({
      ...initial!,
      archivedAt: null,
      updatedAt: "2025-01-04T00:00:00.000Z",
    });
    expect((await storage.get(agentId))?.archivedAt).toBe(archivedAt);

    const archived = await storage.get(agentId);
    expect(archived).not.toBeNull();
    await storage.upsert(
      {
        ...archived!,
        archivedAt: null,
        updatedAt: "2025-01-05T00:00:00.000Z",
      },
      { allowUnarchive: true },
    );
    expect((await storage.get(agentId))?.archivedAt).toBeNull();
  });

  test("stores titles independently of snapshots", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-2",
        provider: "codex",
        cwd: "/tmp/second",
      }),
    );
    await storage.setTitle("agent-2", "Fix Login Bug");

    const current = await storage.get("agent-2");
    expect(current?.title).toBe("Fix Login Bug");

    const reloaded = new AgentStorage(storagePath, createTestLogger());
    const persisted = await reloaded.get("agent-2");
    expect(persisted?.title).toBe("Fix Login Bug");
  });

  test("setTitle throws when the agent record does not exist", async () => {
    await expect(storage.setTitle("missing-agent", "Impossible")).rejects.toThrow(
      "Agent missing-agent not found",
    );
  });

  test("applySnapshot accepts explicit title overrides", async () => {
    const agentId = "agent-override";
    await storage.applySnapshot(createManagedAgent({ id: agentId }), { title: "Provided Title" });

    const record = await storage.get(agentId);
    expect(record?.title).toBe("Provided Title");
  });

  test("applySnapshot preserves custom titles while updating metadata", async () => {
    const agentId = "agent-3";
    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "idle",
        currentModeId: "plan",
      }),
    );
    await storage.setTitle(agentId, "Important Bug Fix");

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        currentModeId: "build",
        updatedAt: new Date("2025-01-02T00:00:00.000Z"),
      }),
    );

    const record = await storage.get(agentId);
    expect(record?.title).toBe("Important Bug Fix");
    expect(record?.lastModeId).toBe("build");
    expect(record?.lastStatus).toBe("running");
  });

  test("applySnapshot projects metadata after in-flight archival writes", async () => {
    const agentId = "agent-pending-write";
    await storage.applySnapshot(createManagedAgent({ id: agentId }));
    const initialRecord = await storage.get(agentId);
    expect(initialRecord).not.toBeNull();

    let releasePendingWrite: (() => void) | null = null;
    const pendingWrite = new Promise<void>((resolve) => {
      releasePendingWrite = resolve;
    });

    const storageInternals = storage as unknown as {
      pendingWrites: Map<string, Promise<void>>;
      cache: Map<string, unknown>;
    };
    storageInternals.pendingWrites.set(agentId, pendingWrite);

    const applySnapshotPromise = storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        updatedAt: new Date("2025-01-02T00:00:00.000Z"),
      }),
    );

    storageInternals.cache.set(agentId, {
      ...initialRecord!,
      title: "Generated title",
      archivedAt: "2025-01-03T00:00:00.000Z",
    });
    releasePendingWrite?.();

    await applySnapshotPromise;
    const record = await storage.get(agentId);
    expect(record?.title).toBe("Generated title");
    expect(record?.archivedAt).toBe("2025-01-03T00:00:00.000Z");
  });

  test("list returns all agents including internal ones", async () => {
    // Create a normal agent
    await storage.applySnapshot(
      createManagedAgent({
        id: "normal-agent",
        cwd: "/tmp/project",
      }),
    );

    // Create an internal agent
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    // Registry should return all agents - filtering is done at the manager level
    const records = await storage.listAll();
    expect(records).toHaveLength(2);
  });

  test("get returns internal agents by ID", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    const record = await storage.get("internal-agent");
    expect(record).not.toBeNull();
    expect(record?.internal).toBe(true);
  });

  test("queries agents by provider session and native handle", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "matching-session",
        provider: "codex",
        persistence: {
          provider: "codex",
          sessionId: "session-1",
          nativeHandle: "thread-1",
        },
      }),
    );
    await storage.applySnapshot(
      createManagedAgent({
        id: "other-session",
        provider: "codex",
        persistence: { provider: "codex", sessionId: "session-2" },
      }),
    );

    await expect(storage.listByProviderSession("codex", "session-1")).resolves.toMatchObject([
      { id: "matching-session" },
    ]);
    await expect(storage.listByProviderSession("codex", "thread-1")).resolves.toMatchObject([
      { id: "matching-session" },
    ]);
  });

  test("queries agents by workspace", async () => {
    await storage.applySnapshot(
      createManagedAgent({ id: "workspace-agent", workspaceId: "workspace-1" }),
    );
    await storage.applySnapshot(
      createManagedAgent({ id: "other-workspace-agent", workspaceId: "workspace-2" }),
    );

    await expect(storage.listByWorkspace("workspace-1")).resolves.toMatchObject([
      { id: "workspace-agent" },
    ]);
  });

  test("internal flag is persisted and reloaded", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    // Reload the registry from disk
    const reloaded = new AgentStorage(storagePath, createTestLogger());
    const record = await reloaded.get("internal-agent");
    expect(record?.internal).toBe(true);

    // Registry returns all agents - filtering happens at manager level
    const records = await reloaded.listAll();
    expect(records).toHaveLength(1);
    expect(records[0]?.internal).toBe(true);
  });

  test("Windows drive-letter paths produce valid directory names", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "win-agent",
        cwd: "D:\\Users\\dev\\MyProject",
      }),
    );

    const record = await storage.get("win-agent");
    expect(record).not.toBeNull();

    // The persisted directory must not contain a colon (invalid on Windows)
    const dirs = readdirSync(storagePath);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).not.toContain(":");
    expect(dirs[0]).toBe("D-Users-dev-MyProject");
  });

  test.each([
    { name: "guarded copy sorts first", guardedDir: "a-guarded", staleDir: "z-stale" },
    { name: "guarded copy sorts last", guardedDir: "z-guarded", staleDir: "a-stale" },
  ])(
    "reloads the $name as the fail-closed duplicate canonical record",
    async ({ guardedDir, staleDir }) => {
      const agentId = "agent-duplicate-pending";
      await storage.applySnapshot(
        createManagedAgent({ id: agentId, provider: "codex", cwd: "/tmp/initial-copy" }),
      );
      const base = await storage.get(agentId);
      if (!base) throw new Error("expected initial record");
      await fs.unlink(findRecordFile(storagePath, agentId));

      const pending = {
        version: 1,
        operation: "archive",
        provider: "codex",
        // Deliberately differs from the guarded copy's current handle. Loading
        // must retain this proof verbatim rather than rewriting it to look like
        // a valid retry authority for either duplicate.
        sessionId: "previous-native-session",
        nativeHandle: "previous-native-handle",
        requestedAt: "2025-01-03T00:00:00.000Z",
      };
      const guarded = {
        ...base,
        cwd: "/tmp/guarded-copy",
        updatedAt: "2025-01-03T00:00:00.000Z",
        persistence: {
          provider: "codex",
          sessionId: "guarded-current-session",
          nativeHandle: "guarded-current-handle",
          metadata: { paseoArchiveStopPending: pending },
        },
      };
      const stale = {
        ...base,
        cwd: "/tmp/stale-copy",
        // A newer ordinary duplicate must not erase a durable uncertainty.
        updatedAt: "2025-01-04T00:00:00.000Z",
        persistence: {
          provider: "codex",
          sessionId: "stale-session",
          nativeHandle: "stale-handle",
          metadata: {},
        },
      };
      const guardedPath = path.join(storagePath, guardedDir, `${agentId}.json`);
      const stalePath = path.join(storagePath, staleDir, `${agentId}.json`);
      await Promise.all([
        fs.mkdir(path.dirname(guardedPath), { recursive: true }),
        fs.mkdir(path.dirname(stalePath), { recursive: true }),
      ]);
      await Promise.all([
        fs.writeFile(guardedPath, JSON.stringify(guarded), "utf8"),
        fs.writeFile(stalePath, JSON.stringify(stale), "utf8"),
      ]);

      const reloaded = new AgentStorage(storagePath, createTestLogger());
      const canonical = await reloaded.get(agentId);

      expect(canonical).toMatchObject({
        cwd: "/tmp/guarded-copy",
        persistence: {
          sessionId: "guarded-current-session",
          nativeHandle: "guarded-current-handle",
        },
      });
      // The mismatched raw marker remains mismatched, so manager retry identity
      // checks fail closed instead of treating the stale handle as settled.
      expect(canonical?.persistence?.metadata?.paseoArchiveStopPending).toEqual(pending);
      await reloaded.upsert({ ...canonical!, title: "ordinary follow-up write" });
      expect((await reloaded.get(agentId))?.persistence?.metadata?.paseoArchiveStopPending).toEqual(
        pending,
      );
    },
  );

  test("serialized startup-resume consumption preserves valid and malformed archive guards", async () => {
    const cases = [
      {
        id: "resume-intent-valid",
        kind: "intent" as const,
        marker: {
          version: 1,
          operation: "archive",
          requestedAt: "2026-11-18T00:00:00.000Z",
        },
      },
      {
        id: "resume-intent-malformed",
        kind: "intent" as const,
        marker: { version: 99, operation: "unknown", preserved: true },
      },
      {
        id: "resume-native-valid",
        kind: "native" as const,
        marker: {
          version: 1,
          operation: "archive",
          provider: "codex",
          sessionId: "native-session-valid",
          nativeHandle: "native-handle-valid",
          requestedAt: "2026-11-18T00:00:00.000Z",
        },
      },
      {
        id: "resume-native-malformed",
        kind: "native" as const,
        marker: { version: 99, operation: "unknown", preserved: "raw-native-marker" },
      },
    ];

    for (const guard of cases) {
      await storage.applySnapshot(
        createManagedAgent({ id: guard.id, lifecycle: "running", cwd: "/tmp/resume-guard" }),
      );
      const base = await storage.get(guard.id);
      if (!base) throw new Error("expected stored resume candidate");

      if (guard.kind === "intent") {
        await storage.upsert(
          { ...base, resumeOnStartup: true, paseoArchiveStopIntent: guard.marker },
          { createArchiveStopIntent: true },
        );
      } else {
        await storage.upsert(
          {
            ...base,
            resumeOnStartup: true,
            persistence: {
              provider: "codex",
              sessionId: `session-${guard.id}`,
              nativeHandle: `handle-${guard.id}`,
              metadata: { paseoArchiveStopPending: guard.marker },
            },
          },
          { createArchiveStopPending: true },
        );
      }

      await expect(storage.consumeResumeOnStartupIfUnguarded(guard.id)).resolves.toBeNull();
      const after = await storage.get(guard.id);
      expect(after?.resumeOnStartup).toBe(true);
      if (guard.kind === "intent") {
        expect(after?.paseoArchiveStopIntent).toEqual(guard.marker);
      } else {
        expect(after?.persistence?.metadata?.paseoArchiveStopPending).toEqual(guard.marker);
      }
    }
  });

  test("remove deletes all duplicate record files across project directories", async () => {
    const agentId = "agent-duplicate";

    // Create a valid record file in two different project directories to simulate
    // storage migrations/duplication. Only one copy will be referenced in-memory,
    // but deletion should remove *all* copies on disk.
    const recordA = await (async () => {
      await storage.applySnapshot(
        createManagedAgent({
          id: agentId,
          cwd: "/tmp/project-a",
          provider: "codex",
        }),
      );
      const record = await storage.get(agentId);
      expect(record).not.toBeNull();
      return record!;
    })();

    const projectDirB = path.join(storagePath, "tmp-project-b");
    await fs.mkdir(projectDirB, { recursive: true });
    const duplicatePathB = path.join(projectDirB, `${agentId}.json`);
    await fs.writeFile(
      duplicatePathB,
      JSON.stringify({ ...recordA, cwd: "/tmp/project-b" }, null, 2),
      "utf8",
    );

    // Force a reload so the registry has to discover from disk (and may choose either copy).
    const reloaded = new AgentStorage(storagePath, createTestLogger());
    const before = await reloaded.listAll();
    expect(before.map((r) => r.id)).toContain(agentId);

    await reloaded.remove(agentId);

    const hasAnyRecordFile = async () => {
      const projects = await fs
        .readdir(storagePath, { withFileTypes: true })
        .catch(() => [] as Awaited<ReturnType<typeof fs.readdir>>);
      const exists = await Promise.all(
        projects
          .filter((project) => project.isDirectory())
          .map(async (project) => {
            const candidate = path.join(storagePath, project.name, `${agentId}.json`);
            try {
              await fs.access(candidate);
              return true;
            } catch {
              return false;
            }
          }),
      );
      return exists.some((present) => present);
    };

    expect(await hasAnyRecordFile()).toBe(false);

    const afterReload = new AgentStorage(storagePath, createTestLogger());
    const after = await afterReload.listAll();
    expect(after.some((r) => r.id === agentId)).toBe(false);
  });
});

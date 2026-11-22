import { ARCHIVE_STOP_PENDING_METADATA_KEY } from "./persistence-metadata.js";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { AgentFeatureSchema, AgentOptionControlSchema, AgentStatusSchema } from "../messages.js";
import { toStoredAgentRecord } from "./agent-projections.js";
import type { ManagedAgent } from "./agent-manager.js";
import type {
  AgentOptionControl,
  AgentPersistenceHandle,
  AgentRuntimeInfo,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import {
  AgentOwnerSchema,
  daemonExecutionKey,
  type AgentOwner,
  type DaemonAgentOwner,
} from "./agent-owner.js";
import { controlsFromFeatures } from "@getpaseo/protocol/option-controls";
import { foldFeatureValues } from "./option-controls.js";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";

export const ARCHIVE_STOP_INTENT_RECORD_KEY = "paseoArchiveStopIntent" as const;

export interface ArchiveStopIntent {
  version: 1;
  operation: "archive" | "terminate";
  requestedAt: string;
}

interface AgentStorageUpsertOptions {
  /** Only the verified archive/terminate terminal paths may remove this guard. */
  clearArchiveStopIntent?: boolean;
  /** Only the archive/terminate transition may introduce a new record-level intent. */
  createArchiveStopIntent?: boolean;
  /** Only the verified archive/terminate terminal paths may remove this guard. */
  clearArchiveStopPending?: boolean;
  /** Only the archive/terminate transition may introduce a new native-stop guard. */
  createArchiveStopPending?: boolean;
  /** Only the verified native-restore path may reopen an archived record. */
  allowUnarchive?: boolean;
}

const SERIALIZABLE_CONFIG_SCHEMA = z
  .object({
    modeId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    thinkingOptionId: z.string().nullable().optional(),
    // COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01. Read-only; folded on parse.
    featureValues: z.record(z.string(), z.unknown()).nullable().optional(),
    providerOptions: z.record(z.string(), z.unknown()).nullable().optional(),
    toolPolicy: z
      .object({
        preapproved: z.array(
          z.object({ kind: z.literal("mcp"), server: z.string(), tool: z.string() }).strict(),
        ),
      })
      .strict()
      .nullable()
      .optional(),
    systemPrompt: z.string().nullable().optional(),
    mcpServers: z.record(z.string(), z.any()).nullable().optional(),
  })
  // Newer daemons may persist config fields this binary does not understand.
  // Keep those bytes while normalizing only the legacy fields we own below.
  .passthrough()
  .nullable()
  .optional();

const PERSISTENCE_HANDLE_SCHEMA = z
  .object({
    provider: z.string(),
    sessionId: z.string(),
    nativeHandle: z.any().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .passthrough()
  .nullable()
  .optional();

const RAW_STORED_AGENT_SCHEMA = z
  .object({
    id: z.string(),
    provider: z.string(),
    cwd: z.string(),
    workspaceId: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    lastActivityAt: z.string().optional(),
    lastUserMessageAt: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    labels: z.record(z.string(), z.string()).default({}),
    metadata: z.record(z.string(), z.custom<JsonValue>()).default({}),
    lastStatus: AgentStatusSchema.default("closed"),
    resumeOnStartup: z.boolean().optional(),
    lastModeId: z.string().nullable().optional(),
    config: SERIALIZABLE_CONFIG_SCHEMA,
    launchEnv: z.record(z.string(), z.string()).optional(),
    runtimeInfo: z
      .object({
        provider: z.string(),
        sessionId: z.string().nullable(),
        model: z.string().nullable().optional(),
        thinkingOptionId: z.string().nullable().optional(),
        modeId: z.string().nullable().optional(),
        extra: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
    controls: z.array(AgentOptionControlSchema).optional(),
    // COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01. Read-only; becomes controls.
    features: z.array(AgentFeatureSchema).optional(),
    persistence: PERSISTENCE_HANDLE_SCHEMA,
    lastError: z.string().nullable().optional(),
    requiresAttention: z.boolean().optional(),
    attentionReason: z.enum(["finished", "error", "permission"]).nullable().optional(),
    attentionTimestamp: z.string().nullable().optional(),
    internal: z.boolean().optional(),
    background: z.boolean().optional(),
    archivedAt: z.string().nullable().optional(),
    // This private guard records only that an archive/terminate transition began
    // before its provider supplied a resumable identity. It is intentionally
    // opaque here so malformed-present data stays fail-closed in the manager.
    [ARCHIVE_STOP_INTENT_RECORD_KEY]: z.unknown().optional(),
    owner: AgentOwnerSchema.optional(),
    // Loading must not compact a record produced by a newer daemon.  The
    // projection path preserves these opaque fields on later writes.
  })
  .passthrough();

export type SerializableAgentConfig = Pick<
  AgentSessionConfig,
  | "modeId"
  | "model"
  | "thinkingOptionId"
  | "providerOptions"
  | "toolPolicy"
  | "systemPrompt"
  | "mcpServers"
>;

/**
 * Zod's passthrough output carries an index signature. Do not derive this
 * public storage type with Omit from that output: TypeScript then loses every
 * known property behind `unknown`. Keep the normalized known surface explicit
 * and intersect it with opaque future fields only at the boundary.
 */
type OpaqueStoredFields = Record<string, unknown>;
// Keep the public normalized surface structural. Intersecting an SDK
// interface with a string index signature makes ordinary SDK values fail
// assignability even though their runtime bytes are valid. Opaque fields stay
// on the parsed object and are preserved by the write-boundary helpers below.
type StoredAgentConfig = SerializableAgentConfig;
type RawStoredAgentConfig = StoredAgentConfig &
  OpaqueStoredFields & {
    featureValues?: Record<string, unknown> | null;
  };
type StoredPersistenceHandle = AgentPersistenceHandle;
type StoredRuntimeInfo = AgentRuntimeInfo;

interface KnownStoredAgentRecord {
  id: string;
  provider: string;
  cwd: string;
  workspaceId?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  lastUserMessageAt?: string | null;
  title?: string | null;
  labels: Record<string, string>;
  metadata: Record<string, JsonValue>;
  lastStatus: AgentLifecycleStatus;
  resumeOnStartup?: boolean;
  lastModeId?: string | null;
  config?: StoredAgentConfig | null;
  launchEnv?: Record<string, string>;
  runtimeInfo?: StoredRuntimeInfo;
  controls?: AgentOptionControl[];
  persistence?: StoredPersistenceHandle | null;
  lastError?: string | null;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  attentionTimestamp?: string | null;
  internal?: boolean;
  background?: boolean;
  archivedAt?: string | null;
  [ARCHIVE_STOP_INTENT_RECORD_KEY]?: unknown;
  owner?: AgentOwner;
}

/** Records carry `providerOptions` and `controls` only; legacy fields are folded when read. */
export type StoredAgentRecord = KnownStoredAgentRecord;

type RawStoredAgentRecord = Omit<KnownStoredAgentRecord, "config" | "controls"> &
  OpaqueStoredFields & {
    config?: RawStoredAgentConfig | null;
    controls?: AgentOptionControl[];
    features?: z.infer<typeof AgentFeatureSchema>[];
  };

// COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01.
function foldLegacyRecordFields(record: RawStoredAgentRecord): StoredAgentRecord {
  const { features, config, controls, ...rest } = record;
  return {
    ...rest,
    ...(config ? { config: foldFeatureValues(config) as StoredAgentConfig } : { config }),
    ...((controls ?? features) ? { controls: controls ?? controlsFromFeatures(features) } : {}),
  } as StoredAgentRecord;
}

const STORED_RECORD_KEYS = new Set([
  "id",
  "provider",
  "cwd",
  "workspaceId",
  "createdAt",
  "updatedAt",
  "lastActivityAt",
  "lastUserMessageAt",
  "title",
  "labels",
  "metadata",
  "lastStatus",
  "resumeOnStartup",
  "lastModeId",
  "config",
  "launchEnv",
  "runtimeInfo",
  "controls",
  "features",
  "persistence",
  "lastError",
  "requiresAttention",
  "attentionReason",
  "attentionTimestamp",
  "internal",
  "background",
  "archivedAt",
  ARCHIVE_STOP_INTENT_RECORD_KEY,
  "owner",
]);

const STORED_CONFIG_KEYS = new Set([
  "modeId",
  "model",
  "thinkingOptionId",
  "featureValues",
  "providerOptions",
  "toolPolicy",
  "systemPrompt",
  "mcpServers",
]);

const PERSISTENCE_HANDLE_KEYS = new Set(["provider", "sessionId", "nativeHandle", "metadata"]);
const RUNTIME_INFO_KEYS = new Set([
  "provider",
  "sessionId",
  "model",
  "thinkingOptionId",
  "modeId",
  "extra",
]);

function opaqueFields(value: object, known: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)));
}

function preserveOpaqueObjectFields<T extends object>(
  previous: T | null | undefined,
  next: T | null | undefined,
  known: ReadonlySet<string>,
): T | null | undefined {
  if (!previous || !next) return next;
  return { ...opaqueFields(previous, known), ...next } as T;
}

/**
 * Preserve data written by a newer daemon without letting known legacy fields
 * reappear after their explicit read transform.  This is deliberately a
 * write-time merge: loading remains read-only and never rewrites/compacts a
 * record just because this version does not recognize every field.
 */
function preserveOpaqueRecordFields(
  previous: StoredAgentRecord | null,
  next: StoredAgentRecord,
): StoredAgentRecord {
  const merged = {
    ...(previous ? opaqueFields(previous, STORED_RECORD_KEYS) : {}),
    ...next,
  } as StoredAgentRecord;
  merged.config = preserveOpaqueObjectFields(
    previous?.config,
    next.config,
    STORED_CONFIG_KEYS,
  ) as StoredAgentRecord["config"];
  merged.persistence = preserveOpaqueObjectFields(
    previous?.persistence,
    next.persistence,
    PERSISTENCE_HANDLE_KEYS,
  ) as StoredAgentRecord["persistence"];
  merged.runtimeInfo = preserveOpaqueObjectFields(
    previous?.runtimeInfo,
    next.runtimeInfo,
    RUNTIME_INFO_KEYS,
  ) as StoredAgentRecord["runtimeInfo"];
  return merged;
}

export function hasArchiveStopPending(record: StoredAgentRecord | null | undefined): boolean {
  return Boolean(
    record?.persistence?.metadata &&
    Object.prototype.hasOwnProperty.call(
      record.persistence.metadata,
      ARCHIVE_STOP_PENDING_METADATA_KEY,
    ),
  );
}

function withoutArchiveStopPending(record: StoredAgentRecord): StoredAgentRecord {
  if (!record.persistence?.metadata) return record;
  const metadata = { ...record.persistence.metadata };
  delete metadata[ARCHIVE_STOP_PENDING_METADATA_KEY];
  return { ...record, persistence: { ...record.persistence, metadata } };
}

function preserveArchiveStopPending(
  existing: StoredAgentRecord | null,
  next: StoredAgentRecord,
  options: AgentStorageUpsertOptions | undefined,
): StoredAgentRecord {
  if (options?.clearArchiveStopPending) {
    return withoutArchiveStopPending(next);
  }
  if (existing && hasArchiveStopPending(existing)) {
    // The receipt is exact ownership evidence for the whole persistence
    // handle, not metadata that may be carried onto a newer provider session.
    // In particular, merging its marker into `next.persistence` would bind
    // receipt A to outer handle B after a stale write. Retain the complete raw
    // guarded handle (including unknown/newer fields and malformed-present
    // data) until an explicitly authorized terminal clear replaces it.
    const previousPersistence = existing.persistence!;
    return {
      ...next,
      persistence: previousPersistence,
    };
  }
  return options?.createArchiveStopPending ? next : withoutArchiveStopPending(next);
}

const STORED_AGENT_SCHEMA = RAW_STORED_AGENT_SCHEMA.transform(
  (record): StoredAgentRecord => foldLegacyRecordFields(record as unknown as RawStoredAgentRecord),
);

export function parseStoredAgentRecord(value: unknown): StoredAgentRecord {
  return STORED_AGENT_SCHEMA.parse(value);
}

export function hasArchiveStopIntent(record: StoredAgentRecord | null | undefined): boolean {
  return Boolean(
    record && Object.prototype.hasOwnProperty.call(record, ARCHIVE_STOP_INTENT_RECORD_KEY),
  );
}

export function readArchiveStopIntent(
  record: StoredAgentRecord | null | undefined,
): ArchiveStopIntent | null {
  const candidate = record?.[ARCHIVE_STOP_INTENT_RECORD_KEY];
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  if (
    value.version !== 1 ||
    (value.operation !== "archive" && value.operation !== "terminate") ||
    typeof value.requestedAt !== "string"
  ) {
    return null;
  }
  return value as unknown as ArchiveStopIntent;
}

export function withArchiveStopIntent(
  record: StoredAgentRecord,
  intent: ArchiveStopIntent,
): StoredAgentRecord {
  return { ...record, [ARCHIVE_STOP_INTENT_RECORD_KEY]: intent };
}

export function withoutArchiveStopIntent(record: StoredAgentRecord): StoredAgentRecord {
  const next = { ...record };
  delete next[ARCHIVE_STOP_INTENT_RECORD_KEY];
  return next;
}

interface LoadedStoredAgentRecord {
  record: StoredAgentRecord;
  filePath: string;
}

function archiveGuardRank(record: StoredAgentRecord): number {
  // A native pending marker is more specific than the no-handle intent, but
  // either must win over an ordinary duplicate. A record with both retains
  // both pieces of fail-closed evidence.
  return (hasArchiveStopPending(record) ? 2 : 0) + (hasArchiveStopIntent(record) ? 1 : 0);
}

function compareCanonicalStoredRecord(
  left: LoadedStoredAgentRecord,
  right: LoadedStoredAgentRecord,
): number {
  const guardOrder = archiveGuardRank(right.record) - archiveGuardRank(left.record);
  if (guardOrder !== 0) return guardOrder;

  // Do not let filesystem enumeration order choose between ordinary copies.
  // ISO timestamps compare lexically, and the path is an explicit stable
  // final tie-breaker for malformed/equal timestamps.
  const updatedOrder = right.record.updatedAt.localeCompare(left.record.updatedAt);
  if (updatedOrder !== 0) return updatedOrder;
  const createdOrder = right.record.createdAt.localeCompare(left.record.createdAt);
  if (createdOrder !== 0) return createdOrder;
  return left.filePath.localeCompare(right.filePath);
}

/**
 * An interrupted cwd move may leave more than one file for an agent id. A
 * guarded copy is canonical even when an unguarded copy is newer: copying a
 * pending marker onto another persistence handle would make a different
 * native session appear retryable. Keep the guarded copy's exact raw identity
 * instead. When separate copies carry a record-level intent and a native
 * pending marker, retain both guards so recovery remains fail-closed.
 */
function chooseCanonicalStoredRecord(
  candidates: readonly LoadedStoredAgentRecord[],
): LoadedStoredAgentRecord {
  const ordered = [...candidates].sort(compareCanonicalStoredRecord);
  const canonical = ordered[0];
  if (!canonical) throw new Error("Expected at least one stored agent record");

  if (hasArchiveStopIntent(canonical.record)) return canonical;
  const intentCarrier = ordered.find((candidate) => hasArchiveStopIntent(candidate.record));
  if (!intentCarrier) return canonical;
  return {
    ...canonical,
    record: {
      ...canonical.record,
      [ARCHIVE_STOP_INTENT_RECORD_KEY]: intentCarrier.record[ARCHIVE_STOP_INTENT_RECORD_KEY],
    },
  };
}

export class AgentStorage {
  private cache: Map<string, StoredAgentRecord> = new Map();
  private pathById: Map<string, string> = new Map();
  private pathsById: Map<string, Set<string>> = new Map();
  private pendingWrites: Map<string, Promise<void>> = new Map();
  private deleting: Set<string> = new Set();
  private daemonAgentIdsByExecution: Map<string, string> = new Map();
  private daemonExecutionKeysByAgentId: Map<string, string> = new Map();
  private readonly idsByWorkspace = new Map<string, Set<string>>();
  private readonly workspaceById = new Map<string, string>();
  private readonly activeIds = new Set<string>();
  private readonly promptTimeByAgent = new Map<string, string>();
  private readonly promptTimes = new Map<string, string>();
  private loaded = false;
  private baseDir: string;
  private loadPromise: Promise<void> | null = null;
  private logger: Logger;

  constructor(baseDir: string, logger: Logger) {
    this.baseDir = baseDir;
    this.logger = logger.child({ module: "agent", component: "agent-storage" });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async listAll(): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  async listActive(options?: { includeArchived?: boolean }): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(
      options?.includeArchived ? this.cache.keys() : this.activeIds,
      (id) => this.cache.get(id)!,
    );
  }

  async listByWorkspaces(
    workspaceIds: Iterable<string>,
    options?: { includeArchived?: boolean },
  ): Promise<StoredAgentRecord[]> {
    await this.load();
    const records: StoredAgentRecord[] = [];
    for (const workspaceId of new Set(workspaceIds)) {
      for (const id of this.idsByWorkspace.get(workspaceId) ?? []) {
        const record = this.cache.get(id)!;
        if (options?.includeArchived || !record.archivedAt) records.push(record);
      }
    }
    return records;
  }

  async lastUserMessageAtByWorkspace(
    workspaceIds?: Iterable<string>,
    options?: { excludeAgentIds?: Iterable<string> },
  ): Promise<ReadonlyMap<string, string>> {
    await this.load();
    const times = new Map<string, string>();
    const excluded = new Set(options?.excludeAgentIds);
    const affected = new Set(Array.from(excluded, (id) => this.workspaceById.get(id)));
    for (const id of workspaceIds ?? this.promptTimes.keys()) {
      let at = this.promptTimes.get(id);
      if (affected.has(id)) {
        at = undefined;
        for (const agentId of this.idsByWorkspace.get(id) ?? []) {
          const record = this.cache.get(agentId)!;
          if (
            !excluded.has(agentId) &&
            !record.internal &&
            !record.background &&
            record.lastUserMessageAt &&
            record.lastUserMessageAt > (at ?? "")
          ) {
            at = record.lastUserMessageAt;
          }
        }
      }
      if (at) times.set(id, at);
    }
    return times;
  }

  private indexWorkspace(record: StoredAgentRecord): void {
    const previous = this.workspaceById.get(record.id);
    if (previous) this.idsByWorkspace.get(previous)?.delete(record.id);
    this.workspaceById.delete(record.id);
    this.activeIds.delete(record.id);
    if (!record.archivedAt) this.activeIds.add(record.id);
    if (record.workspaceId) {
      const ids = this.idsByWorkspace.get(record.workspaceId) ?? new Set<string>();
      ids.add(record.id);
      this.idsByWorkspace.set(record.workspaceId, ids);
      this.workspaceById.set(record.id, record.workspaceId);
    }
    this.indexPromptTime(record, previous);
  }

  private indexPromptTime(record: StoredAgentRecord, previous: string | undefined): void {
    const previousTime = this.promptTimeByAgent.get(record.id);
    const nextTime =
      !record.internal && !record.background ? (record.lastUserMessageAt ?? undefined) : undefined;
    if (nextTime) this.promptTimeByAgent.set(record.id, nextTime);
    else this.promptTimeByAgent.delete(record.id);
    if (previous === record.workspaceId && previousTime === nextTime) return;
    if (
      previous &&
      previousTime &&
      this.promptTimes.get(previous) === previousTime &&
      (previous !== record.workspaceId || !nextTime || nextTime < previousTime)
    ) {
      this.refreshPromptTime(previous);
    }
    if (
      record.workspaceId &&
      nextTime &&
      nextTime > (this.promptTimes.get(record.workspaceId) ?? "")
    ) {
      this.promptTimes.set(record.workspaceId, nextTime);
    }
  }

  private refreshPromptTime(workspaceId: string): void {
    this.promptTimes.delete(workspaceId);
    let latest = "";
    for (const id of this.idsByWorkspace.get(workspaceId) ?? []) {
      const record = this.cache.get(id)!;
      if (
        !record.internal &&
        !record.background &&
        record.lastUserMessageAt &&
        record.lastUserMessageAt > latest
      )
        latest = record.lastUserMessageAt;
    }
    if (latest) this.promptTimes.set(workspaceId, latest);
  }

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    await this.load();
    return this.cache.get(agentId) ?? null;
  }

  async listByProviderSession(
    provider: string,
    providerHandleId: string,
  ): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values()).filter(
      (record) =>
        record.persistence?.provider === provider &&
        (record.persistence.sessionId === providerHandleId ||
          record.persistence.nativeHandle === providerHandleId),
    );
  }

  async listByWorkspace(workspaceId: string): Promise<StoredAgentRecord[]> {
    return this.listByWorkspaces([workspaceId], { includeArchived: true });
  }

  async findByDaemonExecution(owner: DaemonAgentOwner): Promise<StoredAgentRecord | null> {
    await this.load();
    const agentId = this.daemonAgentIdsByExecution.get(daemonExecutionKey(owner));
    return agentId ? (this.cache.get(agentId) ?? null) : null;
  }

  /**
   * Ordinary writes must not erase a durable archive-intent guard from an
   * older snapshot. Only the manager's verified terminal release/commit is
   * allowed to opt into clearing it.
   */
  async upsert(record: StoredAgentRecord, options?: AgentStorageUpsertOptions): Promise<void> {
    await this.load();
    await this.queueRecordMutation(record.id, (existing) => {
      const preservedRecord = preserveOpaqueRecordFields(existing, record);
      const preserveArchivedAt = Boolean(
        existing?.archivedAt && !preservedRecord.archivedAt && !options?.allowUnarchive,
      );
      let next = preserveArchivedAt
        ? { ...preservedRecord, archivedAt: existing!.archivedAt }
        : preservedRecord;
      if (options?.clearArchiveStopIntent) {
        next = withoutArchiveStopIntent(next);
      } else if (existing && hasArchiveStopIntent(existing)) {
        return {
          ...preserveArchiveStopPending(existing, next, options),
          [ARCHIVE_STOP_INTENT_RECORD_KEY]: existing[ARCHIVE_STOP_INTENT_RECORD_KEY],
        };
      } else if (hasArchiveStopIntent(next) && !options?.createArchiveStopIntent) {
        // A terminal write can finish while another caller still holds a
        // pre-terminal guarded record. Ordinary writes never get authority to
        // introduce this private guard, regardless of their timestamp.
        next = withoutArchiveStopIntent(next);
      }
      return preserveArchiveStopPending(existing, next, options);
    });
  }

  /**
   * Consume one startup-resume intent only if the serialized current record is
   * still unguarded. A scheduler may have selected a record before archive or
   * terminate persisted its ownership marker; a stale read/ordinary upsert
   * would preserve that marker yet incorrectly burn the retry intent.
   *
   * Returning the post-consumption record authorizes dispatch. `null` means
   * missing, already consumed, deleting, or guarded (including malformed but
   * present markers), and therefore must never start a provider session.
   */
  async consumeResumeOnStartupIfUnguarded(agentId: string): Promise<StoredAgentRecord | null> {
    await this.load();
    let consumed: StoredAgentRecord | null = null;
    await this.queueRecordMutation(agentId, (existing) => {
      if (
        !existing?.resumeOnStartup ||
        hasArchiveStopIntent(existing) ||
        hasArchiveStopPending(existing)
      ) {
        return null;
      }
      consumed = { ...existing, resumeOnStartup: false };
      return consumed;
    });
    return consumed;
  }

  private queueRecordMutation(
    agentId: string,
    mutate: (existing: StoredAgentRecord | null) => StoredAgentRecord | null,
  ): Promise<void> {
    const prev = this.pendingWrites.get(agentId) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (this.deleting.has(agentId)) {
        return undefined;
      }

      const record = mutate(this.cache.get(agentId) ?? null);
      if (!record) {
        return undefined;
      }
      await this.writeRecord(record);
      return undefined;
    });

    const tracked = next.finally(() => {
      if (this.pendingWrites.get(agentId) === tracked) {
        this.pendingWrites.delete(agentId);
      }
    });

    this.pendingWrites.set(agentId, tracked);
    return tracked;
  }

  private async writeRecord(record: StoredAgentRecord): Promise<void> {
    const agentId = record.id;
    const nextPath = this.buildRecordPath(record);
    const previousPath = this.pathById.get(agentId);

    await writeJsonFileAtomic(nextPath, record);
    this.addIndexedPath(agentId, nextPath);

    if (previousPath && previousPath !== nextPath) {
      try {
        await fs.unlink(previousPath);
      } catch {
        // ignore cleanup errors
      }
      this.removeIndexedPath(agentId, previousPath);
    }

    this.cache.set(agentId, record);
    this.indexOwner(record);
    this.pathById.set(agentId, nextPath);
  }

  beginDelete(agentId: string): void {
    this.deleting.add(agentId);
  }

  async remove(agentId: string): Promise<void> {
    await this.load();
    this.beginDelete(agentId);
    await (this.pendingWrites.get(agentId) ?? Promise.resolve());
    const paths = Array.from(this.pathsById.get(agentId) ?? []);
    await Promise.all(
      paths.map(async (filePath) => {
        try {
          await fs.unlink(filePath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code && code !== "ENOENT") {
            this.logger.warn(
              { err: error, agentId, filePath },
              "Failed to remove agent record file",
            );
          }
        }
      }),
    );

    const workspaceId = this.workspaceById.get(agentId);
    this.workspaceById.delete(agentId);
    this.promptTimeByAgent.delete(agentId);
    this.activeIds.delete(agentId);
    if (workspaceId) {
      this.idsByWorkspace.get(workspaceId)?.delete(agentId);
      this.refreshPromptTime(workspaceId);
    }
    this.cache.delete(agentId);
    this.removeOwnerIndex(agentId);
    this.pathById.delete(agentId);
    this.pathsById.delete(agentId);
  }

  async applySnapshot(
    agent: ManagedAgent,
    options?: { title?: string | null; internal?: boolean; createArchiveStopPending?: boolean },
  ): Promise<void> {
    await this.load();
    const hasTitleOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "title");
    const hasInternalOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "internal");
    await this.queueRecordMutation(agent.id, (existing) => {
      let record = toStoredAgentRecord(agent, {
        title: hasTitleOverride ? (options?.title ?? null) : (existing?.title ?? null),
        createdAt: existing?.createdAt,
        internal: hasInternalOverride ? options?.internal : (agent.internal ?? existing?.internal),
      });

      // Preserve soft-delete/archive status across snapshot flushes. The
      // projection runs inside the per-agent write queue so it cannot commit a
      // stale pre-archive record after the archive mutation.
      if (existing && existing.archivedAt !== undefined) {
        record.archivedAt = existing.archivedAt;
      }
      record = preserveOpaqueRecordFields(existing, record);
      record = preserveArchiveStopPending(existing, record, options);
      // Background is fixed at creation; a runtime opened without it cannot clear it.
      if (existing?.background) record.background = true;
      // Archive intent is a fail-closed admission guard rather than live
      // session state. Snapshot refreshes must preserve even malformed-present
      // values until a verified terminal transition explicitly removes them.
      if (existing && hasArchiveStopIntent(existing)) {
        record[ARCHIVE_STOP_INTENT_RECORD_KEY] = existing[ARCHIVE_STOP_INTENT_RECORD_KEY];
      }
      record.resumeOnStartup =
        existing?.resumeOnStartup && agent.lifecycle !== "idle" && agent.lifecycle !== "error";
      return record;
    });
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    await this.load();
    await this.waitForPendingWrite(agentId);
    const record = await this.get(agentId);
    if (!record) {
      throw new Error(`Agent ${agentId} not found`);
    }
    await this.upsert({ ...record, title });
  }

  async flush(): Promise<void> {
    await this.load().catch(() => undefined);
    const writes = Array.from(this.pendingWrites.values());
    await Promise.allSettled(writes);
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    if (!this.loadPromise) {
      this.loadPromise = this.doLoad();
    }

    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    this.cache.clear();
    this.pathById.clear();
    this.pathsById.clear();
    this.daemonAgentIdsByExecution.clear();
    this.daemonExecutionKeysByAgentId.clear();

    try {
      await this.scanDisk();
      this.loaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return;
      }
      this.logger.error({ err: error }, "Failed to load agents");
      this.loaded = true;
    }
  }

  private async scanDisk(): Promise<void> {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    const rootRecordPaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectFileLists = await Promise.all(
      projectDirs.map(async (projectDir) => {
        try {
          const files = await fs.readdir(projectDir, { withFileTypes: true });
          return files
            .filter((file) => file.isFile() && file.name.endsWith(".json"))
            .map((file) => path.join(projectDir, file.name));
        } catch {
          return [];
        }
      }),
    );

    const allFilePaths = [...rootRecordPaths, ...projectFileLists.flat()].sort();
    const loaded = await Promise.all(
      allFilePaths.map(async (filePath) => {
        const record = await this.readRecordFile(filePath);
        return record ? { record, filePath } : null;
      }),
    );

    const candidatesById = new Map<string, LoadedStoredAgentRecord[]>();
    for (const item of loaded) {
      if (!item) continue;
      const candidates = candidatesById.get(item.record.id) ?? [];
      candidates.push(item);
      candidatesById.set(item.record.id, candidates);
    }

    for (const [agentId, candidates] of candidatesById) {
      const canonical = chooseCanonicalStoredRecord(candidates);
      if (candidates.length > 1) {
        this.logger.warn(
          {
            agentId,
            canonicalPath: canonical.filePath,
            duplicatePaths: candidates.map((candidate) => candidate.filePath),
          },
          "Found duplicate agent records; retaining fail-closed canonical record",
        );
      }
      this.cache.set(agentId, canonical.record);
      this.indexOwner(canonical.record);
      this.pathById.set(agentId, canonical.filePath);
      for (const candidate of candidates) {
        this.addIndexedPath(agentId, candidate.filePath);
      }
    }
  }

  private async readRecordFile(filePath: string): Promise<StoredAgentRecord | null> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      return parseStoredAgentRecord(parsed);
    } catch (error) {
      this.logger.error({ err: error, filePath }, "Skipping invalid agent record");
      return null;
    }
  }

  private buildRecordPath(record: StoredAgentRecord): string {
    const projectDir = projectDirNameFromCwd(record.cwd);
    return path.join(this.baseDir, projectDir, `${record.id}.json`);
  }

  private addIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId) ?? new Set<string>();
    paths.add(filePath);
    this.pathsById.set(agentId, paths);
  }

  private removeIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId);
    if (!paths) {
      return;
    }
    paths.delete(filePath);
    if (paths.size === 0) {
      this.pathsById.delete(agentId);
    }
  }

  private indexOwner(record: StoredAgentRecord): void {
    this.indexWorkspace(record);
    this.removeOwnerIndex(record.id);
    if (record.owner?.kind === "daemon") {
      const key = daemonExecutionKey(record.owner);
      const previousAgentId = this.daemonAgentIdsByExecution.get(key);
      if (previousAgentId && previousAgentId !== record.id) {
        this.daemonExecutionKeysByAgentId.delete(previousAgentId);
      }
      this.daemonAgentIdsByExecution.set(key, record.id);
      this.daemonExecutionKeysByAgentId.set(record.id, key);
    }
  }

  private removeOwnerIndex(agentId: string): void {
    const key = this.daemonExecutionKeysByAgentId.get(agentId);
    if (!key) return;
    if (this.daemonAgentIdsByExecution.get(key) === agentId) {
      this.daemonAgentIdsByExecution.delete(key);
    }
    this.daemonExecutionKeysByAgentId.delete(agentId);
  }

  private async waitForPendingWrite(agentId: string): Promise<void> {
    await (this.pendingWrites.get(agentId) ?? Promise.resolve()).catch(() => undefined);
  }
}

function projectDirNameFromCwd(cwd: string): string {
  // path.win32.parse handles drive letters, UNC roots, and Unix roots on all platforms
  const { root } = path.win32.parse(cwd);
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  // Sanitize root: strip colons and separators, keep letters (e.g. "C:\" → "C", "\\server\share\" → "server-share")
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = sanitizedRoot ? sanitizedRoot + "-" : "";
  if (!withoutRoot) {
    return sanitizedRoot || "root";
  }
  return prefix + withoutRoot.replace(/[\\/]+/g, "-");
}

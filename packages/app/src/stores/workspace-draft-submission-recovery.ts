import { z } from "zod";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ComposerAttachment } from "@/attachments/types";
import { AttachmentMetadataSchema, UserComposerAttachmentSchema } from "@/stores/draft-store/state";
import { ReviewAttachmentSchema, TextAttachmentSchema } from "@getpaseo/protocol/messages";
import { isWeb } from "@/constants/platform";

export const SUBMISSION_RECOVERY_SCHEMA_VERSION = 1;
const DATABASE_NAME = "paseo-composer-submission-recovery";
const DATABASE_VERSION = 1;
const STORE_NAME = "submissions";
const NATIVE_STORAGE_KEY = "@paseo:composer-submission-recovery:v1";

export type SubmissionRecoveryState = "queued" | "dispatching" | "needs_review" | "settled";
export type SubmissionRecoveryKind = "agent_message" | "workspace_create";
export type SubmissionRecoveryInspectionState =
  | "queued"
  | "needs_review"
  | "dispatching_unknown"
  | "accepted";

export interface SubmissionRecoveryLease {
  ownerId: string;
  fence: string;
  expiresAt: number;
}

export interface SubmissionRecoveryRecord {
  schemaVersion: typeof SUBMISSION_RECOVERY_SCHEMA_VERSION;
  id: string;
  clientMessageId: string;
  state: SubmissionRecoveryState;
  submission: {
    kind: SubmissionRecoveryKind;
    serverId: string;
    agentId: string | null;
    workspaceId: string | null;
    draftId: string | null;
    cwd: string;
    text: string;
    attachments: ComposerAttachment[];
  };
  originalDraft: {
    ownerKey: string;
    text: string;
    attachments: ComposerAttachment[];
    selection: { start: number; end: number };
  };
  lease: SubmissionRecoveryLease | null;
  /**
   * The immutable fence for the most recent dispatch attempt. It survives a
   * stale transition to needs_review so that a late authoritative ACK from
   * that attempt can still settle the record without making it retryable.
   */
  dispatchLease?: SubmissionRecoveryLease | null;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
  acceptedAt?: number;
}

const BoundingRectSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
const BrowserElementAttachmentSchema = z.strictObject({
  url: z.string(),
  selector: z.string(),
  tag: z.string(),
  text: z.string(),
  outerHTML: z.string(),
  computedStyles: z.record(z.string(), z.string()),
  boundingRect: BoundingRectSchema,
  reactSource: z
    .strictObject({
      fileName: z.string().nullable(),
      lineNumber: z.number().nullable(),
      columnNumber: z.number().nullable(),
      componentName: z.string().nullable(),
    })
    .nullable(),
  parentChain: z.array(z.string()),
  children: z.array(z.string()),
  comment: z.string().optional(),
  screenshot: AttachmentMetadataSchema.optional(),
  formatted: z.string(),
});
const PullRequestContextFields = {
  id: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  text: z.string(),
  url: z.string().nullable().optional(),
};
const WorkspaceComposerAttachmentSchema = z.union([
  z.strictObject({
    kind: z.literal("browser_element"),
    attachment: BrowserElementAttachmentSchema,
  }),
  z.strictObject({ kind: z.literal("forge.change_request_comment"), ...PullRequestContextFields }),
  z.strictObject({ kind: z.literal("forge.change_request_review"), ...PullRequestContextFields }),
  z.strictObject({ kind: z.literal("forge.change_request_check"), ...PullRequestContextFields }),
  z.strictObject({ kind: z.literal("github.pull_request_comment"), ...PullRequestContextFields }),
  z.strictObject({ kind: z.literal("github.pull_request_review"), ...PullRequestContextFields }),
  z.strictObject({ kind: z.literal("github.pull_request_check"), ...PullRequestContextFields }),
  z.strictObject({
    kind: z.literal("chat_history"),
    id: z.string(),
    // Chat history is intentionally constrained to protocol text context.
    // A broader AgentAttachment union would accept a forge/review/file record
    // that cannot satisfy the Composer chat-history contract on recovery.
    attachment: TextAttachmentSchema,
    source: z.strictObject({
      serverId: z.string(),
      agentId: z.string(),
      boundaryMessageId: z.string().nullable().optional(),
      boundaryCursor: z
        .strictObject({ epoch: z.string(), seq: z.number().int().nonnegative() })
        .nullable()
        .optional(),
      itemCount: z.number().int().nonnegative().optional(),
    }),
  }),
  z.strictObject({
    kind: z.literal("review"),
    attachment: ReviewAttachmentSchema,
    reviewDraftKey: z.string(),
    commentCount: z.number().int().nonnegative(),
  }),
]);
const ComposerAttachmentSchema = z.union([
  UserComposerAttachmentSchema,
  WorkspaceComposerAttachmentSchema,
]);
const LeaseSchema = z.strictObject({
  ownerId: z.string(),
  fence: z.string(),
  expiresAt: z.number().finite(),
});

export const SubmissionRecoveryRecordSchema = z.strictObject({
  schemaVersion: z.literal(SUBMISSION_RECOVERY_SCHEMA_VERSION),
  id: z.string(),
  clientMessageId: z.string(),
  state: z.enum(["queued", "dispatching", "needs_review", "settled"]),
  submission: z.strictObject({
    kind: z.enum(["agent_message", "workspace_create"]),
    serverId: z.string(),
    agentId: z.string().nullable(),
    workspaceId: z.string().nullable(),
    draftId: z.string().nullable(),
    cwd: z.string(),
    text: z.string(),
    attachments: z.array(ComposerAttachmentSchema),
  }),
  originalDraft: z.strictObject({
    ownerKey: z.string(),
    text: z.string(),
    attachments: z.array(ComposerAttachmentSchema),
    selection: z.strictObject({
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    }),
  }),
  lease: LeaseSchema.nullable(),
  dispatchLease: LeaseSchema.nullable().optional(),
  errorMessage: z.string().optional(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  acceptedAt: z.number().finite().optional(),
});

export interface SubmissionRecoveryStore {
  putIfAbsent(record: SubmissionRecoveryRecord): Promise<SubmissionRecoveryRecord>;
  get(id: string): Promise<SubmissionRecoveryRecord | null>;
  list(): Promise<SubmissionRecoveryRecord[]>;
  /**
   * Remove only an immutable record that is still known-unsent. This is used
   * when the in-memory queue is explicitly edited or discarded; it must never
   * erase a dispatching, uncertain, or accepted delivery provenance record.
   */
  discardQueued(input: {
    id: string;
    clientMessageId: string;
    submission: { text: string; attachments: ComposerAttachment[] };
  }): Promise<SubmissionRecoveryDiscardQueuedResult>;
  claimForDispatch(input: {
    id: string;
    ownerId: string;
    now: number;
    leaseMs: number;
  }): Promise<SubmissionRecoveryClaim>;
  markNeedsReview(input: {
    id: string;
    lease: SubmissionRecoveryLease | null;
    errorMessage: string;
    now: number;
  }): Promise<SubmissionRecoveryRecord | null>;
  markSettled(input: {
    id: string;
    lease: SubmissionRecoveryLease | null;
    now: number;
  }): Promise<SubmissionRecoveryRecord | null>;
  remove(id: string): Promise<void>;
}

export type SubmissionRecoveryClaim =
  | { status: "missing" }
  | { status: "acquired"; record: SubmissionRecoveryRecord; lease: SubmissionRecoveryLease }
  | { status: "busy"; record: SubmissionRecoveryRecord }
  | { status: "needs_review"; record: SubmissionRecoveryRecord }
  | { status: "settled"; record: SubmissionRecoveryRecord };

export type SubmissionRecoveryDiscardQueuedResult =
  | { status: "removed" }
  | { status: "missing" }
  | { status: "not_queued"; record: SubmissionRecoveryRecord }
  | { status: "mismatch"; record: SubmissionRecoveryRecord };

function parseRecord(value: unknown): SubmissionRecoveryRecord | null {
  const parsed = SubmissionRecoveryRecordSchema.safeParse(value);
  return parsed.success ? (parsed.data as SubmissionRecoveryRecord) : null;
}

function parseStoredRecord(value: unknown, id: string): SubmissionRecoveryRecord | null {
  if (value === undefined || value === null) return null;
  const record = parseRecord(value);
  if (record) return record;
  throw new Error(
    `Submission recovery record ${id} is unreadable or from an unsupported schema. Keep the draft and resolve this record before retrying.`,
  );
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`)
    .join(",")}}`;
}

/**
 * A settled checkpoint is evidence that this exact local source snapshot was
 * accepted. It must not be presented as a fresh unsent draft merely because a
 * later draft-clear write failed.
 */
export function hasEquivalentOriginalDraftSnapshot(
  record: SubmissionRecoveryRecord,
  draft: { text: string; attachments: readonly ComposerAttachment[] },
): boolean {
  return (
    record.originalDraft.text === draft.text &&
    stableJson(record.originalDraft.attachments as unknown as JsonValue) ===
      stableJson(draft.attachments as unknown as JsonValue)
  );
}

/** Compare a queued/dispatch source to its immutable reserved wire snapshot. */
export function hasEquivalentSubmissionSnapshot(
  record: SubmissionRecoveryRecord,
  submission: { text: string; attachments: readonly ComposerAttachment[] },
): boolean {
  return (
    record.submission.text === submission.text &&
    stableJson(record.submission.attachments as unknown as JsonValue) ===
      stableJson(submission.attachments as unknown as JsonValue)
  );
}

function discardQueuedRecord(input: {
  record: SubmissionRecoveryRecord | null;
  clientMessageId: string;
  submission: { text: string; attachments: ComposerAttachment[] };
}): SubmissionRecoveryDiscardQueuedResult {
  const { record, clientMessageId, submission } = input;
  if (!record) return { status: "missing" };
  if (record.state !== "queued") return { status: "not_queued", record };
  if (
    record.clientMessageId !== clientMessageId ||
    !hasEquivalentSubmissionSnapshot(record, submission)
  ) {
    return { status: "mismatch", record };
  }
  return { status: "removed" };
}

/**
 * Hydration only classifies stored records for inspection. It never claims or
 * dispatches them. A current lease is left to the in-session executor; an
 * expired/missing lease is visible as uncertain while retaining its fence for
 * a possible late authoritative ACK.
 */
export function getSubmissionRecoveryInspectionState(
  record: SubmissionRecoveryRecord,
  now = Date.now(),
): SubmissionRecoveryInspectionState | null {
  if (record.state === "queued") return "queued";
  if (record.state === "needs_review") return "needs_review";
  if (record.state === "settled") return "accepted";
  if (!record.lease || record.lease.expiresAt <= now) return "dispatching_unknown";
  return null;
}

/**
 * A client message identity is a reservation for immutable source bytes. A
 * duplicate delivery may reuse it, but a later edit must reserve a new id
 * rather than accidentally claim and dispatch the older checkpoint.
 */
export function hasEquivalentSubmissionPayload(
  existing: SubmissionRecoveryRecord,
  incoming: SubmissionRecoveryRecord,
): boolean {
  return (
    existing.id === incoming.id &&
    existing.clientMessageId === incoming.clientMessageId &&
    stableJson({
      clientMessageId: existing.clientMessageId,
      submission: existing.submission as unknown as JsonValue,
      originalDraft: existing.originalDraft as unknown as JsonValue,
    }) ===
      stableJson({
        clientMessageId: incoming.clientMessageId,
        submission: incoming.submission as unknown as JsonValue,
        originalDraft: incoming.originalDraft as unknown as JsonValue,
      })
  );
}

function assertEquivalentSubmissionPayload(
  existing: SubmissionRecoveryRecord,
  incoming: SubmissionRecoveryRecord,
): void {
  if (hasEquivalentSubmissionPayload(existing, incoming)) return;
  throw new Error(
    "This client message ID is already reserved for different draft content. Create a new submission instead.",
  );
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Submission recovery IndexedDB request failed.")),
    );
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("Submission recovery IndexedDB transaction aborted.")),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("Submission recovery IndexedDB transaction failed.")),
    );
  });
}

async function runTransaction<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const transaction = database.transaction(STORE_NAME, mode);
  const complete = transactionComplete(transaction);
  try {
    const result = await operation(transaction.objectStore(STORE_NAME));
    await complete;
    return result;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // A failed request can already have aborted the transaction.
    }
    await complete.catch(() => undefined);
    throw error;
  }
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error("IndexedDB is unavailable in this runtime."));
  }
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(databaseName, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Failed to open submission recovery IndexedDB.")),
    );
    request.addEventListener("blocked", () =>
      reject(new Error("Submission recovery IndexedDB open was blocked.")),
    );
  });
}

function staleDispatchRecord(
  record: SubmissionRecoveryRecord,
  now: number,
): SubmissionRecoveryRecord {
  return {
    ...record,
    state: "needs_review",
    lease: null,
    dispatchLease: record.dispatchLease ?? record.lease,
    errorMessage: "The previous send may have reached the provider. Review it before retrying.",
    updatedAt: now,
  };
}

function hasLease(
  record: SubmissionRecoveryRecord,
  lease: SubmissionRecoveryLease | null,
): boolean {
  return (
    lease !== null && record.lease?.ownerId === lease.ownerId && record.lease.fence === lease.fence
  );
}

function hasDispatchLease(
  record: SubmissionRecoveryRecord,
  lease: SubmissionRecoveryLease | null,
): boolean {
  return (
    lease !== null &&
    record.dispatchLease?.ownerId === lease.ownerId &&
    record.dispatchLease.fence === lease.fence
  );
}

function collectAttachmentIds(attachments: readonly ComposerAttachment[], ids: Set<string>): void {
  for (const attachment of attachments) {
    if (attachment.kind === "image" || attachment.kind === "pasted_text") {
      ids.add(attachment.metadata.id);
      continue;
    }
    if (attachment.kind === "browser_element" && attachment.attachment.screenshot) {
      ids.add(attachment.attachment.screenshot.id);
    }
  }
}

export function collectRecoveryAttachmentIds(
  records: readonly SubmissionRecoveryRecord[],
): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.state === "settled") continue;
    collectAttachmentIds(record.submission.attachments, ids);
    collectAttachmentIds(record.originalDraft.attachments, ids);
  }
  return ids;
}

export function createSubmissionRecoveryRecord(input: {
  id: string;
  clientMessageId: string;
  state?: Extract<SubmissionRecoveryState, "queued">;
  submission: SubmissionRecoveryRecord["submission"];
  originalDraft: SubmissionRecoveryRecord["originalDraft"];
  now?: number;
}): SubmissionRecoveryRecord {
  const now = input.now ?? Date.now();
  return {
    schemaVersion: SUBMISSION_RECOVERY_SCHEMA_VERSION,
    id: input.id,
    clientMessageId: input.clientMessageId,
    state: input.state ?? "queued",
    submission: input.submission,
    originalDraft: input.originalDraft,
    lease: null,
    dispatchLease: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** A new local store wrapper can share an IndexedDB database with another tab. */
export function createIndexedDbSubmissionRecoveryStore(input?: {
  databaseName?: string;
}): SubmissionRecoveryStore {
  const databaseName = input?.databaseName ?? DATABASE_NAME;
  let opening: Promise<IDBDatabase> | null = null;

  const database = async () => {
    opening ??= openDatabase(databaseName);
    try {
      return await opening;
    } catch (error) {
      opening = null;
      throw error;
    }
  };

  return {
    async putIfAbsent(record) {
      const db = await database();
      return await runTransaction(db, "readwrite", async (store) => {
        const existing = parseStoredRecord(await requestResult(store.get(record.id)), record.id);
        if (existing) {
          assertEquivalentSubmissionPayload(existing, record);
          return existing;
        }
        await requestResult(store.put(record));
        return record;
      });
    },

    async get(id) {
      const db = await database();
      return await runTransaction(db, "readonly", async (store) =>
        parseStoredRecord(await requestResult(store.get(id)), id),
      );
    },

    async list() {
      const db = await database();
      return await runTransaction(db, "readonly", async (store) => {
        const records = await requestResult<unknown[]>(store.getAll());
        return records
          .map((value) =>
            parseStoredRecord(
              value,
              typeof (value as { id?: unknown } | null)?.id === "string"
                ? (value as { id: string }).id
                : "unknown",
            ),
          )
          .filter((record): record is SubmissionRecoveryRecord => record !== null)
          .sort((left, right) => left.createdAt - right.createdAt);
      });
    },

    async discardQueued({ id, clientMessageId, submission }) {
      const db = await database();
      return await runTransaction(
        db,
        "readwrite",
        async (store): Promise<SubmissionRecoveryDiscardQueuedResult> => {
          const record = parseStoredRecord(await requestResult(store.get(id)), id);
          const result = discardQueuedRecord({ record, clientMessageId, submission });
          if (result.status === "removed") {
            await requestResult(store.delete(id));
          }
          return result;
        },
      );
    },

    async claimForDispatch({ id, ownerId, now, leaseMs }) {
      const db = await database();
      return await runTransaction(
        db,
        "readwrite",
        async (store): Promise<SubmissionRecoveryClaim> => {
          const record = parseStoredRecord(await requestResult(store.get(id)), id);
          if (!record) return { status: "missing" };
          if (record.state === "settled") return { status: "settled", record };
          if (record.state === "needs_review") return { status: "needs_review", record };
          if (record.state === "dispatching") {
            if (record.lease && record.lease.expiresAt <= now) {
              const stale = staleDispatchRecord(record, now);
              await requestResult(store.put(stale));
              return { status: "needs_review", record: stale };
            }
            return { status: "busy", record };
          }
          const lease: SubmissionRecoveryLease = {
            ownerId,
            fence: globalThis.crypto?.randomUUID?.() ?? `${now}:${Math.random()}`,
            expiresAt: now + leaseMs,
          };
          const claimed: SubmissionRecoveryRecord = {
            ...record,
            state: "dispatching",
            lease,
            dispatchLease: lease,
            errorMessage: undefined,
            updatedAt: now,
          };
          await requestResult(store.put(claimed));
          return { status: "acquired", record: claimed, lease };
        },
      );
    },

    async markNeedsReview({ id, lease, errorMessage, now }) {
      const db = await database();
      return await runTransaction(db, "readwrite", async (store) => {
        const record = parseStoredRecord(await requestResult(store.get(id)), id);
        if (!record || record.state === "settled" || !hasLease(record, lease)) return record;
        const next: SubmissionRecoveryRecord = {
          ...record,
          state: "needs_review",
          lease: null,
          dispatchLease: record.dispatchLease ?? record.lease,
          errorMessage,
          updatedAt: now,
        };
        await requestResult(store.put(next));
        return next;
      });
    },

    async markSettled({ id, lease, now }) {
      const db = await database();
      return await runTransaction(db, "readwrite", async (store) => {
        const record = parseStoredRecord(await requestResult(store.get(id)), id);
        if (!record) return null;
        // Once accepted, no later cleanup or stale-lease path may make the
        // record retryable again.
        if (record.state === "settled") return record;
        // A settlement without the immutable dispatch fence is never
        // authoritative. In particular, an arbitrary reload must not turn a
        // queued or uncertain record into an accepted one.
        if (lease === null || (!hasLease(record, lease) && !hasDispatchLease(record, lease))) {
          return record;
        }
        const next: SubmissionRecoveryRecord = {
          ...record,
          state: "settled",
          lease: null,
          errorMessage: undefined,
          acceptedAt: now,
          updatedAt: now,
        };
        await requestResult(store.put(next));
        return next;
      });
    },

    async remove(id) {
      const db = await database();
      await runTransaction(db, "readwrite", async (store) => {
        await requestResult(store.delete(id));
      });
    },
  };
}

interface AsyncKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const NativeRecoveryDocumentSchema = z.strictObject({
  schemaVersion: z.literal(SUBMISSION_RECOVERY_SCHEMA_VERSION),
  records: z.array(SubmissionRecoveryRecordSchema),
});

/**
 * Native has one JavaScript runtime rather than independently racing browser
 * tabs. Keep its recovery records in the same durable AsyncStorage policy as
 * drafts and serialize every local mutation before resolving it.
 */
export function createNativeAsyncStorageSubmissionRecoveryStore(input?: {
  storage?: AsyncKeyValueStorage;
  storageKey?: string;
}): SubmissionRecoveryStore {
  const storage = input?.storage ?? AsyncStorage;
  const storageKey = input?.storageKey ?? NATIVE_STORAGE_KEY;
  let tail: Promise<void> = Promise.resolve();

  const runExclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const readRecords = async (): Promise<Map<string, SubmissionRecoveryRecord>> => {
    const raw = await storage.getItem(storageKey);
    if (raw === null) return new Map();
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("The native submission recovery checkpoint is invalid.");
    }
    const parsed = NativeRecoveryDocumentSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error("The native submission recovery checkpoint is invalid.");
    }
    return new Map(parsed.data.records.map((record) => [record.id, record]));
  };
  const writeRecords = async (records: Map<string, SubmissionRecoveryRecord>): Promise<void> => {
    const document = {
      schemaVersion: SUBMISSION_RECOVERY_SCHEMA_VERSION,
      records: Array.from(records.values()),
    };
    if (records.size === 0) {
      await storage.removeItem(storageKey);
      return;
    }
    await storage.setItem(storageKey, JSON.stringify(document));
  };
  const listRecords = (records: Map<string, SubmissionRecoveryRecord>) =>
    Array.from(records.values()).sort((left, right) => left.createdAt - right.createdAt);

  return {
    putIfAbsent: (record) =>
      runExclusive(async () => {
        const records = await readRecords();
        const existing = records.get(record.id);
        if (existing) {
          assertEquivalentSubmissionPayload(existing, record);
          return existing;
        }
        records.set(record.id, record);
        await writeRecords(records);
        return record;
      }),
    get: (id) =>
      runExclusive(async () => {
        const records = await readRecords();
        return records.get(id) ?? null;
      }),
    list: () =>
      runExclusive(async () => {
        const records = await readRecords();
        return listRecords(records);
      }),
    discardQueued: ({ id, clientMessageId, submission }) =>
      runExclusive(async (): Promise<SubmissionRecoveryDiscardQueuedResult> => {
        const records = await readRecords();
        const result = discardQueuedRecord({
          record: records.get(id) ?? null,
          clientMessageId,
          submission,
        });
        if (result.status === "removed") {
          records.delete(id);
          await writeRecords(records);
        }
        return result;
      }),
    claimForDispatch: ({ id, ownerId, now, leaseMs }) =>
      runExclusive(async (): Promise<SubmissionRecoveryClaim> => {
        const records = await readRecords();
        const record = records.get(id);
        if (!record) return { status: "missing" };
        if (record.state === "settled") return { status: "settled", record };
        if (record.state === "needs_review") return { status: "needs_review", record };
        if (record.state === "dispatching") {
          if (record.lease && record.lease.expiresAt <= now) {
            const stale = staleDispatchRecord(record, now);
            records.set(id, stale);
            await writeRecords(records);
            return { status: "needs_review", record: stale };
          }
          return { status: "busy", record };
        }
        const lease: SubmissionRecoveryLease = {
          ownerId,
          fence: globalThis.crypto?.randomUUID?.() ?? `${now}:${Math.random()}`,
          expiresAt: now + leaseMs,
        };
        const claimed: SubmissionRecoveryRecord = {
          ...record,
          state: "dispatching",
          lease,
          dispatchLease: lease,
          errorMessage: undefined,
          updatedAt: now,
        };
        records.set(id, claimed);
        await writeRecords(records);
        return { status: "acquired", record: claimed, lease };
      }),
    markNeedsReview: ({ id, lease, errorMessage, now }) =>
      runExclusive(async () => {
        const records = await readRecords();
        const record = records.get(id) ?? null;
        if (!record || record.state === "settled" || !hasLease(record, lease)) return record;
        const next: SubmissionRecoveryRecord = {
          ...record,
          state: "needs_review",
          lease: null,
          dispatchLease: record.dispatchLease ?? record.lease,
          errorMessage,
          updatedAt: now,
        };
        records.set(id, next);
        await writeRecords(records);
        return next;
      }),
    markSettled: ({ id, lease, now }) =>
      runExclusive(async () => {
        const records = await readRecords();
        const record = records.get(id) ?? null;
        if (
          !record ||
          lease === null ||
          (!hasLease(record, lease) && !hasDispatchLease(record, lease))
        ) {
          return record;
        }
        if (record.state === "settled") return record;
        const next: SubmissionRecoveryRecord = {
          ...record,
          state: "settled",
          lease: null,
          errorMessage: undefined,
          acceptedAt: now,
          updatedAt: now,
        };
        records.set(id, next);
        await writeRecords(records);
        return next;
      }),
    remove: (id) =>
      runExclusive(async () => {
        const records = await readRecords();
        records.delete(id);
        await writeRecords(records);
      }),
  };
}

/** Browser storage failure must stop before draft clearing; never emulate it in memory. */
export function createUnavailableSubmissionRecoveryStore(): SubmissionRecoveryStore {
  const unavailable = async (): Promise<never> => {
    throw new Error(
      "Submission recovery storage is unavailable in this browser. The draft was kept unchanged.",
    );
  };
  return {
    putIfAbsent: unavailable,
    get: unavailable,
    list: unavailable,
    discardQueued: unavailable,
    claimForDispatch: unavailable,
    markNeedsReview: unavailable,
    markSettled: unavailable,
    remove: unavailable,
  };
}

let defaultStore: SubmissionRecoveryStore | null = null;

export function getSubmissionRecoveryStore(): SubmissionRecoveryStore {
  if (!defaultStore) {
    if (!isWeb) {
      defaultStore = createNativeAsyncStorageSubmissionRecoveryStore();
    } else if (globalThis.indexedDB) {
      defaultStore = createIndexedDbSubmissionRecoveryStore();
    } else {
      defaultStore = createUnavailableSubmissionRecoveryStore();
    }
  }
  return defaultStore;
}

/** Test seam. */
export function __setSubmissionRecoveryStoreForTests(store: SubmissionRecoveryStore | null): void {
  defaultStore = store;
}

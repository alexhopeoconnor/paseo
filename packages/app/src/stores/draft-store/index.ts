import { create } from "zustand";
import { persist } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AttachmentMetadata, WorkspaceFileComposerAttachment } from "@/attachments/types";
import { appendWorkspaceFileAttachment } from "@/attachments/workspace-file";
import {
  garbageCollectAttachments,
  persistAttachmentFromDataUrl,
  persistAttachmentFromFileUri,
  registerAttachmentReferenceCollector,
  type AttachmentReferenceSnapshot,
} from "@/attachments/service";
import { collectRetainedAttachmentIds } from "@/attachments/gc-retention";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { isWeb } from "@/constants/platform";
import {
  applyClearDraftRecord,
  beginFreshDraftRecordOccurrence,
  bindDraftRecordSubmissionCheckpoint,
  createDraftOccurrenceKey,
  detachDraftRecordSubmissionCheckpoint,
  editDraftRecordText,
  ensureEmptyDraftRecordForSubmission,
  collectReferencedAttachmentIdsFromState,
  DRAFT_STORE_VERSION,
  isAttachmentMetadata,
  isCanonicalDraftInput,
  isLegacyDraftImage,
  normalizeComposerAttachment,
  pruneFinalizedDraftRecords,
  replaceDraftRecordForSubmission,
  restoreDraftRecordForSubmission,
  saveDraftRecordInput,
  toDraftInputIfReady,
  type DraftInput,
  type DraftLifecycleState,
  type DraftRecord,
  type DraftStoreState,
} from "./state";
import {
  migrateDraftInput,
  migratePersistedState,
  type MigrateLegacyImages,
  PersistedDraftStoreSchema,
} from "./migration";
import { createDraftPersistStorage, createPreservingDraftPersistStorage } from "./persistence";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { applyMetadataPatch } from "@/composer/draft/metadata";
import { hasDraftContent } from "@/composer/draft/input-draft-core";
import {
  collectRecoveryAttachmentIds,
  getSubmissionRecoveryStore,
} from "@/stores/workspace-draft-submission-recovery";

export type { DraftInput, DraftLifecycleState } from "./state";

export interface DraftSubmissionSnapshot {
  draftKey: string;
  version: number;
  draftOccurrenceKey: string;
  submissionCheckpointId?: string;
  input: DraftInput;
}

export interface DraftSubmissionRestoreSnapshot {
  draftKey: string;
  version: number | null;
  draftOccurrenceKey?: string;
  submissionCheckpointId?: string;
}

interface DraftStoreActions {
  getDraftInput: (draftKey: string) => DraftInput | undefined;
  getDraftSubmissionSnapshot: (draftKey: string) => DraftSubmissionSnapshot | null;
  getDraftSubmissionRestoreSnapshot: (draftKey: string) => DraftSubmissionRestoreSnapshot;
  ensureEmptyDraftSubmissionSnapshot: (input: {
    draftKey: string;
  }) => DraftSubmissionSnapshot | null;
  hydrateDraftInput: (input: { draftKey: string }) => Promise<DraftInput | undefined>;
  saveDraftInput: (input: { draftKey: string; draft: DraftInput }) => void;
  /** Saves what `update` makes of the current input; an emptied input abandons the draft. */
  updateDraftInput: (input: {
    draftKey: string;
    update: (current: DraftInput) => DraftInput;
  }) => void;
  editDraftText: (input: { draftKey: string; text: string }) => void;
  /**
   * Sets the text on behalf of something other than the input, which then shows it. Use
   * `editDraftText` for the input's own edits.
   */
  replaceDraftText: (input: { draftKey: string; text: string }) => void;
  bindDraftSubmissionCheckpoint: (input: {
    draftKey: string;
    expectedVersion: number;
    submissionCheckpointId: string;
  }) => DraftSubmissionSnapshot | null;
  replaceDraftSubmissionInput: (input: {
    draftKey: string;
    expectedVersion: number;
    submissionCheckpointId: string;
    draft: DraftInput;
  }) => DraftSubmissionSnapshot | null;
  restoreDraftSubmissionInput: (input: {
    draftKey: string;
    expectedVersion: number | null;
    expectedSubmissionCheckpointId: string | undefined;
    submissionCheckpointId: string;
    draftOccurrenceKey?: string;
    draft: DraftInput;
  }) => DraftSubmissionSnapshot | null;
  detachDraftSubmissionCheckpoint: (input: {
    draftKey: string;
    expectedVersion?: number;
    submissionCheckpointId?: string;
  }) => boolean;
  markDraftLifecycle: (input: { draftKey: string; lifecycle: DraftLifecycleState }) => void;
  clearDraftInput: (input: {
    draftKey: string;
    lifecycle?: Exclude<DraftLifecycleState, "active">;
  }) => void;
  /** Plugin metadata the draft will create its agent with; see `composer/draft/metadata`. */
  patchDraftMetadata: (input: { draftKey: string; patch: Record<string, JsonValue> }) => void;
  clearDraftMetadata: (input: { draftKey: string }) => void;
  attachWorkspaceFile: (input: {
    draftKey: string;
    attachment: WorkspaceFileComposerAttachment;
  }) => Promise<void>;
  getCreateModalDraft: () => DraftInput | null;
  saveCreateModalDraft: (draft: DraftInput | null) => void;
  collectActiveAttachmentIds: () => string[];
}

interface DraftStoreRuntimeState {
  attachmentFocusRequestByDraftKey: Record<string, number>;
  /** Counts `replaceDraftText`, so a mounted input knows to show text it did not type. */
  textReplacementRequestByDraftKey: Record<string, number>;
  /**
   * Kept beside the prompt so a composer that remounts finds it. Not persisted, and not cleared
   * with an emptied prompt: a plugin's choice outlives the text until the draft is sent.
   */
  metadataByDraftKey: Record<string, Record<string, JsonValue>>;
}

type DraftStore = DraftStoreState & DraftStoreRuntimeState & DraftStoreActions;

type HydrationDraftMutation = "updated" | "cleared";

// Zustand's default persist merge gives stored fields precedence. Preserve
// user/plugin mutations that arrive while AsyncStorage is delayed, without
// letting initial `{}` defaults overwrite unrelated persisted drafts.
const draftHydrationMutations = {
  active: true,
  activeReads: 0,
  drafts: new Map<string, HydrationDraftMutation>(),
  createModalDraft: null as HydrationDraftMutation | null,
};

function beginDraftHydration(): void {
  draftHydrationMutations.active = true;
  draftHydrationMutations.activeReads += 1;
}

function recordDraftHydrationMutation(draftKey: string, mutation: HydrationDraftMutation): void {
  if (!draftHydrationMutations.active) return;
  draftHydrationMutations.drafts.set(draftKey, mutation);
}

function recordCreateModalHydrationMutation(mutation: HydrationDraftMutation): void {
  if (!draftHydrationMutations.active) return;
  draftHydrationMutations.createModalDraft = mutation;
}

function mergeDraftHydrationState(persistedState: unknown, currentState: DraftStore): DraftStore {
  const persisted = (persistedState ?? {}) as Partial<DraftStoreState>;
  const merged: DraftStore = { ...currentState, ...persisted };
  if (
    !draftHydrationMutations.active ||
    (draftHydrationMutations.drafts.size === 0 && !draftHydrationMutations.createModalDraft)
  ) {
    return merged;
  }

  const drafts = { ...(persisted.drafts ?? currentState.drafts) };
  for (const [draftKey, mutation] of draftHydrationMutations.drafts) {
    if (mutation === "cleared") {
      // Leave the persisted record visible just long enough for the post-
      // hydration clear action to make a durable tombstone. Deleting it here
      // would lose a real user clear before persist emits a write.
      continue;
    }
    const current = currentState.drafts[draftKey];
    if (current) {
      drafts[draftKey] = current;
    } else {
      delete drafts[draftKey];
    }
  }

  const createModalDraft =
    draftHydrationMutations.createModalDraft === "updated"
      ? currentState.createModalDraft
      : (persisted.createModalDraft ?? currentState.createModalDraft);
  return { ...merged, drafts, createModalDraft };
}

function takeDeferredHydrationClears(): { drafts: string[]; clearCreateModalDraft: boolean } {
  const drafts = Array.from(draftHydrationMutations.drafts)
    .filter(([, mutation]) => mutation === "cleared")
    .map(([draftKey]) => draftKey);
  return {
    drafts,
    clearCreateModalDraft: draftHydrationMutations.createModalDraft === "cleared",
  };
}

function finishDraftHydration(): void {
  draftHydrationMutations.activeReads = Math.max(0, draftHydrationMutations.activeReads - 1);
  if (draftHydrationMutations.activeReads > 0) return;
  draftHydrationMutations.active = false;
  draftHydrationMutations.drafts.clear();
  draftHydrationMutations.createModalDraft = null;
}

function releaseFailedDraftHydration(): void {
  draftHydrationMutations.activeReads = Math.max(0, draftHydrationMutations.activeReads - 1);
}

let gcScheduled = false;
const DRAFT_PERSISTENCE_KEY = "paseo-drafts";

/**
 * Web drafts and web attachment bytes are both origin-shared. At destructive
 * admission, persistence compares this exact synchronous raw value against
 * the safe hydration snapshot so another tab's write is never silently
 * adopted. Native deliberately has no corresponding cross-process claim.
 */
function readCurrentWebDraftRaw(name: string): string | null {
  const storage = (
    globalThis as {
      localStorage?: { getItem: (key: string) => string | null };
    }
  ).localStorage;
  if (!storage) {
    throw new Error("Web localStorage is unavailable for draft reference verification.");
  }
  return storage.getItem(name);
}

const draftPersistStorage = createDraftPersistStorage(
  createPreservingDraftPersistStorage({
    backingStorage: AsyncStorage,
    stateSchema: PersistedDraftStoreSchema,
    maxVersion: DRAFT_STORE_VERSION,
    // Node-only unit tests intentionally have no browser storage surface;
    // production browser/Electron runtimes do. A browser access failure is
    // still surfaced by the reader itself and fails destructive cleanup shut.
    ...(isWeb && typeof window !== "undefined" ? { readRawSync: readCurrentWebDraftRaw } : {}),
    // Persistence knows when the last hydration/deferred-write gate actually
    // opens. Schedule from that handoff too: an earlier startup pass may have
    // correctly skipped GC while the final Zustand checkpoint was draining.
    onReferenceSafetyAvailable: (name) => {
      if (name === DRAFT_PERSISTENCE_KEY) scheduleAttachmentGc();
    },
  }),
);

export function flushDraftPersistStorage(): Promise<void> {
  return draftPersistStorage?.flush() ?? Promise.resolve();
}

/** Submission paths use this after clearing only to report a cleanup failure. */
export function flushDraftPersistStorageOrThrow(): Promise<void> {
  return draftPersistStorage?.flushOrThrow() ?? Promise.resolve();
}

function createDraftRecord(input: {
  draft: DraftInput;
  lifecycle: DraftLifecycleState;
  previousVersion?: number;
  submissionCheckpointId?: string;
  draftOccurrenceKey?: string;
}): DraftRecord {
  return {
    input: {
      text: input.draft.text,
      attachments: input.draft.attachments.map(normalizeComposerAttachment),
    },
    lifecycle: input.lifecycle,
    updatedAt: Date.now(),
    version: (input.previousVersion ?? 0) + 1,
    draftOccurrenceKey: input.draftOccurrenceKey ?? createDraftOccurrenceKey(),
    ...(input.submissionCheckpointId
      ? { submissionCheckpointId: input.submissionCheckpointId }
      : {}),
  };
}

function createDraftSubmissionSnapshot(
  draftKey: string,
  record: DraftRecord | undefined,
): DraftSubmissionSnapshot | null {
  if (!record || record.lifecycle !== "active" || !isCanonicalDraftInput(record.input)) {
    return null;
  }
  return {
    draftKey,
    version: record.version,
    draftOccurrenceKey:
      record.draftOccurrenceKey ??
      `legacy-draft-occurrence:${draftKey}:${record.version}:${record.updatedAt}`,
    input: record.input,
    ...(record.submissionCheckpointId
      ? { submissionCheckpointId: record.submissionCheckpointId }
      : {}),
  };
}

function createDraftSubmissionRestoreSnapshot(
  draftKey: string,
  record: DraftRecord | undefined,
): DraftSubmissionRestoreSnapshot {
  return {
    draftKey,
    version: record?.version ?? null,
    ...(record?.draftOccurrenceKey ? { draftOccurrenceKey: record.draftOccurrenceKey } : {}),
    ...(record?.submissionCheckpointId
      ? { submissionCheckpointId: record.submissionCheckpointId }
      : {}),
  };
}

const migrateLegacyImages: MigrateLegacyImages = async (images) => {
  if (images.length === 0) {
    return [];
  }

  const migrated = await Promise.all(
    images.map(async (entry) => {
      if (isAttachmentMetadata(entry)) {
        return entry;
      }
      if (!isLegacyDraftImage(entry)) {
        return null;
      }

      try {
        if (entry.uri.startsWith("data:")) {
          return await persistAttachmentFromDataUrl({
            dataUrl: entry.uri,
            mimeType: entry.mimeType,
          });
        }

        return await persistAttachmentFromFileUri({
          uri: entry.uri,
          mimeType: entry.mimeType,
        });
      } catch (error) {
        console.warn("[DraftStore] Failed to migrate legacy draft attachment", {
          uri: entry.uri,
          error,
        });
        // Do not silently strip a supported legacy data/file source. The raw
        // envelope remains the only durable reference until migration has
        // written its canonical attachment, so failure must keep the whole
        // hydration gate closed rather than compacting user bytes away.
        throw error;
      }
    }),
  );

  return migrated.filter((entry): entry is AttachmentMetadata => entry !== null);
};

async function runAttachmentGc(): Promise<void> {
  gcScheduled = false;
  const referenceSafetyError = draftPersistStorage?.getReferenceSafetyError(DRAFT_PERSISTENCE_KEY);
  if (referenceSafetyError) {
    console.warn(
      "[DraftStore] Skipping attachment garbage collection while draft references are unknown",
      referenceSafetyError,
    );
    return;
  }
  const nowMs = Date.now();
  // Zustand persist serializes every `setState` invocation, including one
  // whose updater returns the existing state. A no-op GC sweep would then
  // look like an own durable write, publish a fresh reference authority, and
  // schedule another sweep indefinitely. Decide before invoking the persisted
  // setter so only an actual finalized-record prune changes the draft bytes.
  const state = useDraftStore.getState();
  const prunedDrafts = pruneFinalizedDraftRecords({ drafts: state.drafts, nowMs });
  if (prunedDrafts !== state.drafts) {
    useDraftStore.setState({ drafts: prunedDrafts });
  }

  try {
    const references = await collectLifecycleAttachmentReferences();
    await garbageCollectAttachments(references);
  } catch (error) {
    // A failed recovery-store read must not make a submitted record retryable;
    // skip this GC pass and preserve the existing attachment store contents.
    console.warn("[DraftStore] Attachment garbage collection reference retention failed", error);
  }
}

async function collectLifecycleAttachmentReferences(): Promise<AttachmentReferenceSnapshot> {
  if (!draftPersistStorage) {
    throw new Error(
      "Draft persistence is unavailable; preserving attachment bytes until references can be proven.",
    );
  }
  const authority = draftPersistStorage.getReferenceSafetyAuthority(DRAFT_PERSISTENCE_KEY);
  const referencedIds = new Set<string>();
  for (const id of useDraftStore.getState().collectActiveAttachmentIds()) {
    referencedIds.add(id);
  }
  for (const id of collectRetainedAttachmentIds()) {
    referencedIds.add(id);
  }

  const pendingByDraftId = useCreateFlowStore.getState().pendingByDraftId;
  for (const pendingCreate of Object.values(pendingByDraftId)) {
    if (pendingCreate.lifecycle !== "active" || !pendingCreate.images) {
      continue;
    }
    for (const image of pendingCreate.images) {
      referencedIds.add(image.id);
    }
  }

  const sessions = useSessionStore.getState().sessions;
  for (const session of Object.values(sessions)) {
    collectQueuedMessageAttachmentIds(session, referencedIds);
    collectStreamUserImageIds(session.agentStreamTail, referencedIds);
    collectStreamUserImageIds(session.agentStreamHead, referencedIds);
  }

  // Browser-element screenshots live in the workspace attachment store, not in
  // drafts, so collect their ids here to keep them from being garbage collected
  // before the user sends the message.
  const attachmentsByScope = useWorkspaceAttachmentsStore.getState().attachmentsByScope;
  for (const attachments of Object.values(attachmentsByScope)) {
    for (const attachment of attachments) {
      if (attachment.kind === "browser_element" && attachment.attachment.screenshot) {
        referencedIds.add(attachment.attachment.screenshot.id);
      }
    }
  }

  const recoveryRecords = await getSubmissionRecoveryStore().list();
  for (const id of collectRecoveryAttachmentIds(recoveryRecords)) {
    referencedIds.add(id);
  }
  // `list()` is an external durable-store await. A new hydrate may have
  // started (or even completed) while it ran, so this exact snapshot cannot
  // authorize deletion until its original generation still proves current.
  authority.assertCurrent();
  return { referencedIds, assertCurrent: authority.assertCurrent };
}

function collectQueuedMessageAttachmentIds(
  session: SessionState,
  referencedIds: Set<string>,
): void {
  for (const queue of session.queuedMessages.values()) {
    for (const queuedMessage of queue) {
      for (const attachment of queuedMessage.attachments) {
        if (attachment.kind === "image" || attachment.kind === "pasted_text") {
          referencedIds.add(attachment.metadata.id);
        } else if (attachment.kind === "browser_element" && attachment.attachment.screenshot) {
          // Legacy queue rows predate durable checkpoint/client identities,
          // but browser-element screenshots are still byte-store owned by the
          // queued attachment. Keep that explicit reference until the row is
          // consumed or deliberately removed.
          referencedIds.add(attachment.attachment.screenshot.id);
        }
      }
    }
  }
}

function collectStreamUserImageIds(
  streams: SessionState["agentStreamTail"],
  referencedIds: Set<string>,
): void {
  for (const stream of streams.values()) {
    for (const item of stream) {
      if (item.kind !== "user_message") continue;
      for (const image of item.images ?? []) {
        referencedIds.add(image.id);
      }
    }
  }
}

// `deleteAttachments` is a legacy low-level API. Give it the same complete
// reference view as normal draft GC so a manual pill removal cannot erase a
// queued or recovery-owned blob before the collector sees it.
registerAttachmentReferenceCollector(collectLifecycleAttachmentReferences);

function scheduleAttachmentGc(): void {
  if (gcScheduled) {
    return;
  }
  gcScheduled = true;
  if (typeof queueMicrotask === "function") {
    queueMicrotask(() => {
      void runAttachmentGc();
    });
    return;
  }
  setTimeout(() => {
    void runAttachmentGc();
  }, 0);
}

/**
 * Queue/recovery reconciliation calls this after dropping a known-unsent
 * checkpoint. The collector still owns deletion, so shared queued, stream,
 * and recovery references are never removed directly from a pill action.
 */
export function scheduleAttachmentGarbageCollection(): void {
  // Queue editing may hand the attachment back to a React-owned composer
  // draft. Let that state publication commit before scanning references;
  // immediate direct deletion would be unsafe if the rendered draft has not
  // observed the returned attachment yet.
  setTimeout(scheduleAttachmentGc, 0);
}

async function migrateAllLegacyDrafts(): Promise<void> {
  const state = useDraftStore.getState();
  const keys = Object.entries(state.drafts)
    .filter(([, record]) => record.lifecycle === "active" && !isCanonicalDraftInput(record.input))
    .map(([draftKey]) => draftKey);

  let migrationError: unknown;
  for (const draftKey of keys) {
    try {
      await state.hydrateDraftInput({ draftKey });
    } catch (error) {
      console.warn("[DraftStore] Failed to migrate draft during startup", {
        draftKey,
        error,
      });
      migrationError ??= error;
    }
  }

  // `persist.migrate` does not run when a v8 envelope contains the still
  // accepted legacy `input.images` shape. The create modal is not keyed in
  // `drafts`, so give it the same asynchronous canonicalization before
  // opening attachment-reference safety. Capture the exact record object and
  // only replace it if it is still current after attachment persistence: a
  // prompt edit/clear while awaiting must win over this startup migration.
  const modalRecord = state.createModalDraft;
  if (modalRecord?.lifecycle === "active" && !isCanonicalDraftInput(modalRecord.input)) {
    try {
      const migratedDraft = await migrateDraftInput(
        { rawInput: modalRecord.input },
        { migrateLegacyImages },
      );
      let changed = false;
      useDraftStore.setState((current) => {
        if (current.createModalDraft !== modalRecord) {
          return current;
        }
        changed = true;
        return {
          createModalDraft: createDraftRecord({
            draft: migratedDraft,
            lifecycle: modalRecord.lifecycle,
            previousVersion: modalRecord.version,
            submissionCheckpointId: modalRecord.submissionCheckpointId,
            draftOccurrenceKey: modalRecord.draftOccurrenceKey,
          }),
        };
      });
      if (changed) {
        recordCreateModalHydrationMutation("updated");
        scheduleAttachmentGc();
      }
    } catch (error) {
      console.warn("[DraftStore] Failed to migrate create-modal draft during startup", {
        error,
      });
      migrationError ??= error;
    }
  }
  if (migrationError) {
    throw migrationError;
  }
}

async function finalizeDraftStorageHydration(error: unknown): Promise<void> {
  if (error) {
    draftPersistStorage?.markReferenceHydrationFailed(DRAFT_PERSISTENCE_KEY, error);
    releaseFailedDraftHydration();
    return;
  }

  try {
    // A current-version envelope can still contain legacy input.images. Keep
    // attachment deletion closed until those references are canonicalized,
    // then fold every pre-hydration mutation through one durability barrier.
    await migrateAllLegacyDrafts();
    const waitForDurableReferences = async (): Promise<void> => {
      const referencesReady =
        draftPersistStorage?.markReferenceHydrationComplete(DRAFT_PERSISTENCE_KEY);
      const durable = draftPersistStorage?.flushOrThrow();
      const results = await Promise.allSettled([referencesReady, durable]);
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed) {
        throw failed.reason;
      }
    };

    await waitForDurableReferences();
    if (draftPersistStorage?.getReferenceSafetyError(DRAFT_PERSISTENCE_KEY)) {
      // The persistence finalizer can hand itself one more deferred mutation
      // while clearing its own finalization flag. Await that current
      // generation too: otherwise references become safe after this callback
      // returns and its post-hydration GC pass is never scheduled.
      await Promise.resolve();
      await waitForDurableReferences();
    }
    if (draftPersistStorage?.getReferenceSafetyError(DRAFT_PERSISTENCE_KEY)) {
      // Another overlapping rehydrate owns the current generation. It will
      // release the mutation tracker and schedule GC once references are safe.
      releaseFailedDraftHydration();
      return;
    }
    const deferredClears = takeDeferredHydrationClears();
    finishDraftHydration();
    for (const draftKey of deferredClears.drafts) {
      useDraftStore.getState().clearDraftInput({ draftKey, lifecycle: "abandoned" });
    }
    if (deferredClears.clearCreateModalDraft) {
      useDraftStore.getState().saveCreateModalDraft(null);
    }
    await flushDraftPersistStorageOrThrow();
    scheduleAttachmentGc();
  } catch (hydrationError) {
    draftPersistStorage?.markReferenceHydrationFailed(DRAFT_PERSISTENCE_KEY, hydrationError);
    releaseFailedDraftHydration();
    console.warn("[DraftStore] Draft storage hydration did not become durable", hydrationError);
  }
}

export const useDraftStore = create<DraftStore>()(
  persist(
    (set, get) => ({
      drafts: {},
      createModalDraft: null,
      attachmentFocusRequestByDraftKey: {},
      textReplacementRequestByDraftKey: {},
      metadataByDraftKey: {},

      getDraftInput: (draftKey) => {
        const record = get().drafts[draftKey];
        return toDraftInputIfReady(record);
      },

      getDraftSubmissionSnapshot: (draftKey) =>
        createDraftSubmissionSnapshot(draftKey, get().drafts[draftKey]),

      getDraftSubmissionRestoreSnapshot: (draftKey) =>
        createDraftSubmissionRestoreSnapshot(draftKey, get().drafts[draftKey]),

      ensureEmptyDraftSubmissionSnapshot: ({ draftKey }) => {
        let snapshot: DraftSubmissionSnapshot | null = null;
        let changed = false;
        set((state) => {
          const existing = state.drafts[draftKey];
          const next = ensureEmptyDraftRecordForSubmission(existing, Date.now());
          snapshot = createDraftSubmissionSnapshot(draftKey, next);
          if (!snapshot || next === existing) {
            return state;
          }
          changed = true;
          return {
            drafts: {
              ...state.drafts,
              [draftKey]: next,
            },
          };
        });
        if (changed) {
          recordDraftHydrationMutation(draftKey, "updated");
          scheduleAttachmentGc();
        }
        return snapshot;
      },

      hydrateDraftInput: async ({ draftKey }) => {
        const current = get().drafts[draftKey];
        if (!current) {
          return undefined;
        }
        if (current.lifecycle !== "active") {
          return undefined;
        }
        const ready = toDraftInputIfReady(current);
        if (ready) {
          return ready;
        }

        const migratedDraft = await migrateDraftInput(
          { rawInput: current.input },
          { migrateLegacyImages },
        );

        let changed = false;
        set((state) => {
          const existing = state.drafts[draftKey];
          if (!existing || existing.version !== current.version) {
            return state;
          }
          changed = true;
          return {
            drafts: {
              ...state.drafts,
              [draftKey]: createDraftRecord({
                draft: migratedDraft,
                lifecycle: existing.lifecycle,
                previousVersion: existing.version,
                submissionCheckpointId: existing.submissionCheckpointId,
                draftOccurrenceKey: existing.draftOccurrenceKey,
              }),
            },
          };
        });

        if (changed) {
          recordDraftHydrationMutation(draftKey, "updated");
          scheduleAttachmentGc();
        }
        return migratedDraft;
      },

      saveDraftInput: ({ draftKey, draft }) => {
        let changed = false;
        set((state) => {
          const existing = state.drafts[draftKey];
          const next = saveDraftRecordInput(existing, draft, Date.now());
          if (next === existing) {
            return state;
          }
          changed = true;
          return {
            drafts: {
              ...state.drafts,
              [draftKey]: next,
            },
          };
        });
        if (changed) {
          recordDraftHydrationMutation(draftKey, "updated");
          scheduleAttachmentGc();
        }
      },

      updateDraftInput: ({ draftKey, update }) => {
        const next = update(get().getDraftInput(draftKey) ?? { text: "", attachments: [] });
        if (hasDraftContent(next)) get().saveDraftInput({ draftKey, draft: next });
        else get().clearDraftInput({ draftKey, lifecycle: "abandoned" });
      },

      editDraftText: ({ draftKey, text }) => {
        let changed = false;
        set((state) => {
          const previous = state.drafts[draftKey];
          const next = editDraftRecordText(previous, text, Date.now());
          changed = next !== previous;
          return next === previous ? state : { drafts: { ...state.drafts, [draftKey]: next } };
        });
        if (changed) recordDraftHydrationMutation(draftKey, "updated");
      },

      replaceDraftText: ({ draftKey, text }) => {
        // A plugin may deliberately replace a hidden draft with the same
        // bytes. The write is still a new user-visible edit and must not
        // inherit an earlier submission checkpoint.
        let changed = false;
        set((state) => {
          const existing = state.drafts[draftKey];
          const next = beginFreshDraftRecordOccurrence(existing, Date.now());
          changed = Boolean(next && next !== existing);
          return next && next !== existing
            ? { drafts: { ...state.drafts, [draftKey]: next } }
            : state;
        });
        if (changed) recordDraftHydrationMutation(draftKey, "updated");
        get().editDraftText({ draftKey, text });
        set((state) => ({
          textReplacementRequestByDraftKey: {
            ...state.textReplacementRequestByDraftKey,
            [draftKey]: (state.textReplacementRequestByDraftKey[draftKey] ?? 0) + 1,
          },
        }));
      },

      bindDraftSubmissionCheckpoint: ({ draftKey, expectedVersion, submissionCheckpointId }) => {
        let snapshot: DraftSubmissionSnapshot | null = null;
        let changed = false;
        set((state) => {
          const bound = bindDraftRecordSubmissionCheckpoint({
            record: state.drafts[draftKey],
            expectedVersion,
            submissionCheckpointId,
            now: Date.now(),
          });
          if (!bound) {
            return state;
          }
          snapshot = createDraftSubmissionSnapshot(draftKey, bound);
          if (bound === state.drafts[draftKey]) {
            return state;
          }
          changed = true;
          return {
            drafts: {
              ...state.drafts,
              [draftKey]: bound,
            },
          };
        });
        if (changed) recordDraftHydrationMutation(draftKey, "updated");
        return snapshot;
      },

      replaceDraftSubmissionInput: ({
        draftKey,
        expectedVersion,
        submissionCheckpointId,
        draft,
      }) => {
        let snapshot: DraftSubmissionSnapshot | null = null;
        let changed = false;
        set((state) => {
          const next = replaceDraftRecordForSubmission({
            record: state.drafts[draftKey],
            expectedVersion,
            submissionCheckpointId,
            draft,
            now: Date.now(),
          });
          if (!next) {
            return state;
          }
          snapshot = createDraftSubmissionSnapshot(draftKey, next);
          if (next === state.drafts[draftKey]) {
            return state;
          }
          changed = true;
          return {
            drafts: {
              ...state.drafts,
              [draftKey]: next,
            },
          };
        });
        if (changed) recordDraftHydrationMutation(draftKey, "updated");
        return snapshot;
      },

      restoreDraftSubmissionInput: ({
        draftKey,
        expectedVersion,
        expectedSubmissionCheckpointId,
        submissionCheckpointId,
        draftOccurrenceKey,
        draft,
      }) => {
        let snapshot: DraftSubmissionSnapshot | null = null;
        let changed = false;
        set((state) => {
          const next = restoreDraftRecordForSubmission({
            record: state.drafts[draftKey],
            expectedVersion,
            expectedSubmissionCheckpointId,
            submissionCheckpointId,
            draftOccurrenceKey,
            draft,
            now: Date.now(),
          });
          if (!next) {
            return state;
          }
          snapshot = createDraftSubmissionSnapshot(draftKey, next);
          if (next === state.drafts[draftKey]) {
            return state;
          }
          changed = true;
          return {
            drafts: {
              ...state.drafts,
              [draftKey]: next,
            },
          };
        });
        if (changed) recordDraftHydrationMutation(draftKey, "updated");
        if (snapshot) scheduleAttachmentGc();
        return snapshot;
      },

      detachDraftSubmissionCheckpoint: ({ draftKey, expectedVersion, submissionCheckpointId }) => {
        let detached = false;
        set((state) => {
          const record = state.drafts[draftKey];
          if (!record) {
            return state;
          }
          if (expectedVersion !== undefined && record.version !== expectedVersion) {
            return state;
          }
          if (
            submissionCheckpointId !== undefined &&
            record.submissionCheckpointId !== submissionCheckpointId
          ) {
            return state;
          }
          const next = detachDraftRecordSubmissionCheckpoint(record, Date.now());
          if (!next || next === record) {
            return state;
          }
          detached = true;
          return {
            drafts: {
              ...state.drafts,
              [draftKey]: next,
            },
          };
        });
        if (detached) recordDraftHydrationMutation(draftKey, "updated");
        return detached;
      },

      markDraftLifecycle: ({ draftKey, lifecycle }) => {
        let changed = false;
        set((state) => {
          const existing = state.drafts[draftKey];
          if (!existing || existing.lifecycle === lifecycle) {
            return state;
          }
          const { submissionCheckpointId: _submissionCheckpointId, ...record } = existing;
          const checkpoint =
            lifecycle === "sent" && existing.submissionCheckpointId
              ? { submissionCheckpointId: existing.submissionCheckpointId }
              : {};
          changed = true;
          return {
            drafts: {
              ...state.drafts,
              [draftKey]: {
                ...record,
                lifecycle,
                updatedAt: Date.now(),
                version: existing.version + 1,
                ...checkpoint,
              },
            },
          };
        });
        if (changed) {
          recordDraftHydrationMutation(draftKey, "updated");
          scheduleAttachmentGc();
        }
      },

      clearDraftInput: ({ draftKey, lifecycle }) => {
        recordDraftHydrationMutation(draftKey, "cleared");
        set((state) => {
          const existing = state.drafts[draftKey];
          if (!existing) {
            return state;
          }
          const cleared = applyClearDraftRecord({
            record: existing,
            lifecycle,
            nowMs: Date.now(),
          });
          if (cleared) {
            return {
              drafts: {
                ...state.drafts,
                [draftKey]: cleared,
              },
            };
          }
          const nextDrafts = { ...state.drafts };
          delete nextDrafts[draftKey];
          return { drafts: nextDrafts };
        });

        scheduleAttachmentGc();
      },

      patchDraftMetadata: ({ draftKey, patch }) => {
        set((state) => {
          const next = applyMetadataPatch(state.metadataByDraftKey[draftKey] ?? {}, patch);
          const { [draftKey]: _previous, ...others } = state.metadataByDraftKey;
          return {
            metadataByDraftKey:
              Object.keys(next).length > 0 ? { ...others, [draftKey]: next } : others,
          };
        });
      },

      clearDraftMetadata: ({ draftKey }) => {
        set((state) => {
          if (!(draftKey in state.metadataByDraftKey)) return state;
          const { [draftKey]: _removed, ...others } = state.metadataByDraftKey;
          return { metadataByDraftKey: others };
        });
      },

      attachWorkspaceFile: async ({ draftKey, attachment }) => {
        await get().hydrateDraftInput({ draftKey });
        set((state) => {
          const existing = state.drafts[draftKey];
          const draft = toDraftInputIfReady(existing) ?? { text: "", attachments: [] };
          return {
            drafts: {
              ...state.drafts,
              [draftKey]: createDraftRecord({
                draft: {
                  ...draft,
                  attachments: appendWorkspaceFileAttachment(draft.attachments, attachment),
                },
                lifecycle: "active",
                previousVersion: existing?.version,
              }),
            },
            attachmentFocusRequestByDraftKey: {
              ...state.attachmentFocusRequestByDraftKey,
              [draftKey]: (state.attachmentFocusRequestByDraftKey[draftKey] ?? 0) + 1,
            },
          };
        });
        recordDraftHydrationMutation(draftKey, "updated");
        scheduleAttachmentGc();
      },

      getCreateModalDraft: () => {
        const record = get().createModalDraft;
        return toDraftInputIfReady(record) ?? null;
      },

      saveCreateModalDraft: (draft) => {
        recordCreateModalHydrationMutation(draft ? "updated" : "cleared");
        set((state) => {
          if (!draft) {
            return { createModalDraft: null };
          }
          return {
            createModalDraft: createDraftRecord({
              draft,
              lifecycle: "active",
              previousVersion: state.createModalDraft?.version,
            }),
          };
        });
        scheduleAttachmentGc();
      },

      collectActiveAttachmentIds: () => {
        return Array.from(collectReferencedAttachmentIdsFromState(get()).values());
      },
    }),
    {
      name: DRAFT_PERSISTENCE_KEY,
      version: DRAFT_STORE_VERSION,
      storage: draftPersistStorage,
      partialize: ({ drafts, createModalDraft }) => ({ drafts, createModalDraft }),
      migrate: (state, persistedVersion) =>
        migratePersistedState(
          state,
          {
            migrateLegacyImages,
            nowMs: Date.now(),
          },
          persistedVersion,
        ),
      merge: mergeDraftHydrationState,
      onRehydrateStorage: () => {
        beginDraftHydration();
        return (_state, error) => {
          void finalizeDraftStorageHydration(error);
        };
      },
    },
  ),
);

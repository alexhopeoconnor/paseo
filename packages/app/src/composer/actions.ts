import type { SelectedFile } from "@/attachments/selected-file";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import { FILE_UPLOAD_MAX_BYTES } from "@/attachments/upload-limit";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import type {
  AttachmentMetadata,
  ComposerAttachment,
  UserComposerAttachment,
} from "@/attachments/types";
import {
  isWorkspaceAttachment,
  userAttachmentsOnly,
} from "@/attachments/workspace-attachment-utils";
import {
  prepareComposerSendPayload,
  type ComposerAttachmentSubmitFormat,
  type PreparedComposerSendPayload,
} from "@/composer/attachments/submit";
import { createUserMessage, generateMessageId, type UserMessageItem } from "@/types/stream";
import type { MessageSubmissionRejectionOutcome } from "@/composer/submission/model";
import type { PickedImageAttachmentInput } from "@/hooks/image-attachment-picker";
import { i18n } from "@/i18n/i18next";
import {
  getSubmissionRecoveryStore,
  hasEquivalentSubmissionSnapshot,
  type SubmissionRecoveryLease,
  type SubmissionRecoveryRecord,
  type SubmissionRecoveryStore,
} from "@/stores/workspace-draft-submission-recovery";

const SUBMISSION_RECOVERY_LEASE_MS = 30_000;

function createSubmissionRecoveryOwnerId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `composer:${Date.now()}:${Math.random()}`;
}

export interface QueuedComposerMessage {
  id: string;
  /** Stable wire identity retained when the existing queue executor dispatches this item. */
  clientMessageId?: string;
  /**
   * Durable recovery-record identity. v8 occurrence reservations deliberately
   * use a different record id from their wire clientMessageId, so queue
   * reconciliation must never substitute one for the other.
   */
  submissionRecoveryId?: string;
  text: string;
  attachments: ComposerAttachment[];
}

export interface AttachmentPersister {
  persistFromBlob: (input: {
    blob: Blob;
    mimeType: string;
    fileName: string | null;
  }) => Promise<AttachmentMetadata>;
  persistFromFileUri: (input: {
    uri: string;
    mimeType: string;
    fileName: string | null;
  }) => Promise<AttachmentMetadata>;
  persistFromDataUrl: (input: {
    dataUrl: string;
    mimeType: string;
    fileName: string | null;
  }) => Promise<AttachmentMetadata>;
  deleteAttachments: (metadata: AttachmentMetadata[]) => Promise<void> | void;
}

export interface ComposerSendClient {
  sendAgentMessage: (
    agentId: string,
    text: string,
    options: {
      messageId: string;
      activeTurnBehavior?: ActiveTurnBehavior;
      images: Array<{ data: string; mimeType: string }>;
      attachments: PreparedComposerSendPayload["attachments"];
    },
  ) => Promise<unknown>;
  uploadFile: (input: { fileName: string; mimeType: string; bytes: Uint8Array }) => Promise<{
    requestId: string;
    file: {
      type: "uploaded_file";
      id: string;
      fileName: string;
      mimeType: string;
      size: number;
      path: string;
    } | null;
    error: string | null;
  }>;
}

export interface ComposerCancelClient {
  cancelAgent: (agentId: string) => Promise<void> | void;
}

export interface MessageSubmissionWriter {
  begin: (agentId: string, message: UserMessageItem) => void;
  accept: (agentId: string, clientMessageId: string) => void;
  reject: (agentId: string, clientMessageId: string) => MessageSubmissionRejectionOutcome;
}

export interface QueueWriter {
  read: (agentId: string) => QueuedComposerMessage[];
  write: (
    updater: (prev: Map<string, QueuedComposerMessage[]>) => Map<string, QueuedComposerMessage[]>,
  ) => void;
}

export async function pickAndPersistImages(input: {
  pickImages: () => Promise<PickedImageAttachmentInput[] | null>;
  persister: Pick<
    AttachmentPersister,
    "persistFromBlob" | "persistFromFileUri" | "persistFromDataUrl"
  >;
}): Promise<AttachmentMetadata[]> {
  const result = await input.pickImages();
  if (!result?.length) return [];
  return await Promise.all(
    result.map(async (picked) => {
      const fileName = picked.fileName ?? null;
      const mimeType = picked.mimeType;
      if (picked.source.kind === "blob") {
        return await input.persister.persistFromBlob({
          blob: picked.source.blob,
          mimeType,
          fileName,
        });
      }
      if (picked.source.kind === "data_url") {
        return await input.persister.persistFromDataUrl({
          dataUrl: picked.source.dataUrl,
          mimeType,
          fileName,
        });
      }
      return await input.persister.persistFromFileUri({
        uri: picked.source.uri,
        mimeType,
        fileName,
      });
    }),
  );
}

export async function uploadFileAttachments(input: {
  client: ComposerSendClient;
  files: SelectedFile[];
}): Promise<Extract<ComposerAttachment, { kind: "file" }>[]> {
  const result = await uploadFileAttachmentBatch(input);
  if (result.failed.length > 0) {
    throw new Error(result.failed[0]?.errorMessage ?? "Upload failed.");
  }
  return result.uploaded;
}

export interface FileUploadBatchFailure {
  file: SelectedFile;
  errorMessage: string;
}

export interface FileUploadBatchResult {
  uploaded: Extract<ComposerAttachment, { kind: "file" }>[];
  failed: FileUploadBatchFailure[];
}

/**
 * Validate every file in the batch before issuing an upload, then retain every
 * acknowledged upload if a later request fails. The caller can retry only the
 * returned failures without duplicating successful remote files.
 */
export async function uploadFileAttachmentBatch(input: {
  client: ComposerSendClient;
  files: SelectedFile[];
}): Promise<FileUploadBatchResult> {
  const result: Extract<ComposerAttachment, { kind: "file" }>[] = [];
  const prepared: Array<{
    source: SelectedFile;
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
  }> = [];
  const preflightFailures: FileUploadBatchFailure[] = [];

  for (const file of input.files) {
    try {
      const bytes = await file.readBytes();
      if (bytes.byteLength > FILE_UPLOAD_MAX_BYTES) {
        throw new Error(
          i18n.t("composer.errors.fileTooLarge", { size: "50MB", fileName: file.fileName }),
        );
      }
      prepared.push({
        source: file,
        fileName: file.fileName,
        mimeType: file.mimeType,
        bytes,
      });
    } catch (error) {
      preflightFailures.push({
        file,
        errorMessage: error instanceof Error ? error.message : "Unable to read file.",
      });
    }
  }

  // Never start an upload if the batch cannot be fully preflighted. This
  // prevents a valid leading file from being orphaned behind an invalid one.
  // Return every source file for explicit retry: valid files here were never
  // attempted and must not disappear merely because a sibling was invalid.
  if (preflightFailures.length > 0) {
    const bySource = new Map(preflightFailures.map((failure) => [failure.file, failure]));
    return {
      uploaded: [],
      failed: [
        ...preflightFailures,
        ...input.files
          .filter((file) => !bySource.has(file))
          .map((file) => ({
            file,
            errorMessage: "Upload was not started because another file failed preflight.",
          })),
      ],
    };
  }

  const failures: FileUploadBatchFailure[] = [];
  for (const file of prepared) {
    try {
      const response = await input.client.uploadFile(file);
      if (response.error || !response.file) {
        throw new Error(response.error ?? "Upload failed.");
      }
      result.push({ kind: "file", attachment: response.file });
    } catch (error) {
      failures.push({
        file: file.source,
        errorMessage: error instanceof Error ? error.message : "Upload failed.",
      });
    }
  }

  return { uploaded: result, failed: failures };
}

export function removeComposerAttachmentAtIndex<T extends ComposerAttachment>(input: {
  attachments: T[];
  index: number;
  /**
   * Compatibility-only. Local attachment bytes are released by reference-aware
   * draft GC, never synchronously from an individual pill removal: the same
   * metadata can still be held by a queued message or recovery checkpoint.
   */
  deleteAttachments?: AttachmentPersister["deleteAttachments"];
}): T[] {
  return input.attachments.filter((_, i) => i !== input.index);
}

export interface CancelComposerAgentInput {
  client: ComposerCancelClient | null;
  agentId: string;
  isAgentRunning: boolean;
  isCancellingAgent: boolean;
  isConnected: boolean;
}

export function cancelComposerAgent(input: CancelComposerAgentInput): Promise<void> | null {
  if (!input.isAgentRunning || input.isCancellingAgent) return null;
  if (!input.isConnected || !input.client) return null;
  try {
    return Promise.resolve(input.client.cancelAgent(input.agentId));
  } catch (error) {
    return Promise.reject(error);
  }
}

export interface DispatchComposerAgentMessageInput {
  client: ComposerSendClient;
  agentId: string;
  text: string;
  attachments: ComposerAttachment[];
  attachmentSubmitFormat?: ComposerAttachmentSubmitFormat;
  encodeImages: (
    images: AttachmentMetadata[],
  ) => Promise<Array<{ data: string; mimeType: string }> | undefined>;
  submission: MessageSubmissionWriter;
  activeTurnBehavior?: ActiveTurnBehavior;
  activeTurnId?: string;
  /** Reused only for an explicitly persisted retry/queue item. */
  clientMessageId?: string;
  /** Caller-prepared bytes are reused for timeline presentation and transport. */
  preparedPayload?: PreparedComposerSendPayload;
}

export async function dispatchComposerAgentMessage(
  input: DispatchComposerAgentMessageInput,
): Promise<void> {
  const wirePayload =
    input.preparedPayload ??
    (await prepareComposerSendPayload({
      attachments: input.attachments,
      format: input.attachmentSubmitFormat,
      encodeImages: input.encodeImages,
    }));
  const clientMessageId = input.clientMessageId ?? generateMessageId();
  const userMessage = createUserMessage({
    clientMessageId,
    text: input.text,
    timestamp: new Date(),
    images: wirePayload.images,
    attachments: wirePayload.attachments,
    ...(input.activeTurnBehavior === "steer" && input.activeTurnId
      ? { turnId: input.activeTurnId }
      : {}),
  });
  input.submission.begin(input.agentId, userMessage);
  try {
    await input.client.sendAgentMessage(input.agentId, input.text, {
      messageId: clientMessageId,
      ...(input.activeTurnBehavior ? { activeTurnBehavior: input.activeTurnBehavior } : {}),
      images: wirePayload.imageData,
      attachments: wirePayload.attachments,
    });
    input.submission.accept(input.agentId, clientMessageId);
  } catch (error) {
    input.submission.reject(input.agentId, clientMessageId);
    throw error;
  }
}

export interface QueueComposerMessageInput {
  agentId: string;
  text: string;
  attachments: ComposerAttachment[];
  queue: QueueWriter;
  clientMessageId?: string;
  submissionRecoveryId?: string;
}

export interface QueueComposerMessageResult {
  queued: QueuedComposerMessage | null;
}

export function queueComposerMessage(input: QueueComposerMessageInput): QueueComposerMessageResult {
  const trimmed = input.text.trim();
  if (!trimmed && input.attachments.length === 0) {
    return { queued: null };
  }
  const clientMessageId = input.clientMessageId ?? generateMessageId();
  const item: QueuedComposerMessage = {
    id: clientMessageId,
    clientMessageId,
    ...(input.submissionRecoveryId !== undefined
      ? { submissionRecoveryId: input.submissionRecoveryId }
      : {}),
    text: trimmed,
    attachments: input.attachments,
  };
  input.queue.write((prev) => {
    const next = new Map(prev);
    next.set(input.agentId, [...(prev.get(input.agentId) ?? []), item]);
    return next;
  });
  return { queued: item };
}

export interface EditQueuedComposerMessageInput {
  agentId: string;
  messageId: string;
  queue: QueueWriter;
}

export interface EditQueuedComposerMessageResult {
  status: "edited";
  text: string;
  attachments: UserComposerAttachment[];
}

export type RemoveQueuedComposerMessageResult =
  | { status: "removed" }
  | { status: "missing" }
  | { status: "needs_review"; errorMessage: string };

function removeQueuedItem(input: {
  queue: QueueWriter;
  agentId: string;
  item: QueuedComposerMessage;
}): boolean {
  let removed = false;
  input.queue.write((prev) => {
    const current = prev.get(input.agentId) ?? [];
    // An in-process send/edit race must not remove a replacement queue entry
    // merely because it has reused the same display id. The exact snapshot
    // object read before the durable operation is the only removable entry.
    if (!current.includes(input.item)) return prev;
    removed = true;
    const next = new Map(prev);
    next.set(
      input.agentId,
      current.filter((queued) => queued !== input.item),
    );
    return next;
  });
  return removed;
}

/**
 * A legacy queue row can be its only local attachment owner until the regular
 * send lifecycle has durably reserved a recovery checkpoint. Take temporary,
 * process-local ownership before removing that exact row so GC/direct delete
 * cannot reclaim bytes during the asynchronous handoff.
 *
 * These are the complete `ComposerAttachment` variants that point into the
 * local attachment byte store. The remaining variants carry remote uploaded
 * file handles or inline/context protocol data only.
 */
function retainQueuedAttachmentBytes(
  attachments: readonly ComposerAttachment[],
): Array<() => void> {
  const attachmentIds = new Set<string>();
  for (const attachment of attachments) {
    if (attachment.kind === "image" || attachment.kind === "pasted_text") {
      attachmentIds.add(attachment.metadata.id);
      continue;
    }
    if (attachment.kind === "browser_element" && attachment.attachment.screenshot) {
      attachmentIds.add(attachment.attachment.screenshot.id);
    }
  }
  return Array.from(attachmentIds, retainAttachmentForGarbageCollection);
}

function releaseQueuedAttachmentBytes(releases: readonly (() => void)[]): void {
  for (const release of releases) {
    release();
  }
}

function describeQueuedDiscardState(status: "missing" | "mismatch" | "not_queued"): string {
  if (status === "missing") return "The queued submission checkpoint is missing.";
  if (status === "mismatch") {
    return "The queued submission differs from its durable checkpoint.";
  }
  return "This queued submission is already dispatching or has an uncertain outcome.";
}

type QueuedRecoveryIdentity =
  | { status: "none" }
  | { status: "invalid" }
  | { status: "ready"; recoveryId: string; clientMessageId: string };

/**
 * Pre-v8 queue rows used their stable wire ID as the recovery key. Keep that
 * narrow fallback for existing rows, but never infer a v8 record association
 * from a row that has no durable record id: a missing or mismatched checkpoint
 * must stop dispatch rather than being treated as accepted.
 */
function getQueuedRecoveryIdentity(item: QueuedComposerMessage): QueuedRecoveryIdentity {
  if (item.submissionRecoveryId !== undefined) {
    return item.clientMessageId === undefined
      ? { status: "invalid" }
      : {
          status: "ready",
          recoveryId: item.submissionRecoveryId,
          clientMessageId: item.clientMessageId,
        };
  }
  return item.clientMessageId === undefined
    ? { status: "none" }
    : {
        status: "ready",
        recoveryId: item.clientMessageId,
        clientMessageId: item.clientMessageId,
      };
}

function matchesQueuedRecoveryRecord(input: {
  item: QueuedComposerMessage;
  recoveryId: string;
  clientMessageId: string;
  record: SubmissionRecoveryRecord;
}): boolean {
  return (
    input.record.id === input.recoveryId &&
    input.record.clientMessageId === input.clientMessageId &&
    hasEquivalentSubmissionSnapshot(input.record, {
      text: input.item.text,
      attachments: input.item.attachments,
    })
  );
}

async function removeQueuedComposerSnapshot(
  input: EditQueuedComposerMessageInput,
  item: QueuedComposerMessage,
): Promise<RemoveQueuedComposerMessageResult> {
  const recoveryIdentity = getQueuedRecoveryIdentity(item);
  if (recoveryIdentity.status === "invalid") {
    return {
      status: "needs_review",
      errorMessage:
        "The queued submission checkpoint is incomplete. Inspect it before editing or discarding it.",
    };
  }
  if (recoveryIdentity.status === "ready") {
    let discarded;
    try {
      discarded = await getSubmissionRecoveryStore().discardQueued({
        id: recoveryIdentity.recoveryId,
        clientMessageId: recoveryIdentity.clientMessageId,
        submission: { text: item.text, attachments: item.attachments },
      });
    } catch (error) {
      return {
        status: "needs_review",
        errorMessage:
          error instanceof Error ? error.message : "Unable to reconcile the queued submission.",
      };
    }
    if (discarded.status !== "removed") {
      const stateDescription = describeQueuedDiscardState(discarded.status);
      return {
        status: "needs_review",
        errorMessage: `${stateDescription} Inspect it before editing or discarding it.`,
      };
    }
  }

  if (!removeQueuedItem({ queue: input.queue, agentId: input.agentId, item })) {
    // The durable queued record was deleted, so another same-window action
    // won the local race. Do not remove a newer queue snapshot by id.
    return { status: "missing" };
  }
  return { status: "removed" };
}

/**
 * Explicitly remove a queued snapshot only after atomically deleting the
 * matching durable known-unsent checkpoint. Dispatching, uncertain and
 * accepted records remain available for inspection rather than being erased
 * by an edit/delete control.
 */
export async function removeQueuedComposerMessage(
  input: EditQueuedComposerMessageInput,
): Promise<RemoveQueuedComposerMessageResult> {
  const item = input.queue.read(input.agentId).find((q) => q.id === input.messageId);
  if (!item) return { status: "missing" };
  return await removeQueuedComposerSnapshot(input, item);
}

export async function editQueuedComposerMessage(
  input: EditQueuedComposerMessageInput,
): Promise<EditQueuedComposerMessageResult | RemoveQueuedComposerMessageResult> {
  const item = input.queue.read(input.agentId).find((q) => q.id === input.messageId);
  if (!item) return { status: "missing" };
  const removed = await removeQueuedComposerSnapshot(input, item);
  if (removed.status !== "removed") return removed;
  return {
    status: "edited",
    text: item.text,
    attachments: userAttachmentsOnly(item.attachments),
  };
}

export interface SendQueuedComposerMessageNowInput {
  agentId: string;
  messageId: string;
  queue: QueueWriter;
  submitMessage: (input: {
    text: string;
    attachments: ComposerAttachment[];
    clientMessageId: string;
  }) => Promise<void>;
  failedToSendMessage?: string;
}

export type SendQueuedComposerMessageNowResult =
  | { status: "missing" }
  | { status: "submitted" }
  | { status: "needs_review"; errorMessage: string }
  | { status: "busy" }
  | { status: "failed"; errorMessage: string };

type QueuedDispatchPreparation =
  | {
      status: "ready";
      recoveryId: string;
      recoveryLease: SubmissionRecoveryLease | null;
      recoveryStore: SubmissionRecoveryStore | null;
    }
  | { status: "finished"; result: SendQueuedComposerMessageNowResult };

async function markQueuedRecoveryNeedsReview(input: {
  recoveryStore: SubmissionRecoveryStore;
  recoveryId: string;
  lease: SubmissionRecoveryLease;
  errorMessage: string;
  warning: string;
}): Promise<void> {
  try {
    await input.recoveryStore.markNeedsReview({
      id: input.recoveryId,
      lease: input.lease,
      errorMessage: input.errorMessage,
      now: Date.now(),
    });
  } catch (error) {
    console.warn(input.warning, error);
  }
}

async function settleQueuedRecovery(input: {
  recoveryStore: SubmissionRecoveryStore;
  recoveryId: string;
  lease: SubmissionRecoveryLease;
}): Promise<void> {
  try {
    await input.recoveryStore.markSettled({
      id: input.recoveryId,
      lease: input.lease,
      now: Date.now(),
    });
  } catch (error) {
    // The daemon accepted this message. Do not make it retryable merely
    // because local record cleanup/settling encountered a storage error.
    console.warn("[Composer] Failed to settle accepted queued recovery record", error);
  }
}

function restoreQueuedItem(input: {
  queue: QueueWriter;
  agentId: string;
  item: QueuedComposerMessage;
}): void {
  input.queue.write((prev) => {
    const next = new Map(prev);
    next.set(input.agentId, [input.item, ...(prev.get(input.agentId) ?? [])]);
    return next;
  });
}

async function prepareQueuedDispatch(input: {
  queue: QueueWriter;
  agentId: string;
  item: QueuedComposerMessage;
}): Promise<QueuedDispatchPreparation> {
  const recoveryIdentity = getQueuedRecoveryIdentity(input.item);
  if (recoveryIdentity.status === "invalid") {
    return {
      status: "finished",
      result: {
        status: "needs_review",
        errorMessage:
          "The queued submission checkpoint is incomplete. Keep the draft and inspect it before retrying.",
      },
    };
  }
  if (recoveryIdentity.status === "none") {
    return {
      status: "ready",
      recoveryId: input.item.id,
      recoveryLease: null,
      recoveryStore: null,
    };
  }

  const recoveryStore = getSubmissionRecoveryStore();
  let inspected;
  try {
    inspected = await recoveryStore.get(recoveryIdentity.recoveryId);
  } catch (error) {
    return {
      status: "finished",
      result: {
        status: "failed",
        errorMessage:
          error instanceof Error ? error.message : "Unable to inspect queued submission.",
      },
    };
  }
  if (!inspected) {
    return {
      status: "finished",
      result: {
        status: "failed",
        errorMessage:
          "The queued submission checkpoint is missing. Keep the draft and resolve it before retrying.",
      },
    };
  }
  if (
    !matchesQueuedRecoveryRecord({
      item: input.item,
      recoveryId: recoveryIdentity.recoveryId,
      clientMessageId: recoveryIdentity.clientMessageId,
      record: inspected,
    })
  ) {
    return {
      status: "finished",
      result: {
        status: "needs_review",
        errorMessage:
          "The queued item differs from its durable submission checkpoint. Inspect it before retrying.",
      },
    };
  }
  let claim;
  try {
    claim = await recoveryStore.claimForDispatch({
      id: recoveryIdentity.recoveryId,
      ownerId: createSubmissionRecoveryOwnerId(),
      now: Date.now(),
      leaseMs: SUBMISSION_RECOVERY_LEASE_MS,
    });
  } catch (error) {
    return {
      status: "finished",
      result: {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Unable to claim queued submission.",
      },
    };
  }

  if (
    claim.status !== "missing" &&
    !matchesQueuedRecoveryRecord({
      item: input.item,
      recoveryId: recoveryIdentity.recoveryId,
      clientMessageId: recoveryIdentity.clientMessageId,
      record: claim.record,
    })
  ) {
    return {
      status: "finished",
      result: {
        status: "needs_review",
        errorMessage:
          "The queued item differs from its durable submission checkpoint. Inspect it before retrying.",
      },
    };
  }

  switch (claim.status) {
    case "missing":
      return {
        status: "finished",
        result: {
          status: "failed",
          errorMessage:
            "The queued submission checkpoint is missing. Keep the draft and resolve it before retrying.",
        },
      };
    case "busy":
      return { status: "finished", result: { status: "busy" } };
    case "needs_review":
      removeQueuedItem(input);
      return {
        status: "finished",
        result: {
          status: "needs_review",
          errorMessage: claim.record.errorMessage ?? "Needs review.",
        },
      };
    case "settled":
      removeQueuedItem(input);
      return { status: "finished", result: { status: "submitted" } };
    case "acquired": {
      return {
        status: "ready",
        recoveryId: recoveryIdentity.recoveryId,
        recoveryLease: claim.lease,
        recoveryStore,
      };
    }
  }
  return {
    status: "finished",
    result: {
      status: "failed",
      errorMessage:
        "The queued submission has an unsupported durable state. Inspect it before retrying.",
    },
  };
}

export async function sendQueuedComposerMessageNow(
  input: SendQueuedComposerMessageNowInput,
): Promise<SendQueuedComposerMessageNowResult> {
  const item = input.queue.read(input.agentId).find((q) => q.id === input.messageId);
  if (!item) return { status: "missing" };
  const preparation = await prepareQueuedDispatch({
    queue: input.queue,
    agentId: input.agentId,
    item,
  });
  if (preparation.status === "finished") return preparation.result;
  // Install the retention holds synchronously before the queue write. A
  // collector that snapshots before the removal still sees the row; one that
  // snapshots afterwards sees these holds until the durable handoff finishes.
  const releaseAttachmentBytes = retainQueuedAttachmentBytes(item.attachments);
  try {
    if (!removeQueuedItem({ queue: input.queue, agentId: input.agentId, item })) {
      return { status: "missing" };
    }
    await input.submitMessage({
      text: item.text,
      attachments: item.attachments,
      clientMessageId: item.clientMessageId ?? item.id,
    });
    if (preparation.recoveryLease && preparation.recoveryStore) {
      await settleQueuedRecovery({
        recoveryStore: preparation.recoveryStore,
        recoveryId: preparation.recoveryId,
        lease: preparation.recoveryLease,
      });
    }
    return { status: "submitted" };
  } catch (error) {
    if (preparation.recoveryLease && preparation.recoveryStore) {
      const errorMessage = error instanceof Error ? error.message : "Queued send outcome unknown.";
      await markQueuedRecoveryNeedsReview({
        recoveryStore: preparation.recoveryStore,
        recoveryId: preparation.recoveryId,
        lease: preparation.recoveryLease,
        errorMessage,
        warning: "[Composer] Failed to retain queued submission for review",
      });
      return { status: "needs_review", errorMessage };
    }
    restoreQueuedItem({ queue: input.queue, agentId: input.agentId, item });
    return {
      status: "failed",
      errorMessage:
        error instanceof Error
          ? error.message
          : (input.failedToSendMessage ?? i18n.t("composer.errors.failedToSend")),
    };
  } finally {
    releaseQueuedAttachmentBytes(releaseAttachmentBytes);
  }
}

export interface OpenComposerAttachmentInput {
  attachment: ComposerAttachment;
  setLightboxMetadata: (metadata: AttachmentMetadata) => void;
  openWorkspaceAttachment: (input: { attachment: ComposerAttachment }) => boolean;
  openExternalUrl: (url: string) => void;
}

export function openComposerAttachment(input: OpenComposerAttachmentInput): void {
  if (input.attachment.kind === "image") {
    input.setLightboxMetadata(input.attachment.metadata);
    return;
  }
  if (
    input.attachment.kind === "file" ||
    input.attachment.kind === "workspace_file" ||
    input.attachment.kind === "pasted_text"
  ) {
    return;
  }
  if (isWorkspaceAttachment(input.attachment)) {
    input.openWorkspaceAttachment({ attachment: input.attachment });
    return;
  }
  input.openExternalUrl(input.attachment.item.url);
}

export function buildForgeAttachment(item: ForgeSearchItem): UserComposerAttachment {
  return item.kind === "change_request"
    ? { kind: "forge_change_request", item }
    : { kind: "forge_issue", item };
}

function isForgeAttachment(
  attachment: UserComposerAttachment,
): attachment is Extract<
  UserComposerAttachment,
  { kind: "forge_issue" | "forge_change_request" | "github_issue" | "github_pr" }
> {
  return (
    attachment.kind === "forge_issue" ||
    attachment.kind === "forge_change_request" ||
    // COMPAT(githubAttachmentKinds): accept legacy persisted attachment kinds
    // until 2027-01-17, when supported floors are >= v0.2.0 and old drafts no
    // longer require them.
    attachment.kind === "github_issue" ||
    attachment.kind === "github_pr"
  );
}

export function toggleForgeAttachment(
  current: UserComposerAttachment[],
  item: ForgeSearchItem,
): UserComposerAttachment[] {
  const matches = (attachment: UserComposerAttachment) =>
    isForgeAttachment(attachment) &&
    attachment.item.kind === item.kind &&
    attachment.item.number === item.number;
  if (current.some(matches)) {
    return current.filter((attachment) => !matches(attachment));
  }
  return [...current, buildForgeAttachment(item)];
}

interface ToggleForgeAttachmentFromPickerInput {
  current: UserComposerAttachment[];
  item: ForgeSearchItem;
  markForgeAttachmentRemoved: (attachment: UserComposerAttachment) => void;
}

export function toggleForgeAttachmentFromPicker({
  current,
  item,
  markForgeAttachmentRemoved,
}: ToggleForgeAttachmentFromPickerInput): UserComposerAttachment[] {
  const existingAttachment = current.find(
    (attachment) =>
      isForgeAttachment(attachment) &&
      attachment.item.kind === item.kind &&
      attachment.item.number === item.number,
  );
  if (existingAttachment) {
    markForgeAttachmentRemoved(existingAttachment);
  }
  return toggleForgeAttachment(current, item);
}

export function findForgeItemByOption(
  items: readonly ForgeSearchItem[],
  optionId: string,
): ForgeSearchItem | undefined {
  return items.find((candidate) => `${candidate.kind}:${candidate.number}` === optionId);
}

export function isAttachmentSelectedForForgeItem(
  current: readonly ComposerAttachment[],
  item: ForgeSearchItem,
): boolean {
  return userAttachmentsOnly(current).some(
    (attachment) =>
      isForgeAttachment(attachment) &&
      attachment.item.kind === item.kind &&
      attachment.item.number === item.number,
  );
}

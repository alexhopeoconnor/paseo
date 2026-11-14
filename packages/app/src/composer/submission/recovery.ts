import type { ComposerAttachment } from "@/attachments/types";
import {
  createSubmissionRecoveryRecord,
  getSubmissionRecoveryStore,
  type SubmissionRecoveryLease,
  type SubmissionRecoveryRecord,
} from "@/stores/workspace-draft-submission-recovery";

export const COMPOSER_SUBMISSION_LEASE_MS = 30_000;

function createOwnerId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `composer:${Date.now()}:${Math.random()}`;
}

export interface PreparedComposerSubmissionRecovery {
  record: SubmissionRecoveryRecord;
  lease: SubmissionRecoveryLease | null;
}

/**
 * Persist the complete source snapshot before the UI clears. Direct sends also
 * claim the record atomically; queue sends remain queued until the existing
 * executor explicitly drains them.
 */
export async function prepareComposerSubmissionRecovery(input: {
  clientMessageId: string;
  state: "queued" | "dispatching";
  kind: "agent_message" | "workspace_create";
  serverId: string;
  agentId: string;
  workspaceId?: string | null;
  draftId?: string | null;
  cwd: string;
  text: string;
  attachments: ComposerAttachment[];
  originalDraft: {
    text: string;
    attachments: ComposerAttachment[];
    selection: { start: number; end: number };
  };
}): Promise<PreparedComposerSubmissionRecovery> {
  const store = getSubmissionRecoveryStore();
  const record = await store.putIfAbsent(
    createSubmissionRecoveryRecord({
      id: input.clientMessageId,
      clientMessageId: input.clientMessageId,
      submission: {
        kind: input.kind,
        serverId: input.serverId,
        agentId: input.agentId,
        workspaceId: input.workspaceId ?? null,
        draftId: input.draftId ?? null,
        cwd: input.cwd,
        text: input.text,
        attachments: input.attachments,
      },
      originalDraft: {
        ownerKey: `${input.serverId}:${input.agentId}`,
        text: input.originalDraft.text,
        attachments: input.originalDraft.attachments,
        selection: input.originalDraft.selection,
      },
    }),
  );
  if (input.state === "queued") return { record, lease: null };

  const claim = await store.claimForDispatch({
    id: record.id,
    ownerId: createOwnerId(),
    now: Date.now(),
    leaseMs: COMPOSER_SUBMISSION_LEASE_MS,
  });
  if (claim.status === "acquired") return { record: claim.record, lease: claim.lease };
  if (claim.status === "settled") {
    throw new Error(
      "This submission was already accepted. Inspect the retained checkpoint before sending new content.",
    );
  }
  if (claim.status === "needs_review") {
    throw new Error(claim.record.errorMessage ?? "This submission needs review before retrying.");
  }
  if (claim.status === "busy") {
    throw new Error("This submission is already being sent in another window.");
  }
  throw new Error("The persisted submission could not be claimed.");
}

export async function discardPreparedComposerSubmission(recordId: string): Promise<void> {
  await getSubmissionRecoveryStore().remove(recordId);
}

export async function markComposerSubmissionNeedsReview(input: {
  recovery: PreparedComposerSubmissionRecovery;
  error: unknown;
}): Promise<void> {
  if (!input.recovery.lease) return;
  const errorMessage =
    input.error instanceof Error ? input.error.message : "The submission outcome is unknown.";
  await getSubmissionRecoveryStore().markNeedsReview({
    id: input.recovery.record.id,
    lease: input.recovery.lease,
    errorMessage,
    now: Date.now(),
  });
}

export async function markComposerSubmissionSettled(
  recovery: PreparedComposerSubmissionRecovery,
): Promise<void> {
  if (!recovery.lease) return;
  await getSubmissionRecoveryStore().markSettled({
    id: recovery.record.id,
    lease: recovery.lease,
    now: Date.now(),
  });
}

import type { ComposerAttachment } from "@/attachments/types";
import {
  createSubmissionRecoveryOwnerKey,
  createSubmissionRecoveryReservation,
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
 * These two identities have different jobs in v8: the recovery id fences the
 * durable occurrence, while the client id identifies the wire/user row.
 * Calculate them before async payload work so provisional presentation never
 * invents a second same-occurrence wire id.
 */
export interface ComposerSubmissionIdentity {
  recoveryId: string;
  clientMessageId: string;
}

export function resolveComposerSubmissionIdentity(input: {
  clientMessageId: string;
  draftOccurrenceKey?: string;
  kind: "agent_message" | "workspace_create";
  serverId: string;
  agentId: string;
  workspaceId?: string | null;
  draftId?: string | null;
  cwd: string;
}): ComposerSubmissionIdentity {
  const ownerKey = createSubmissionRecoveryOwnerKey({
    kind: input.kind,
    serverId: input.serverId,
    agentId: input.agentId,
    workspaceId: input.workspaceId ?? null,
    draftId: input.draftId ?? null,
    cwd: input.cwd,
  });
  const reservation = input.draftOccurrenceKey
    ? createSubmissionRecoveryReservation({
        ownerKey,
        draftOccurrenceKey: input.draftOccurrenceKey,
      })
    : { id: input.clientMessageId, clientMessageId: input.clientMessageId };
  return { recoveryId: reservation.id, clientMessageId: reservation.clientMessageId };
}

/**
 * Reserve the complete source snapshot before the UI clears. The caller binds
 * the returned identity to its durable draft before claiming a direct-send
 * lease; queue sends remain queued until the existing executor drains them.
 */
export async function prepareComposerSubmissionRecovery(input: {
  clientMessageId: string;
  draftOccurrenceKey?: string;
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
  identity?: ComposerSubmissionIdentity;
}): Promise<PreparedComposerSubmissionRecovery> {
  const store = getSubmissionRecoveryStore();
  const identity =
    input.identity ??
    resolveComposerSubmissionIdentity({
      clientMessageId: input.clientMessageId,
      draftOccurrenceKey: input.draftOccurrenceKey,
      kind: input.kind,
      serverId: input.serverId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      draftId: input.draftId,
      cwd: input.cwd,
    });
  const ownerKey = createSubmissionRecoveryOwnerKey({
    kind: input.kind,
    serverId: input.serverId,
    agentId: input.agentId,
    workspaceId: input.workspaceId ?? null,
    draftId: input.draftId ?? null,
    cwd: input.cwd,
  });
  const record = await store.putIfAbsent(
    createSubmissionRecoveryRecord({
      id: identity.recoveryId,
      clientMessageId: identity.clientMessageId,
      ...(input.draftOccurrenceKey ? { draftOccurrenceKey: input.draftOccurrenceKey } : {}),
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
        ownerKey,
        text: input.originalDraft.text,
        attachments: input.originalDraft.attachments,
        selection: input.originalDraft.selection,
      },
    }),
  );
  if (record.id !== identity.recoveryId || record.clientMessageId !== identity.clientMessageId) {
    throw new Error("The durable submission reservation did not match this presentation.");
  }
  return { record, lease: null };
}

/** Claim only a checkpoint whose draft association is already durable. */
export async function claimPreparedComposerSubmission(
  record: SubmissionRecoveryRecord,
): Promise<PreparedComposerSubmissionRecovery> {
  const store = getSubmissionRecoveryStore();
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

/**
 * A reservation may have been observed or claimed by another window after
 * putIfAbsent. Only remove the still-queued immutable record that this caller
 * reserved; never erase dispatching, uncertain, or accepted provenance.
 */
export async function discardPreparedComposerSubmission(
  record: SubmissionRecoveryRecord,
): Promise<void> {
  await getSubmissionRecoveryStore().discardQueued({
    id: record.id,
    clientMessageId: record.clientMessageId,
    submission: {
      text: record.submission.text,
      attachments: record.submission.attachments,
    },
  });
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

export interface PendingMessageSubmission {
  clientMessageId: string;
}

/**
 * A local-only presentation lease. It is deliberately distinct from the wire
 * client id: a deterministic v8 wire id may be reused by a newer local
 * preparation after an older preflight has aborted.
 */
export interface MessageSubmissionPresentation {
  presentationToken: string;
  ownerIdentity: string;
  phase: "preparing" | "dispatching";
  compatibility: "canonical" | "legacy";
}

export type MessageSubmissionRecord = PendingMessageSubmission & {
  providerAcknowledged: boolean;
  rpcSettled: boolean;
  /**
   * A canonical row was admitted while this exact lease was promoted, before
   * the executor reached transport. It is not proof that the local payload
   * was sent, so the composer takes the durable needs-review path instead.
   */
  canonicalObservedAtPromotion?: boolean;
  presentation?: MessageSubmissionPresentation;
};

const EMPTY_MESSAGE_SUBMISSIONS: readonly MessageSubmissionRecord[] = [];

function ownsAgentTurnPresentation(submission: MessageSubmissionRecord): boolean {
  // Durable preflight owns a recoverable local row, not a daemon turn. It
  // masks its source until promotion, but must not surface an interrupt before
  // transport can actually begin.
  if (submission.presentation?.phase === "preparing") return false;
  // A legacy lease preserves the local row and its recovery fence because an
  // old daemon cannot acknowledge it canonically. It is not evidence that the
  // daemon started an agent turn.
  return (
    !submission.providerAcknowledged &&
    !submission.canonicalObservedAtPromotion &&
    submission.presentation?.compatibility !== "legacy"
  );
}

export function getActiveMessageSubmissions(
  submissions: readonly MessageSubmissionRecord[] | null | undefined,
): readonly PendingMessageSubmission[] {
  return (submissions ?? EMPTY_MESSAGE_SUBMISSIONS).filter(ownsAgentTurnPresentation);
}

export function hasActiveMessageSubmission(
  submissions: readonly MessageSubmissionRecord[] | null | undefined,
): boolean {
  return (submissions ?? EMPTY_MESSAGE_SUBMISSIONS).some(ownsAgentTurnPresentation);
}

/** IDs that must remain locally visible across normal canonical replacement. */
export function getSendingClientMessageIds(
  submissions: readonly MessageSubmissionRecord[] | null | undefined,
): string[] {
  return (submissions ?? [])
    .filter((submission) => !submission.providerAcknowledged)
    .map((submission) => submission.clientMessageId);
}

/** A canonical id is not authority to consume a not-yet-dispatched lease. */
export function getPreparingClientMessageIds(
  submissions: readonly MessageSubmissionRecord[] | null | undefined,
): string[] {
  return (submissions ?? [])
    .filter((submission) => submission.presentation?.phase === "preparing")
    .map((submission) => submission.clientMessageId);
}

export function findMessageSubmissionPresentation(
  submissions: readonly MessageSubmissionRecord[] | null | undefined,
  ownerIdentity: string,
): MessageSubmissionPresentation | null {
  for (const submission of submissions ?? []) {
    const presentation = submission.presentation;
    // Canonical admission can precede the transport callback. Keep an
    // ordinary dispatched lease addressable until that callback settles it,
    // but a promotion collision is terminal and must not reauthorize it.
    if (presentation?.ownerIdentity === ownerIdentity && !submission.canonicalObservedAtPromotion) {
      return presentation;
    }
  }
  return null;
}

export function hasCurrentMessageSubmissionPresentation(
  submissions: readonly MessageSubmissionRecord[] | null | undefined,
  input: Pick<PendingMessageSubmission, "clientMessageId"> &
    Pick<MessageSubmissionPresentation, "ownerIdentity" | "presentationToken">,
): boolean {
  return (submissions ?? []).some(
    (submission) =>
      submission.clientMessageId === input.clientMessageId &&
      submission.presentation?.presentationToken === input.presentationToken &&
      submission.presentation.ownerIdentity === input.ownerIdentity,
  );
}

export type MessageSubmissionRejectionOutcome = "rejected" | "accepted" | "unknown" | "stale";

/** Promotion either authorizes transport or reports a canonical collision held behind the lease. */
export type MessageSubmissionPromotionOutcome = "promoted" | "canonical-observed" | "stale";

export interface MessageSubmissionRejectionResult {
  submissions: MessageSubmissionRecord[];
  outcome: MessageSubmissionRejectionOutcome;
}

export function beginMessageSubmission(
  submissions: readonly MessageSubmissionRecord[],
  input: PendingMessageSubmission & { presentation?: MessageSubmissionPresentation },
): MessageSubmissionRecord[] {
  if (submissions.some((submission) => submission.clientMessageId === input.clientMessageId)) {
    throw new Error(`Message submission already exists: ${input.clientMessageId}`);
  }
  return [
    ...submissions,
    {
      clientMessageId: input.clientMessageId,
      providerAcknowledged: false,
      rpcSettled: false,
      ...(input.presentation ? { presentation: input.presentation } : {}),
    },
  ];
}

/** Promote only the current local preparation; stale preflight continuations are no-ops. */
export function promoteMessageSubmission(
  submissions: readonly MessageSubmissionRecord[],
  input: Pick<PendingMessageSubmission, "clientMessageId"> &
    Pick<MessageSubmissionPresentation, "presentationToken">,
): MessageSubmissionRecord[] {
  const index = submissions.findIndex(
    (submission) =>
      submission.clientMessageId === input.clientMessageId &&
      submission.presentation?.presentationToken === input.presentationToken &&
      submission.presentation?.phase === "preparing",
  );
  if (index < 0) return submissions as MessageSubmissionRecord[];
  return submissions.map((submission, submissionIndex) =>
    submissionIndex === index
      ? {
          ...submission,
          presentation: { ...submission.presentation!, phase: "dispatching" },
        }
      : submission,
  );
}

export function acceptMessageSubmission(
  submissions: readonly MessageSubmissionRecord[],
  clientMessageId: string,
  presentationToken?: string,
): MessageSubmissionRecord[] {
  const index = submissions.findIndex(
    (submission) => submission.clientMessageId === clientMessageId,
  );
  if (index < 0) return submissions as MessageSubmissionRecord[];
  const submission = submissions[index];
  if (
    presentationToken !== undefined &&
    submission.presentation?.presentationToken !== presentationToken
  ) {
    return submissions as MessageSubmissionRecord[];
  }
  // A preflight has not claimed/transported anything; an RPC acknowledgement
  // for an older same-id attempt must not consume its current local lease.
  if (submission.presentation?.phase === "preparing") {
    return submissions as MessageSubmissionRecord[];
  }
  // A canonical item consumed during this exact promotion is a collision,
  // not an acknowledgement of this executor's payload. Composer retains the
  // claimed durable checkpoint for review before allowing any later cleanup.
  if (submission.canonicalObservedAtPromotion) {
    return submissions as MessageSubmissionRecord[];
  }
  // Old daemons do not promise a later canonical acknowledgement. Retire only
  // local bookkeeping after a successful RPC, retaining the local stream row.
  if (presentationToken !== undefined && submission.presentation?.compatibility === "legacy") {
    return submissions.filter((_, submissionIndex) => submissionIndex !== index);
  }
  if (submission.providerAcknowledged) {
    return submissions.filter((_, submissionIndex) => submissionIndex !== index);
  }
  if (submission.rpcSettled) return submissions as MessageSubmissionRecord[];
  return submissions.map((item, submissionIndex) =>
    submissionIndex === index ? { ...item, rpcSettled: true } : item,
  );
}

/**
 * Canonical stream reconciliation carries only wire ids. It may advance a
 * dispatched lease, never a local preparation with the same deterministic id.
 */
export function observeMessageSubmissionCanonical(
  submissions: readonly MessageSubmissionRecord[],
  clientMessageIds: readonly string[],
): MessageSubmissionRecord[] {
  if (clientMessageIds.length === 0) return submissions as MessageSubmissionRecord[];
  const observed = new Set(clientMessageIds);
  let changed = false;
  const next = submissions.flatMap((submission): MessageSubmissionRecord[] => {
    if (
      submission.providerAcknowledged ||
      !observed.has(submission.clientMessageId) ||
      submission.presentation?.phase === "preparing"
    ) {
      return [submission];
    }
    changed = true;
    return submission.rpcSettled ? [] : [{ ...submission, providerAcknowledged: true }];
  });
  return changed ? next : (submissions as MessageSubmissionRecord[]);
}

export function rejectMessageSubmission(
  submissions: readonly MessageSubmissionRecord[],
  clientMessageId: string,
  presentationToken?: string,
): MessageSubmissionRejectionResult {
  const submission = submissions.find((item) => item.clientMessageId === clientMessageId);
  if (!submission) {
    return { outcome: "unknown", submissions: submissions as MessageSubmissionRecord[] };
  }
  if (
    presentationToken !== undefined &&
    submission.presentation?.presentationToken !== presentationToken
  ) {
    return { outcome: "stale", submissions: submissions as MessageSubmissionRecord[] };
  }
  // This exact presentation has already consumed a deferred canonical item.
  // A stale callback must not remove either its local fence or the canonical
  // stream row before Composer has durably recorded the collision for review.
  if (submission.canonicalObservedAtPromotion) {
    return { outcome: "stale", submissions: submissions as MessageSubmissionRecord[] };
  }
  return {
    outcome: submission.providerAcknowledged ? "accepted" : "rejected",
    submissions: submissions.filter((item) => item.clientMessageId !== clientMessageId),
  };
}

/** Abort is valid only before promotion; a claimed/dispatching record is retained for review. */
export function abortMessageSubmission(
  submissions: readonly MessageSubmissionRecord[],
  input: Pick<PendingMessageSubmission, "clientMessageId"> &
    Pick<MessageSubmissionPresentation, "presentationToken">,
): MessageSubmissionRejectionResult {
  const current = submissions.find(
    (submission) => submission.clientMessageId === input.clientMessageId,
  );
  if (
    !current ||
    current.presentation?.presentationToken !== input.presentationToken ||
    current.presentation?.phase !== "preparing"
  ) {
    return { outcome: "stale", submissions: submissions as MessageSubmissionRecord[] };
  }
  return rejectMessageSubmission(submissions, input.clientMessageId, input.presentationToken);
}

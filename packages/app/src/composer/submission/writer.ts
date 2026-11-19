import type { MessageSubmissionWriter } from "@/composer/actions";
import type { MessageSubmissionPresentation } from "@/composer/submission/model";
import { useSessionStore } from "@/stores/session-store";
import type { UserMessageItem } from "@/types/stream";

function createPresentationToken(): string {
  return globalThis.crypto?.randomUUID?.() ?? `submission:${Date.now()}:${Math.random()}`;
}

function withCompatibility(
  presentation: MessageSubmissionPresentation,
  compatibility: MessageSubmissionPresentation["compatibility"],
): MessageSubmissionPresentation {
  return presentation.compatibility === compatibility
    ? presentation
    : { ...presentation, compatibility };
}

function createCompatibilityMessageSubmissionWriter(serverId: string): MessageSubmissionWriter {
  // The map only supplies a token for ordinary old call sites that still begin
  // immediately before transport. Explicit early presentations carry their
  // own token and survive remount in SessionState instead.
  const implicitTokens = new Map<string, string>();
  return {
    begin: (agentId, message, presentation) => {
      const token = presentation?.presentationToken ?? createPresentationToken();
      implicitTokens.set(message.clientMessageId!, token);
      useSessionStore.getState().beginAgentMessageSubmission(serverId, agentId, message, {
        presentationToken: token,
        ownerIdentity: presentation?.ownerIdentity ?? `legacy:${agentId}`,
        phase: presentation?.phase ?? "dispatching",
        compatibility: "legacy",
      });
    },
    promote: (agentId, clientMessageId, presentationToken) =>
      useSessionStore
        .getState()
        .promoteAgentMessageSubmission(serverId, agentId, clientMessageId, presentationToken),
    abort: (agentId, clientMessageId, presentationToken) =>
      useSessionStore
        .getState()
        .abortAgentMessageSubmission(serverId, agentId, clientMessageId, presentationToken),
    accept: (agentId, clientMessageId, presentationToken) => {
      const token = presentationToken ?? implicitTokens.get(clientMessageId);
      useSessionStore
        .getState()
        .acceptAgentMessageSubmission(serverId, agentId, clientMessageId, token);
      if (token === implicitTokens.get(clientMessageId)) implicitTokens.delete(clientMessageId);
    },
    reject: (agentId, clientMessageId, presentationToken) => {
      const token = presentationToken ?? implicitTokens.get(clientMessageId);
      const outcome = useSessionStore
        .getState()
        .rejectAgentMessageSubmission(serverId, agentId, clientMessageId, token);
      if (token === implicitTokens.get(clientMessageId) && outcome !== "stale") {
        implicitTokens.delete(clientMessageId);
      }
      return outcome;
    },
  };
}

function createTrackedMessageSubmissionWriter(serverId: string): MessageSubmissionWriter {
  return {
    begin: (agentId, message, presentation) =>
      useSessionStore
        .getState()
        .beginAgentMessageSubmission(
          serverId,
          agentId,
          message,
          presentation ? withCompatibility(presentation, "canonical") : undefined,
        ),
    promote: (agentId, clientMessageId, presentationToken) =>
      useSessionStore
        .getState()
        .promoteAgentMessageSubmission(serverId, agentId, clientMessageId, presentationToken),
    abort: (agentId, clientMessageId, presentationToken) =>
      useSessionStore
        .getState()
        .abortAgentMessageSubmission(serverId, agentId, clientMessageId, presentationToken),
    accept: (agentId, clientMessageId, presentationToken) =>
      useSessionStore
        .getState()
        .acceptAgentMessageSubmission(serverId, agentId, clientMessageId, presentationToken),
    reject: (agentId, clientMessageId, presentationToken) =>
      useSessionStore
        .getState()
        .rejectAgentMessageSubmission(serverId, agentId, clientMessageId, presentationToken),
  };
}

export function createMessageSubmissionWriter(serverId: string): MessageSubmissionWriter {
  const supportsTrackedMessageSubmissions =
    useSessionStore.getState().sessions[serverId]?.serverInfo?.features
      ?.canonicalSubmittedPrompts === true;
  if (!supportsTrackedMessageSubmissions) {
    // COMPAT(canonicalSubmittedPrompts): added in v0.2.6; remove the gate after 2027-01-31 once daemon floor >= v0.2.6.
    return createCompatibilityMessageSubmissionWriter(serverId);
  }
  return createTrackedMessageSubmissionWriter(serverId);
}

export function handoffCreatedAgentMessageSubmission(
  serverId: string,
  agentId: string,
  message: UserMessageItem,
): boolean {
  return useSessionStore.getState().handoffCreatedAgentUserMessage(serverId, agentId, message);
}

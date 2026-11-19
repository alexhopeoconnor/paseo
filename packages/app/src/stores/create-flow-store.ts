import { create } from "zustand";
import type { UserMessageImageAttachment } from "@/types/stream";
import type { AgentAttachment } from "@getpaseo/protocol/messages";

export type CreateFlowLifecycleState = "active" | "abandoned" | "sent";

/** Local-only compositor ownership. It never crosses the create request boundary. */
export interface CreateFlowPresentation {
  presentationToken: string;
  ownerIdentity: string;
  phase: "preparing" | "dispatching";
}

export interface PendingCreateAttempt {
  draftId: string;
  serverId: string;
  workspaceId?: string;
  agentId: string | null;
  clientMessageId: string;
  text: string;
  timestamp: number;
  lifecycle: CreateFlowLifecycleState;
  presentation?: CreateFlowPresentation;
  errorMessage?: string;
  images?: UserMessageImageAttachment[];
  attachments?: AgentAttachment[];
}

export function isActiveCreateFlowForDraft(input: {
  pending: PendingCreateAttempt | null | undefined;
  serverId: string | null;
  draftId: string | null | undefined;
}): boolean {
  const draftId = input.draftId?.trim();
  return Boolean(
    draftId &&
    input.pending?.draftId === draftId &&
    input.pending.serverId === input.serverId &&
    input.pending.lifecycle === "active",
  );
}

interface CreateFlowState {
  pendingByDraftId: Record<string, PendingCreateAttempt>;
  setPending: (pending: Omit<PendingCreateAttempt, "lifecycle">) => void;
  trySetPending: (pending: Omit<PendingCreateAttempt, "lifecycle">) => boolean;
  beginPresentation: (
    pending: Omit<PendingCreateAttempt, "lifecycle"> & { presentation: CreateFlowPresentation },
  ) => boolean;
  promotePresentation: (input: { draftId: string; presentationToken: string }) => boolean;
  abortPresentation: (input: {
    draftId: string;
    presentationToken: string;
    errorMessage?: string;
  }) => boolean;
  completePresentation: (input: {
    draftId: string;
    clientMessageId: string;
    ownerIdentity: string;
    presentationToken: string;
    agentId: string;
  }) => boolean;
  updateAgentId: (input: { draftId: string; agentId: string; presentationToken?: string }) => void;
  markLifecycle: (input: {
    draftId: string;
    lifecycle: CreateFlowLifecycleState;
    errorMessage?: string;
    presentationToken?: string;
  }) => void;
  rekeyDraft: (input: { fromDraftId: string; toDraftId: string }) => void;
  clear: (input: { draftId: string }) => void;
  clearByAgent: (input: { serverId: string; agentId: string }) => void;
  clearAll: () => void;
}

export const useCreateFlowStore = create<CreateFlowState>((set, get) => ({
  pendingByDraftId: {},
  setPending: (pending) =>
    set((state) => ({
      pendingByDraftId: {
        ...state.pendingByDraftId,
        [pending.draftId]: {
          ...pending,
          lifecycle: "active",
        },
      },
    })),
  trySetPending: (pending) => {
    const existing = get().pendingByDraftId[pending.draftId];
    if (existing?.serverId === pending.serverId && existing.lifecycle !== "abandoned") return false;
    get().setPending(pending);
    return true;
  },
  beginPresentation: (pending) => {
    const existing = get().pendingByDraftId[pending.draftId];
    if (existing?.serverId === pending.serverId && existing.lifecycle !== "abandoned") return false;
    get().setPending(pending);
    return true;
  },
  promotePresentation: ({ draftId, presentationToken }) => {
    let promoted = false;
    set((state) => {
      const current = state.pendingByDraftId[draftId];
      const presentation = current?.presentation;
      if (
        !current ||
        current.lifecycle !== "active" ||
        !presentation ||
        presentation.presentationToken !== presentationToken
      ) {
        return state;
      }
      if (presentation.phase === "dispatching") {
        promoted = true;
        return state;
      }
      promoted = true;
      return {
        pendingByDraftId: {
          ...state.pendingByDraftId,
          [draftId]: {
            ...current,
            presentation: { ...presentation, phase: "dispatching" },
          },
        },
      };
    });
    return promoted;
  },
  abortPresentation: ({ draftId, presentationToken, errorMessage }) => {
    let aborted = false;
    set((state) => {
      const current = state.pendingByDraftId[draftId];
      const presentation = current?.presentation;
      if (
        !current ||
        current.lifecycle !== "active" ||
        !presentation ||
        presentation.presentationToken !== presentationToken ||
        presentation.phase !== "preparing"
      ) {
        return state;
      }
      aborted = true;
      return {
        pendingByDraftId: {
          ...state.pendingByDraftId,
          [draftId]: {
            ...current,
            lifecycle: "abandoned",
            ...(errorMessage ? { errorMessage } : {}),
          },
        },
      };
    });
    return aborted;
  },
  completePresentation: ({
    draftId,
    clientMessageId,
    ownerIdentity,
    presentationToken,
    agentId,
  }) => {
    let completed = false;
    set((state) => {
      const current = state.pendingByDraftId[draftId];
      const presentation = current?.presentation;
      if (
        !current ||
        current.lifecycle !== "active" ||
        current.clientMessageId !== clientMessageId ||
        !presentation ||
        presentation.ownerIdentity !== ownerIdentity ||
        presentation.presentationToken !== presentationToken ||
        presentation.phase !== "dispatching"
      ) {
        return state;
      }
      completed = true;
      return {
        pendingByDraftId: {
          ...state.pendingByDraftId,
          [draftId]: { ...current, agentId, lifecycle: "sent" },
        },
      };
    });
    return completed;
  },
  updateAgentId: ({ draftId, agentId, presentationToken }) =>
    set((state) => {
      const current = state.pendingByDraftId[draftId];
      if (
        !current ||
        current.agentId === agentId ||
        (presentationToken !== undefined &&
          current.presentation?.presentationToken !== presentationToken)
      ) {
        return state;
      }
      return {
        pendingByDraftId: {
          ...state.pendingByDraftId,
          [draftId]: { ...current, agentId },
        },
      };
    }),
  markLifecycle: ({ draftId, lifecycle, errorMessage, presentationToken }) =>
    set((state) => {
      const current = state.pendingByDraftId[draftId];
      if (
        !current ||
        current.lifecycle === lifecycle ||
        (presentationToken !== undefined &&
          current.presentation?.presentationToken !== presentationToken)
      ) {
        return state;
      }
      return {
        pendingByDraftId: {
          ...state.pendingByDraftId,
          [draftId]: { ...current, lifecycle, errorMessage },
        },
      };
    }),
  rekeyDraft: ({ fromDraftId, toDraftId }) =>
    set((state) => {
      const current = state.pendingByDraftId[fromDraftId];
      if (!current) {
        return state;
      }
      if (fromDraftId === toDraftId) {
        return state;
      }
      const { [fromDraftId]: _removed, ...rest } = state.pendingByDraftId;
      return {
        pendingByDraftId: {
          ...rest,
          [toDraftId]: { ...current, draftId: toDraftId },
        },
      };
    }),
  clear: ({ draftId }) =>
    set((state) => {
      if (!state.pendingByDraftId[draftId]) {
        return state;
      }
      const { [draftId]: _removed, ...rest } = state.pendingByDraftId;
      return { pendingByDraftId: rest };
    }),
  clearByAgent: ({ serverId, agentId }) =>
    set((state) => {
      const next = Object.fromEntries(
        Object.entries(state.pendingByDraftId).filter(
          ([, pending]) =>
            pending.lifecycle !== "sent" ||
            pending.serverId !== serverId ||
            pending.agentId !== agentId,
        ),
      );
      if (Object.keys(next).length === Object.keys(state.pendingByDraftId).length) {
        return state;
      }
      return { pendingByDraftId: next };
    }),
  clearAll: () => set({ pendingByDraftId: {} }),
}));

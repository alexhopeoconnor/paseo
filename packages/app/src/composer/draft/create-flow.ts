import { useCallback, useMemo, useReducer, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ComposerAttachment } from "@/attachments/types";
import {
  prepareComposerSendPayload,
  resolveComposerAttachmentSubmitFormat,
  type PreparedComposerSendPayload,
} from "@/composer/attachments/submit";
import { isActiveCreateFlowForDraft, useCreateFlowStore } from "@/stores/create-flow-store";
import { handoffCreatedAgentMessageSubmission } from "@/composer/submission/writer";
import { useSessionStore } from "@/stores/session-store";
import { createUserMessage, type UserMessageImageAttachment } from "@/types/stream";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { encodeImages } from "@/utils/encode-images";

interface CreateAttempt {
  clientMessageId: string;
  text: string;
  timestamp: Date;
  images?: UserMessageImageAttachment[];
  imageData?: Array<{ data: string; mimeType: string }>;
  attachments?: AgentAttachment[];
}

type DraftAgentMachineState<TDraftAgent> =
  | { tag: "draft"; errorMessage: string }
  | { tag: "creating"; attempt: CreateAttempt; draftAgent: TDraftAgent };

type DraftAgentMachineEvent<TDraftAgent> =
  | { type: "DRAFT_SET_ERROR"; message: string }
  | { type: "SUBMIT"; attempt: CreateAttempt; draftAgent: TDraftAgent }
  | { type: "CREATE_FAILED"; message: string };

function assertNever(value: never): never {
  throw new Error(`Unhandled state: ${JSON.stringify(value)}`);
}

function reducer<TDraftAgent>(
  state: DraftAgentMachineState<TDraftAgent>,
  event: DraftAgentMachineEvent<TDraftAgent>,
): DraftAgentMachineState<TDraftAgent> {
  switch (event.type) {
    case "DRAFT_SET_ERROR": {
      if (state.tag !== "draft") {
        return state;
      }
      return { ...state, errorMessage: event.message };
    }
    case "SUBMIT": {
      return { tag: "creating", attempt: event.attempt, draftAgent: event.draftAgent };
    }
    case "CREATE_FAILED": {
      if (state.tag !== "creating") {
        return state;
      }
      return { tag: "draft", errorMessage: event.message };
    }
    default:
      return assertNever(event);
  }
}

function prepareCreateAttempt<TDraftAgent>(
  attempt: CreateAttempt,
  buildDraftAgent: (attempt: CreateAttempt) => TDraftAgent,
): DraftAgentMachineState<TDraftAgent> {
  try {
    return { tag: "creating", attempt, draftAgent: buildDraftAgent(attempt) };
  } catch (error) {
    return { tag: "draft", errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

interface CreateRequestResult<TCreateResult> {
  agentId: string | null;
  result: TCreateResult;
}

interface SubmitContext {
  text: string;
  attachments: ComposerAttachment[];
  cwd: string;
  clientMessageId?: string;
  preparedPayload?: PreparedComposerSendPayload;
}

function throwCreateInputError(message: string, setFormError: (message: string) => void): never {
  setFormError(message);
  throw new Error(message);
}

async function prepareDraftCreateAttempt(input: {
  submit: SubmitContext;
  draftId: string;
  allowEmptyText: boolean;
  getPendingServerId: () => string | null;
  validateBeforeSubmit: ((ctx: SubmitContext) => string | null) | undefined;
  setFormError: (message: string) => void;
  noHostSelectedMessage: string;
  initialPromptRequiredMessage: string;
}): Promise<{ attempt: CreateAttempt; pendingServerId: string }> {
  const { text, attachments, cwd, clientMessageId, preparedPayload } = input.submit;
  const trimmedPrompt = text.trim();
  const pendingServerId = input.getPendingServerId();
  if (!pendingServerId) {
    return throwCreateInputError(input.noHostSelectedMessage, input.setFormError);
  }
  const supportsForgeSearch =
    useSessionStore.getState().sessions[pendingServerId]?.serverInfo?.features?.forgeSearch ===
    true;
  const wirePayload =
    preparedPayload ??
    (await prepareComposerSendPayload({
      attachments,
      format: resolveComposerAttachmentSubmitFormat({
        supportsForgeAttachments: supportsForgeSearch,
      }),
      encodeImages,
    }));
  if (
    !trimmedPrompt &&
    wirePayload.images.length === 0 &&
    wirePayload.attachments.length === 0 &&
    !input.allowEmptyText
  ) {
    return throwCreateInputError(input.initialPromptRequiredMessage, input.setFormError);
  }
  const validationError = input.validateBeforeSubmit?.({ text: trimmedPrompt, attachments, cwd });
  if (validationError) return throwCreateInputError(validationError, input.setFormError);

  return {
    pendingServerId,
    attempt: {
      clientMessageId: clientMessageId ?? `${input.draftId}:initial-message`,
      text: trimmedPrompt,
      timestamp: new Date(),
      ...(wirePayload.images.length > 0 ? { images: wirePayload.images } : {}),
      ...(wirePayload.imageData.length > 0 ? { imageData: wirePayload.imageData } : {}),
      ...(wirePayload.attachments.length > 0 ? { attachments: wirePayload.attachments } : {}),
    },
  };
}

interface CreateRequestContext {
  attempt: CreateAttempt;
  text: string;
  images?: UserMessageImageAttachment[];
  imageData?: Array<{ data: string; mimeType: string }>;
  attachments?: AgentAttachment[];
  cwd: string;
}

interface UseDraftAgentCreateFlowOptions<TDraftAgent, TCreateResult> {
  draftId: string;
  getPendingServerId: () => string | null;
  initialAttempt?: CreateAttempt | null;
  allowEmptyText?: boolean;
  validateBeforeSubmit?: (ctx: SubmitContext) => string | null;
  onBeforeSubmit?: (ctx: CreateRequestContext) => Promise<void> | void;
  onCreateStart?: () => void;
  createRequest: (ctx: CreateRequestContext) => Promise<CreateRequestResult<TCreateResult>>;
  buildDraftAgent: (attempt: CreateAttempt) => TDraftAgent;
  onCreateSuccess: (ctx: { result: TCreateResult; attempt: CreateAttempt }) => Promise<void> | void;
  onCreateError?: (error: Error) => void;
}

export function useDraftAgentCreateFlow<TDraftAgent, TCreateResult>({
  draftId,
  getPendingServerId,
  initialAttempt = null,
  allowEmptyText = false,
  validateBeforeSubmit,
  onBeforeSubmit,
  onCreateStart,
  createRequest,
  buildDraftAgent,
  onCreateSuccess,
  onCreateError,
}: UseDraftAgentCreateFlowOptions<TDraftAgent, TCreateResult>) {
  const { t } = useTranslation();
  const [localMachine, dispatch] = useReducer(
    reducer<TDraftAgent>,
    initialAttempt,
    (attempt): DraftAgentMachineState<TDraftAgent> =>
      attempt
        ? prepareCreateAttempt(attempt, buildDraftAgent)
        : {
            tag: "draft",
            errorMessage: "",
          },
  );

  const pending = useCreateFlowStore((state) => state.pendingByDraftId[draftId]);
  // Remounts can precede model hydration. Rebuild the preview when its inputs
  // arrive, and observe the original request's failure through shared state.
  const machine = useMemo<DraftAgentMachineState<TDraftAgent>>(() => {
    if (pending?.lifecycle === "abandoned") {
      return { tag: "draft", errorMessage: pending.errorMessage ?? "" };
    }
    if (pending?.lifecycle === "active" && localMachine.tag === "draft" && initialAttempt) {
      return prepareCreateAttempt(initialAttempt, buildDraftAgent);
    }
    return localMachine;
  }, [pending, localMachine, initialAttempt, buildDraftAgent]);

  const setPendingCreateAttempt = useCreateFlowStore((state) => state.setPending);
  const updatePendingAgentId = useCreateFlowStore((state) => state.updateAgentId);
  const markPendingCreateLifecycle = useCreateFlowStore((state) => state.markLifecycle);
  // State transitions are asynchronous to a same-tick caller. Reserve before
  // any payload preparation so direct consumers cannot start two creates while
  // pasted-text/image bytes are being prepared.
  const createInputReservationRef = useRef(false);
  const formErrorMessage = machine.tag === "draft" ? machine.errorMessage : "";
  const isSubmitting = machine.tag === "creating";

  const draftAgent = machine.tag === "creating" ? machine.draftAgent : null;
  const startCreateAttempt = useCallback(
    (attempt: CreateAttempt) => {
      const prepared = prepareCreateAttempt(attempt, buildDraftAgent);
      if (prepared.tag === "draft") {
        dispatch({ type: "DRAFT_SET_ERROR", message: prepared.errorMessage });
        throw new Error(prepared.errorMessage);
      }
      dispatch({ type: "SUBMIT", attempt, draftAgent: prepared.draftAgent });
    },
    [buildDraftAgent],
  );

  const runCreateAttempt = useCallback(
    async ({ attempt, cwd }: { attempt: CreateAttempt; cwd: string }) => {
      const pendingServerId = getPendingServerId();
      if (!pendingServerId) {
        const error = new Error(t("composer.errors.noHostSelected"));
        dispatch({ type: "DRAFT_SET_ERROR", message: error.message });
        throw error;
      }

      try {
        await onBeforeSubmit?.({
          attempt,
          text: attempt.text,
          images: attempt.images,
          ...(attempt.imageData ? { imageData: attempt.imageData } : {}),
          attachments: attempt.attachments,
          cwd,
        });
        const createResult = await createRequest({
          attempt,
          text: attempt.text,
          images: attempt.images,
          ...(attempt.imageData ? { imageData: attempt.imageData } : {}),
          attachments: attempt.attachments,
          cwd,
        });

        if (createResult.agentId) {
          updatePendingAgentId({ draftId, agentId: createResult.agentId });
          handoffCreatedAgentMessageSubmission(
            pendingServerId,
            createResult.agentId,
            createUserMessage({
              clientMessageId: attempt.clientMessageId,
              text: attempt.text,
              timestamp: attempt.timestamp,
              images: attempt.images,
              attachments: attempt.attachments,
            }),
          );
          markPendingCreateLifecycle({ draftId, lifecycle: "sent" });
        }

        await onCreateSuccess({ result: createResult.result, attempt });
      } catch (error) {
        const resolved =
          error instanceof Error ? error : new Error(t("composer.errors.failedToCreateAgent"));
        dispatch({ type: "CREATE_FAILED", message: resolved.message });
        markPendingCreateLifecycle({
          draftId,
          lifecycle: "abandoned",
          errorMessage: resolved.message,
        });
        onCreateError?.(resolved);
        throw error;
      }
    },
    [
      createRequest,
      draftId,
      getPendingServerId,
      markPendingCreateLifecycle,
      onBeforeSubmit,
      onCreateError,
      onCreateSuccess,
      t,
      updatePendingAgentId,
    ],
  );

  const handleCreateFromInput = useCallback(
    async ({ text, attachments, cwd, clientMessageId, preparedPayload }: SubmitContext) => {
      const existing = useCreateFlowStore.getState().pendingByDraftId[draftId];
      if (
        createInputReservationRef.current ||
        isSubmitting ||
        isActiveCreateFlowForDraft({ pending: existing, serverId: getPendingServerId(), draftId })
      ) {
        throw new Error(t("composer.errors.alreadyLoading"));
      }
      createInputReservationRef.current = true;

      try {
        dispatch({ type: "DRAFT_SET_ERROR", message: "" });
        const { attempt, pendingServerId } = await prepareDraftCreateAttempt({
          submit: {
            text,
            attachments,
            cwd,
            clientMessageId,
            preparedPayload,
          },
          draftId,
          allowEmptyText,
          getPendingServerId,
          validateBeforeSubmit,
          setFormError: (message) => dispatch({ type: "DRAFT_SET_ERROR", message }),
          noHostSelectedMessage: t("composer.errors.noHostSelected"),
          initialPromptRequiredMessage: t("composer.errors.initialPromptRequired"),
        });

        startCreateAttempt(attempt);
        setPendingCreateAttempt({
          draftId,
          serverId: pendingServerId,
          agentId: null,
          clientMessageId: attempt.clientMessageId,
          text: attempt.text,
          timestamp: attempt.timestamp.getTime(),
          ...(attempt.images && attempt.images.length > 0 ? { images: attempt.images } : {}),
          ...(attempt.attachments && attempt.attachments.length > 0
            ? { attachments: attempt.attachments }
            : {}),
        });

        onCreateStart?.();
        await runCreateAttempt({ attempt, cwd });
      } finally {
        createInputReservationRef.current = false;
      }
    },
    [
      allowEmptyText,
      draftId,
      getPendingServerId,
      isSubmitting,
      onCreateStart,
      runCreateAttempt,
      setPendingCreateAttempt,
      startCreateAttempt,
      t,
      validateBeforeSubmit,
    ],
  );

  const continueCreateFromAttempt = useCallback(
    async ({ attempt, cwd }: { attempt: CreateAttempt; cwd: string }) => {
      if (!isSubmitting) {
        startCreateAttempt(attempt);
      }
      await runCreateAttempt({ attempt, cwd });
    },
    [isSubmitting, runCreateAttempt, startCreateAttempt],
  );

  return {
    machine,
    formErrorMessage,
    isSubmitting,
    draftAgent,
    handleCreateFromInput,
    continueCreateFromAttempt,
  };
}

export type { CreateAttempt as DraftCreateAttempt };

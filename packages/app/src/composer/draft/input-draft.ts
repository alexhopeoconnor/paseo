import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { UserComposerAttachment } from "@/attachments/types";
import type { TextReplacement } from "@/composer/types";
import type { DraftAgentControlsProps } from "@/composer/agent-controls";
import type { DraftCommandTarget } from "@/agent-commands";
import {
  useAgentFormState,
  type CreateAgentInitialValues,
  type UseAgentFormStateResult,
} from "@/hooks/use-agent-form-state";
import { useDraftProviderOptions } from "@/hooks/use-draft-provider-options";
import {
  buildDraftAgentControls,
  resolveDraftKey,
  type DraftKeyInput,
} from "@/composer/draft/input-draft-core";
import {
  buildDraftCommandTarget,
  resolveEffectiveComposerModeId,
  resolveEffectiveComposerModelId,
  resolveEffectiveComposerThinkingOptionId,
  type ProviderSelectionState,
} from "@/provider-selection/provider-selection";
import {
  useDraftStore,
  type DraftInput,
  type DraftSubmissionRestoreSnapshot,
  type DraftSubmissionSnapshot,
} from "@/stores/draft-store";
import { AfterPaintPublication } from "@/composer/after-paint-publication";
import { useShallow } from "zustand/shallow";
import type { ComposerTextSource } from "@/composer/text-source";
import { isWeb } from "@/constants/platform";

const NO_METADATA: Record<string, JsonValue> = {};

type AttachmentUpdater =
  | UserComposerAttachment[]
  | ((prev: UserComposerAttachment[]) => UserComposerAttachment[]);

function haveSameAttachmentIdentity(
  left: readonly UserComposerAttachment[],
  right: readonly UserComposerAttachment[],
): boolean {
  return (
    left.length === right.length && left.every((attachment, index) => attachment === right[index])
  );
}

interface AgentInputDraftComposerOptions {
  initialServerId: string | null;
  initialValues?: CreateAgentInitialValues;
  initialProviderOptions?: Record<string, unknown>;
  /** Which composer a plugin's `useComposer()` reports. */
  context?: "draft" | "new-workspace";
  isVisible?: boolean;
  lockedWorkingDir?: string;
}

interface UseAgentInputDraftInput {
  draftKey: DraftKeyInput;
  composer?: AgentInputDraftComposerOptions;
}

type DraftComposerState = UseAgentFormStateResult & {
  workingDir: string;
  effectiveModeId: string;
  effectiveModelId: string;
  effectiveThinkingOptionId: string;
  providerOptions: Record<string, unknown> | undefined;
  /** What plugins set on the agent this draft creates. */
  metadata: Record<string, JsonValue>;
  agentControls: DraftAgentControlsProps;
  commandDraft: DraftCommandTarget;
};

export interface AgentInputDraft {
  textSource: ComposerTextSource;
  editText: (text: string) => void;
  replaceText: (text: string) => void;
  textReplacement: TextReplacement;
  attachments: UserComposerAttachment[];
  setAttachments: (updater: AttachmentUpdater) => void;
  clear: (lifecycle: "sent" | "abandoned") => void;
  submissionBinding: DraftSubmissionBinding;
  submissionSnapshot: DraftSubmissionSnapshot | null;
  isHydrated: boolean;
  attachmentFocusRequestId: number;
  composerState: DraftComposerState | null;
}

export interface DraftSubmissionBinding {
  flushAfterPaint: () => void;
  capture: () => DraftSubmissionSnapshot | null;
  ensureEmptyForSubmission: () => DraftSubmissionSnapshot | null;
  captureRestore: () => DraftSubmissionRestoreSnapshot;
  isCurrent: (snapshot: DraftSubmissionSnapshot) => boolean;
  bind: (input: {
    snapshot: DraftSubmissionSnapshot;
    submissionCheckpointId: string;
  }) => DraftSubmissionSnapshot | null;
  replaceForSubmission: (input: {
    snapshot: DraftSubmissionSnapshot;
    draft: { text: string; attachments: UserComposerAttachment[] };
  }) => DraftSubmissionSnapshot | null;
  restore: (input: {
    snapshot: DraftSubmissionRestoreSnapshot;
    submissionCheckpointId: string;
    draftOccurrenceKey?: string;
    draft: { text: string; attachments: UserComposerAttachment[] };
  }) => DraftSubmissionSnapshot | null;
  detach: (snapshot: DraftSubmissionSnapshot) => boolean;
}

export function useAgentInputDraft(input: UseAgentInputDraftInput): AgentInputDraft {
  const composerOptions = input.composer ?? null;
  const workingDir = composerOptions?.lockedWorkingDir?.trim() || "";
  const formState = useAgentFormState({
    workingDir,
    serverId: composerOptions?.initialServerId ?? null,
    initialValues: composerOptions?.initialValues,
    isVisible: composerOptions?.isVisible ?? false,
    isCreateFlow: true,
  });
  const draftKey = useMemo(
    () =>
      resolveDraftKey({
        draftKey: input.draftKey,
        selectedServerId: formState.selectedServerId,
      }),
    [formState.selectedServerId, input.draftKey],
  );
  const draftAttachments = useDraftStore(
    useShallow((state) =>
      state.drafts[draftKey]?.lifecycle === "active"
        ? (state.drafts[draftKey].input.attachments ?? [])
        : [],
    ),
  );
  // Text is published through textSource without rerendering this parent.
  // Notices only need an active checkpoint identity; capture() reads the
  // current version and input imperatively at Send time.
  const draftSubmissionState = useDraftStore(
    useShallow((state) => {
      const record = state.drafts[draftKey];
      return {
        isActive: record?.lifecycle === "active",
        submissionCheckpointId: record?.submissionCheckpointId ?? null,
      };
    }),
  );
  const submissionSnapshot = useMemo<DraftSubmissionSnapshot | null>(() => {
    if (!draftSubmissionState.isActive || !draftSubmissionState.submissionCheckpointId) {
      return null;
    }
    const snapshot = useDraftStore.getState().getDraftSubmissionSnapshot(draftKey);
    return snapshot?.submissionCheckpointId === draftSubmissionState.submissionCheckpointId
      ? snapshot
      : null;
  }, [draftKey, draftSubmissionState.isActive, draftSubmissionState.submissionCheckpointId]);
  const textSource = useMemo<ComposerTextSource>(
    () => ({
      getSnapshot: () => {
        const record = useDraftStore.getState().drafts[draftKey];
        return record?.lifecycle === "active" ? record.input.text : "";
      },
      subscribe: (listener) =>
        useDraftStore.subscribe((state, previous) => {
          if (
            state.drafts[draftKey]?.input.text !== previous.drafts[draftKey]?.input.text ||
            state.drafts[draftKey]?.lifecycle !== previous.drafts[draftKey]?.lifecycle
          )
            listener();
        }),
    }),
    [draftKey],
  );
  const attachmentFocusRequestId = useDraftStore(
    (state) => state.attachmentFocusRequestByDraftKey[draftKey] ?? 0,
  );
  const [hydratedDraftKey, setHydratedDraftKey] = useState<string | null>(null);
  const isHydrated = hydratedDraftKey === draftKey;
  const textReplacementRevisionRef = useRef(0);
  const [textReplacement, setTextReplacement] = useState<TextReplacement>(() => ({
    kind: "initial",
    key: `${draftKey}:0`,
    text: textSource.getSnapshot(),
  }));

  const publishTextReplacement = useCallback(
    (kind: "hydrated" | "replace", nextText: string) => {
      textReplacementRevisionRef.current += 1;
      setTextReplacement({
        kind,
        key: `${draftKey}:${textReplacementRevisionRef.current}`,
        text: nextText,
      });
    },
    [draftKey],
  );

  const saveDraft = useCallback(
    (update: (draft: DraftInput) => DraftInput) =>
      useDraftStore.getState().updateDraftInput({ draftKey, update }),
    [draftKey],
  );

  const textPublication = useMemo(
    () =>
      new AfterPaintPublication<string>((nextText) => {
        useDraftStore.getState().editDraftText({ draftKey, text: nextText });
      }),
    [draftKey],
  );

  // Text another module put in the draft (a plugin writing to a composer that is not on screen)
  // reaches the input the way a rewind restore does.
  const replacementRequest = useDraftStore(
    (state) => state.textReplacementRequestByDraftKey[draftKey] ?? 0,
  );
  const shownReplacementRequestRef = useRef({ draftKey, request: replacementRequest });
  useEffect(() => {
    const shown = shownReplacementRequestRef.current;
    if (shown.draftKey === draftKey && shown.request === replacementRequest) return;
    shownReplacementRequestRef.current = { draftKey, request: replacementRequest };
    textPublication.cancel();
    publishTextReplacement("replace", textSource.getSnapshot());
  }, [draftKey, publishTextReplacement, replacementRequest, textPublication, textSource]);

  const editText = useCallback(
    (nextText: string) => {
      const currentRecord = useDraftStore.getState().drafts[draftKey];
      // Submission-owned clear/restore writes the draft record before it
      // mirrors the same text into the platform input. Some inputs emit that
      // mirror through onChange. It is not a fresh user edit and must not
      // detach the checkpoint that owns the just-written state.
      if (
        currentRecord?.lifecycle === "active" &&
        currentRecord.submissionCheckpointId !== undefined &&
        currentRecord.input.text === nextText
      ) {
        return;
      }
      if (isWeb) {
        if (currentRecord?.input.text !== nextText) {
          useDraftStore.getState().detachDraftSubmissionCheckpoint({ draftKey });
        }
        textPublication.stage(nextText);
      } else {
        useDraftStore.getState().editDraftText({ draftKey, text: nextText });
      }
    },
    [draftKey, textPublication],
  );

  const replaceText = useCallback(
    (nextText: string) => {
      textPublication.cancel();
      useDraftStore.getState().replaceDraftText({ draftKey, text: nextText });
      publishTextReplacement("replace", nextText);
    },
    [draftKey, publishTextReplacement, textPublication],
  );

  const setAttachments = useCallback(
    (updater: AttachmentUpdater) => {
      const store = useDraftStore.getState();
      const current = store.getDraftInput(draftKey) ?? { text: "", attachments: [] };
      const nextAttachments =
        typeof updater === "function" ? updater(current.attachments) : updater;
      if (haveSameAttachmentIdentity(current.attachments, nextAttachments)) {
        return;
      }
      saveDraft(() => ({ ...current, attachments: nextAttachments }));
    },
    [draftKey, saveDraft],
  );

  const metadata = useDraftStore((state) => state.metadataByDraftKey[draftKey] ?? NO_METADATA);
  const setMetadata = useCallback(
    (patch: Record<string, JsonValue>) =>
      useDraftStore.getState().patchDraftMetadata({ draftKey, patch }),
    [draftKey],
  );

  const clear = useCallback(
    (lifecycle: "sent" | "abandoned") => {
      textPublication.cancel();
      useDraftStore.getState().clearDraftInput({ draftKey, lifecycle });
      if (lifecycle === "sent") useDraftStore.getState().clearDraftMetadata({ draftKey });
    },
    [draftKey, textPublication],
  );

  const submissionBinding = useMemo<DraftSubmissionBinding>(
    () => ({
      flushAfterPaint: () => textPublication.flush(),
      capture: () => useDraftStore.getState().getDraftSubmissionSnapshot(draftKey),
      ensureEmptyForSubmission: () =>
        useDraftStore.getState().ensureEmptyDraftSubmissionSnapshot({ draftKey }),
      captureRestore: () => useDraftStore.getState().getDraftSubmissionRestoreSnapshot(draftKey),
      isCurrent: (snapshot) => {
        const current = useDraftStore.getState().getDraftSubmissionSnapshot(draftKey);
        return (
          current?.draftKey === snapshot.draftKey &&
          current.version === snapshot.version &&
          current.draftOccurrenceKey === snapshot.draftOccurrenceKey &&
          current.submissionCheckpointId === snapshot.submissionCheckpointId
        );
      },
      bind: ({ snapshot, submissionCheckpointId }) =>
        useDraftStore.getState().bindDraftSubmissionCheckpoint({
          draftKey,
          expectedVersion: snapshot.version,
          submissionCheckpointId,
        }),
      replaceForSubmission: ({ snapshot, draft }) => {
        if (!snapshot.submissionCheckpointId) {
          return null;
        }
        return useDraftStore.getState().replaceDraftSubmissionInput({
          draftKey,
          expectedVersion: snapshot.version,
          submissionCheckpointId: snapshot.submissionCheckpointId,
          draft,
        });
      },
      restore: ({ snapshot, submissionCheckpointId, draftOccurrenceKey, draft }) =>
        useDraftStore.getState().restoreDraftSubmissionInput({
          draftKey,
          expectedVersion: snapshot.version,
          expectedSubmissionCheckpointId: snapshot.submissionCheckpointId,
          submissionCheckpointId,
          draftOccurrenceKey,
          draft,
        }),
      detach: (snapshot) => {
        if (!snapshot.submissionCheckpointId) {
          return false;
        }
        return useDraftStore.getState().detachDraftSubmissionCheckpoint({
          draftKey,
          expectedVersion: snapshot.version,
          submissionCheckpointId: snapshot.submissionCheckpointId,
        });
      },
    }),
    [draftKey, textPublication],
  );

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") textPublication.flush();
    };
    const flush = () => textPublication.flush();
    const canListenForPageHide =
      isWeb && typeof window !== "undefined" && typeof window.addEventListener === "function";
    if (isWeb && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", flushWhenHidden);
    }
    if (canListenForPageHide) {
      window.addEventListener("pagehide", flush);
    }
    return () => {
      if (isWeb && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", flushWhenHidden);
      }
      if (canListenForPageHide) {
        window.removeEventListener("pagehide", flush);
      }
      textPublication.flush();
    };
  }, [textPublication]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await useDraftStore.getState().hydrateDraftInput({ draftKey });
      if (!cancelled) {
        const hydratedText = useDraftStore.getState().getDraftInput(draftKey)?.text ?? "";
        publishTextReplacement("hydrated", hydratedText);
        setHydratedDraftKey(draftKey);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [draftKey, publishTextReplacement]);

  const providerSelection = useMemo<ProviderSelectionState>(
    () => ({
      provider: formState.selectedProvider,
      modelId: formState.selectedModel,
      modeId: formState.selectedMode,
      thinkingOptionId: formState.selectedThinkingOptionId,
      availableModels: formState.availableModels,
      modeOptions: formState.modeOptions,
    }),
    [
      formState.availableModels,
      formState.modeOptions,
      formState.selectedMode,
      formState.selectedModel,
      formState.selectedProvider,
      formState.selectedThinkingOptionId,
    ],
  );

  const effectiveModeId = useMemo(
    () => resolveEffectiveComposerModeId(providerSelection, formState.isModelLoading),
    [formState.isModelLoading, providerSelection],
  );

  const effectiveModelId = useMemo(
    () => resolveEffectiveComposerModelId(providerSelection),
    [providerSelection],
  );

  const effectiveThinkingOptionId = useMemo(
    () => resolveEffectiveComposerThinkingOptionId(providerSelection, effectiveModelId),
    [effectiveModelId, providerSelection],
  );

  const {
    optionControls: draftOptionControls,
    options: draftOptions,
    shownOptions: draftShownOptions,
    setOption: setDraftOption,
    applyProfile: applyProfileOptions,
  } = useDraftProviderOptions({
    serverId: formState.selectedServerId,
    provider: formState.selectedProvider,
    getProvider: formState.getSelectedProvider,
    cwd: workingDir,
    modeId: formState.selectedMode,
    modelId: effectiveModelId,
    thinkingOptionId: effectiveThinkingOptionId,
    initialOptions: composerOptions?.initialProviderOptions,
  });

  const applyDraftAgentProfile = useCallback(
    (profile: Parameters<typeof formState.applyProfileFromUser>[0]) => {
      formState.applyProfileFromUser(profile);
      applyProfileOptions({ provider: profile.provider, options: profile.options });
    },
    [applyProfileOptions, formState],
  );

  const commandDraft = useMemo(
    () =>
      buildDraftCommandTarget({
        selection: providerSelection,
        cwd: workingDir,
        effectiveModelId,
        effectiveThinkingOptionId,
        providerOptions: draftOptions,
      }),
    [effectiveModelId, effectiveThinkingOptionId, draftOptions, providerSelection, workingDir],
  );

  const composerState = useMemo<DraftComposerState | null>(() => {
    if (!composerOptions) {
      return null;
    }

    return {
      ...formState,
      workingDir,
      effectiveModeId,
      effectiveModelId,
      effectiveThinkingOptionId,
      providerOptions: draftOptions,
      metadata,
      agentControls: buildDraftAgentControls({
        formState,
        optionControls: draftOptionControls,
        options: draftShownOptions,
        onSetOption: setDraftOption,
        onApplyAgentProfile: applyDraftAgentProfile,
        context: composerOptions.context ?? "draft",
        metadata,
        onSetMetadata: setMetadata,
      }),
      commandDraft,
    };
  }, [
    commandDraft,
    composerOptions,
    effectiveModeId,
    effectiveModelId,
    effectiveThinkingOptionId,
    draftOptionControls,
    draftOptions,
    draftShownOptions,
    setDraftOption,
    applyDraftAgentProfile,
    formState,
    metadata,
    setMetadata,
    workingDir,
  ]);

  return {
    textSource,
    editText,
    replaceText,
    textReplacement,
    attachments: draftAttachments,
    setAttachments,
    clear,
    submissionBinding,
    submissionSnapshot,
    isHydrated,
    attachmentFocusRequestId,
    composerState,
  };
}

export const __private__ = {
  resolveDraftKey,
  resolveEffectiveComposerModeId,
  resolveEffectiveComposerModelId,
  resolveEffectiveComposerThinkingOptionId,
  buildDraftCommandTarget,
  buildDraftAgentControls,
};

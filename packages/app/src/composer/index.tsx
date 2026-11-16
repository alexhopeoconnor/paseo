import {
  useComposerEditingSession,
  useComposerFullscreen,
  type ComposerEditingSession,
} from "./editing-session";
import type { ComposerTextSource } from "./text-source";
import type { DraftSubmissionBinding } from "./draft/input-draft";
import type { DraftSubmissionSnapshot } from "@/stores/draft-store";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  View,
  Pressable,
  Text,
  StyleSheet as RNStyleSheet,
  type PressableStateCallbackType,
} from "react-native";
import type { TFunction } from "i18next";
import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  useSyncExternalStore,
  useImperativeHandle,
  memo,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePanelStore } from "@/stores/panel-store";
import { useHasFinePointer } from "@/hooks/use-fine-pointer";
import { useShallow } from "zustand/shallow";
import {
  ArrowUp,
  Square,
  Pencil,
  AudioLines,
  CircleDot,
  FileText,
  GitPullRequest,
  Image as ImageIcon,
  ClipboardPaste,
  Paperclip,
} from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import { FOOTER_HEIGHT } from "@/constants/layout";
import {
  AgentControls,
  DraftAgentControls,
  type DraftAgentControlsProps,
} from "@/composer/agent-controls";
import { ContextWindowMeter } from "@/components/context-window-meter";
import { useImageAttachmentPicker } from "@/hooks/use-image-attachment-picker";
import {
  selectAgentSentMessages,
  selectAgentTurnPresentation,
  useSessionStore,
} from "@/stores/session-store";
import { useFilePicker } from "@/hooks/use-file-picker";
import { useFileDrop } from "@/components/file-drop/use-file-drop";
import type { DroppedItem } from "@/components/file-drop/types";
import {
  MessageInput,
  type AttachmentMenuItem,
  type ComposerKeyPressEvent,
  type MessageInputRef,
  type WebClipboardPasteEvent,
} from "./input/input";
import type { ImageAttachment, MessagePayload, TextReplacement } from "./types";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { DraftCommandTarget } from "@/agent-commands";
import { encodeImages } from "@/utils/encode-images";
import { persistClipboardImageFiles } from "@/utils/image-attachments-from-files";
import { focusWithRetries } from "@/utils/web-focus";
import {
  cancelComposerAgent,
  dispatchComposerAgentMessage,
  editQueuedComposerMessage,
  findForgeItemByOption,
  isAttachmentSelectedForForgeItem,
  openComposerAttachment,
  pickAndPersistImages,
  queueComposerMessage,
  removeComposerAttachmentAtIndex,
  sendQueuedComposerMessageNow,
  toggleForgeAttachmentFromPicker,
  uploadFileAttachmentBatch,
  type AttachmentPersister,
  type FileUploadBatchFailure,
  type QueueWriter,
  type QueuedComposerMessage,
} from "@/composer/actions";
import { useVoiceOptional } from "@/contexts/voice-context";
import { useToast } from "@/contexts/toast-context";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shortcut } from "@/components/ui/shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { AutocompletePopover } from "@/components/ui/autocomplete-popover";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import { useAgentAutocomplete } from "@/hooks/use-agent-autocomplete";
import { usePluginClientSlashCommands } from "@/plugins/client-slash-commands";
import {
  executePluginClientSlashCommand,
  resolvePluginClientSlashCommand,
} from "@/plugins/client-slash-commands/model";
import {
  useHostRuntimeAgentDirectoryStatus,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import {
  persistAttachmentFromBlob,
  persistAttachmentFromDataUrl,
  persistAttachmentFromFileUri,
} from "@/attachments/service";
import { resolveAgentControlsMode } from "@/composer/agent-controls/mode";
import { resolveComposerInputMode, type ComposerInputMode } from "@/composer/input-mode";
import { resolveActiveSendBehavior } from "./input/state";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import type { MessageInputKeyboardActionKind } from "@/keyboard/actions";
import { submitAgentInput } from "@/composer/submit";
import { clipboardFileToSelectedFile } from "@/composer/clipboard-classifier";
import { persistPastedTextAttachment } from "@/composer/pasted-text";
import { PastedTextSheet, type PastedTextInspectorTarget } from "@/composer/pasted-text-sheet";
import { SubmissionRecoverySheet } from "@/composer/submission/recovery-sheet";
import {
  prepareComposerSendPayload,
  resolveComposerAttachmentSubmitFormat,
  type PreparedComposerSendPayload,
} from "@/composer/attachments/submit";
import {
  claimPreparedComposerSubmission,
  discardPreparedComposerSubmission,
  markComposerSubmissionNeedsReview,
  markComposerSubmissionSettled,
  prepareComposerSubmissionRecovery,
  type PreparedComposerSubmissionRecovery,
} from "@/composer/submission/recovery";
import {
  flushDraftPersistStorageOrThrow,
  scheduleAttachmentGarbageCollection,
} from "@/stores/draft-store";
import {
  getSubmissionRecoveryStore,
  getSubmissionRecoveryInspectionState,
  type SubmissionRecoveryRecord,
} from "@/stores/workspace-draft-submission-recovery";
import { generateMessageId } from "@/types/stream";
import { ComposerRecall } from "@/composer/recall";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { ComposerKeyboardScopeProvider, useComposerKeyboardScope } from "@/composer/keyboard-scope";
import { useAppSettings } from "@/hooks/use-settings";
import { RenderProfile } from "@/utils/render-profiler";
import { AfterPaintPublication } from "@/composer/after-paint-publication";
import { isWeb, isNative } from "@/constants/platform";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import type {
  AttachmentMetadata,
  ComposerAttachment,
  UserComposerAttachment,
  WorkspaceFileComposerAttachment,
  WorkspaceComposerAttachment,
} from "@/attachments/types";
import type { SelectedFile } from "@/attachments/selected-file";
import { composerWorkspaceAttachment } from "@/composer/attachments/workspace";
import {
  collectWorkspaceAttachmentsForScopes,
  useWorkspaceAttachmentsForScopes,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { droppedItemsToSelectedFiles } from "@/composer/attachments/drop";
import { getFileTypeLabel } from "@/attachments/file-types";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import {
  AttachmentFrame,
  AttachmentLabel,
  AttachmentPill,
  AttachmentThumbnail,
} from "@/components/attachment-pill";
import { AttachmentLightbox, type ImageLightboxSource } from "@/components/attachment-lightbox";
import { openExternalUrl } from "@/utils/open-external-url";
import { useIsDictationReady } from "@/hooks/use-is-dictation-ready";
import { useForgeSearchQuery } from "@/git/use-forge-search-query";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { useCheckoutPrStatusQuery } from "@/git/use-pr-status-query";
import { getForgePresentation } from "@/git/forge";
import { ForgeBrandIcon } from "@/git/forge-icon";
import { useComposerForgeAutoAttach } from "./forge-auto-attach";
import { readClipboardImage } from "./clipboard-image";
import { normalizeNativePastedImages, type NativePastedFile } from "./native-pasted-image";
import { PluginResourceAttachmentPill, usePluginAttachmentPicker } from "@/plugins";
import { resolveClientSlashCommand, type ClientSlashCommand } from "@/client-slash-commands";
import {
  appendWorkspaceFileAttachment,
  getWorkspaceFileAttachmentKey,
  getWorkspaceFileAttachmentSubtitle,
} from "@/attachments/workspace-file";
import {
  resolveWorkspaceFileDrop,
  type WorkspaceFileDragPayload,
} from "@/attachments/workspace-file-drag";

const composerImageAttachmentPersister: Pick<
  AttachmentPersister,
  "persistFromBlob" | "persistFromDataUrl" | "persistFromFileUri"
> = {
  persistFromBlob: persistAttachmentFromBlob,
  persistFromDataUrl: persistAttachmentFromDataUrl,
  persistFromFileUri: persistAttachmentFromFileUri,
};

type QueuedMessage = QueuedComposerMessage;

/** Legacy in-memory queue rows predate the stable wire identity field. */
function getQueuedClientMessageId(input: { id: string; clientMessageId?: string }): string {
  return input.clientMessageId ?? input.id;
}

type AttachmentListUpdater =
  | UserComposerAttachment[]
  | ((prev: UserComposerAttachment[]) => UserComposerAttachment[]);

const EMPTY_ATTACHMENT_SCOPE_KEYS: readonly string[] = [];

interface ComposerOwnerSnapshot {
  identity: string;
  epoch: number;
}

/** The recovery listing is inspection-only; it never replays a submission. */
type RecoveryInspectionState = "loading" | "ready" | "error";

interface ComposerSubmissionOrigin {
  owner: ComposerOwnerSnapshot;
  clearDraft: (lifecycle: "sent" | "abandoned") => void;
  onChangeAttachments: (updater: AttachmentListUpdater) => void;
  onChangeText: (text: string) => void;
  textSource: ComposerTextSource;
  submissionBinding?: DraftSubmissionBinding;
}

/**
 * An attachment blob can already be durable while its reference in the draft
 * has not crossed the draft-store barrier. Callers must keep that reference
 * and retry the barrier, never repeat the blob/upload operation.
 */
type AttachmentReferenceCommitResult =
  | { status: "durable" }
  | { status: "pending_durability"; error: unknown };

function createComposerOwnerIdentity(input: {
  serverId: string;
  agentId: string;
  workspaceId: string | null | undefined;
  cwd: string;
}): string {
  return [input.serverId, input.agentId, input.workspaceId ?? "", input.cwd].join("\u0000");
}

function noop() {}
const noopCallback = () => {};

function sameComposerAttachmentSnapshot(
  current: readonly ComposerAttachment[],
  snapshot: readonly ComposerAttachment[],
): boolean {
  return (
    current.length === snapshot.length &&
    current.every((attachment, index) => attachment === snapshot[index])
  );
}

/**
 * Remove only snapshot objects that still exist in the origin draft. This is
 * deliberately identity based: a later attachment with the same filename or
 * metadata is a distinct edit and must survive an older send's cleanup.
 */
function subtractConsumedUserAttachmentSnapshot(
  current: readonly UserComposerAttachment[],
  consumed: readonly UserComposerAttachment[],
): UserComposerAttachment[] {
  const remainingConsumed = [...consumed];
  return current.filter((attachment) => {
    const index = remainingConsumed.indexOf(attachment);
    if (index < 0) return true;
    remainingConsumed.splice(index, 1);
    return false;
  });
}

function selectReviewableComposerSubmissions(input: {
  records: SubmissionRecoveryRecord[];
  serverId: string;
  agentId: string;
  now?: number;
}): SubmissionRecoveryRecord[] {
  const now = input.now ?? Date.now();
  return input.records.filter(
    (record) =>
      record.submission.serverId === input.serverId &&
      record.submission.agentId === input.agentId &&
      getSubmissionRecoveryInspectionState(record, now) !== null &&
      record.state !== "settled",
  );
}

function getSubmissionRecoveryPillContent(record: SubmissionRecoveryRecord): {
  title: string;
  subtitle: string;
} {
  switch (getSubmissionRecoveryInspectionState(record)) {
    case "queued":
      return {
        title: "Queued submission retained",
        subtitle: "Not sent automatically after reload",
      };
    case "dispatching_unknown":
      return { title: "Submission outcome unknown", subtitle: "Inspect before retrying" };
    case "accepted":
      return { title: "Submission accepted", subtitle: "This saved attempt will not send again" };
    default:
      return {
        title: "Submission needs review",
        subtitle: record.errorMessage ?? "Provider outcome is unknown",
      };
  }
}

function matchesComposerOwner(
  record: SubmissionRecoveryRecord,
  owner: ComposerOwnerSnapshot,
): boolean {
  if (record.submission.agentId === null) {
    return false;
  }
  return (
    createComposerOwnerIdentity({
      serverId: record.submission.serverId,
      agentId: record.submission.agentId,
      workspaceId: record.submission.workspaceId,
      cwd: record.submission.cwd,
    }) === owner.identity
  );
}

function findBoundSubmissionRecovery(input: {
  records: readonly SubmissionRecoveryRecord[];
  owner: ComposerOwnerSnapshot;
  snapshot: DraftSubmissionSnapshot | null;
}): SubmissionRecoveryRecord | null {
  const { records, owner, snapshot } = input;
  if (!snapshot?.submissionCheckpointId) {
    return null;
  }
  return (
    records.find(
      (record) =>
        record.id === snapshot.submissionCheckpointId && matchesComposerOwner(record, owner),
    ) ?? null
  );
}

function getRecoverySendBlockMessage(input: {
  inspectionState: RecoveryInspectionState;
  snapshot: DraftSubmissionSnapshot | null;
  record: SubmissionRecoveryRecord | null;
}): string | null {
  const checkpointId = input.snapshot?.submissionCheckpointId;
  if (checkpointId) {
    if (input.inspectionState === "loading") {
      return "Checking the submission checkpoint linked to this draft before sending.";
    }
    if (input.inspectionState === "error") {
      return "The submission checkpoint linked to this draft could not be inspected. Edit the draft to begin a new attempt.";
    }
    if (!input.record) {
      return "The submission checkpoint linked to this draft is unavailable or belongs to a different composer. Edit the draft to begin a new attempt.";
    }
  } else if (input.inspectionState === "loading") {
    return "Checking prior submission recovery before sending.";
  }
  if (!input.record) return null;
  if (getSubmissionRecoveryInspectionState(input.record) === "accepted") {
    return "This submission attempt was already accepted. Inspect its recovery checkpoint before sending it again.";
  }
  return "This draft is linked to a recovery checkpoint. Inspect it before retrying.";
}

function shouldQueueComposerSubmission(
  forceQueue: boolean,
  isAgentRunning: boolean,
  forceSend: boolean | undefined,
): boolean {
  return forceQueue || (isAgentRunning && !forceSend);
}

function canStartComposerSubmission(forceQueue: boolean, hasSubmitExecutor: boolean): boolean {
  return forceQueue || hasSubmitExecutor;
}

interface ComposerSubmissionPreflightInput {
  outgoingMessage: string;
  outgoingAttachments: readonly ComposerAttachment[];
  forceQueue: boolean;
  isAgentRunning: boolean;
  forceSend: boolean | undefined;
  hasExternalContent: boolean;
  allowEmptySubmit: boolean;
  hasSubmitExecutor: boolean;
}

function getComposerSubmissionPreflight(input: ComposerSubmissionPreflightInput): {
  trimmedMessage: string;
  shouldQueue: boolean;
  canSubmit: boolean;
} | null {
  const trimmedMessage = input.outgoingMessage.trim();
  const shouldQueue = shouldQueueComposerSubmission(
    input.forceQueue,
    input.isAgentRunning,
    input.forceSend,
  );
  const canSubmit = canStartComposerSubmission(input.forceQueue, input.hasSubmitExecutor);
  const hasContent =
    Boolean(trimmedMessage) ||
    input.outgoingAttachments.length > 0 ||
    input.hasExternalContent ||
    input.allowEmptySubmit;
  if (!hasContent || !canSubmit) return null;
  return { trimmedMessage, shouldQueue, canSubmit };
}

function canCreateEmptyComposerSubmissionSnapshot(input: {
  outgoingMessage: string;
  outgoingAttachments: readonly ComposerAttachment[];
  outgoingUserAttachments: readonly UserComposerAttachment[];
  allowEmptySubmit: boolean;
  hasExternalContent: boolean;
}): boolean {
  return (
    input.outgoingMessage.length === 0 &&
    input.outgoingUserAttachments.length === 0 &&
    (input.allowEmptySubmit || input.hasExternalContent || input.outgoingAttachments.length > 0)
  );
}

function resolveComposerButtonIconSize(): number {
  return isWeb ? ICON_SIZE.md : ICON_SIZE.lg;
}

function resolveIsComposerLocked(
  submitBehavior: "clear" | "preserve-and-lock",
  isSubmitLoading: boolean,
): boolean {
  return submitBehavior === "preserve-and-lock" && isSubmitLoading;
}

function resolveIsVoiceModeForAgent(
  voice: ReturnType<typeof useVoiceOptional>,
  serverId: string,
  agentId: string,
): boolean {
  return voice?.isVoiceModeForAgent(serverId, agentId) ?? false;
}

function resolveKeyboardPriority(isMessageInputFocused: boolean): number {
  return isMessageInputFocused ? 200 : 100;
}

function resolveIsDesktopWebBreakpoint(isMobile: boolean): boolean {
  return isWeb && !isMobile;
}

function resolveCompactLayout(override: boolean | undefined, formFactor: boolean): boolean {
  return override ?? formFactor;
}

function resolveMessagePlaceholder(
  inputMode: ComposerInputMode,
  isDesktopWebBreakpoint: boolean,
  t: TFunction,
  override: string | undefined,
): string {
  // A terminal placeholder names what it launches ("Prompt Codex", "Run a
  // command"), which depends on the selected profile. Only the caller knows
  // that, so it wins when supplied.
  if (override !== undefined) {
    return override;
  }
  if (inputMode === "terminal") {
    return t("composer.placeholders.terminal");
  }
  return isDesktopWebBreakpoint
    ? t("composer.placeholders.desktop")
    : t("composer.placeholders.mobile");
}

function resolveGithubSearchEnabled(
  isGithubPickerOpen: boolean,
  isConnected: boolean,
  cwd: string,
): boolean {
  return isGithubPickerOpen && isConnected && cwd.trim().length > 0;
}

function resolveCheckoutRemoteUrl(
  checkoutStatus: ReturnType<typeof useCheckoutStatusQuery>["status"],
): string | null {
  return checkoutStatus?.remoteUrl ?? null;
}

function buildCancelButtonStyle(isConnected: boolean, isCancellingAgent: boolean): object[] {
  const disabled = !isConnected || isCancellingAgent ? styles.buttonDisabled : undefined;
  return [styles.cancelButton, disabled].filter((value): value is object => Boolean(value));
}

function buildRealtimeVoiceButtonStyle(
  hovered: boolean | undefined,
  voiceButtonDisabled: boolean,
  reserveLeadingSpace: boolean,
): object[] {
  const hoveredStyle = hovered ? styles.iconButtonHovered : undefined;
  const disabledStyle = voiceButtonDisabled ? styles.buttonDisabled : undefined;
  const reserveStyle = reserveLeadingSpace ? styles.realtimeVoiceButtonCompactReserve : undefined;
  return [styles.realtimeVoiceButton, reserveStyle, hoveredStyle, disabledStyle].filter(
    (value): value is object => Boolean(value),
  );
}

function buildAgentStateSelector(serverId: string, agentId: string) {
  return (state: ReturnType<typeof useSessionStore.getState>) => {
    const agent = state.sessions[serverId]?.agents?.get(agentId) ?? null;
    return {
      status: agent?.status ?? null,
      contextWindowMaxTokens: agent?.lastUsage?.contextWindowMaxTokens ?? null,
      contextWindowUsedTokens: agent?.lastUsage?.contextWindowUsedTokens ?? null,
      totalCostUsd: agent?.lastUsage?.totalCostUsd ?? null,
      model: agent?.model ?? null,
    };
  };
}

interface RenderLeftContentArgs {
  agentControls: DraftAgentControlsProps | undefined;
  agentId: string;
  serverId: string;
  focusInput: () => void;
  isCompactLayout: boolean;
  showAgentControls: boolean;
}

function renderLeftContent(args: RenderLeftContentArgs): ReactElement | null {
  const { agentControls, agentId, serverId, focusInput, isCompactLayout } = args;
  if (!args.showAgentControls) return null;
  if (resolveAgentControlsMode(agentControls) === "draft" && agentControls) {
    return <DraftAgentControls {...agentControls} isCompactLayout={isCompactLayout} />;
  }
  return (
    <AgentControls
      agentId={agentId}
      serverId={serverId}
      onDropdownClose={focusInput}
      isCompactLayout={isCompactLayout}
    />
  );
}

interface PendingFileAttachment {
  id: number;
  file: SelectedFile;
  ownerIdentity: string;
}

interface FailedFileAttachment extends PendingFileAttachment {
  errorMessage: string;
}

interface RenderAttachmentTrayArgs {
  serverId: string;
  selectedAttachments: ComposerAttachment[];
  pendingFiles: PendingFileAttachment[];
  failedFiles: FailedFileAttachment[];
  reviewableSubmissions: SubmissionRecoveryRecord[];
  unresolvedSubmissionCheckpoint: "checking" | "unavailable" | null;
  isComposerLocked: boolean;
  handleOpenAttachment: (attachment: ComposerAttachment) => void;
  handleRemoveAttachment: (index: number) => void;
  handleRetryFailedFile: (id: number) => void;
  handleRemoveFailedFile: (id: number) => void;
  handleInspectSubmission: (record: SubmissionRecoveryRecord) => void;
  labels: {
    openImage: string;
    removeImage: string;
    removeFile: string;
    openGithub: (kind: string, numberLabel: string) => string;
    removeGithub: (kind: string, numberLabel: string) => string;
  };
}

function FailedFileAttachmentPill({
  entry,
  disabled,
  onRetry,
  onRemove,
}: {
  entry: FailedFileAttachment;
  disabled: boolean;
  onRetry: (id: number) => void;
  onRemove: (id: number) => void;
}) {
  const handleOpen = useCallback(() => onRetry(entry.id), [entry.id, onRetry]);
  const handleRemove = useCallback(() => onRemove(entry.id), [entry.id, onRemove]);

  return (
    <View style={styles.failedAttachment}>
      <AttachmentPill
        testID="composer-failed-file-attachment"
        onOpen={handleOpen}
        onRemove={handleRemove}
        openAccessibilityLabel={`Retry ${entry.file.fileName}: ${entry.errorMessage}`}
        removeAccessibilityLabel={`Remove ${entry.file.fileName}`}
        disabled={disabled}
      >
        <AttachmentLabel
          icon={filePillIcon}
          title={entry.file.fileName}
          subtitle={entry.errorMessage}
        />
      </AttachmentPill>
      <Text
        testID="composer-file-attachment-error"
        accessibilityRole="alert"
        selectable
        style={styles.sendErrorText}
      >
        {entry.errorMessage}
      </Text>
    </View>
  );
}

function ReviewableSubmissionAttachment({
  record,
  onInspect,
}: {
  record: SubmissionRecoveryRecord;
  onInspect: (record: SubmissionRecoveryRecord) => void;
}) {
  const handlePress = useCallback(() => onInspect(record), [onInspect, record]);
  const content = getSubmissionRecoveryPillContent(record);

  return (
    <AttachmentFrame
      testID="composer-submission-needs-review"
      onPress={handlePress}
      accessibilityLabel="Inspect retained submission checkpoint"
    >
      <AttachmentLabel icon={filePillIcon} title={content.title} subtitle={content.subtitle} />
    </AttachmentFrame>
  );
}

function UnresolvedSubmissionCheckpointAttachment({
  state,
}: {
  state: "checking" | "unavailable";
}) {
  const isChecking = state === "checking";
  return (
    <AttachmentFrame testID="composer-submission-checkpoint-unresolved">
      <AttachmentLabel
        icon={filePillIcon}
        title={isChecking ? "Checking submission checkpoint" : "Submission checkpoint unavailable"}
        subtitle={
          isChecking
            ? "This draft remains blocked until it is verified"
            : "Edit this draft to begin a new attempt"
        }
      />
    </AttachmentFrame>
  );
}

function renderAttachmentTray(args: RenderAttachmentTrayArgs): ReactElement | null {
  const {
    serverId,
    selectedAttachments,
    pendingFiles,
    failedFiles,
    reviewableSubmissions,
    unresolvedSubmissionCheckpoint,
    isComposerLocked,
    handleOpenAttachment,
    handleRemoveAttachment,
    handleRetryFailedFile,
    handleRemoveFailedFile,
    handleInspectSubmission,
    labels,
  } = args;
  if (
    selectedAttachments.length === 0 &&
    pendingFiles.length === 0 &&
    failedFiles.length === 0 &&
    reviewableSubmissions.length === 0 &&
    !unresolvedSubmissionCheckpoint
  ) {
    return null;
  }
  return (
    <View style={styles.attachmentTray} testID="composer-attachment-tray">
      {selectedAttachments.map((attachment, index) =>
        renderComposerAttachmentPill({
          serverId,
          attachment,
          index,
          disabled: isComposerLocked,
          onOpen: handleOpenAttachment,
          onRemove: handleRemoveAttachment,
          labels,
        }),
      )}
      {pendingFiles.map(({ id, file }) => (
        <AttachmentFrame key={id} testID="composer-pending-file-attachment">
          <AttachmentLabel
            icon={pendingFilePillIcon}
            title={file.fileName}
            subtitle={getFileTypeLabel(file.fileName) ?? ""}
          />
        </AttachmentFrame>
      ))}
      {failedFiles.map((entry) => (
        <FailedFileAttachmentPill
          key={`failed:${entry.id}`}
          entry={entry}
          disabled={isComposerLocked}
          onRetry={handleRetryFailedFile}
          onRemove={handleRemoveFailedFile}
        />
      ))}
      {reviewableSubmissions.map((record) => (
        <ReviewableSubmissionAttachment
          key={`submission-review:${record.id}`}
          record={record}
          onInspect={handleInspectSubmission}
        />
      ))}
      {unresolvedSubmissionCheckpoint ? (
        <UnresolvedSubmissionCheckpointAttachment state={unresolvedSubmissionCheckpoint} />
      ) : null}
    </View>
  );
}

interface RenderQueueTrackArgs {
  queuedMessages: readonly QueuedMessage[];
  handleEditQueuedMessage: (id: string) => void;
  handleSendQueuedNow: (id: string) => Promise<void>;
  editLabel: string;
  sendNowLabel: string;
}

function renderQueueTrack(args: RenderQueueTrackArgs): ReactElement | null {
  const { queuedMessages, handleEditQueuedMessage, handleSendQueuedNow, editLabel, sendNowLabel } =
    args;
  if (queuedMessages.length === 0) return null;
  return (
    <View style={styles.queueTrack}>
      {queuedMessages.map((item) => (
        <QueuedMessageRow
          key={item.id}
          item={item}
          onEdit={handleEditQueuedMessage}
          onSendNow={handleSendQueuedNow}
          editLabel={editLabel}
          sendNowLabel={sendNowLabel}
        />
      ))}
    </View>
  );
}

interface RenderComposerAttachmentPillArgs {
  serverId: string;
  attachment: ComposerAttachment;
  index: number;
  disabled: boolean;
  onOpen: (attachment: ComposerAttachment) => void;
  onRemove: (index: number) => void;
  labels: RenderAttachmentTrayArgs["labels"];
}

function renderComposerAttachmentPill(args: RenderComposerAttachmentPillArgs): ReactElement {
  const { attachment, index, disabled, onOpen, onRemove, labels } = args;
  if (attachment.kind === "image") {
    return (
      <ImageAttachmentPill
        key={attachment.metadata.id}
        attachment={attachment}
        index={index}
        disabled={disabled}
        onOpen={onOpen}
        onRemove={onRemove}
        openLabel={labels.openImage}
        removeLabel={labels.removeImage}
      />
    );
  }
  if (attachment.kind === "pasted_text") {
    return (
      <PastedTextAttachmentPill
        key={attachment.metadata.id}
        attachment={attachment}
        index={index}
        disabled={disabled}
        onOpen={onOpen}
        onRemove={onRemove}
      />
    );
  }
  if (attachment.kind === "file") {
    return (
      <FileAttachmentPill
        key={attachment.attachment.id}
        attachment={attachment}
        index={index}
        disabled={disabled}
        onRemove={onRemove}
        removeLabel={labels.removeFile}
      />
    );
  }
  if (attachment.kind === "workspace_file") {
    return (
      <WorkspaceFileAttachmentPill
        key={`workspace-file:${getWorkspaceFileAttachmentKey(attachment)}`}
        attachment={attachment}
        index={index}
        disabled={disabled}
        onRemove={onRemove}
        removeLabel={labels.removeFile}
      />
    );
  }
  if (composerWorkspaceAttachment.is(attachment)) {
    return composerWorkspaceAttachment.renderPill({
      attachment,
      index,
      disabled,
      onOpen,
      onRemove,
    });
  }
  if (attachment.kind === "plugin_resource") {
    return (
      <PluginResourceAttachmentPill
        serverId={args.serverId}
        key={`${attachment.pluginId}:${attachment.sourceId}:${attachment.item.id}`}
        attachment={attachment}
        index={index}
        disabled={disabled}
        onOpen={onOpen}
        onRemove={onRemove}
        openLabel={labels.openGithub}
        removeLabel={labels.removeGithub}
      />
    );
  }
  return (
    <GithubAttachmentPill
      key={`${attachment.item.kind}:${attachment.item.number}`}
      attachment={attachment}
      index={index}
      disabled={disabled}
      onOpen={onOpen}
      onRemove={onRemove}
      openLabel={labels.openGithub}
      removeLabel={labels.removeGithub}
    />
  );
}

function resolveErrorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return null;
}

interface AttemptStartRealtimeVoiceArgs {
  voice: ReturnType<typeof useVoiceOptional>;
  isConnected: boolean;
  hasAgent: boolean;
  serverId: string;
  agentId: string;
  toastErrorRef: { current: (message: string) => void };
}

function attemptStartRealtimeVoice(args: AttemptStartRealtimeVoiceArgs): void {
  const { voice, isConnected, hasAgent, serverId, agentId, toastErrorRef } = args;
  if (!voice || !isConnected || !hasAgent) return;
  if (voice.isVoiceSwitching) return;
  if (voice.isVoiceModeForAgent(serverId, agentId)) return;
  void voice.startVoice(serverId, agentId).catch((error) => {
    console.error("[Composer] Failed to start voice mode", error);
    const message = resolveErrorMessage(error);
    if (message && message.trim().length > 0) {
      toastErrorRef.current(message);
    }
  });
}

function focusMessageInputWithPlatformStrategy(messageInputRef: {
  current: MessageInputRef | null;
}): void {
  if (isNative) {
    messageInputRef.current?.focus();
    return;
  }
  focusWithRetries({
    focus: () => messageInputRef.current?.focus(),
    isFocused: () => {
      const el = messageInputRef.current?.getNativeElement?.() ?? null;
      const active = typeof document !== "undefined" ? document.activeElement : null;
      return Boolean(el) && active === el;
    },
  });
}

interface DispatchComposerKeyboardActionArgs {
  action: KeyboardActionDefinition;
  isPaneFocused: boolean;
  messageInputRef: { current: MessageInputRef | null };
  isAgentRunning: boolean;
  isCancellingAgent: boolean;
  isConnected: boolean;
  handleCancelAgent: () => void;
  focusMessageInputForKeyboardAction: () => void;
}

function dispatchComposerKeyboardAction(args: DispatchComposerKeyboardActionArgs): boolean {
  const {
    action,
    isPaneFocused,
    messageInputRef,
    isAgentRunning,
    isCancellingAgent,
    isConnected,
    handleCancelAgent,
    focusMessageInputForKeyboardAction,
  } = args;
  if (!isPaneFocused) return false;

  if (action.id === "agent.interrupt") {
    if (messageInputRef.current?.runKeyboardAction("dictation-cancel")) return true;
    if (!isAgentRunning || isCancellingAgent || !isConnected) return false;
    handleCancelAgent();
    return true;
  }

  if (action.id === "message-input.focus") {
    focusMessageInputForKeyboardAction();
    return true;
  }

  const passthroughAction = resolveMessageInputPassthroughAction(action.id);
  if (!passthroughAction) return false;
  const result = messageInputRef.current?.runKeyboardAction(passthroughAction);
  if (
    passthroughAction === "send" ||
    passthroughAction === "dictation-confirm" ||
    passthroughAction === "voice-mute-toggle"
  ) {
    return result ?? false;
  }
  return true;
}

function ComposerKeyboardRegistration({
  messageInputRef,
  isAgentRunning,
  isCancellingAgent,
  isConnected,
  handleCancelAgent,
  focusMessageInputForKeyboardAction,
  isMessageInputFocused,
  handlerId,
}: Omit<DispatchComposerKeyboardActionArgs, "action" | "isPaneFocused"> & {
  isMessageInputFocused: boolean;
  handlerId: string;
}) {
  const { isActiveComposer } = useComposerKeyboardScope();
  const handleKeyboardAction = useCallback(
    (action: KeyboardActionDefinition): boolean =>
      dispatchComposerKeyboardAction({
        action,
        isPaneFocused: isActiveComposer,
        messageInputRef,
        isAgentRunning,
        isCancellingAgent,
        isConnected,
        handleCancelAgent,
        focusMessageInputForKeyboardAction,
      }),
    [
      focusMessageInputForKeyboardAction,
      handleCancelAgent,
      isActiveComposer,
      isAgentRunning,
      isCancellingAgent,
      isConnected,
      messageInputRef,
    ],
  );

  useKeyboardActionHandler({
    handlerId,
    actions: [
      "agent.interrupt",
      "message-input.focus",
      "message-input.send",
      "message-input.dictation-toggle",
      "message-input.dictation-cancel",
      "message-input.dictation-confirm",
      "message-input.voice-toggle",
      "message-input.voice-mute-toggle",
    ],
    enabled: isActiveComposer,
    priority: resolveKeyboardPriority(isMessageInputFocused),
    isActive: () => isActiveComposer,
    handle: handleKeyboardAction,
  });
  return null;
}

function ComposerAutocomplete(props: React.ComponentProps<typeof AutocompletePopover>) {
  const { isActiveComposer } = useComposerKeyboardScope();
  return <AutocompletePopover {...props} visible={isActiveComposer && props.visible} />;
}

function resolveMessageInputPassthroughAction(
  actionId: string,
): MessageInputKeyboardActionKind | null {
  switch (actionId) {
    case "message-input.send":
      return "send";
    case "message-input.dictation-confirm":
      return "dictation-confirm";
    case "message-input.dictation-toggle":
      return "dictation-toggle";
    case "message-input.dictation-cancel":
      return "dictation-cancel";
    case "message-input.voice-toggle":
      return "voice-toggle";
    case "message-input.voice-mute-toggle":
      return "voice-mute-toggle";
    default:
      return null;
  }
}

interface QueuedMessageRowProps {
  item: QueuedMessage;
  onEdit: (id: string) => void;
  onSendNow: (id: string) => void;
  editLabel: string;
  sendNowLabel: string;
}

function QueuedMessageRow({
  item,
  onEdit,
  onSendNow,
  editLabel,
  sendNowLabel,
}: QueuedMessageRowProps) {
  const handleEdit = useCallback(() => {
    onEdit(item.id);
  }, [onEdit, item.id]);
  const handleSendNow = useCallback(() => {
    onSendNow(item.id);
  }, [onSendNow, item.id]);
  return (
    <View style={styles.queueItem}>
      <Text style={styles.queueText} numberOfLines={2} ellipsizeMode="tail">
        {item.text}
      </Text>
      <View style={styles.queueActions}>
        <Pressable
          onPress={handleEdit}
          style={styles.queueActionButton}
          accessibilityLabel={editLabel}
          accessibilityRole="button"
        >
          <ThemedPencil size={ICON_SIZE.sm} uniProps={iconForegroundMapping} />
        </Pressable>
        <Pressable
          onPress={handleSendNow}
          style={[styles.queueActionButton, styles.queueSendButton]}
          accessibilityLabel={sendNowLabel}
          accessibilityRole="button"
        >
          <ThemedArrowUp size={ICON_SIZE.sm} uniProps={iconAccentForegroundMapping} />
        </Pressable>
      </View>
    </View>
  );
}

interface ImageAttachmentPillProps {
  attachment: Extract<ComposerAttachment, { kind: "image" }>;
  index: number;
  disabled: boolean;
  onOpen: (attachment: ComposerAttachment) => void;
  onRemove: (index: number) => void;
  openLabel: string;
  removeLabel: string;
}

function ImageAttachmentPill({
  attachment,
  index,
  disabled,
  onOpen,
  onRemove,
  openLabel,
  removeLabel,
}: ImageAttachmentPillProps) {
  const handleOpen = useCallback(() => {
    onOpen(attachment);
  }, [onOpen, attachment]);
  const handleRemove = useCallback(() => {
    onRemove(index);
  }, [onRemove, index]);
  return (
    <AttachmentPill
      testID="composer-image-attachment-pill"
      onOpen={handleOpen}
      onRemove={handleRemove}
      openAccessibilityLabel={openLabel}
      removeAccessibilityLabel={removeLabel}
      disabled={disabled}
    >
      <AttachmentThumbnail metadata={attachment.metadata} />
    </AttachmentPill>
  );
}

interface GithubAttachmentPillProps {
  attachment: Extract<
    ComposerAttachment,
    { kind: "forge_change_request" | "forge_issue" | "github_pr" | "github_issue" }
  >;
  index: number;
  disabled: boolean;
  onOpen: (attachment: ComposerAttachment) => void;
  onRemove: (index: number) => void;
  openLabel: (kind: string, numberLabel: string) => string;
  removeLabel: (kind: string, numberLabel: string) => string;
}

function GithubAttachmentPill({
  attachment,
  index,
  disabled,
  onOpen,
  onRemove,
  openLabel,
  removeLabel,
}: GithubAttachmentPillProps) {
  const item = attachment.item;
  const presentation = getForgePresentation(item.forge ?? "github");
  const isChangeRequest = item.kind === "change_request";
  const kindLabel = isChangeRequest ? presentation.changeRequestAbbrev : "issue";
  const subtitleKind = isChangeRequest ? presentation.changeRequestAbbrev : "Issue";
  const numberPrefix = isChangeRequest ? presentation.numberPrefix : presentation.issueNumberPrefix;
  const handleOpen = useCallback(() => {
    onOpen(attachment);
  }, [onOpen, attachment]);
  const handleRemove = useCallback(() => {
    onRemove(index);
  }, [onRemove, index]);
  return (
    <AttachmentPill
      testID="composer-github-attachment-pill"
      onOpen={handleOpen}
      onRemove={handleRemove}
      openAccessibilityLabel={openLabel(kindLabel, `${numberPrefix}${item.number}`)}
      removeAccessibilityLabel={removeLabel(kindLabel, `${numberPrefix}${item.number}`)}
      disabled={disabled}
    >
      <AttachmentLabel
        icon={isChangeRequest ? githubPrPillIcon : githubIssuePillIcon}
        title={item.title}
        subtitle={`${subtitleKind} ${numberPrefix}${item.number}`}
      />
    </AttachmentPill>
  );
}

interface PastedTextAttachmentPillProps {
  attachment: Extract<ComposerAttachment, { kind: "pasted_text" }>;
  index: number;
  disabled: boolean;
  onOpen: (attachment: ComposerAttachment) => void;
  onRemove: (index: number) => void;
}

function PastedTextAttachmentPill({
  attachment,
  index,
  disabled,
  onOpen,
  onRemove,
}: PastedTextAttachmentPillProps) {
  const handleOpen = useCallback(() => {
    onOpen(attachment);
  }, [attachment, onOpen]);
  const handleRemove = useCallback(() => {
    onRemove(index);
  }, [index, onRemove]);
  return (
    <AttachmentPill
      testID="composer-pasted-text-attachment-pill"
      onOpen={handleOpen}
      onRemove={handleRemove}
      openAccessibilityLabel="Inspect pasted text"
      removeAccessibilityLabel="Remove pasted text"
      disabled={disabled}
    >
      <AttachmentLabel
        icon={filePillIcon}
        title="Pasted text"
        subtitle={`${attachment.codePointCount.toLocaleString()} characters · ${attachment.logicalLineCount.toLocaleString()} lines`}
      />
    </AttachmentPill>
  );
}

interface FileAttachmentPillProps {
  attachment: Extract<ComposerAttachment, { kind: "file" }>;
  index: number;
  disabled: boolean;
  onRemove: (index: number) => void;
  removeLabel: string;
}

function FileAttachmentPill({
  attachment,
  index,
  disabled,
  onRemove,
  removeLabel,
}: FileAttachmentPillProps) {
  const { t } = useTranslation();
  const handleRemove = useCallback(() => {
    onRemove(index);
  }, [onRemove, index]);
  const fileName = attachment.attachment.fileName;
  return (
    <AttachmentPill
      testID="composer-file-attachment-pill"
      onOpen={noopCallback}
      onRemove={handleRemove}
      openAccessibilityLabel={fileName}
      removeAccessibilityLabel={removeLabel}
      disabled={disabled}
    >
      <AttachmentLabel
        icon={filePillIcon}
        title={fileName}
        subtitle={getFileTypeLabel(fileName) ?? t("message.attachments.file")}
      />
    </AttachmentPill>
  );
}

interface WorkspaceFileAttachmentPillProps {
  attachment: WorkspaceFileComposerAttachment;
  index: number;
  disabled: boolean;
  onRemove: (index: number) => void;
  removeLabel: string;
}

function WorkspaceFileAttachmentPill({
  attachment,
  index,
  disabled,
  onRemove,
  removeLabel,
}: WorkspaceFileAttachmentPillProps) {
  const handleRemove = useCallback(() => {
    onRemove(index);
  }, [index, onRemove]);
  const fileName = attachment.path.split("/").pop() ?? attachment.path;
  return (
    <AttachmentPill
      testID="composer-workspace-file-attachment-pill"
      onOpen={noopCallback}
      onRemove={handleRemove}
      openAccessibilityLabel={fileName}
      removeAccessibilityLabel={removeLabel}
      disabled={disabled}
    >
      <AttachmentLabel
        icon={filePillIcon}
        title={fileName}
        subtitle={getWorkspaceFileAttachmentSubtitle(attachment)}
      />
    </AttachmentPill>
  );
}

interface GithubPickerOptionProps {
  label: string;
  testID: string;
  active: boolean;
  selected: boolean;
  item: ForgeSearchItem;
  onToggle: (item: ForgeSearchItem) => void;
}

function GithubPickerOption({
  label,
  testID,
  active,
  selected,
  item,
  onToggle,
}: GithubPickerOptionProps) {
  const handlePress = useCallback(() => {
    onToggle(item);
  }, [onToggle, item]);
  const leadingSlot = useMemo(
    () =>
      item.kind === "change_request" ? (
        <ThemedGitPullRequest size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
      ) : (
        <ThemedCircleDot size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
      ),
    [item.kind],
  );
  return (
    <ComboboxItem
      testID={testID}
      label={label}
      selected={selected}
      active={active}
      onPress={handlePress}
      leadingSlot={leadingSlot}
    />
  );
}

interface ComposerProps {
  agentId: string;
  serverId: string;
  workspaceId?: string | null;
  isPaneFocused: boolean;
  onSubmitMessage?: (payload: MessagePayload) => Promise<void>;
  onClientSlashCommand?: (command: ClientSlashCommand) => Promise<void>;
  /** When true, the submit button is enabled even without text or images (e.g. external attachment selected). */
  hasExternalContent?: boolean;
  /** When true, the composer can submit even with no text or attachments. */
  allowEmptySubmit?: boolean;
  /** Optional accessibility label for the primary submit button. */
  submitButtonAccessibilityLabel?: string;
  /** Optional testID for the primary submit button. */
  submitButtonTestID?: string;
  submitIcon?: "arrow" | "return";
  /** Externally controlled loading state. When true, disables the submit button. */
  isSubmitLoading?: boolean;
  /** When true, waits for pasted forge links to resolve before enabling submit. */
  waitForForgeAutoAttachOnSubmit?: boolean;
  submitBehavior?: "clear" | "preserve-and-lock";
  /** When true, blurs the input immediately when submitting. */
  blurOnSubmit?: boolean;
  textSource: ComposerTextSource;
  onChangeText: (text: string) => void;
  textReplacement: TextReplacement;
  attachments: UserComposerAttachment[];
  attachmentScopeKeys?: readonly string[];
  onOpenWorkspaceAttachment?: (attachment: WorkspaceComposerAttachment) => void;
  onChangeAttachments: (updater: AttachmentListUpdater) => void;
  onForgeChangeRequestDetected?: () => void;
  onForgeChangeRequestAutoAttach?: (item: ForgeSearchItem) => void;
  cwd: string;
  clearDraft: (lifecycle: "sent" | "abandoned") => void;
  /** Optional persisted draft owner for durable submission recovery binding. */
  submissionBinding?: DraftSubmissionBinding;
  submissionSnapshot?: DraftSubmissionSnapshot | null;
  /** When true, auto-focuses the text input on web. */
  autoFocus?: boolean;
  /** Changing this value requests focus again while autoFocus remains true. */
  autoFocusKey?: string;
  /** Callback to expose a focus function to parent components (desktop only). */
  onFocusInput?: (focus: () => void) => void;
  /** Draft context for listing commands before an agent exists. Omitted for running agents. */
  commandDraft?: DraftCommandTarget;
  /** Called when a message is about to be sent (any path: keyboard, dictation, queued). */
  onMessageSent?: () => void;
  onComposerHeightChange?: (height: number) => void;
  onAttentionInputFocus?: () => void;
  onAttentionPromptSend?: () => void;
  /** Controlled agent controls rendered in input area (draft flows). */
  agentControls?: DraftAgentControlsProps;
  /** Extra styles merged onto the message input wrapper (e.g. elevated background). */
  inputWrapperStyle?: import("react-native").ViewStyle;
  /** Optional panel/container layout breakpoint. Defaults to the screen breakpoint. */
  isCompactLayout?: boolean;
  /**
   * What this composer is for. Terminal drops the chat-agent affordances and
   * uses the terminal font; see `@/composer/input-mode`. Callers set the mode
   * and nothing else — never branch on it at the call site.
   */
  inputMode?: ComposerInputMode;
  /** Renders the current text as static text on the same surface, for content there is nothing to type into. */
  readOnly?: boolean;
  /** Replaces the submit icon with this label, still inside the composer's own toolbar row. */
  submitLabel?: string;
  /** Overrides the mode's default placeholder, for text only the caller can build. */
  placeholder?: string;
  /**
   * The host that also lays out the dock and chrome shares this session so its
   * fullscreen state and the composer's agree. Defaults to the tab's session for
   * `inputMode`.
   */
  editingSession?: ComposerEditingSession;
}

const EMPTY_ARRAY: readonly QueuedMessage[] = [];
const StableMessageInput = memo(MessageInput);

interface ComposerAutocompleteHandle {
  onKeyPress: (event: ComposerKeyPressEvent) => boolean;
}

function ComposerAutocompleteBinding({
  text,
  cursor,
  recall,
  configuration,
  inputRef,
  children,
  anchorStyle,
  show,
  ref,
}: {
  text: ComposerTextSource;
  cursor: StoreApi<number>;
  recall: ComposerRecall;
  configuration: Omit<
    Parameters<typeof useAgentAutocomplete>[0],
    "userInput" | "cursorIndex" | "onAutocompleteApplied"
  >;
  inputRef: React.RefObject<MessageInputRef | null>;
  children: React.ReactNode;
  anchorStyle: React.ComponentProps<typeof View>["style"];
  show: boolean;
  ref: React.Ref<ComposerAutocompleteHandle>;
}) {
  const userInput = useSyncExternalStore(text.subscribe, text.getSnapshot, text.getSnapshot);
  const cursorIndex = useStore(cursor);
  const autocomplete = useAgentAutocomplete({
    ...configuration,
    userInput,
    cursorIndex: Math.min(cursorIndex, userInput.length),
    onAutocompleteApplied: () => inputRef.current?.focus(),
  });
  // A recalled message is sent as is; its leading `/command` must not open the picker.
  const isShown = show && !recall.isShowing(userInput);
  const handleKeyPress = autocomplete.onKeyPress;
  useImperativeHandle(ref, () => ({ onKeyPress: (event) => isShown && handleKeyPress(event) }), [
    isShown,
    handleKeyPress,
  ]);
  const selectOption = autocomplete.onSelectOption;
  const onSelect = useCallback(
    (option: AutocompleteOption) => selectOption(option, inputRef.current?.getInputSnapshot()),
    [selectOption, inputRef],
  );
  return (
    <ComposerAutocomplete
      visible={autocomplete.isVisible && isShown}
      anchorStyle={anchorStyle}
      options={autocomplete.options}
      selectedIndex={autocomplete.selectedIndex}
      onSelect={onSelect}
      isLoading={autocomplete.isLoading}
      errorMessage={autocomplete.errorMessage}
      loadingText={autocomplete.loadingText}
      emptyText={autocomplete.emptyText}
    >
      {children}
    </ComposerAutocomplete>
  );
}

function ComposerForgeBinding({
  text,
  configuration,
  ref,
  onResolvingChange,
}: {
  text: ComposerTextSource;
  configuration: Omit<Parameters<typeof useComposerForgeAutoAttach>[0], "text">;
  ref: React.Ref<ReturnType<typeof useComposerForgeAutoAttach>>;
  onResolvingChange: (resolving: boolean) => void;
}) {
  const value = useSyncExternalStore(text.subscribe, text.getSnapshot, text.getSnapshot);
  const binding = useComposerForgeAutoAttach({ ...configuration, text: value });
  useImperativeHandle(ref, () => binding, [binding]);
  useLayoutEffect(
    () => onResolvingChange(binding.isResolving),
    [binding.isResolving, onResolvingChange],
  );
  return null;
}

interface ComposerCancelButtonProps {
  buttonIconSize: number;
  cancelButtonStyle: (object | undefined)[];
  handleCancelAgent: () => void;
  isConnected: boolean;
  isCancellingAgent: boolean;
  agentInterruptKeys: ReturnType<typeof useShortcutKeys>;
  t: TFunction;
}

function ComposerCancelButton({
  buttonIconSize,
  cancelButtonStyle,
  handleCancelAgent,
  isConnected,
  isCancellingAgent,
  agentInterruptKeys,
  t,
}: ComposerCancelButtonProps) {
  const accessibilityLabel = isCancellingAgent
    ? t("composer.cancel.cancelingAgent")
    : t("composer.cancel.stopAgent");
  const icon = isCancellingAgent ? (
    <LoadingSpinner size="small" color="white" />
  ) : (
    <Square size={buttonIconSize} color="white" fill="white" />
  );
  const shortcutNode = agentInterruptKeys ? <Shortcut chord={agentInterruptKeys} /> : null;
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        onPress={handleCancelAgent}
        disabled={!isConnected || isCancellingAgent}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        style={cancelButtonStyle}
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <View style={styles.tooltipRow}>
          <Text style={styles.tooltipText}>{t("composer.cancel.interrupt")}</Text>
          {shortcutNode}
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

interface ComposerVoiceModeButtonProps {
  buttonIconSize: number;
  handleToggleRealtimeVoice: () => void;
  isConnected: boolean;
  isVoiceSwitching: boolean;
  realtimeVoiceButtonStyle: (
    state: PressableStateCallbackType & { hovered?: boolean },
  ) => (object | undefined)[];
  voiceToggleKeys: ReturnType<typeof useShortcutKeys>;
  t: TFunction;
}

interface ComposerRightControlsSlotProps extends ComposerVoiceModeButtonProps {
  isVoiceModeForAgent: boolean;
  hasAgent: boolean;
  isAgentRunning: boolean;
  hasSendableContent: boolean;
  isCompact: boolean;
  showVoice: boolean;
}

function ComposerRightControlsSlot({
  isVoiceModeForAgent,
  hasAgent,
  isAgentRunning,
  hasSendableContent,
  isCompact,
  showVoice,
  ...voiceProps
}: ComposerRightControlsSlotProps) {
  const hideVoiceForCompactInput = isCompact && hasSendableContent;
  const showVoiceModeButton =
    showVoice && !isVoiceModeForAgent && hasAgent && !isAgentRunning && !hideVoiceForCompactInput;
  if (!showVoiceModeButton) return null;
  return (
    <View style={styles.rightControls}>
      <ComposerVoiceModeButton {...voiceProps} />
    </View>
  );
}

function ComposerVoiceModeButton({
  buttonIconSize,
  handleToggleRealtimeVoice,
  isConnected,
  isVoiceSwitching,
  realtimeVoiceButtonStyle,
  voiceToggleKeys,
  t,
}: ComposerVoiceModeButtonProps) {
  const shortcutNode = voiceToggleKeys ? <Shortcut chord={voiceToggleKeys} /> : null;
  const renderTriggerContent = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => {
      if (isVoiceSwitching) {
        return <LoadingSpinner size="small" color="white" />;
      }
      const colorMapping = hovered ? iconForegroundMapping : iconForegroundMutedMapping;
      return <ThemedAudioLines size={buttonIconSize} uniProps={colorMapping} />;
    },
    [buttonIconSize, isVoiceSwitching],
  );
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        onPress={handleToggleRealtimeVoice}
        disabled={!isConnected || isVoiceSwitching}
        accessibilityLabel={t("composer.voice.enableVoiceMode")}
        accessibilityRole="button"
        style={realtimeVoiceButtonStyle}
      >
        {renderTriggerContent}
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <View style={styles.tooltipRow}>
          <Text style={styles.tooltipText}>{t("composer.voice.voiceMode")}</Text>
          {shortcutNode}
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

export function Composer({ isPaneFocused, ...props }: ComposerProps) {
  // A compact overlay panel (agent list, explorer) covers the pane without taking its
  // focus. The composer gives up input from the moment the user asks for the panel,
  // not when its motion settles, so the exit action and autocomplete never race it.
  // Pane focus stays put, so the keyboard the panel dismisses is a blur in the
  // user's own pane: closing the panel does not bring focus back.
  const isCompact = useIsCompactFormFactor();
  const overlayPanelRequested = usePanelStore((state) => state.mobilePanel.target !== "agent");
  const coveredByOverlayPanel = isCompact && overlayPanelRequested;
  return (
    <ComposerKeyboardScopeProvider
      isPaneFocused={isPaneFocused}
      isActiveComposer={isPaneFocused && !coveredByOverlayPanel}
    >
      <RenderProfile id="ComposerContent">
        <ComposerContent {...props} />
      </RenderProfile>
    </ComposerKeyboardScopeProvider>
  );
}

type ComposerContentProps = Omit<ComposerProps, "isPaneFocused">;

const ComposerContent = memo(ComposerContentImpl);

// oxlint-disable-next-line complexity
function ComposerContentImpl({
  agentId,
  serverId,
  workspaceId,
  onSubmitMessage,
  onClientSlashCommand,
  hasExternalContent = false,
  allowEmptySubmit = false,
  submitButtonAccessibilityLabel,
  submitButtonTestID,
  submitIcon = "arrow",
  isSubmitLoading = false,
  waitForForgeAutoAttachOnSubmit = false,
  submitBehavior = "clear",
  blurOnSubmit = false,
  textSource,
  onChangeText,
  textReplacement,
  attachments,
  attachmentScopeKeys = EMPTY_ATTACHMENT_SCOPE_KEYS,
  onOpenWorkspaceAttachment,
  onChangeAttachments,
  onForgeChangeRequestDetected,
  onForgeChangeRequestAutoAttach,
  cwd,
  clearDraft,
  submissionBinding,
  submissionSnapshot = null,
  autoFocus = false,
  autoFocusKey,
  onFocusInput,
  commandDraft,
  onMessageSent,
  onComposerHeightChange,
  onAttentionInputFocus,
  onAttentionPromptSend,
  agentControls,
  inputWrapperStyle,
  isCompactLayout: isCompactLayoutOverride,
  inputMode = "chat",
  editingSession: providedEditingSession,
  readOnly = false,
  submitLabel,
  placeholder,
}: ComposerContentProps) {
  const mode = resolveComposerInputMode(inputMode);
  const { t } = useTranslation();
  const buttonIconSize = resolveComposerButtonIconSize();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const agentDirectoryStatus = useHostRuntimeAgentDirectoryStatus(serverId);
  const toast = useToast();
  const toastErrorRef = useRef(toast.error);
  toastErrorRef.current = toast.error;
  const voice = useVoiceOptional();
  const voiceToggleKeys = useShortcutKeys("voice-toggle");
  const agentInterruptKeys = useShortcutKeys("agent-interrupt");
  const isDictationReady = useIsDictationReady({
    serverId,
    isConnected,
    agentDirectoryStatus,
  });

  const { settings: appSettings } = useAppSettings();

  const agentState = useSessionStore(useShallow(buildAgentStateSelector(serverId, agentId)));

  const queuedMessagesRaw = useSessionStore((state) =>
    state.sessions[serverId]?.queuedMessages?.get(agentId),
  );
  const queuedMessages = queuedMessagesRaw ?? EMPTY_ARRAY;

  const setQueuedMessages = useSessionStore((state) => state.setQueuedMessages);

  const isCompactFormFactor = useIsCompactFormFactor();
  const isCompactLayout = resolveCompactLayout(isCompactLayoutOverride, isCompactFormFactor);
  const isDesktopWebBreakpoint = resolveIsDesktopWebBreakpoint(isCompactFormFactor);
  const hasFinePointer = useHasFinePointer();
  const isDesktopLayout = resolveIsDesktopWebBreakpoint(isCompactLayout);
  const messagePlaceholder = resolveMessagePlaceholder(inputMode, isDesktopLayout, t, placeholder);
  const currentDraftText = useSyncExternalStore(
    textSource.subscribe,
    textSource.getSnapshot,
    textSource.getSnapshot,
  );
  const hasText = currentDraftText.trim().length > 0;
  const setUserInput = onChangeText;
  const workspaceAttachments = useWorkspaceAttachmentsForScopes(attachmentScopeKeys);
  const attachmentScopeIdentity = attachmentScopeKeys.join("\u0000");
  const attachmentScopeIdentityRef = useRef(attachmentScopeIdentity);
  attachmentScopeIdentityRef.current = attachmentScopeIdentity;
  const {
    selectedAttachments,
    buildOutgoingAttachments,
    removeAttachment,
    openAttachment,
    beginSubmit,
    clearSentAttachments,
    completeSubmit,
    resetSuppression,
  } = composerWorkspaceAttachment.useBinding({
    normalAttachments: attachments,
    workspaceAttachments,
    onOpenWorkspaceAttachment,
  });
  const setSelectedAttachments = onChangeAttachments;
  const selectedAttachmentsRef = useRef(selectedAttachments);
  useEffect(() => {
    selectedAttachmentsRef.current = selectedAttachments;
  }, [selectedAttachments]);
  const checkoutStatusQuery = useCheckoutStatusQuery({ serverId, cwd });
  const supportsForgeSearch = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.forgeSearch === true,
  );
  const forgeAutoAttachRef = useRef<ReturnType<typeof useComposerForgeAutoAttach>>(null);
  const [isForgeResolving, setIsForgeResolving] = useState(false);
  const forgeConfiguration = useMemo(
    () => ({
      remoteUrl: resolveCheckoutRemoteUrl(checkoutStatusQuery.status),
      attachments,
      client,
      isConnected,
      serverId,
      cwd,
      supportsForgeSearch,
      setAttachments: setSelectedAttachments,
      onChangeRequestDetected: onForgeChangeRequestDetected,
      onChangeRequestAdded: onForgeChangeRequestAutoAttach,
    }),
    [
      checkoutStatusQuery.status,
      attachments,
      client,
      isConnected,
      serverId,
      cwd,
      supportsForgeSearch,
      setSelectedAttachments,
      onForgeChangeRequestDetected,
      onForgeChangeRequestAutoAttach,
    ],
  );
  const cursor = useMemo(() => createStore<number>(() => 0), []);
  const cursorPublication = useMemo(
    () => new AfterPaintPublication<number>((position) => cursor.setState(position)),
    [cursor],
  );
  useEffect(() => () => cursorPublication.cancel(), [cursorPublication]);
  const autocompleteRef = useRef<ComposerAutocompleteHandle>(null);
  const recall = useMemo(() => new ComposerRecall(), []);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPreparingSubmission, setIsPreparingSubmission] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFileAttachment[]>([]);
  const [failedFiles, setFailedFiles] = useState<FailedFileAttachment[]>([]);
  const nextPendingFileId = useRef(0);
  const pendingAttachmentReferenceOwnersRef = useRef(new Set<string>());
  const [pendingNativeImagePastes, setPendingNativeImagePastes] = useState(0);
  const [pendingWebPastes, setPendingWebPastes] = useState(0);
  const editingSession = useComposerEditingSession(inputMode, providedEditingSession);
  const isFullscreen = useComposerFullscreen(editingSession);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isMessageInputFocused, setIsMessageInputFocused] = useState(false);
  const [isGithubPickerOpen, setIsGithubPickerOpen] = useState(false);
  const [githubSearchQuery, setGithubSearchQuery] = useState("");
  const [lightboxMetadata, setLightboxMetadata] = useState<AttachmentMetadata | null>(null);
  const [pastedTextInspectorTarget, setPastedTextInspectorTarget] =
    useState<PastedTextInspectorTarget | null>(null);
  const [submissionRecoveryRecords, setSubmissionRecoveryRecords] = useState<
    SubmissionRecoveryRecord[]
  >([]);
  const [recoveryInspectionState, setRecoveryInspectionState] =
    useState<RecoveryInspectionState>("loading");
  const recoveryInspectionEpochRef = useRef(0);
  const [submissionRecoveryInspectorTarget, setSubmissionRecoveryInspectorTarget] =
    useState<SubmissionRecoveryRecord | null>(null);
  const attachButtonRef = useRef<View | null>(null);
  const messageInputRef = useRef<MessageInputRef>(null);
  const composerOwnerIdentity = createComposerOwnerIdentity({
    serverId,
    agentId,
    workspaceId,
    cwd,
  });
  const composerOwnerRef = useRef<ComposerOwnerSnapshot>({
    identity: composerOwnerIdentity,
    epoch: 0,
  });
  if (composerOwnerRef.current.identity !== composerOwnerIdentity) {
    composerOwnerRef.current = {
      identity: composerOwnerIdentity,
      epoch: composerOwnerRef.current.epoch + 1,
    };
  }
  const composerOwner = composerOwnerRef.current;
  const boundSubmissionRecovery = useMemo(
    () =>
      findBoundSubmissionRecovery({
        records: submissionRecoveryRecords,
        owner: composerOwner,
        snapshot: submissionSnapshot,
      }),
    [composerOwner, submissionRecoveryRecords, submissionSnapshot],
  );
  const unresolvedSubmissionCheckpoint = useMemo<"checking" | "unavailable" | null>(() => {
    if (!submissionSnapshot?.submissionCheckpointId) return null;
    if (recoveryInspectionState === "loading") return "checking";
    if (recoveryInspectionState === "error" || !boundSubmissionRecovery) {
      return "unavailable";
    }
    return null;
  }, [boundSubmissionRecovery, recoveryInspectionState, submissionSnapshot]);
  const reviewableSubmissions = useMemo(() => {
    const queuedIds = new Set(queuedMessages.map(getQueuedClientMessageId));
    const unresolved = selectReviewableComposerSubmissions({
      records: submissionRecoveryRecords,
      serverId,
      agentId,
    }).filter((record) => record.state !== "queued" || !queuedIds.has(record.id));
    const acceptedBoundSubmission =
      boundSubmissionRecovery?.state === "settled" ? [boundSubmissionRecovery] : [];
    return [...unresolved, ...acceptedBoundSubmission];
  }, [agentId, boundSubmissionRecovery, queuedMessages, serverId, submissionRecoveryRecords]);
  const pendingFilesForCurrentOwner = useMemo(
    () => pendingFiles.filter((entry) => entry.ownerIdentity === composerOwner.identity),
    [composerOwner.identity, pendingFiles],
  );
  const failedFilesForCurrentOwner = useMemo(
    () => failedFiles.filter((entry) => entry.ownerIdentity === composerOwner.identity),
    [composerOwner.identity, failedFiles],
  );
  const isUploadingFile = pendingFilesForCurrentOwner.length > 0;
  // React state does not synchronously disable a second pointer/key event. Keep
  // the preparation/send ownership in a ref so two same-tick sends cannot mint
  // two durable message identities for one visible snapshot.
  const submissionInFlightOwnersRef = useRef(new Set<string>());
  // A previous target can finish preparing after navigation. Track ownership
  // separately from the rendered loading flag so its cleanup cannot turn off
  // the indicator for a newer target's submission.
  const preparingSubmissionOwnersRef = useRef(new Set<string>());
  const pendingWebPasteOperationsRef = useRef(0);
  useEffect(() => {
    setIsPreparingSubmission(preparingSubmissionOwnersRef.current.has(composerOwner.identity));
  }, [composerOwner.identity]);
  const refreshReviewableSubmissions = useCallback(async () => {
    const epoch = recoveryInspectionEpochRef.current + 1;
    recoveryInspectionEpochRef.current = epoch;
    setRecoveryInspectionState("loading");
    try {
      const records = await getSubmissionRecoveryStore().list();
      if (recoveryInspectionEpochRef.current !== epoch) return;
      setSubmissionRecoveryRecords(records);
      setRecoveryInspectionState("ready");
    } catch (error) {
      // Recovery hydration is inspection only. It must never dispatch a
      // persisted record. A bound draft cannot safely mint a replacement
      // identity until its exact checkpoint can be verified.
      if (recoveryInspectionEpochRef.current !== epoch) return;
      console.warn("[Composer] Failed to inspect recoverable submissions", error);
      setRecoveryInspectionState("error");
    }
  }, []);
  useEffect(() => {
    void refreshReviewableSubmissions();
    return () => {
      // Ignore a late initial listing after this composer has unmounted.
      recoveryInspectionEpochRef.current += 1;
    };
  }, [refreshReviewableSubmissions]);
  useEffect(() => {
    const now = Date.now();
    let nextDispatchExpiry: number | null = null;
    for (const record of submissionRecoveryRecords) {
      const expiry = record.state === "dispatching" ? record.lease?.expiresAt : undefined;
      if (expiry === undefined || expiry <= now) continue;
      nextDispatchExpiry =
        nextDispatchExpiry === null ? expiry : Math.min(nextDispatchExpiry, expiry);
    }
    if (nextDispatchExpiry === null) return;

    // A reload must expose a lease once it becomes stale, but inspection
    // never claims, mutates, or replays the record. The retained dispatch
    // fence remains available for a late acknowledgement from its owner.
    const timeout = setTimeout(
      () => {
        void refreshReviewableSubmissions();
      },
      nextDispatchExpiry - now + 1,
    );
    return () => clearTimeout(timeout);
  }, [refreshReviewableSubmissions, submissionRecoveryRecords]);
  const pluginAttachments = usePluginAttachmentPicker({
    serverId,
    client,
    connected: isConnected,
    attachments,
    onChangeAttachments: setSelectedAttachments,
    anchorRef: attachButtonRef,
  });
  const pluginClientSlashCommands = usePluginClientSlashCommands({
    serverId,
    workspaceId,
    agentId,
  });
  const isComposerLocked = resolveIsComposerLocked(submitBehavior, isSubmitLoading);
  const keyboardHandlerIdRef = useRef(
    `message-input:${serverId}:${agentId}:${Math.random().toString(36).slice(2)}`,
  );

  const replaceUserInput = useCallback(
    (text: string, selection?: { start: number; end: number }) => {
      if (messageInputRef.current) {
        messageInputRef.current.replaceText(text, selection);
        return;
      }
      onChangeText(text);
    },
    [onChangeText],
  );

  const runClientSlashCommand = useCallback(
    (command: ClientSlashCommand): boolean => {
      if (command.execution !== "immediate" || !onClientSlashCommand) {
        return false;
      }

      if (blurOnSubmit) {
        messageInputRef.current?.blur();
      }
      clearDraft("sent");
      replaceUserInput("");
      setSelectedAttachments([]);
      resetSuppression();
      setSendError(null);
      setIsProcessing(true);
      void onClientSlashCommand(command)
        .catch((error) => {
          console.error("[Composer] Failed to run client slash command:", error);
          setSendError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          setIsProcessing(false);
        });
      return true;
    },
    [
      blurOnSubmit,
      clearDraft,
      onClientSlashCommand,
      resetSuppression,
      setSelectedAttachments,
      replaceUserInput,
    ],
  );

  const runPluginClientSlashCommand = useCallback(
    (resolved: { command: (typeof pluginClientSlashCommands)[number]; args: string }): boolean => {
      if (blurOnSubmit) messageInputRef.current?.blur();
      clearDraft("sent");
      replaceUserInput("");
      setSelectedAttachments([]);
      resetSuppression();
      setSendError(null);
      executePluginClientSlashCommand({
        command: resolved.command,
        args: resolved.args,
        onError(error) {
          console.error("[Composer] Failed to run plugin client slash command:", error);
          toastErrorRef.current(error instanceof Error ? error.message : String(error));
        },
      });
      return true;
    },
    [blurOnSubmit, clearDraft, replaceUserInput, resetSuppression, setSelectedAttachments],
  );

  const { pickImages } = useImageAttachmentPicker();
  const { pickFiles } = useFilePicker();
  const agentIdRef = useRef(agentId);

  const addImages = useCallback(
    (images: ImageAttachment[]) => {
      setSelectedAttachments((prev) => [
        ...prev,
        ...images.map((metadata) => ({ kind: "image" as const, metadata })),
      ]);
    },
    [setSelectedAttachments],
  );

  const captureComposerSubmissionOrigin = useCallback(
    (): ComposerSubmissionOrigin => ({
      owner: composerOwner,
      clearDraft,
      onChangeAttachments,
      onChangeText,
      textSource,
      submissionBinding,
    }),
    [clearDraft, composerOwner, onChangeAttachments, onChangeText, submissionBinding, textSource],
  );

  /**
   * Persist the draft reference after its blob has been written. The source
   * attachment must be reachable from the origin draft before a prevented
   * browser paste is considered consumed.
   */
  const commitAttachmentsToOrigin = useCallback(
    async (origin: ComposerSubmissionOrigin, attachmentsToAppend: UserComposerAttachment[]) => {
      if (attachmentsToAppend.length === 0) {
        return { status: "durable" } satisfies AttachmentReferenceCommitResult;
      }
      origin.onChangeAttachments((current) => [...current, ...attachmentsToAppend]);
      try {
        await flushDraftPersistStorageOrThrow();
        pendingAttachmentReferenceOwnersRef.current.delete(origin.owner.identity);
        return { status: "durable" } satisfies AttachmentReferenceCommitResult;
      } catch (error) {
        // The reference was synchronously appended to the captured draft. Do
        // not turn a reference-write failure into a second paste/upload: a
        // later explicit send retries only this flush barrier.
        pendingAttachmentReferenceOwnersRef.current.add(origin.owner.identity);
        return {
          status: "pending_durability",
          error,
        } satisfies AttachmentReferenceCommitResult;
      }
    },
    [],
  );

  const flushPendingAttachmentReferences = useCallback(
    async (origin: ComposerSubmissionOrigin): Promise<void> => {
      if (!pendingAttachmentReferenceOwnersRef.current.has(origin.owner.identity)) return;
      await flushDraftPersistStorageOrThrow();
      pendingAttachmentReferenceOwnersRef.current.delete(origin.owner.identity);
    },
    [],
  );

  const retainFailedFiles = useCallback(
    (entries: readonly FileUploadBatchFailure[], ownerIdentity: string) => {
      if (entries.length === 0) return;
      setFailedFiles((failed) => [
        ...failed,
        ...entries.map((entry) => ({
          id: nextPendingFileId.current++,
          file: entry.file,
          errorMessage: entry.errorMessage,
          ownerIdentity,
        })),
      ]);
    },
    [],
  );

  const focusInput = useCallback(() => {
    if (isNative) return;
    focusWithRetries({
      focus: () => messageInputRef.current?.focus(),
      isFocused: () => {
        const el = messageInputRef.current?.getNativeElement?.() ?? null;
        return el != null && document.activeElement === el;
      },
    });
  }, []);

  const handleWorkspaceFileDropped = useCallback(
    (payload: WorkspaceFileDragPayload) => {
      if (!workspaceId) {
        return;
      }
      const attachment = resolveWorkspaceFileDrop({ payload, serverId, workspaceId });
      if (!attachment) {
        return;
      }
      setSelectedAttachments((current) => appendWorkspaceFileAttachment(current, attachment));
      focusInput();
    },
    [focusInput, serverId, setSelectedAttachments, workspaceId],
  );

  useEffect(() => {
    onFocusInput?.(focusInput);
  }, [focusInput, onFocusInput]);

  const submitMessage = useCallback(
    async (
      text: string,
      submitAttachments: ComposerAttachment[],
      options?: { clientMessageId?: string; preparedPayload?: PreparedComposerSendPayload },
    ) => {
      onMessageSent?.();
      if (onSubmitMessage) {
        await onSubmitMessage({
          text,
          attachments: submitAttachments,
          cwd,
          ...options,
        });
        return;
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const activeTurnBehavior = appSettings.sendBehavior === "steer" ? "steer" : "interrupt";
      await dispatchComposerAgentMessage({
        client,
        agentId,
        text,
        attachments: submitAttachments,
        attachmentSubmitFormat: resolveComposerAttachmentSubmitFormat({
          supportsForgeAttachments: supportsForgeSearch,
        }),
        encodeImages,
        submission: createMessageSubmissionWriter(serverId),
        activeTurnBehavior,
        ...options,
        activeTurnId:
          activeTurnBehavior === "steer"
            ? (selectAgentTurnPresentation(useSessionStore.getState().sessions[serverId], agentId)
                .turnId ?? undefined)
            : undefined,
      });
      onAttentionPromptSend?.();
    },
    [
      agentId,
      appSettings.sendBehavior,
      client,
      cwd,
      onAttentionPromptSend,
      onMessageSent,
      onSubmitMessage,
      serverId,
      supportsForgeSearch,
      t,
    ],
  );

  useEffect(() => {
    agentIdRef.current = agentId;
  }, [agentId]);

  const hasActiveTurn = useSessionStore(
    (state) => selectAgentTurnPresentation(state.sessions[serverId], agentId).isActive,
  );
  const isCancellingAgent = useSessionStore(
    (state) => selectAgentTurnPresentation(state.sessions[serverId], agentId).isCancelling,
  );
  const isAgentRunning = hasActiveTurn;
  // Queueing behind a permission prompt would strand the message: the turn is
  // parked until the request is answered.
  const hasPendingPermission = useSessionStore((state) => {
    const pendingPermissions = state.sessions[serverId]?.pendingPermissions;
    if (!pendingPermissions) return false;
    for (const permission of pendingPermissions.values()) {
      if (permission.agentId === agentId) return true;
    }
    return false;
  });
  const activeSendBehavior = resolveActiveSendBehavior(
    appSettings.sendBehavior,
    hasPendingPermission,
  );
  const hasAgent = agentState.status !== null;

  const queueWriter = useMemo<QueueWriter>(
    () => ({
      read: (id) => useSessionStore.getState().sessions[serverId]?.queuedMessages?.get(id) ?? [],
      write: (updater) => setQueuedMessages(serverId, updater),
    }),
    [serverId, setQueuedMessages],
  );

  const queueMessage = useCallback(
    (
      queuedMessage: string,
      queuedAttachments: ComposerAttachment[],
      clientMessageId: string | undefined,
    ) => {
      const result = queueComposerMessage({
        agentId,
        text: queuedMessage,
        attachments: queuedAttachments,
        queue: queueWriter,
        clientMessageId,
      });
      if (!result.queued) return;

      resetSuppression();
      clearSentAttachments(queuedAttachments);
    },
    [agentId, clearSentAttachments, queueWriter, resetSuppression],
  );

  const sendMessageWithContent = useCallback(
    async (
      outgoingMessage: string,
      outgoingAttachments: ComposerAttachment[],
      forceSend?: boolean,
      originalInput?: { text: string; selection: { start: number; end: number } },
      forceQueue = false,
    ) => {
      // Capture the executor and target from this render before preparing any
      // bytes. A route change while preparation is pending must not redirect
      // this snapshot to the newly selected agent/workspace.
      submissionBinding?.flushAfterPaint();
      let draftSnapshot = submissionBinding?.capture() ?? null;
      const outgoingUserAttachments =
        composerWorkspaceAttachment.userAttachmentsOnly(outgoingAttachments);
      const initialAttachmentScopeIdentity = attachmentScopeIdentity;
      const hasCurrentWorkspaceAttachmentSnapshot = () => {
        if (attachmentScopeIdentityRef.current !== initialAttachmentScopeIdentity) {
          return false;
        }
        const currentWorkspaceAttachments = collectWorkspaceAttachmentsForScopes({
          attachmentsByScope: useWorkspaceAttachmentsStore.getState().attachmentsByScope,
          scopeKeys: attachmentScopeKeys,
        });
        return sameComposerAttachmentSnapshot(currentWorkspaceAttachments, workspaceAttachments);
      };
      const initialInput = originalInput ?? {
        text: outgoingMessage,
        selection: { start: outgoingMessage.length, end: outgoingMessage.length },
      };
      const submissionPreflight = getComposerSubmissionPreflight({
        outgoingMessage,
        outgoingAttachments,
        forceQueue,
        isAgentRunning,
        forceSend,
        hasExternalContent,
        allowEmptySubmit,
        hasSubmitExecutor: Boolean(client || onSubmitMessage),
      });
      if (!submissionPreflight) return;
      const { trimmedMessage, shouldQueue, canSubmit } = submissionPreflight;
      if (submissionBinding && !draftSnapshot) {
        // Empty workspace creation and external-context-only sends have no
        // typed source to hydrate. Materialize their empty origin only after
        // deliberate Send has passed preflight; typing and hydration never do
        // this. Ordinary non-empty input still fails closed without a fresh
        // persisted snapshot.
        const canCreateEmptySubmissionSnapshot = canCreateEmptyComposerSubmissionSnapshot({
          outgoingMessage,
          outgoingAttachments,
          outgoingUserAttachments,
          allowEmptySubmit,
          hasExternalContent,
        });
        if (!canCreateEmptySubmissionSnapshot) {
          setSendError("Draft changes are still being prepared. Retry sending.");
          return;
        }
        draftSnapshot = submissionBinding.ensureEmptyForSubmission();
        if (!draftSnapshot) {
          setSendError("Draft changes are still being prepared. Retry sending.");
          return;
        }
      }
      const recoveryBlockMessage = getRecoverySendBlockMessage({
        inspectionState: recoveryInspectionState,
        snapshot: draftSnapshot,
        record: findBoundSubmissionRecovery({
          records: submissionRecoveryRecords,
          owner: composerOwner,
          snapshot: draftSnapshot,
        }),
      });
      if (recoveryBlockMessage) {
        setSendError(recoveryBlockMessage);
        return;
      }
      if (pendingWebPasteOperationsRef.current > 0) {
        setSendError("Pasted content is still being prepared.");
        return;
      }
      if (submissionInFlightOwnersRef.current.has(composerOwner.identity)) {
        return;
      }

      const origin: ComposerSubmissionOrigin = {
        owner: composerOwner,
        clearDraft,
        onChangeAttachments,
        onChangeText,
        textSource,
        submissionBinding,
      };
      submissionInFlightOwnersRef.current.add(origin.owner.identity);

      let recovery: PreparedComposerSubmissionRecovery | null = null;
      let preparedPayload: PreparedComposerSendPayload | undefined;
      let clientMessageId: string | undefined;
      let didClearOutgoingSnapshot = false;
      let submissionInput = draftSnapshot?.input ?? {
        text: initialInput.text,
        attachments: outgoingUserAttachments,
      };
      const isOriginCurrent = () => composerOwnerRef.current === origin.owner;
      const isDraftSnapshotCurrent = () =>
        !draftSnapshot ||
        !origin.submissionBinding ||
        origin.submissionBinding.isCurrent(draftSnapshot);
      const replaceSubmissionInput = (nextInput: {
        text: string;
        attachments: UserComposerAttachment[];
      }) => {
        if (draftSnapshot && origin.submissionBinding) {
          const nextSnapshot = origin.submissionBinding.replaceForSubmission({
            snapshot: draftSnapshot,
            draft: nextInput,
          });
          if (!nextSnapshot) {
            return false;
          }
          draftSnapshot = nextSnapshot;
        }
        submissionInput = nextInput;
        return true;
      };
      const ownsInitialSnapshot = () => {
        if (!hasCurrentWorkspaceAttachmentSnapshot()) {
          return false;
        }
        // When navigation happened after the user pressed send, the captured
        // executor still owns its text source rather than the newly mounted
        // input. Attachment cleanup below is identity-subtractive against the
        // captured origin, so a later attachment edit remains intact.
        if (!isOriginCurrent()) {
          return origin.textSource.getSnapshot() === initialInput.text;
        }
        const current = messageInputRef.current?.getInputSnapshot();
        if (!current && origin.textSource.getSnapshot() !== initialInput.text) {
          return false;
        }
        if (
          current &&
          (current.text !== initialInput.text ||
            current.selection.start !== initialInput.selection.start ||
            current.selection.end !== initialInput.selection.end)
        ) {
          return false;
        }
        return sameComposerAttachmentSnapshot(selectedAttachmentsRef.current, outgoingAttachments);
      };
      const ownsClearedSnapshot = () => {
        if (!isOriginCurrent() || !isDraftSnapshotCurrent()) return false;
        const current = messageInputRef.current?.getInputSnapshot();
        if (!current) return didClearOutgoingSnapshot;
        const currentUserAttachments = composerWorkspaceAttachment.userAttachmentsOnly(
          selectedAttachmentsRef.current,
        );
        return (
          current?.text === "" &&
          (currentUserAttachments.length === 0 ||
            // React may not have published the initial clear yet. Only the
            // exact outgoing objects can be that stale render; newer additions
            // belong to the next draft and must survive this acknowledgement.
            (didClearOutgoingSnapshot &&
              sameComposerAttachmentSnapshot(currentUserAttachments, outgoingUserAttachments)))
        );
      };
      const canRestoreOriginSnapshot = () => {
        if (!isDraftSnapshotCurrent()) return false;
        if (isOriginCurrent()) return ownsClearedSnapshot();
        return didClearOutgoingSnapshot && origin.textSource.getSnapshot() === "";
      };
      const setOriginUserInput = (text: string, selection?: { start: number; end: number }) => {
        if (!isDraftSnapshotCurrent()) return;
        const originText = origin.textSource.getSnapshot();
        if (!isOriginCurrent()) {
          if (text === "" && originText !== initialInput.text) return;
          if (text === initialInput.text && didClearOutgoingSnapshot && originText !== "") return;
        }
        if (!replaceSubmissionInput({ ...submissionInput, text })) return;
        if (text === "") didClearOutgoingSnapshot = true;
        if (isOriginCurrent() && messageInputRef.current) {
          messageInputRef.current.replaceText(text, selection);
          return;
        }
        origin.onChangeText(text);
      };
      const setOriginAttachments = (nextAttachments: ComposerAttachment[]) => {
        if (!isDraftSnapshotCurrent()) return;
        const nextUserAttachments =
          composerWorkspaceAttachment.userAttachmentsOnly(nextAttachments);
        if (nextUserAttachments.length === 0) {
          // Controlled callers have no durable submission snapshot. Preserve
          // their live attachment list and subtract only the exact objects
          // consumed by this older send; a switch can add another attachment
          // before this preparation finishes.
          if (!draftSnapshot || !origin.submissionBinding) {
            origin.onChangeAttachments((current) => {
              const retained = subtractConsumedUserAttachmentSnapshot(
                current,
                outgoingUserAttachments,
              );
              if (
                retained.length === 0 &&
                isOriginCurrent() &&
                messageInputRef.current?.getInputSnapshot().text === ""
              ) {
                didClearOutgoingSnapshot = true;
              }
              return retained;
            });
            return;
          }
          const retained = subtractConsumedUserAttachmentSnapshot(
            submissionInput.attachments,
            outgoingUserAttachments,
          );
          if (!replaceSubmissionInput({ ...submissionInput, attachments: retained })) return;
          origin.onChangeAttachments(() => {
            if (
              retained.length === 0 &&
              isOriginCurrent() &&
              messageInputRef.current?.getInputSnapshot().text === ""
            ) {
              didClearOutgoingSnapshot = true;
            }
            return retained;
          });
          return;
        }
        const restoresOutgoingSnapshot = sameComposerAttachmentSnapshot(
          nextUserAttachments,
          outgoingUserAttachments,
        );
        if (!replaceSubmissionInput({ ...submissionInput, attachments: nextUserAttachments }))
          return;
        if (!isOriginCurrent() && restoresOutgoingSnapshot && didClearOutgoingSnapshot) {
          origin.onChangeAttachments((current) =>
            current.length === 0 ? nextUserAttachments : current,
          );
          return;
        }
        // This callback belongs to the captured draft owner. Never use the
        // current prop/ref here: it may now describe another workspace.
        origin.onChangeAttachments(nextUserAttachments);
      };
      const setOriginSendError = (message: string | null) => {
        if (isOriginCurrent()) setSendError(message);
      };
      const setOriginProcessing = (processing: boolean) => {
        if (isOriginCurrent()) setIsProcessing(processing);
      };
      const abandonStaleDispatch = async () => {
        const currentRecovery = recovery;
        const draftBinding = origin.submissionBinding;
        const boundSnapshot = draftSnapshot;
        if (
          currentRecovery &&
          boundSnapshot &&
          boundSnapshot.submissionCheckpointId === currentRecovery.record.id &&
          draftBinding
        ) {
          draftBinding.detach(boundSnapshot);
        }
        if (!currentRecovery) return;
        if (currentRecovery.lease) {
          await markComposerSubmissionNeedsReview({
            recovery: currentRecovery,
            error: new Error("The draft changed before this submission could be dispatched."),
          });
          return;
        }
        await discardPreparedComposerSubmission(currentRecovery.record);
      };

      const preparePayloadAndReserveRecovery = async () => {
        try {
          await flushPendingAttachmentReferences(origin);
        } catch (error) {
          setOriginSendError(
            "Attachment changes are waiting to be saved. Retry sending to save the existing attachment without uploading it again.",
          );
          console.warn("[Composer] Failed to persist pending attachment references", error);
          return false;
        }
        if (!ownsInitialSnapshot() || !isDraftSnapshotCurrent()) {
          return false;
        }
        const attachmentSubmitFormat = resolveComposerAttachmentSubmitFormat({
          supportsForgeAttachments: supportsForgeSearch,
        });
        preparedPayload = await prepareComposerSendPayload({
          attachments: outgoingAttachments,
          format: attachmentSubmitFormat,
          encodeImages,
        });
        if (!ownsInitialSnapshot() || !isDraftSnapshotCurrent()) {
          return false;
        }
        clientMessageId = generateMessageId();
        recovery = await prepareComposerSubmissionRecovery({
          clientMessageId,
          kind: onSubmitMessage ? "workspace_create" : "agent_message",
          serverId,
          agentId,
          workspaceId,
          draftId: onSubmitMessage ? agentId : null,
          cwd,
          text: trimmedMessage,
          attachments: outgoingAttachments,
          originalDraft: {
            text: initialInput.text,
            attachments: outgoingAttachments,
            selection: initialInput.selection,
          },
        });
        if (!ownsInitialSnapshot() || !isDraftSnapshotCurrent()) {
          await discardPreparedComposerSubmission(recovery.record);
          return false;
        }
        return true;
      };

      const bindAndClaimRecovery = async () => {
        const preparedRecovery = recovery;
        if (!preparedRecovery) return false;
        const draftBinding = origin.submissionBinding;
        if (draftSnapshot && draftBinding) {
          const boundSnapshot = draftBinding.bind({
            snapshot: draftSnapshot,
            submissionCheckpointId: preparedRecovery.record.id,
          });
          if (!boundSnapshot) {
            await discardPreparedComposerSubmission(preparedRecovery.record);
            return false;
          }
          draftSnapshot = boundSnapshot;
          try {
            await flushDraftPersistStorageOrThrow();
          } catch (error) {
            draftBinding.detach(boundSnapshot);
            await discardPreparedComposerSubmission(preparedRecovery.record);
            throw error;
          }
          if (!ownsInitialSnapshot() || !isDraftSnapshotCurrent()) {
            draftBinding.detach(boundSnapshot);
            await discardPreparedComposerSubmission(preparedRecovery.record);
            return false;
          }
        }
        if (shouldQueue) return true;
        const claimedRecovery = await claimPreparedComposerSubmission(preparedRecovery.record);
        recovery = claimedRecovery;
        if (!ownsInitialSnapshot() || !isDraftSnapshotCurrent()) {
          await abandonStaleDispatch();
          return false;
        }
        return true;
      };

      const dispatchPreparedSubmission = async () => {
        // bindAndClaimRecovery() resolves asynchronously. Check again at the
        // dispatch boundary so a user/context edit in that final microtask
        // cannot reach either queueMessage or the provider.
        if (!ownsInitialSnapshot() || !isDraftSnapshotCurrent()) {
          await abandonStaleDispatch();
          return;
        }
        const result = await submitAgentInput({
          message: outgoingMessage,
          attachments: outgoingAttachments,
          hasExternalContent,
          allowEmptySubmit,
          forceSend,
          submitBehavior,
          isAgentRunning: shouldQueue,
          // Parent-managed submits are still valid submit paths even when the
          // transport is disconnected, because the parent decides the failure mode.
          canSubmit,
          queueMessage: ({ message: queuedText, attachments: queuedAttachments }) => {
            queueMessage(queuedText, queuedAttachments, clientMessageId);
          },
          submitMessage: async ({ message: submitText, attachments: submitAttachments }) => {
            if (submitBehavior !== "preserve-and-lock") {
              beginSubmit(submitAttachments);
            }
            try {
              await submitMessage(submitText, submitAttachments, {
                clientMessageId,
                preparedPayload,
              });
              if (recovery) {
                try {
                  await markComposerSubmissionSettled(recovery);
                } catch (error) {
                  // Provider acceptance is sticky even if the local settled
                  // marker cannot be cleaned up immediately.
                  console.warn("[Composer] Failed to settle accepted submission recovery", error);
                }
              }
            } catch (error) {
              if (recovery) {
                try {
                  await markComposerSubmissionNeedsReview({ recovery, error });
                  if (isOriginCurrent()) void refreshReviewableSubmissions();
                } catch (recoveryError) {
                  console.warn("[Composer] Failed to retain submission for review", recoveryError);
                }
              }
              throw error;
            }
          },
          clearDraft: async (lifecycle) => {
            // Workspace creation intentionally keeps the source visible and
            // locked while its parent resolves. Once accepted, turn it into
            // this checkpoint's sent tombstone here so the parent does not
            // race a second draft clear against the bound record.
            if (lifecycle === "sent" && submitBehavior === "preserve-and-lock") {
              if (!isDraftSnapshotCurrent()) return;
              setOriginUserInput("");
              setOriginAttachments([]);
            }
            if (!ownsClearedSnapshot() || !isDraftSnapshotCurrent()) return;
            origin.clearDraft(lifecycle);
            try {
              await flushDraftPersistStorageOrThrow();
            } catch (error) {
              // The durable recovery record already contains the original
              // draft, so an accepted send must not become retryable here.
              console.warn("[Composer] Failed to flush cleared draft after accepted send", error);
            }
          },
          setUserInput: setOriginUserInput,
          setAttachments: setOriginAttachments,
          canRestoreSnapshot: canRestoreOriginSnapshot,
          restoreMessage: initialInput.text,
          restoreSelection: initialInput.selection,
          setSendError: setOriginSendError,
          setIsProcessing: setOriginProcessing,
          onSubmitError: (error) => {
            console.error("[AgentInput] Failed to send message:", error);
          },
          failedToSendMessage: t("composer.errors.failedToSend"),
        });
        completeSubmit({
          result,
          outgoingAttachments,
        });
      };

      const runSubmissionLifecycle = async () => {
        try {
          preparingSubmissionOwnersRef.current.add(origin.owner.identity);
          if (isOriginCurrent()) setIsPreparingSubmission(true);
          if (!(await preparePayloadAndReserveRecovery())) return;
          if (!(await bindAndClaimRecovery())) return;
          await dispatchPreparedSubmission();
        } catch (error) {
          console.error("[Composer] Failed to prepare a durable submission:", error);
          setOriginSendError(
            error instanceof Error ? error.message : t("composer.errors.failedToSend"),
          );
        } finally {
          preparingSubmissionOwnersRef.current.delete(origin.owner.identity);
          if (isOriginCurrent()) {
            setIsPreparingSubmission(
              preparingSubmissionOwnersRef.current.has(origin.owner.identity),
            );
          }
          submissionInFlightOwnersRef.current.delete(origin.owner.identity);
        }
      };
      await runSubmissionLifecycle();
    },
    [
      allowEmptySubmit,
      attachmentScopeIdentity,
      attachmentScopeKeys,
      beginSubmit,
      client,
      clearDraft,
      composerOwner,
      completeSubmit,
      hasExternalContent,
      isAgentRunning,
      recoveryInspectionState,
      agentId,
      cwd,
      onChangeAttachments,
      onChangeText,
      onSubmitMessage,
      queueMessage,
      submissionRecoveryRecords,
      submissionBinding,
      serverId,
      supportsForgeSearch,
      textSource,
      workspaceId,
      workspaceAttachments,
      flushPendingAttachmentReferences,
      refreshReviewableSubmissions,
      submitBehavior,
      submitMessage,
      t,
    ],
  );

  const handleSubmit = useCallback(
    (payload: MessagePayload) => {
      const outgoingAttachments = buildOutgoingAttachments(attachments);
      const inputSnapshot = messageInputRef.current?.getInputSnapshot() ?? {
        text: payload.text,
        selection: { start: payload.text.length, end: payload.text.length },
      };
      const clientSlashCommand = resolveClientSlashCommand({
        text: payload.text,
        hasAttachments: outgoingAttachments.length > 0,
      });
      if (clientSlashCommand && runClientSlashCommand(clientSlashCommand)) {
        return;
      }
      const pluginSlashCommand = resolvePluginClientSlashCommand({
        text: payload.text,
        hasAttachments: outgoingAttachments.length > 0,
        commands: pluginClientSlashCommands,
      });
      if (pluginSlashCommand && runPluginClientSlashCommand(pluginSlashCommand)) return;

      if (blurOnSubmit) {
        messageInputRef.current?.blur();
      }
      void sendMessageWithContent(
        payload.text,
        outgoingAttachments,
        payload.forceSend,
        inputSnapshot,
      );
    },
    [
      attachments,
      blurOnSubmit,
      buildOutgoingAttachments,
      runClientSlashCommand,
      pluginClientSlashCommands,
      runPluginClientSlashCommand,
      sendMessageWithContent,
    ],
  );

  const handlePickImage = useCallback(async () => {
    const origin = captureComposerSubmissionOrigin();
    const newImages = await pickAndPersistImages({
      pickImages,
      persister: composerImageAttachmentPersister,
    });
    if (newImages.length === 0) return;
    const commit = await commitAttachmentsToOrigin(
      origin,
      newImages.map((metadata) => ({ kind: "image" as const, metadata })),
    );
    if (commit.status === "pending_durability") {
      toastErrorRef.current(
        commit.error instanceof Error ? commit.error.message : t("composer.errors.uploadFailed"),
      );
    }
  }, [captureComposerSubmissionOrigin, commitAttachmentsToOrigin, pickImages, t]);

  const handlePasteImage = useCallback(async () => {
    const origin = captureComposerSubmissionOrigin();
    try {
      const newImages = await pickAndPersistImages({
        pickImages: async () => {
          const image = await readClipboardImage(Clipboard);
          return image ? [image] : null;
        },
        persister: composerImageAttachmentPersister,
      });
      if (newImages.length === 0) {
        toastErrorRef.current(t("composer.errors.noClipboardImage"));
        return;
      }
      const commit = await commitAttachmentsToOrigin(
        origin,
        newImages.map((metadata) => ({ kind: "image" as const, metadata })),
      );
      if (commit.status === "pending_durability") {
        throw commit.error;
      }
    } catch (error) {
      console.error("[Composer] Failed to paste clipboard image:", error);
      toastErrorRef.current(t("composer.errors.pasteImageFailed"));
    }
  }, [captureComposerSubmissionOrigin, commitAttachmentsToOrigin, t]);

  const handleNativePasteImages = useCallback(
    (files: readonly NativePastedFile[]) => {
      const origin = captureComposerSubmissionOrigin();
      setPendingNativeImagePastes((pending) => pending + 1);
      void (async () => {
        try {
          const newImages = await pickAndPersistImages({
            pickImages: async () => normalizeNativePastedImages(files),
            persister: composerImageAttachmentPersister,
          });
          if (newImages.length > 0) {
            const commit = await commitAttachmentsToOrigin(
              origin,
              newImages.map((metadata) => ({ kind: "image" as const, metadata })),
            );
            if (commit.status === "pending_durability") throw commit.error;
          }
        } catch (error) {
          console.error("[Composer] Failed to persist pasted image:", error);
          toastErrorRef.current(t("composer.errors.pasteImageFailed"));
        } finally {
          setPendingNativeImagePastes((pending) => Math.max(0, pending - 1));
        }
      })();
    },
    [captureComposerSubmissionOrigin, commitAttachmentsToOrigin, t],
  );

  const uploadSelectedFiles = useCallback(
    async (
      files: SelectedFile[],
      origin: ComposerSubmissionOrigin = captureComposerSubmissionOrigin(),
    ) => {
      if (files.length === 0) return;
      if (!client) {
        retainFailedFiles(
          files.map((file) => ({
            file,
            errorMessage: t("composer.errors.daemonClientDisconnected"),
          })),
          origin.owner.identity,
        );
        return;
      }

      const placeholders = files.map((file) => ({
        id: nextPendingFileId.current++,
        file,
        ownerIdentity: origin.owner.identity,
      }));
      setPendingFiles((pending) => [...pending, ...placeholders]);
      try {
        let result: Awaited<ReturnType<typeof uploadFileAttachmentBatch>>;
        try {
          result = await uploadFileAttachmentBatch({ client, files });
        } catch (error) {
          console.error("[Composer] Failed to upload file:", error);
          retainFailedFiles(
            files.map((file) => ({
              file,
              errorMessage:
                error instanceof Error ? error.message : t("composer.errors.uploadFailed"),
            })),
            origin.owner.identity,
          );
          toastErrorRef.current(
            error instanceof Error ? error.message : t("composer.errors.uploadFailed"),
          );
          return;
        }

        if (result.uploaded.length > 0) {
          const commit = await commitAttachmentsToOrigin(origin, result.uploaded);
          if (commit.status === "pending_durability") {
            // These uploads already have a live origin-draft reference. Retain
            // the reference flush for Send; never put their source bytes back
            // into the retry tray where they could create duplicate uploads.
            toastErrorRef.current(
              commit.error instanceof Error
                ? commit.error.message
                : t("composer.errors.uploadFailed"),
            );
          }
        }
        retainFailedFiles(result.failed, origin.owner.identity);
        if (result.failed.length > 0) {
          toastErrorRef.current(
            result.failed[0]?.errorMessage ?? t("composer.errors.uploadFailed"),
          );
        }
      } finally {
        setPendingFiles((pending) => pending.filter((entry) => !placeholders.includes(entry)));
      }
    },
    [captureComposerSubmissionOrigin, client, commitAttachmentsToOrigin, retainFailedFiles, t],
  );

  const handleRetryFailedFile = useCallback(
    (id: number) => {
      const failed = failedFiles.find((entry) => entry.id === id);
      if (!failed) return;
      setFailedFiles((entries) => entries.filter((entry) => entry.id !== id));
      void uploadSelectedFiles([failed.file]);
    },
    [failedFiles, uploadSelectedFiles],
  );

  const handleRemoveFailedFile = useCallback((id: number) => {
    setFailedFiles((entries) => entries.filter((entry) => entry.id !== id));
  }, []);

  const handleInspectSubmission = useCallback((record: SubmissionRecoveryRecord) => {
    setSubmissionRecoveryInspectorTarget(record);
  }, []);

  const handleDiscardSubmissionRecovery = useCallback(
    (record: SubmissionRecoveryRecord) => {
      const owner = composerOwner;
      if (!matchesComposerOwner(record, owner)) {
        return;
      }
      const binding = submissionBinding;
      const snapshot = binding?.capture() ?? null;
      void (async () => {
        try {
          if (snapshot?.submissionCheckpointId === record.id && binding) {
            if (!binding.detach(snapshot)) {
              return;
            }
            await flushDraftPersistStorageOrThrow();
            if (composerOwnerRef.current !== owner) {
              return;
            }
          }
          await getSubmissionRecoveryStore().remove(record.id);
          if (composerOwnerRef.current !== owner) {
            return;
          }
          setSubmissionRecoveryInspectorTarget(null);
          await refreshReviewableSubmissions();
        } catch (error) {
          console.error("[Composer] Failed to discard submission recovery checkpoint", error);
          toastErrorRef.current(
            error instanceof Error ? error.message : t("composer.errors.failedToSend"),
          );
        }
      })();
    },
    [composerOwner, refreshReviewableSubmissions, submissionBinding, t],
  );

  const handleRestoreSubmissionRecovery = useCallback(
    (record: SubmissionRecoveryRecord) => {
      const owner = composerOwner;
      const binding = submissionBinding;
      if (record.state === "settled" || !binding || !matchesComposerOwner(record, owner)) {
        return;
      }
      const restoreSnapshot = binding.captureRestore();
      if (
        restoreSnapshot.submissionCheckpointId &&
        restoreSnapshot.submissionCheckpointId !== record.id
      ) {
        setSendError("This draft is linked to another submission checkpoint.");
        return;
      }
      // Restore input and checkpoint in the same CAS state transition. A
      // regular text/attachment callback may begin persistence immediately,
      // so it must only mirror this already-bound state afterward.
      const boundSnapshot = binding.restore({
        snapshot: restoreSnapshot,
        submissionCheckpointId: record.id,
        draft: {
          text: record.originalDraft.text,
          attachments: composerWorkspaceAttachment.userAttachmentsOnly(
            record.originalDraft.attachments,
          ),
        },
      });
      if (!boundSnapshot) {
        setSendError("The restored draft changed before its checkpoint could be attached.");
        return;
      }
      replaceUserInput(record.originalDraft.text, record.originalDraft.selection);
      binding.flushAfterPaint();
      if (!binding.isCurrent(boundSnapshot)) {
        return;
      }
      void (async () => {
        try {
          await flushDraftPersistStorageOrThrow();
          if (composerOwnerRef.current !== owner || !binding.isCurrent(boundSnapshot)) {
            return;
          }
          setSendError(null);
        } catch (error) {
          // A storage failure can happen after a partial write. Keep the
          // in-memory explicit association fail-closed: removing it here
          // would turn an uncertain restored attempt into a fresh send
          // without any user edit or discard.
          console.warn("[Composer] Failed to flush restored submission draft", error);
          toastErrorRef.current(
            error instanceof Error ? error.message : t("composer.errors.failedToSend"),
          );
        }
      })();
    },
    [composerOwner, replaceUserInput, submissionBinding, t],
  );

  const handleWebPaste = useCallback(
    ({ paste, isConnected: pasteIsConnected, inputSnapshot }: WebClipboardPasteEvent) => {
      const origin = captureComposerSubmissionOrigin();
      const isOriginCurrent = () => composerOwnerRef.current === origin.owner;
      pendingWebPasteOperationsRef.current += 1;
      setPendingWebPastes((pending) => pending + 1);
      const reportFailure = (error: unknown) => {
        console.error("[Composer] Failed to process pasted clipboard content:", error);
        if (isOriginCurrent()) {
          toastErrorRef.current(
            error instanceof Error ? error.message : t("composer.errors.uploadFailed"),
          );
        }
      };
      void (async () => {
        const retainExactPastedText = async () => {
          if (!paste.shouldCreatePastedTextAttachment) return;
          const currentInput = isOriginCurrent()
            ? messageInputRef.current?.getInputSnapshot()
            : undefined;
          const originText = currentInput?.text ?? origin.textSource.getSnapshot();
          const originSelection = currentInput?.selection;
          let nextText: string;
          let caret: number;
          if (
            inputSnapshot &&
            originText === inputSnapshot.text &&
            originSelection?.start === inputSnapshot.selection.start &&
            originSelection.end === inputSnapshot.selection.end
          ) {
            nextText =
              inputSnapshot.text.slice(0, inputSnapshot.selection.start) +
              paste.text +
              inputSnapshot.text.slice(inputSnapshot.selection.end);
            caret = inputSnapshot.selection.start + paste.text.length;
          } else {
            nextText = originText + paste.text;
            caret = nextText.length;
          }
          if (isOriginCurrent() && messageInputRef.current) {
            messageInputRef.current.replaceText(nextText, { start: caret, end: caret });
          } else {
            // This is intentionally the captured callback, not the latest
            // input ref: a target switch must retain the exact buffer in the
            // origin draft instead of writing it into the next agent.
            origin.onChangeText(nextText);
          }
          try {
            await flushDraftPersistStorageOrThrow();
          } catch (error) {
            // The browser cannot promise reload durability in this case, but
            // the exact source remains in the live origin draft rather than
            // being silently discarded after preventDefault().
            console.warn("[Composer] Failed to durably retain pasted text fallback", error);
          }
        };

        if (paste.shouldCreatePastedTextAttachment) {
          try {
            const pastedText = await persistPastedTextAttachment({
              text: paste.text,
              codePointCount: paste.codePointCount,
              logicalLineCount: paste.logicalLineCount,
            });
            // Do not consider the prevented paste consumed until both the
            // bytes and its origin-draft reference have crossed their
            // durability barriers.
            const commit = await commitAttachmentsToOrigin(origin, [pastedText]);
            if (commit.status === "pending_durability") {
              // The attachment is already present in the live origin draft.
              // Retrying its reference flush is safe; adding this exact text
              // back into the input would duplicate it on the next submit.
              reportFailure(commit.error);
            }
          } catch (error) {
            await retainExactPastedText();
            reportFailure(error);
          }
        }
        if (paste.imageFiles.length > 0) {
          try {
            const result = await persistClipboardImageFiles(paste.imageFiles);
            if (result.attachments.length > 0) {
              const commit = await commitAttachmentsToOrigin(
                origin,
                result.attachments.map((metadata) => ({ kind: "image" as const, metadata })),
              );
              if (commit.status === "pending_durability") {
                reportFailure(commit.error);
              }
            }
            if (result.failed.length > 0) {
              retainFailedFiles(
                result.failed.map(({ file, error }) => ({
                  file: clipboardFileToSelectedFile(file),
                  errorMessage:
                    error instanceof Error ? error.message : "Unable to save pasted image.",
                })),
                origin.owner.identity,
              );
            }
          } catch (error) {
            // None of these source Files has reached the origin draft in this
            // branch. Keep every one visible for explicit retry, then continue
            // with non-image files below.
            retainFailedFiles(
              paste.imageFiles.map(({ file }) => ({
                file: clipboardFileToSelectedFile(file),
                errorMessage:
                  error instanceof Error ? error.message : "Unable to save pasted image.",
              })),
              origin.owner.identity,
            );
            reportFailure(error);
          }
        }
        if (paste.uploadFiles.length > 0) {
          const files = paste.uploadFiles.map(clipboardFileToSelectedFile);
          if (pasteIsConnected && client) {
            await uploadSelectedFiles(files, origin);
          } else {
            retainFailedFiles(
              files.map((file) => ({
                file,
                errorMessage: t("composer.errors.daemonClientDisconnected"),
              })),
              origin.owner.identity,
            );
          }
        }
      })()
        .catch((error) => reportFailure(error))
        .finally(() => {
          pendingWebPasteOperationsRef.current = Math.max(
            0,
            pendingWebPasteOperationsRef.current - 1,
          );
          setPendingWebPastes((pending) => Math.max(0, pending - 1));
        });
    },
    [
      captureComposerSubmissionOrigin,
      client,
      commitAttachmentsToOrigin,
      retainFailedFiles,
      t,
      uploadSelectedFiles,
    ],
  );

  const handlePickFile = useCallback(async () => {
    const origin = captureComposerSubmissionOrigin();
    if (!client) {
      toastErrorRef.current(t("composer.errors.daemonClientDisconnected"));
      return;
    }
    try {
      const files = await pickFiles();
      if (!files) return;
      await uploadSelectedFiles(files, origin);
    } catch (error) {
      console.error("[Composer] Failed to upload file:", error);
      toastErrorRef.current(
        error instanceof Error ? error.message : t("composer.errors.uploadFailed"),
      );
    }
  }, [captureComposerSubmissionOrigin, client, pickFiles, t, uploadSelectedFiles]);

  const handleGenericFilesDropped = useCallback(
    async (items: DroppedItem[]) => {
      const origin = captureComposerSubmissionOrigin();
      try {
        const files = droppedItemsToSelectedFiles(items);
        if (files.length === 0) return;
        if (!client || !isConnected) {
          toastErrorRef.current(t("composer.errors.daemonClientDisconnected"));
          return;
        }
        await uploadSelectedFiles(files, origin);
      } catch (error) {
        console.error("[Composer] Failed to upload dropped files:", error);
        toastErrorRef.current(
          error instanceof Error ? error.message : t("composer.errors.uploadFailed"),
        );
      }
    },
    [captureComposerSubmissionOrigin, client, isConnected, t, uploadSelectedFiles],
  );

  const handleRemoveAttachment = useCallback(
    (index: number) => {
      forgeAutoAttachRef.current?.markForgeAttachmentRemoved(selectedAttachments[index]);
      const didRemoveWorkspaceAttachment = removeAttachment({
        selectedAttachments,
        index,
      });
      if (didRemoveWorkspaceAttachment) {
        return;
      }
      setSelectedAttachments((prev) =>
        removeComposerAttachmentAtIndex({ attachments: prev, index }),
      );
    },
    [removeAttachment, selectedAttachments, setSelectedAttachments],
  );

  const handleOpenAttachment = useCallback(
    (attachment: ComposerAttachment) => {
      if (attachment.kind === "pasted_text") {
        const index = selectedAttachments.findIndex(
          (candidate) =>
            candidate.kind === "pasted_text" && candidate.metadata.id === attachment.metadata.id,
        );
        if (index >= 0) {
          setPastedTextInspectorTarget({ attachment, index });
        }
        return;
      }
      openComposerAttachment({
        attachment,
        setLightboxMetadata,
        openWorkspaceAttachment: openAttachment,
        openExternalUrl: (url) => {
          void openExternalUrl(url);
        },
      });
    },
    [openAttachment, selectedAttachments],
  );

  const handleCancelAgent = useCallback(() => {
    const targetAgentId = agentIdRef.current;
    const cancellation = cancelComposerAgent({
      client,
      agentId: targetAgentId,
      isAgentRunning,
      isCancellingAgent,
      isConnected,
    });
    if (!cancellation) return;
    const requestId = getHostRuntimeStore().beginAgentCancellation(serverId, targetAgentId);
    void cancellation
      .catch((error) => {
        const message = resolveErrorMessage(error);
        if (message && message.trim().length > 0) {
          toastErrorRef.current(message);
        }
      })
      .finally(() => {
        getHostRuntimeStore().settleAgentCancellation(serverId, targetAgentId, requestId);
      });
    messageInputRef.current?.focus();
  }, [client, isAgentRunning, isCancellingAgent, isConnected, serverId]);

  const focusMessageInputForKeyboardAction = useCallback(() => {
    focusMessageInputWithPlatformStrategy(messageInputRef);
  }, []);

  const isVoiceModeForAgent = resolveIsVoiceModeForAgent(voice, serverId, agentId);

  const handleToggleRealtimeVoice = useCallback(() => {
    attemptStartRealtimeVoice({
      voice,
      isConnected,
      hasAgent,
      serverId,
      agentId,
      toastErrorRef,
    });
  }, [agentId, hasAgent, isConnected, serverId, voice]);

  const handleEditQueuedMessage = useCallback(
    async (id: string) => {
      const result = await editQueuedComposerMessage({
        agentId,
        messageId: id,
        queue: queueWriter,
      });
      if (result.status === "edited") {
        replaceUserInput(result.text);
        setSelectedAttachments(result.attachments);
        scheduleAttachmentGarbageCollection();
        return;
      }
      if (result.status === "needs_review") {
        setSendError(result.errorMessage);
        void refreshReviewableSubmissions();
      }
    },
    [agentId, queueWriter, refreshReviewableSubmissions, replaceUserInput, setSelectedAttachments],
  );

  const handleSendQueuedNow = useCallback(
    async (id: string) => {
      if (!client && !onSubmitMessage) return;
      // Reuse the regular send path; server-side send atomically interrupts any active run.
      const result = await sendQueuedComposerMessageNow({
        agentId,
        messageId: id,
        queue: queueWriter,
        submitMessage: ({ text, attachments: queuedAttachments, clientMessageId }) =>
          submitMessage(text, queuedAttachments, { clientMessageId }),
        failedToSendMessage: t("composer.errors.failedToSend"),
      });
      if (result.status === "failed" || result.status === "needs_review") {
        setSendError(result.errorMessage);
      }
      if (result.status === "needs_review") {
        void refreshReviewableSubmissions();
      }
    },
    [agentId, client, onSubmitMessage, queueWriter, refreshReviewableSubmissions, submitMessage, t],
  );

  const handleQueue = useCallback(
    (payload: MessagePayload) => {
      const outgoingAttachments = buildOutgoingAttachments(attachments);
      const clientSlashCommand = resolveClientSlashCommand({
        text: payload.text,
        hasAttachments: outgoingAttachments.length > 0,
      });
      if (clientSlashCommand && runClientSlashCommand(clientSlashCommand)) {
        return;
      }
      const pluginSlashCommand = resolvePluginClientSlashCommand({
        text: payload.text,
        hasAttachments: outgoingAttachments.length > 0,
        commands: pluginClientSlashCommands,
      });
      if (pluginSlashCommand && runPluginClientSlashCommand(pluginSlashCommand)) return;
      const inputSnapshot = messageInputRef.current?.getInputSnapshot() ?? {
        text: payload.text,
        selection: { start: payload.text.length, end: payload.text.length },
      };
      void sendMessageWithContent(
        payload.text,
        outgoingAttachments,
        undefined,
        inputSnapshot,
        true,
      );
    },
    [
      attachments,
      buildOutgoingAttachments,
      pluginClientSlashCommands,
      runClientSlashCommand,
      runPluginClientSlashCommand,
      sendMessageWithContent,
    ],
  );

  const hasSendableContent = hasText || selectedAttachments.length > 0;

  // An open autocomplete owns the arrows; otherwise they may recall sent messages.
  const handleCommandKeyPress = useCallback(
    (event: ComposerKeyPressEvent) => {
      if (autocompleteRef.current?.onKeyPress(event)) return true;
      const recalledText = recall.handleKeyPress(event, () =>
        selectAgentSentMessages(useSessionStore.getState().sessions[serverId], agentId),
      );
      if (recalledText === null) return false;
      event.preventDefault();
      replaceUserInput(recalledText);
      return true;
    },
    [agentId, recall, replaceUserInput, serverId],
  );

  const cancelButtonStyle = useMemo(
    () => buildCancelButtonStyle(isConnected, isCancellingAgent),
    [isConnected, isCancellingAgent],
  );

  const isVoiceSwitching = voice?.isVoiceSwitching ?? false;
  const voiceButtonDisabled = !isConnected || isVoiceSwitching;
  const realtimeVoiceButtonStyle = useCallback(
    (state: PressableStateCallbackType & { hovered?: boolean }) =>
      buildRealtimeVoiceButtonStyle(state.hovered, voiceButtonDisabled, isCompactLayout),
    [isCompactLayout, voiceButtonDisabled],
  );

  const activeActionContent = useMemo(
    () => (
      <ComposerCancelButton
        buttonIconSize={buttonIconSize}
        cancelButtonStyle={cancelButtonStyle}
        handleCancelAgent={handleCancelAgent}
        isConnected={isConnected}
        isCancellingAgent={isCancellingAgent}
        agentInterruptKeys={agentInterruptKeys}
        t={t}
      />
    ),
    [
      agentInterruptKeys,
      buttonIconSize,
      cancelButtonStyle,
      handleCancelAgent,
      isCancellingAgent,
      isConnected,
      t,
    ],
  );

  const rightContent = useMemo(
    () => (
      <ComposerRightControlsSlot
        isVoiceModeForAgent={isVoiceModeForAgent}
        hasAgent={hasAgent}
        isAgentRunning={isAgentRunning}
        hasSendableContent={hasSendableContent}
        isCompact={isCompactLayout}
        showVoice={mode.showVoice}
        buttonIconSize={buttonIconSize}
        handleToggleRealtimeVoice={handleToggleRealtimeVoice}
        isConnected={isConnected}
        isVoiceSwitching={isVoiceSwitching}
        realtimeVoiceButtonStyle={realtimeVoiceButtonStyle}
        voiceToggleKeys={voiceToggleKeys}
        t={t}
      />
    ),
    [
      buttonIconSize,
      handleToggleRealtimeVoice,
      hasAgent,
      hasSendableContent,
      isAgentRunning,
      isConnected,
      isCompactLayout,
      isVoiceModeForAgent,
      isVoiceSwitching,
      mode.showVoice,
      realtimeVoiceButtonStyle,
      t,
      voiceToggleKeys,
    ],
  );

  const contextWindowMeterGlyphSize = isCompactLayout ? ICON_SIZE.md : buttonIconSize;
  const beforeVoiceContent = useMemo(
    () =>
      hasAgent ? (
        <View style={styles.contextWindowMeterSlot}>
          <ContextWindowMeter
            serverId={serverId}
            agentId={agentId}
            maxTokens={agentState.contextWindowMaxTokens}
            usedTokens={agentState.contextWindowUsedTokens}
            totalCostUsd={agentState.totalCostUsd}
            glyphSize={contextWindowMeterGlyphSize}
          />
        </View>
      ) : null,
    [
      hasAgent,
      serverId,
      agentId,
      agentState.contextWindowMaxTokens,
      agentState.contextWindowUsedTokens,
      agentState.totalCostUsd,
      contextWindowMeterGlyphSize,
    ],
  );

  const hasGithubAttachment = useMemo(
    () =>
      selectedAttachments.some(
        (attachment) =>
          attachment.kind === "forge_change_request" ||
          attachment.kind === "forge_issue" ||
          attachment.kind === "github_pr" ||
          attachment.kind === "github_issue",
      ),
    [selectedAttachments],
  );
  // Composer stays mounted for each focused agent, so avoid a forge CLI call
  // until the forge-specific picker or attachment presentation is visible.
  const { forge } = useCheckoutPrStatusQuery({
    serverId,
    cwd,
    enabled: isConnected && cwd.trim().length > 0 && (isGithubPickerOpen || hasGithubAttachment),
  });
  const forgePresentation = useMemo(() => getForgePresentation(forge), [forge]);

  const githubSearchQueryTrimmed = githubSearchQuery.trim();
  const githubSearchResultsQuery = useForgeSearchQuery({
    client,
    serverId,
    cwd,
    query: githubSearchQueryTrimmed,
    supportsForgeSearch,
    enabled: resolveGithubSearchEnabled(isGithubPickerOpen, isConnected, cwd),
  });

  const githubSearchItemsRaw = githubSearchResultsQuery.data?.items;
  const githubSearchItems = useMemo(() => githubSearchItemsRaw ?? [], [githubSearchItemsRaw]);
  const githubSearchOptions: ComboboxOption[] = useMemo(
    () =>
      githubSearchItems.map((item) => {
        const presentation = getForgePresentation(item.forge ?? "github");
        const numberPrefix =
          item.kind === "change_request"
            ? presentation.numberPrefix
            : presentation.issueNumberPrefix;
        return {
          id: `${item.kind}:${item.number}`,
          label: `${numberPrefix}${item.number} ${item.title}`,
          description: githubSearchQueryTrimmed,
        };
      }),
    [githubSearchItems, githubSearchQueryTrimmed],
  );

  const attachmentMenuItems = useMemo<AttachmentMenuItem[]>(() => {
    const items: AttachmentMenuItem[] = [
      {
        id: "image",
        label: t("composer.attachments.addImage"),
        icon: <ThemedImageIcon size={ICON_SIZE.md} uniProps={iconForegroundMutedMapping} />,
        onSelect: () => {
          void handlePickImage();
        },
      },
    ];
    if (isNative) {
      items.push({
        id: "paste-image",
        label: t("composer.attachments.pasteImage"),
        icon: <ThemedClipboardPaste size={ICON_SIZE.md} uniProps={iconForegroundMutedMapping} />,
        onSelect: () => {
          void handlePasteImage();
        },
      });
    }
    items.push(
      {
        id: "github",
        label: t("composer.attachments.addIssueOrPr", {
          context: forgePresentation.changeRequestContext,
        }),
        icon: renderForgeAttachmentIcon(forgePresentation.icon),
        onSelect: () => {
          setIsGithubPickerOpen(true);
        },
      },
      ...pluginAttachments.menuItems,
      {
        id: "file",
        label: t("composer.attachments.addFile"),
        icon: <ThemedPaperclip size={ICON_SIZE.md} uniProps={iconForegroundMutedMapping} />,
        onSelect: () => {
          void handlePickFile();
        },
      },
    );
    return items;
  }, [
    forgePresentation,
    handlePasteImage,
    handlePickFile,
    handlePickImage,
    pluginAttachments.menuItems,
    t,
  ]);

  const handleToggleGithubItem = useCallback(
    (item: ForgeSearchItem) => {
      const nextAttachments = toggleForgeAttachmentFromPicker({
        current: attachments,
        item,
        markForgeAttachmentRemoved: (attachment) =>
          forgeAutoAttachRef.current?.markForgeAttachmentRemoved(attachment),
      });
      setSelectedAttachments(nextAttachments);
      setIsGithubPickerOpen(false);
      setGithubSearchQuery("");
    },
    [attachments, setSelectedAttachments, setGithubSearchQuery, setIsGithubPickerOpen],
  );

  const leftContent = useMemo(
    () =>
      renderLeftContent({
        agentControls,
        agentId,
        serverId,
        focusInput,
        isCompactLayout,
        showAgentControls: mode.showAgentControls,
      }),
    [agentControls, agentId, focusInput, isCompactLayout, mode.showAgentControls, serverId],
  );

  const handleAttachButtonRef = useCallback((node: View | null) => {
    attachButtonRef.current = node;
  }, []);

  const handleSelectionChange = useCallback(
    (selection: { start: number; end: number }) => {
      if (isWeb) {
        cursorPublication.stage(selection.start);
      } else {
        cursor.setState(selection.start);
      }
    },
    [cursorPublication, cursor],
  );

  const handleFocusChange = useCallback(
    (focused: boolean) => {
      setIsMessageInputFocused(focused);
      if (focused) {
        onAttentionInputFocus?.();
      }
    },
    [onAttentionInputFocus],
  );

  const handleLightboxClose = useCallback(() => {
    setLightboxMetadata(null);
  }, []);
  const lightboxSource = useMemo<ImageLightboxSource | null>(
    () => (lightboxMetadata ? { type: "attachment", metadata: lightboxMetadata } : null),
    [lightboxMetadata],
  );

  const handleGithubPickerOpenChange = useCallback(
    (open: boolean) => {
      setIsGithubPickerOpen(open);
      if (!open) {
        setGithubSearchQuery("");
      }
    },
    [setGithubSearchQuery],
  );

  const renderGithubPickerOption = useCallback(
    ({ option, active }: { option: ComboboxOption; selected: boolean; active: boolean }) => {
      const item = findForgeItemByOption(githubSearchItems, option.id);
      if (!item) {
        return <View key={option.id} />;
      }
      const selected = isAttachmentSelectedForForgeItem(selectedAttachments, item);
      return (
        <GithubPickerOption
          key={option.id}
          testID={`composer-github-option-${option.id}`}
          label={option.label}
          selected={selected}
          active={active}
          item={item}
          onToggle={handleToggleGithubItem}
        />
      );
    },
    [githubSearchItems, selectedAttachments, handleToggleGithubItem],
  );

  // Fullscreen fills the dock slot: the chain down to the input stretches and drops
  // the inline padding, which the fullscreen presentation supplies itself.
  const inputAreaContainerStyle = useMemo(
    () => [
      styles.inputAreaContainer,
      isComposerLocked && styles.inputAreaLocked,
      isFullscreen && styles.inputAreaFullscreen,
    ],
    [isComposerLocked, isFullscreen],
  );
  const inputAreaContentStyle = useMemo(
    () => [styles.inputAreaContent, isFullscreen && styles.fullscreenFill],
    [isFullscreen],
  );
  const messageInputContainerStyle = useMemo(
    () => [styles.messageInputContainer, isFullscreen && styles.fullscreenFill],
    [isFullscreen],
  );

  const attachmentTray = useMemo(
    () =>
      renderAttachmentTray({
        serverId,
        selectedAttachments,
        pendingFiles: pendingFilesForCurrentOwner,
        failedFiles: failedFilesForCurrentOwner,
        reviewableSubmissions,
        unresolvedSubmissionCheckpoint,
        isComposerLocked,
        handleOpenAttachment,
        handleRemoveAttachment,
        handleRetryFailedFile,
        handleRemoveFailedFile,
        handleInspectSubmission,
        labels: {
          openImage: t("composer.attachments.openImage"),
          removeImage: t("composer.attachments.removeImage"),
          removeFile: t("composer.attachments.removeFile"),
          openGithub: (kind: string, numberLabel: string) =>
            t("composer.attachments.openGithub", { kind, number: numberLabel }),
          removeGithub: (kind: string, numberLabel: string) =>
            t("composer.attachments.removeGithub", { kind, number: numberLabel }),
        },
      }),
    [
      handleOpenAttachment,
      handleRemoveAttachment,
      handleRetryFailedFile,
      handleRemoveFailedFile,
      handleInspectSubmission,
      isComposerLocked,
      serverId,
      selectedAttachments,
      pendingFilesForCurrentOwner,
      failedFilesForCurrentOwner,
      reviewableSubmissions,
      unresolvedSubmissionCheckpoint,
      t,
    ],
  );

  const queueList = useMemo(
    () =>
      renderQueueTrack({
        queuedMessages,
        handleEditQueuedMessage,
        handleSendQueuedNow,
        editLabel: t("composer.attachments.editQueuedMessage"),
        sendNowLabel: t("composer.attachments.sendQueuedMessageNow"),
      }),
    [handleEditQueuedMessage, handleSendQueuedNow, queuedMessages, t],
  );

  const autocompleteConfiguration = useMemo(
    () => ({
      setUserInput: replaceUserInput,
      serverId,
      agentId,
      draft: commandDraft,
      canExecuteClientSlashCommand: buildOutgoingAttachments(attachments).length === 0,
      onClientSlashCommand: runClientSlashCommand,
      pluginClientSlashCommands,
    }),
    [
      replaceUserInput,
      serverId,
      agentId,
      commandDraft,
      buildOutgoingAttachments,
      attachments,
      runClientSlashCommand,
      pluginClientSlashCommands,
    ],
  );

  const isSubmitLoadingVisible =
    isPreparingSubmission ||
    isProcessing ||
    isSubmitLoading ||
    isUploadingFile ||
    pendingNativeImagePastes > 0 ||
    pendingWebPastes > 0;
  const isSubmitDisabled =
    isSubmitLoadingVisible || (waitForForgeAutoAttachOnSubmit && isForgeResolving);

  // Disable drops while submitting/uploading: the submit path clears and restores attachments,
  // so a drop in that window would be lost or land on a locked draft. `disabled` hides the
  // backdrop and rejects the drop atomically, instead of accepting a drop with no feedback.
  useFileDrop(
    {
      onFiles: addImages,
      onGenericFiles: handleGenericFilesDropped,
      onWorkspaceFile: handleWorkspaceFileDropped,
    },
    { disabled: isSubmitLoadingVisible },
  );

  // Focusing the composer on a touch screen raises the on-screen keyboard over the conversation.
  const messageInputAutoFocus = autoFocus && isDesktopWebBreakpoint && hasFinePointer;
  const submitLoadingPressHandler = isAgentRunning ? handleCancelAgent : undefined;
  const sendErrorNode = useMemo(
    () =>
      sendError ? (
        <Text accessibilityRole="alert" style={styles.sendErrorText}>
          {sendError}
        </Text>
      ) : null,
    [sendError],
  );
  const handleClosePastedTextInspector = useCallback(() => {
    setPastedTextInspectorTarget(null);
  }, []);
  const handleCloseSubmissionRecoveryInspector = useCallback(() => {
    setSubmissionRecoveryInspectorTarget(null);
  }, []);
  const githubEmptyText = githubSearchResultsQuery.isFetching
    ? t("composer.github.searching")
    : t("composer.github.noResults");
  const recoveryInspectionDataSet = useMemo(
    () => (isWeb ? { submissionRecoveryState: recoveryInspectionState } : undefined),
    [recoveryInspectionState],
  );

  return (
    <>
      <ComposerKeyboardRegistration
        handlerId={keyboardHandlerIdRef.current}
        messageInputRef={messageInputRef}
        isAgentRunning={isAgentRunning}
        isCancellingAgent={isCancellingAgent}
        isConnected={isConnected}
        handleCancelAgent={handleCancelAgent}
        focusMessageInputForKeyboardAction={focusMessageInputForKeyboardAction}
        isMessageInputFocused={isMessageInputFocused}
      />
      <View
        testID="composer-root"
        dataSet={recoveryInspectionDataSet}
        style={
          isFullscreen ? animatedStaticStyles.fullscreenContainer : animatedStaticStyles.container
        }
      >
        <AttachmentLightbox source={lightboxSource} onClose={handleLightboxClose} />
        <PastedTextSheet
          target={pastedTextInspectorTarget}
          onClose={handleClosePastedTextInspector}
          onRemove={handleRemoveAttachment}
        />
        <SubmissionRecoverySheet
          record={submissionRecoveryInspectorTarget}
          onClose={handleCloseSubmissionRecoveryInspector}
          onDiscard={handleDiscardSubmissionRecovery}
          onRestore={handleRestoreSubmissionRecovery}
        />
        {/* Input area */}
        <View style={inputAreaContainerStyle}>
          <View style={inputAreaContentStyle}>
            {isFullscreen ? null : queueList}
            {!isFullscreen && sendErrorNode}

            <ComposerAutocompleteBinding
              text={textSource}
              cursor={cursor}
              recall={recall}
              inputRef={messageInputRef}
              anchorStyle={messageInputContainerStyle}
              show={mode.showAutocomplete && !isFullscreen}
              ref={autocompleteRef}
              configuration={autocompleteConfiguration}
            >
              <ComposerForgeBinding
                text={textSource}
                configuration={forgeConfiguration}
                ref={forgeAutoAttachRef}
                onResolvingChange={setIsForgeResolving}
              />

              {/* MessageInput handles everything: text, dictation, attachments, all buttons */}
              <RenderProfile id="MessageInput">
                <StableMessageInput
                  ref={messageInputRef}
                  editingSession={editingSession}
                  submissionError={sendErrorNode}
                  value={textSource.getSnapshot()}
                  onChangeText={setUserInput}
                  onSubmit={handleSubmit}
                  hasExternalContent={hasExternalContent}
                  allowEmptySubmit={allowEmptySubmit}
                  submitButtonAccessibilityLabel={submitButtonAccessibilityLabel}
                  submitButtonTestID={submitButtonTestID}
                  submitIcon={submitIcon}
                  isSubmitDisabled={isSubmitDisabled}
                  isSubmitLoading={isSubmitLoadingVisible}
                  preserveHeightOnSubmit={submitBehavior === "preserve-and-lock"}
                  attachments={selectedAttachments}
                  cwd={cwd}
                  attachmentMenuItems={attachmentMenuItems}
                  onAttachButtonRef={handleAttachButtonRef}
                  onWebPaste={handleWebPaste}
                  onPasteImages={handleNativePasteImages}
                  client={client}
                  isReadyForDictation={isDictationReady}
                  placeholder={messagePlaceholder}
                  autoFocus={messageInputAutoFocus}
                  autoFocusKey={`${serverId}:${agentId}:${autoFocusKey ?? ""}`}
                  disabled={isSubmitLoading}
                  leftContent={leftContent}
                  beforeVoiceContent={beforeVoiceContent}
                  rightContent={rightContent}
                  activeActionContent={activeActionContent}
                  voiceServerId={serverId}
                  voiceAgentId={agentId}
                  isAgentRunning={isAgentRunning}
                  defaultSendBehavior={activeSendBehavior}
                  sendShortcut={appSettings.sendShortcut}
                  onQueue={handleQueue}
                  onSubmitLoadingPress={submitLoadingPressHandler}
                  onKeyPress={handleCommandKeyPress}
                  onSelectionChange={handleSelectionChange}
                  onFocusChange={handleFocusChange}
                  onHeightChange={onComposerHeightChange}
                  inputWrapperStyle={inputWrapperStyle}
                  attachmentSlot={attachmentTray}
                  inputMode={inputMode}
                  readOnly={readOnly}
                  textReplacement={textReplacement}
                  submitLabel={submitLabel}
                />
              </RenderProfile>
              <Combobox
                options={githubSearchOptions}
                value=""
                onSelect={noop}
                keepOpenOnSelect
                searchable
                searchPlaceholder={t("composer.github.searchPlaceholder", {
                  context: forgePresentation.changeRequestContext,
                })}
                title={t("composer.github.title", {
                  context: forgePresentation.changeRequestContext,
                })}
                open={isGithubPickerOpen}
                onOpenChange={handleGithubPickerOpenChange}
                onSearchQueryChange={setGithubSearchQuery}
                desktopPlacement="top-start"
                anchorRef={attachButtonRef}
                emptyText={githubEmptyText}
                renderOption={renderGithubPickerOption}
              />
              {pluginAttachments.picker}
            </ComposerAutocompleteBinding>
          </View>
        </View>
      </View>
    </>
  );
}

const animatedStaticStyles = RNStyleSheet.create({
  container: {
    flexDirection: "column",
    // Propagate the viewport's height constraint down to the scrolling input.
    flexShrink: 1,
    position: "relative",
  },
  fullscreenContainer: {
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
});

const styles = StyleSheet.create((theme: Theme) => ({
  borderSeparator: {
    height: theme.borderWidth[1],
    backgroundColor: theme.colors.border,
  },
  inputAreaContainer: {
    flexShrink: 1,
    position: "relative",
    minHeight: FOOTER_HEIGHT,
    marginHorizontal: "auto",
    alignItems: "center",
    width: "100%",
    overflow: "visible",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  inputAreaLocked: {
    opacity: 0.6,
  },
  inputAreaFullscreen: {
    flex: 1,
    minHeight: 0,
    alignItems: "stretch",
    paddingHorizontal: 0,
    paddingBottom: 0,
  },
  fullscreenFill: {
    flex: 1,
    minHeight: 0,
    maxWidth: "100%",
  },
  inputAreaContent: {
    flexShrink: 1,
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    gap: theme.spacing[3],
  },
  messageInputContainer: {
    flexShrink: 1,
    position: "relative",
    width: "100%",
    gap: theme.spacing[3],
  },
  cancelButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.red[600],
    alignItems: "center",
    justifyContent: "center",
    marginLeft: theme.spacing[1],
  },
  rightControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  contextWindowMeterSlot: {
    width: 28,
    height: 28,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  realtimeVoiceButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  realtimeVoiceButtonCompactReserve: {
    marginLeft: theme.spacing[1],
  },
  realtimeVoiceButtonActive: {
    backgroundColor: theme.colors.palette.green[600],
    borderColor: theme.colors.palette.green[800],
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  attachmentTray: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  failedAttachment: {
    width: 260,
    maxWidth: "100%",
    gap: theme.spacing[1],
    alignItems: "flex-start",
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  queueTrack: {
    flexDirection: "column",
    gap: theme.spacing[2],
  },
  queueItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  queueText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  queueActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  queueActionButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
  queueSendButton: {
    backgroundColor: theme.colors.accent,
  },
  sendErrorText: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.base,
  },
})) as unknown as Record<string, object>;

const ThemedAttachmentSpinner = withUnistyles(LoadingSpinner);
const ThemedPencil = withUnistyles(Pencil);
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedAudioLines = withUnistyles(AudioLines);
const ThemedPaperclip = withUnistyles(Paperclip);
const ThemedImageIcon = withUnistyles(ImageIcon);
const ThemedClipboardPaste = withUnistyles(ClipboardPaste);
const ThemedFileText = withUnistyles(FileText);
const iconForegroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const iconForegroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const iconAccentForegroundMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });

function renderForgeAttachmentIcon(icon: string): ReactElement {
  return (
    <ForgeBrandIcon iconKind={icon} size={ICON_SIZE.md} uniProps={iconForegroundMutedMapping} />
  );
}

const githubPrPillIcon = (
  <ThemedGitPullRequest size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
);
const githubIssuePillIcon = (
  <ThemedCircleDot size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
);
const filePillIcon = <ThemedFileText size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />;

const pendingFilePillIcon = (
  <ThemedAttachmentSpinner size={18} uniProps={iconForegroundMutedMapping} />
);

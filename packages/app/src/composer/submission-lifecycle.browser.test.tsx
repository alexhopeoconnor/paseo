import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { flushDraftPersistStorageOrThrowMock } = vi.hoisted(() => ({
  flushDraftPersistStorageOrThrowMock: vi.fn(),
}));
const dictationTestState = vi.hoisted(() => ({
  isRecording: false,
  transcript: "",
  onTranscript: null as ((text: string, meta: { requestId: string }) => void) | null,
}));
const hostRuntimeTestState = vi.hoisted(() => ({
  client: null as unknown,
  isConnected: false,
}));

vi.mock("@/contexts/toast-context", () => ({
  ToastApiProvider: ({ children }: { children: React.ReactNode }) => children,
  useToast: () => ({ show: vi.fn(), copied: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/hooks/use-archive-agent", () => ({
  clearArchiveAgentPending: vi.fn(),
}));
// Fork navigation is outside this mounted submission/stream boundary.
vi.mock("@/hooks/use-fork-agent", () => ({
  useForkAgent: () => async () => undefined,
}));
vi.mock("react-native-unistyles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native-unistyles")>();
  return {
    ...actual,
    useUnistyles: () => {
      const { theme, ...rest } = actual.useUnistyles();
      return {
        ...rest,
        theme: {
          ...theme,
          colors: {
            ...theme.colors,
            palette: { ...theme.colors.palette, zinc: { 600: "#52525b" } },
          },
        },
      };
    },
  };
});
vi.mock("@/stores/draft-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/draft-store")>()),
  flushDraftPersistStorageOrThrow: flushDraftPersistStorageOrThrowMock,
}));
vi.mock("@/hooks/use-dictation", () => ({
  useDictation: (options: {
    onTranscript: (text: string, meta: { requestId: string }) => void;
  }) => {
    dictationTestState.onTranscript = options.onTranscript;
    return {
      isRecording: dictationTestState.isRecording,
      isRecordingActive: () => dictationTestState.isRecording,
      isProcessing: false,
      partialTranscript: "",
      volume: 0,
      duration: 0,
      error: null,
      status: dictationTestState.isRecording ? "recording" : "idle",
      startDictation: async () => undefined,
      cancelDictation: async () => undefined,
      confirmDictation: async () => {
        options.onTranscript(dictationTestState.transcript, { requestId: "test-dictation" });
      },
      retryFailedDictation: async () => undefined,
      discardFailedDictation: () => undefined,
      reset: () => undefined,
    };
  },
}));
vi.mock("@/runtime/host-runtime", () => {
  const connectionStatuses = new Map();
  const hosts: never[] = [];
  return {
    getHostRuntimeStore: () => ({
      beginAgentCancellation: () => "test-cancellation",
      settleAgentCancellation: () => undefined,
      getClient: () => hostRuntimeTestState.client,
      fetchAgentTimeline: async () => {
        throw new Error("Unexpected timeline fetch in submission fixture");
      },
    }),
    useHostRuntimeClient: () => hostRuntimeTestState.client,
    useHostRuntimeIsConnected: () => hostRuntimeTestState.isConnected,
    useHostRuntimeAgentDirectoryStatus: () => null,
    useHostRuntimeConnectionStatus: () => "offline",
    useHostRuntimeConnectionStatuses: () => connectionStatuses,
    useHostRuntimeSnapshot: () => null,
    useHostRuntimeLastError: () => null,
    useHostRuntimeIsDirectoryLoading: () => false,
    useHosts: () => hosts,
  };
});
vi.mock("@/git/use-status-query", () => ({
  useCheckoutStatusQuery: () => ({
    status: null,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
  }),
}));
vi.mock("@/git/use-pr-status-query", () => ({
  useCheckoutPrStatusQuery: () => ({
    status: null,
    githubFeaturesEnabled: true,
    authState: null,
    forge: "github",
    resolvedForge: null,
    payloadError: null,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
  }),
}));

import { ToastApiProvider } from "@/contexts/toast-api-context";
import { CommandCenterProvider } from "@/command-center/provider";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { KeyboardShiftProvider } from "@/keyboard/shift";
import type {
  AttachmentStore,
  ChatHistoryContextAttachment,
  ComposerAttachment,
  SaveAttachmentInput,
  UserComposerAttachment,
  WorkspaceComposerAttachment,
} from "@/attachments/types";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import type { ComposerTextSource } from "@/composer/text-source";
import {
  __setSubmissionRecoveryStoreForTests,
  createSubmissionRecoveryRecord,
  type SubmissionRecoveryLease,
  type SubmissionRecoveryRecord,
  type SubmissionRecoveryStore,
} from "@/stores/workspace-draft-submission-recovery";
import { resolveComposerSubmissionIdentity } from "@/composer/submission/recovery";
import { Composer } from "./index";
import { ComposerEditingSession } from "./editing-session";
import { persistPastedTextAttachment } from "./pasted-text-attachment";
import { useAgentInputDraft } from "./draft/input-draft";
import { useDraftStore } from "@/stores/draft-store";
import { selectAgentTurnPresentation, useSessionStore, type Agent } from "@/stores/session-store";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { i18n } from "@/i18n/i18next";
import { APP_SETTINGS_QUERY_KEY, DEFAULT_CLIENT_SETTINGS } from "@/hooks/use-settings/storage";
import { AgentStreamView } from "@/agent-stream/view";
import { RetainedPanel } from "@/components/retained-panel";
import { PaneFocusProvider, createPaneFocusContextValue } from "@/panels/pane-context";
import {
  getActiveMessageSubmissions,
  getPreparingClientMessageIds,
} from "@/composer/submission/model";
import { selectAgentTimelineTurnPresentation } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";

interface MutableTextSource {
  textSource: ComposerTextSource;
  set: (text: string) => void;
}

interface MutableAttachmentSource {
  getSnapshot: () => UserComposerAttachment[];
  subscribe: (listener: () => void) => () => void;
  set: (attachments: UserComposerAttachment[]) => void;
}

function createTextSource(initial: string): MutableTextSource {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    textSource: {
      getSnapshot: () => value,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    set: (next) => {
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

function createAttachmentSource(initial: UserComposerAttachment[] = []): MutableAttachmentSource {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

function createRunningAgent(agentId: string): Agent {
  return {
    serverId: "server",
    id: agentId,
    provider: "codex",
    status: "running",
    turn: {
      phase: "open",
      turnId: "running-turn",
      startedAt: new Date(0),
      cancellationRequestId: null,
    },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastUserMessageAt: null,
    lastActivityAt: new Date(0),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/repo",
    model: null,
    parentAgentId: null,
    labels: {},
  };
}

function replaceOpenAgentTurn(
  agents: Map<string, Agent>,
  agentId: string,
  turnId: string,
): Map<string, Agent> {
  const current = agents.get(agentId);
  if (!current || current.turn.phase !== "open") return agents;
  const next = new Map(agents);
  next.set(agentId, { ...current, turn: { ...current.turn, turnId } });
  return next;
}

function setOpenAgentTurn(agentId: string, turnId: string): void {
  useSessionStore
    .getState()
    .setAgents("server", (agents) => replaceOpenAgentTurn(agents, agentId, turnId));
}

function makeAgentRunning(agentId: string): void {
  const store = useSessionStore.getState();
  store.initializeSession("server", null as never);
  store.setAgents("server", new Map([[agentId, createRunningAgent(agentId)]]));
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function queueMicrotaskTurns(remaining: number, callback: () => void): void {
  if (remaining <= 0) {
    callback();
    return;
  }
  queueMicrotask(() => queueMicrotaskTurns(remaining - 1, callback));
}

function createAttachmentStoreForPaste(): {
  store: AttachmentStore;
  saved: SaveAttachmentInput[];
} {
  const saved: SaveAttachmentInput[] = [];
  const dataById = new Map<string, string>();
  let sequence = 0;
  return {
    saved,
    store: {
      storageType: "web-indexeddb",
      save: async (input) => {
        saved.push(input);
        if (input.source.kind !== "bytes") throw new Error("Expected pasted text bytes");
        const id = input.id ?? `pasted-${++sequence}`;
        dataById.set(id, btoa(String.fromCharCode(...input.source.bytes)));
        return {
          id,
          mimeType: input.mimeType ?? "text/plain",
          storageType: "web-indexeddb",
          storageKey: id,
          fileName: input.fileName ?? null,
          byteSize: input.source.bytes.byteLength,
          createdAt: 1,
        };
      },
      encodeBase64: async ({ attachment }) => {
        const data = dataById.get(attachment.storageKey);
        if (!data) throw new Error("Missing pasted attachment bytes");
        return data;
      },
      resolvePreviewUrl: async () => "blob:test",
      delete: async () => undefined,
      garbageCollect: async () => undefined,
    },
  };
}

function createRecoveryStore(input: {
  putGate: Promise<void>;
  onPut: (record: SubmissionRecoveryRecord) => void;
  onClaim?: () => void;
  markNeedsReviewGate?: Promise<void>;
  onMarkNeedsReview?: (record: SubmissionRecoveryRecord) => void;
  /** Simulates another tab completing a durable transition before our CAS discard. */
  onDiscardInspected?: (record: SubmissionRecoveryRecord) => SubmissionRecoveryRecord | void;
  initialRecords?: SubmissionRecoveryRecord[];
  listError?: Error;
}): SubmissionRecoveryStore {
  const records = new Map<string, SubmissionRecoveryRecord>(
    input.initialRecords?.map((record): [string, SubmissionRecoveryRecord] => [record.id, record]),
  );
  return {
    putIfAbsent: async (record) => {
      input.onPut(record);
      await input.putGate;
      const existing = records.get(record.id);
      if (existing) return existing;
      records.set(record.id, record);
      return record;
    },
    get: async (id) => records.get(id) ?? null,
    list: async () => {
      if (input.listError) throw input.listError;
      return Array.from(records.values());
    },
    discardQueued: async ({ id, clientMessageId, submission }) => {
      const record = records.get(id);
      if (!record) return { status: "missing" };
      if (record.state !== "queued") return { status: "not_queued", record };
      if (
        record.clientMessageId !== clientMessageId ||
        record.submission.text !== submission.text ||
        record.submission.attachments !== submission.attachments
      ) {
        return { status: "mismatch", record };
      }
      records.delete(id);
      return { status: "removed" };
    },
    claimForDispatch: async ({ id, ownerId, now, leaseMs }) => {
      input.onClaim?.();
      const record = records.get(id);
      if (!record) return { status: "missing" };
      if (record.state === "settled") return { status: "settled", record };
      if (record.state === "needs_review") return { status: "needs_review", record };
      if (record.state === "dispatching") return { status: "busy", record };
      const lease: SubmissionRecoveryLease = {
        ownerId,
        fence: `fence:${id}`,
        expiresAt: now + leaseMs,
      };
      const claimed: SubmissionRecoveryRecord = {
        ...record,
        revision: record.revision + 1,
        state: "dispatching",
        lease,
        dispatchLease: lease,
        updatedAt: now,
      };
      records.set(id, claimed);
      return { status: "acquired", record: claimed, lease };
    },
    markNeedsReview: async ({ id, lease, errorMessage, now }) => {
      if (input.markNeedsReviewGate) await input.markNeedsReviewGate;
      const record = records.get(id) ?? null;
      if (
        !record ||
        record.state === "settled" ||
        !lease ||
        record.lease?.ownerId !== lease.ownerId ||
        record.lease.fence !== lease.fence
      ) {
        return record;
      }
      const next: SubmissionRecoveryRecord = {
        ...record,
        revision: record.revision + 1,
        state: "needs_review",
        lease: null,
        dispatchLease: record.dispatchLease ?? lease,
        errorMessage,
        updatedAt: now,
      };
      records.set(id, next);
      input.onMarkNeedsReview?.(next);
      return next;
    },
    markSettled: async ({ id, lease, now }) => {
      const record = records.get(id) ?? null;
      if (
        !record ||
        record.state === "settled" ||
        !lease ||
        (record.lease?.fence !== lease.fence && record.dispatchLease?.fence !== lease.fence)
      ) {
        return record;
      }
      const next: SubmissionRecoveryRecord = {
        ...record,
        revision: record.revision + 1,
        state: "settled",
        lease: null,
        acceptedAt: now,
        updatedAt: now,
      };
      records.set(id, next);
      return next;
    },
    discardInspected: async ({ id, expectedRevision, expectedClientMessageId }) => {
      let record = records.get(id);
      if (!record) return { status: "missing" };
      const raced = input.onDiscardInspected?.(record);
      if (raced) {
        record = raced;
        records.set(id, record);
      }
      if (
        record.revision !== expectedRevision ||
        record.clientMessageId !== expectedClientMessageId ||
        record.state !== "queued" ||
        record.lease !== null ||
        record.dispatchLease
      ) {
        return { status: "changed", record };
      }
      records.delete(id);
      return { status: "removed" };
    },
  };
}

interface ComposerRenderInput {
  agentId: string;
  persistedDraftKey?: string;
  source: MutableTextSource;
  attachmentSource?: MutableAttachmentSource;
  onSubmit: (payload: { text: string; attachments: ComposerAttachment[] }) => Promise<void>;
  clearDraft?: () => void;
  allowEmptySubmit?: boolean;
  hasExternalContent?: boolean;
  attachmentScopeKeys?: readonly string[];
  sendBehavior?: "interrupt" | "steer" | "queue";
  editingSession?: ComposerEditingSession;
  /** Exercise the actual host client path instead of the controlled parent submitter. */
  runtimeSubmit?: boolean;
  withStream?: boolean;
  streamActive?: boolean;
  holdStreamTuple?: boolean;
}

interface MountedComposer {
  root: Root;
  container: HTMLDivElement;
  render: (input: ComposerRenderInput) => void;
}

const mounted: MountedComposer[] = [];

function PersistedDraftComposer({
  agentId,
  draftKey,
  onSubmit,
  allowEmptySubmit = false,
  hasExternalContent = false,
  attachmentScopeKeys,
  editingSession,
  runtimeSubmit = false,
}: Pick<
  ComposerRenderInput,
  | "agentId"
  | "onSubmit"
  | "allowEmptySubmit"
  | "hasExternalContent"
  | "attachmentScopeKeys"
  | "editingSession"
  | "runtimeSubmit"
> & { draftKey: string }) {
  const draft = useAgentInputDraft({ draftKey });
  return (
    <Composer
      isPaneFocused
      serverId="server"
      agentId={agentId}
      workspaceId="workspace"
      cwd="/repo"
      textSource={draft.textSource}
      onChangeText={draft.editText}
      textReplacement={draft.textReplacement}
      attachments={draft.attachments}
      onChangeAttachments={draft.setAttachments}
      clearDraft={draft.clear}
      submissionBinding={draft.submissionBinding}
      submissionSnapshot={draft.submissionSnapshot}
      {...(runtimeSubmit ? {} : { onSubmitMessage: onSubmit })}
      allowEmptySubmit={allowEmptySubmit}
      hasExternalContent={hasExternalContent}
      attachmentScopeKeys={attachmentScopeKeys}
      editingSession={editingSession}
      submitButtonTestID="submit"
    />
  );
}
const testToastApi = {
  show: () => () => undefined,
  copied: () => undefined,
  error: () => undefined,
};

function disposeComposer(entry: MountedComposer): void {
  const index = mounted.indexOf(entry);
  if (index >= 0) mounted.splice(index, 1);
  act(() => entry.root.unmount());
  entry.container.remove();
}

function ControlledComposer({
  agentId,
  source,
  attachmentSource,
  onSubmit,
  clearDraft,
  allowEmptySubmit = false,
  hasExternalContent = false,
  attachmentScopeKeys,
  editingSession,
  runtimeSubmit = false,
}: ComposerRenderInput) {
  const fallbackAttachmentSource = React.useMemo(() => createAttachmentSource(), []);
  const resolvedAttachmentSource = attachmentSource ?? fallbackAttachmentSource;
  const attachments = React.useSyncExternalStore(
    resolvedAttachmentSource.subscribe,
    resolvedAttachmentSource.getSnapshot,
    resolvedAttachmentSource.getSnapshot,
  );
  const textReplacement = React.useMemo(
    () => ({
      kind: "initial" as const,
      key: `${agentId}:initial`,
      text: source.textSource.getSnapshot(),
    }),
    [agentId, source],
  );
  const handleChangeAttachments = React.useCallback(
    (
      updater:
        | UserComposerAttachment[]
        | ((current: UserComposerAttachment[]) => UserComposerAttachment[]),
    ) => {
      const current = resolvedAttachmentSource.getSnapshot();
      resolvedAttachmentSource.set(typeof updater === "function" ? updater(current) : updater);
    },
    [resolvedAttachmentSource],
  );
  const handleClearDraft = React.useCallback(() => {
    if (clearDraft) {
      clearDraft();
      return;
    }
    source.set("");
  }, [clearDraft, source]);
  const handleSubmitMessage = React.useCallback(
    (
      payload: Parameters<NonNullable<React.ComponentProps<typeof Composer>["onSubmitMessage"]>>[0],
    ) => onSubmit(payload),
    [onSubmit],
  );
  return (
    <Composer
      isPaneFocused
      serverId="server"
      agentId={agentId}
      workspaceId="workspace"
      cwd="/repo"
      textSource={source.textSource}
      onChangeText={source.set}
      textReplacement={textReplacement}
      attachments={attachments}
      onChangeAttachments={handleChangeAttachments}
      clearDraft={handleClearDraft}
      {...(runtimeSubmit ? {} : { onSubmitMessage: handleSubmitMessage })}
      allowEmptySubmit={allowEmptySubmit}
      hasExternalContent={hasExternalContent}
      attachmentScopeKeys={attachmentScopeKeys}
      editingSession={editingSession}
      submitButtonTestID="submit"
    />
  );
}

const EMPTY_TEST_STREAM: StreamItem[] = [];
const TEST_PANE_FOCUS = createPaneFocusContextValue({
  isWorkspaceFocused: true,
  isPaneFocused: true,
});
const EMPTY_TEST_PERMISSIONS = new Map();
const TEST_STREAM_STYLE = { height: 320, width: 720 };

/** Real stream view fed from one session snapshot, beside the real composer. */
function MountedSubmissionStream({
  agentId,
  active,
  hold,
}: {
  agentId: string;
  active: boolean;
  hold: boolean;
}) {
  const context = React.useMemo(
    () => ({
      serverId: "server",
      id: agentId,
      status: "idle" as const,
      cwd: "/repo",
      workspaceId: "workspace",
    }),
    [agentId],
  );
  const session = useSessionStore((state) => state.sessions.server);
  const submissions = session?.messageSubmissions.get(agentId);
  const tail = session?.agentStreamTail.get(agentId) ?? EMPTY_TEST_STREAM;
  const head = session?.agentStreamHead.get(agentId) ?? EMPTY_TEST_STREAM;
  const current = {
    tail,
    head,
    pending: getActiveMessageSubmissions(submissions),
    preparing: getPreparingClientMessageIds(submissions),
    turn: selectAgentTimelineTurnPresentation(session, agentId),
  };
  const held = React.useRef(current);
  if (!hold) held.current = current;
  const shown = hold ? held.current : current;
  return (
    <PaneFocusProvider value={TEST_PANE_FOCUS}>
      <RetainedPanel active={active} style={TEST_STREAM_STYLE} testID="submission-test-stream">
        <AgentStreamView
          agentId={agentId}
          serverId="server"
          context={context}
          streamItems={shown.tail}
          streamHead={shown.head}
          pendingPermissions={EMPTY_TEST_PERMISSIONS}
          pendingMessageSubmissions={shown.pending}
          preparingClientMessageIds={shown.preparing}
          turnPresentation={shown.turn}
        />
      </RetainedPanel>
    </PaneFocusProvider>
  );
}

function mountComposer(): MountedComposer {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const render: MountedComposer["render"] = ({
    agentId,
    persistedDraftKey,
    source,
    attachmentSource,
    onSubmit,
    clearDraft,
    allowEmptySubmit,
    hasExternalContent,
    attachmentScopeKeys,
    sendBehavior,
    editingSession,
    runtimeSubmit,
    withStream,
    streamActive = true,
    holdStreamTuple = false,
  }) => {
    if (sendBehavior) {
      queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, {
        ...DEFAULT_CLIENT_SETTINGS,
        sendBehavior,
      });
    }
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CommandCenterProvider>
            <KeyboardActionDispatcherProvider>
              <KeyboardShiftProvider>
                <ToastApiProvider api={testToastApi}>
                  {withStream ? (
                    <MountedSubmissionStream
                      agentId={agentId}
                      active={streamActive}
                      hold={holdStreamTuple}
                    />
                  ) : null}
                  {persistedDraftKey ? (
                    <PersistedDraftComposer
                      agentId={agentId}
                      draftKey={persistedDraftKey}
                      onSubmit={onSubmit}
                      allowEmptySubmit={allowEmptySubmit}
                      hasExternalContent={hasExternalContent}
                      attachmentScopeKeys={attachmentScopeKeys}
                      editingSession={editingSession}
                      runtimeSubmit={runtimeSubmit}
                    />
                  ) : (
                    <ControlledComposer
                      agentId={agentId}
                      source={source}
                      attachmentSource={attachmentSource}
                      onSubmit={onSubmit}
                      clearDraft={clearDraft}
                      allowEmptySubmit={allowEmptySubmit}
                      hasExternalContent={hasExternalContent}
                      attachmentScopeKeys={attachmentScopeKeys}
                      editingSession={editingSession}
                      runtimeSubmit={runtimeSubmit}
                    />
                  )}
                </ToastApiProvider>
              </KeyboardShiftProvider>
            </KeyboardActionDispatcherProvider>
          </CommandCenterProvider>
        </QueryClientProvider>,
      );
    });
  };
  const result = { root, container, render };
  mounted.push(result);
  return result;
}

async function settleReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitForStreamPaint(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for composer browser condition");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function waitForReact(predicate: () => boolean): Promise<void> {
  await act(async () => {
    await waitFor(predicate);
  });
}

function submitButton(container: HTMLElement): HTMLElement {
  const button = container.querySelector('[data-testid="submit"]');
  if (!(button instanceof HTMLElement)) throw new Error("submit button not found");
  return button;
}

function dictationInsertAndSendButton(container: HTMLElement): HTMLElement {
  const label = i18n.t("message.dictation.insertAndSend");
  const button = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error("dictation insert-and-send button not found");
  return button;
}

function pasteFile(container: HTMLElement, file: File): ClipboardEvent {
  const textarea = container.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("composer textarea not found");
  const clipboardData = new DataTransfer();
  clipboardData.items.add(file);
  const event = new ClipboardEvent("paste", {
    clipboardData,
    bubbles: true,
    cancelable: true,
  });
  act(() => textarea.dispatchEvent(event));
  return event;
}

function pasteText(container: HTMLElement, text: string): ClipboardEvent {
  const textarea = container.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("composer textarea not found");
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  const event = new ClipboardEvent("paste", {
    clipboardData,
    bubbles: true,
    cancelable: true,
  });
  act(() => textarea.dispatchEvent(event));
  return event;
}

function replaceInputText(container: HTMLElement, text: string): void {
  const textarea = container.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("composer textarea not found");
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setValue) throw new Error("textarea value setter not found");
  act(() => {
    setValue.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  flushDraftPersistStorageOrThrowMock.mockReset();
  flushDraftPersistStorageOrThrowMock.mockResolvedValue(undefined);
  dictationTestState.isRecording = false;
  dictationTestState.transcript = "";
  dictationTestState.onTranscript = null;
  hostRuntimeTestState.client = null;
  hostRuntimeTestState.isConnected = false;
  useWorkspaceAttachmentsStore.setState({ attachmentsByScope: {} });
});

afterEach(() => {
  __setSubmissionRecoveryStoreForTests(null);
  __setAttachmentStoreForTests(null);
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe("Composer submission lifecycle", () => {
  it("keeps a Ctrl+Enter queue draft until its durable reservation is accepted", async () => {
    const reservation = createDeferred<void>();
    const records: SubmissionRecoveryRecord[] = [];
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({
        putGate: reservation.promise,
        onPut: (record) => records.push(record),
      }),
    );
    makeAgentRunning("agent-a");
    const source = createTextSource("queue after durable reservation");
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();

    try {
      composer.render({ agentId: "agent-a", source, onSubmit });
      await settleReact();
      const textarea = composer.container.querySelector("textarea");
      if (!(textarea instanceof HTMLTextAreaElement))
        throw new Error("composer textarea not found");

      // This is the keyboard route used by Ctrl/Cmd+Enter while a turn runs.
      // The durable put is intentionally held so a premature input clear would
      // invalidate the snapshot before queue insertion.
      act(() => {
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await waitForReact(() => records.length === 1);
      expect(source.textSource.getSnapshot()).toBe("queue after durable reservation");
      expect(textarea.value).toBe("queue after durable reservation");
      const queuedBeforeReservation =
        useSessionStore.getState().sessions.server?.queuedMessages.get("agent-a") ?? [];
      expect(queuedBeforeReservation).toEqual([]);

      await act(async () => reservation.resolve());
      await waitForReact(() => {
        const queued =
          useSessionStore.getState().sessions.server?.queuedMessages.get("agent-a") ?? [];
        return queued.length === 1;
      });
      expect(source.textSource.getSnapshot()).toBe("");
      expect(textarea.value).toBe("");
      expect(useSessionStore.getState().sessions.server?.queuedMessages.get("agent-a")).toEqual([
        expect.objectContaining({ text: "queue after durable reservation" }),
      ]);
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      useSessionStore.getState().clearSession("server");
    }
  });

  it("keeps an Insert-and-send dictation transcript until its queued checkpoint is durable", async () => {
    const reservation = createDeferred<void>();
    const records: SubmissionRecoveryRecord[] = [];
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({
        putGate: reservation.promise,
        onPut: (record) => records.push(record),
      }),
    );
    const draftKey = "test:dictation-queue-durable";
    const initialText = "typed context";
    const transcript = "spoken queue follow-up";
    useDraftStore
      .getState()
      .saveDraftInput({ draftKey, draft: { text: initialText, attachments: [] } });
    makeAgentRunning("agent-a");
    dictationTestState.isRecording = true;
    dictationTestState.transcript = transcript;
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();

    try {
      composer.render({
        agentId: "agent-a",
        source: createTextSource(""),
        persistedDraftKey: draftKey,
        onSubmit,
        sendBehavior: "queue",
      });
      await settleReact();

      await act(async () => {
        dictationInsertAndSendButton(composer.container).click();
      });
      await waitForReact(() => records.length === 1);

      const queuedText = `${initialText} ${transcript}`;
      const textarea = composer.container.querySelector("textarea");
      if (!(textarea instanceof HTMLTextAreaElement))
        throw new Error("composer textarea not found");
      expect(useDraftStore.getState().getDraftInput(draftKey)?.text).toBe(queuedText);
      expect(textarea.value).toBe(queuedText);
      expect(
        useSessionStore.getState().sessions.server?.queuedMessages.get("agent-a") ?? [],
      ).toEqual([]);

      await act(async () => reservation.resolve());
      await waitForReact(
        () =>
          (useSessionStore.getState().sessions.server?.queuedMessages.get("agent-a") ?? [])
            .length === 1,
      );

      expect(useDraftStore.getState().drafts[draftKey]).toEqual(
        expect.objectContaining({ lifecycle: "sent", input: { text: "", attachments: [] } }),
      );
      expect(useDraftStore.getState().getDraftInput(draftKey)).toBeUndefined();
      expect(textarea.value).toBe("");
      expect(useSessionStore.getState().sessions.server?.queuedMessages.get("agent-a")).toEqual([
        expect.objectContaining({
          text: queuedText,
          clientMessageId: records[0]?.clientMessageId,
          submissionRecoveryId: records[0]?.id,
        }),
      ]);
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      useSessionStore.getState().clearSession("server");
    }
  });

  it("keeps an Insert-and-send dictation transcript visible when its queued reservation fails", async () => {
    const reservation = createDeferred<void>();
    const records: SubmissionRecoveryRecord[] = [];
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({
        putGate: reservation.promise,
        onPut: (record) => records.push(record),
      }),
    );
    const draftKey = "test:dictation-queue-reservation-failure";
    const initialText = "typed context";
    const transcript = "spoken queue follow-up";
    const queuedText = `${initialText} ${transcript}`;
    useDraftStore
      .getState()
      .saveDraftInput({ draftKey, draft: { text: initialText, attachments: [] } });
    makeAgentRunning("agent-a");
    dictationTestState.isRecording = true;
    dictationTestState.transcript = transcript;
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();

    try {
      composer.render({
        agentId: "agent-a",
        source: createTextSource(""),
        persistedDraftKey: draftKey,
        onSubmit,
        sendBehavior: "queue",
      });
      await settleReact();

      await act(async () => {
        dictationInsertAndSendButton(composer.container).click();
      });
      await waitForReact(() => records.length === 1);

      const heldTextarea = composer.container.querySelector("textarea");
      if (!(heldTextarea instanceof HTMLTextAreaElement)) {
        throw new Error("composer textarea not found");
      }
      expect(useDraftStore.getState().getDraftInput(draftKey)?.text).toBe(queuedText);
      expect(heldTextarea.value).toBe(queuedText);
      expect(
        useSessionStore.getState().sessions.server?.queuedMessages.get("agent-a") ?? [],
      ).toEqual([]);

      await act(async () =>
        reservation.reject(new Error("dictation queue reservation unavailable")),
      );
      await waitForReact(
        () =>
          composer.container
            .querySelector('[data-testid="composer-root"]')
            ?.textContent?.includes("dictation queue reservation unavailable") ?? false,
      );

      const textarea = composer.container.querySelector("textarea");
      if (!(textarea instanceof HTMLTextAreaElement))
        throw new Error("composer textarea not found");
      expect(useDraftStore.getState().getDraftInput(draftKey)?.text).toBe(queuedText);
      expect(textarea.value).toBe(queuedText);
      expect(
        useSessionStore.getState().sessions.server?.queuedMessages.get("agent-a") ?? [],
      ).toEqual([]);
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      useSessionStore.getState().clearSession("server");
    }
  });

  it("keeps the full upload error readable beside the retry action", async () => {
    const fileName = "large-evidence-attachment-for-the-upload-error.txt";
    const message = i18n.t("composer.errors.fileTooLarge", { size: "50MB", fileName });
    const uploadFile = vi.fn(async () => ({ error: message }));
    hostRuntimeTestState.client = {
      isConnected: true,
      uploadFile,
      subscribeRawMessages: () => () => undefined,
      subscribeConnectionStatus: () => () => undefined,
      on: () => () => undefined,
    };
    hostRuntimeTestState.isConnected = true;
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: Promise.resolve(), onPut: () => {} }),
    );
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      onSubmit: vi.fn(async () => undefined),
    });
    await settleReact();
    pasteFile(composer.container, new File(["fixture"], fileName, { type: "text/plain" }));
    await waitForReact(() => uploadFile.mock.calls.length === 1);
    await settleReact();
    const error = composer.container.querySelector(
      '[data-testid="composer-file-attachment-error"]',
    );
    if (!(error instanceof HTMLElement)) throw new Error("Full upload error not found");
    expect(error.textContent).toBe(message);
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.scrollHeight).toBeLessThanOrEqual(error.clientHeight + 1);
    expect(error.scrollWidth).toBeLessThanOrEqual(error.clientWidth + 1);
    expect(error.getBoundingClientRect().height).toBeGreaterThan(24);
    expect(
      composer.container
        .querySelector('[data-testid="composer-failed-file-attachment"]')
        ?.getAttribute("aria-label"),
    ).toBe(`Retry ${fileName}: ${message}`);
  });

  it("keeps a newly added attachment while an accepted send is awaiting acknowledgement", async () => {
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: Promise.resolve(), onPut: () => {} }),
    );
    const { store } = createAttachmentStoreForPaste();
    __setAttachmentStoreForTests(store);
    const pasted = await persistPastedTextAttachment({
      text: "same payload",
      codePointCount: 12,
      logicalLineCount: 1,
    });
    const draftKey = "test:retain-newer-attachment";
    useDraftStore
      .getState()
      .saveDraftInput({ draftKey, draft: { text: "first message", attachments: [pasted] } });
    const gate = createDeferred<void>();
    const onSubmit = vi.fn(() => gate.promise);
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit,
    });
    await settleReact();
    act(() => submitButton(composer.container).click());
    await waitForReact(() => onSubmit.mock.calls.length === 1);
    expect(useDraftStore.getState().drafts[draftKey]?.input.attachments).toEqual([]);
    // A distinct occurrence of even the same bytes belongs to the next draft.
    const newerAttachment = { ...pasted };
    act(() =>
      useDraftStore
        .getState()
        .saveDraftInput({ draftKey, draft: { text: "", attachments: [newerAttachment] } }),
    );
    await settleReact();
    await act(async () => gate.resolve());
    await settleReact();
    expect(useDraftStore.getState().getDraftInput(draftKey)?.attachments).toEqual([
      newerAttachment,
    ]);
  });

  it("clears sent images and pasted text through the real draft hook before the next send", async () => {
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: Promise.resolve(), onPut: () => {} }),
    );
    const { store } = createAttachmentStoreForPaste();
    __setAttachmentStoreForTests(store);
    const image: UserComposerAttachment = {
      kind: "image",
      metadata: await store.save({
        mimeType: "image/png",
        source: { kind: "bytes", bytes: new Uint8Array([1, 2, 3]) },
      }),
    };
    const pasted = await persistPastedTextAttachment({
      text: "pasted context",
      codePointCount: 14,
      logicalLineCount: 1,
    });
    const draftKey = "test:clear-sent-attachments";
    useDraftStore
      .getState()
      .saveDraftInput({ draftKey, draft: { text: "first message", attachments: [image, pasted] } });
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit,
    });
    await settleReact();
    act(() => submitButton(composer.container).click());
    await waitForReact(() => onSubmit.mock.calls.length === 1);
    await settleReact();
    expect(onSubmit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "first message", attachments: [image, pasted] }),
    );
    expect(useDraftStore.getState().drafts[draftKey]?.lifecycle).toBe("sent");
    expect(useDraftStore.getState().drafts[draftKey]?.input.attachments).toEqual([]);
    expect(
      composer.container.querySelectorAll('[data-testid="composer-pasted-text-attachment-pill"]'),
    ).toHaveLength(0);

    replaceInputText(composer.container, "second message");
    await settleReact();
    act(() => submitButton(composer.container).click());
    await waitForReact(() => onSubmit.mock.calls.length === 2);
    expect(onSubmit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "second message", attachments: [] }),
    );
  });

  it("accepts only one same-tick caller submit while durable preparation is pending", async () => {
    const gate = createDeferred<void>();
    const onPut = vi.fn();
    __setSubmissionRecoveryStoreForTests(createRecoveryStore({ putGate: gate.promise, onPut }));
    const source = createTextSource("send once");
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({ agentId: "agent-a", source, onSubmit });
    await settleReact();

    const button = submitButton(composer.container);
    act(() => {
      button.click();
      button.click();
    });
    await settleReact();
    expect(onPut).toHaveBeenCalledTimes(1);

    gate.resolve();
    await settleReact();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ text: "send once" }));
  });

  it("presents a direct plain submission immediately but keeps its source until durable reservation", async () => {
    const reservation = createDeferred<void>();
    const onPut = vi.fn();
    const sendAgentMessage = vi.fn(async () => undefined);
    const client = { sendAgentMessage };
    const source = createTextSource("show before durable reservation");
    const composer = mountComposer();
    const expectedError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sessionStore = useSessionStore.getState();
    sessionStore.clearSession("server");
    sessionStore.initializeSession("server", client as never);
    sessionStore.updateSessionServerInfo("server", {
      serverId: "server",
      hostname: null,
      version: "0.2.6",
      features: { canonicalSubmittedPrompts: true },
    });
    hostRuntimeTestState.client = client;
    hostRuntimeTestState.isConnected = true;
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: reservation.promise, onPut }),
    );

    try {
      composer.render({
        agentId: "agent-a",
        source,
        onSubmit: vi.fn(async () => undefined),
        runtimeSubmit: true,
        withStream: true,
      });
      await waitForReact(
        () =>
          composer.container
            .querySelector('[data-testid="composer-root"]')
            ?.getAttribute("data-submission-recovery-state") === "ready",
      );

      act(() => submitButton(composer.container).click());
      await waitForReact(() => onPut.mock.calls.length === 1);
      await waitForReact(() => {
        const submissions =
          useSessionStore.getState().sessions.server?.messageSubmissions.get("agent-a") ?? [];
        return submissions.length === 1 && submissions[0]?.presentation?.phase === "preparing";
      });

      expect(
        selectAgentTurnPresentation(useSessionStore.getState().sessions.server, "agent-a").isActive,
      ).toBe(false);

      const visibleRow =
        useSessionStore.getState().sessions.server?.agentStreamTail.get("agent-a") ?? [];
      expect(visibleRow).toMatchObject([
        { kind: "user_message", text: "show before durable reservation" },
      ]);
      expect(source.textSource.getSnapshot()).toBe("show before durable reservation");
      const textarea = composer.container.querySelector("textarea");
      if (!(textarea instanceof HTMLTextAreaElement))
        throw new Error("composer textarea not found");
      expect(textarea.value).toBe("");
      expect(textarea.readOnly).toBe(true);
      expect(submitButton(composer.container).querySelector('[role="progressbar"]')).not.toBeNull();
      await waitForStreamPaint();
      expect(composer.container.querySelector('[aria-label="Stop agent"]')).toBeNull();
      expect(sendAgentMessage).not.toHaveBeenCalled();
      expect(composer.container.querySelector('[data-testid="user-message"]')).toBeNull();

      await act(async () => reservation.reject(new Error("reservation unavailable")));
      await waitForReact(() => {
        const submissions =
          useSessionStore.getState().sessions.server?.messageSubmissions.get("agent-a") ?? [];
        return submissions.length === 0;
      });

      expect(source.textSource.getSnapshot()).toBe("show before durable reservation");
      expect(textarea.value).toBe("show before durable reservation");
      expect(
        useSessionStore.getState().sessions.server?.agentStreamTail.get("agent-a") ?? [],
      ).toEqual([]);
      expect(sendAgentMessage).not.toHaveBeenCalled();

      // No canonical A was admitted during this failed preflight. Replacing
      // the transiently unavailable recovery backend must permit the same
      // retained source to make a normal new attempt rather than treating the
      // old aborted preparation as a permanent collision.
      const retryPut = vi.fn();
      __setSubmissionRecoveryStoreForTests(
        createRecoveryStore({ putGate: Promise.resolve(), onPut: retryPut }),
      );
      act(() => submitButton(composer.container).click());
      await waitForReact(() => retryPut.mock.calls.length === 1);
      await waitForReact(() => sendAgentMessage.mock.calls.length === 1);
      expect(source.textSource.getSnapshot()).toBe("");
    } finally {
      expectedError.mockRestore();
      useSessionStore.getState().clearSession("server");
    }
  });

  it("reveals a durably promoted row and working state after a retained preflight", async () => {
    const reservation = createDeferred<void>();
    const sent = createDeferred<void>();
    const records: SubmissionRecoveryRecord[] = [];
    const onClaim = vi.fn();
    const sendAgentMessage = vi.fn(async () => await sent.promise);
    const client = { sendAgentMessage };
    const source = createTextSource("promote after retained preflight");
    const composer = mountComposer();
    const store = useSessionStore.getState();
    store.clearSession("server");
    store.initializeSession("server", client as never);
    store.updateSessionServerInfo("server", {
      serverId: "server",
      hostname: null,
      version: "0.2.6",
      features: { canonicalSubmittedPrompts: true },
    });
    hostRuntimeTestState.client = client;
    hostRuntimeTestState.isConnected = true;
    const recoveryStore = createRecoveryStore({
      putGate: reservation.promise,
      onPut: (record) => records.push(record),
      onClaim,
    });
    __setSubmissionRecoveryStoreForTests(recoveryStore);
    const render = (streamActive: boolean, holdStreamTuple = false) =>
      composer.render({
        agentId: "agent-a",
        source,
        onSubmit: vi.fn(async () => undefined),
        runtimeSubmit: true,
        withStream: true,
        streamActive,
        holdStreamTuple,
      });

    try {
      render(true);
      await waitForReact(
        () =>
          composer.container
            .querySelector('[data-testid="composer-root"]')
            ?.getAttribute("data-submission-recovery-state") === "ready",
      );
      act(() => submitButton(composer.container).click());
      await waitForReact(() => records.length === 1);
      await waitForReact(
        () =>
          useSessionStore.getState().sessions.server?.messageSubmissions.get("agent-a")?.[0]
            ?.presentation?.phase === "preparing",
      );
      const row = useSessionStore.getState().sessions.server?.agentStreamTail.get("agent-a")?.[0];
      expect(row).toMatchObject({ kind: "user_message", text: "promote after retained preflight" });
      expect(records[0].clientMessageId).toBe(
        row?.kind === "user_message" ? row.clientMessageId : null,
      );
      expect(source.textSource.getSnapshot()).toBe("promote after retained preflight");
      expect(submitButton(composer.container).querySelector('[role="progressbar"]')).not.toBeNull();
      await waitForStreamPaint();
      expect(composer.container.querySelector('[aria-label="Stop agent"]')).toBeNull();
      expect(onClaim).not.toHaveBeenCalled();
      expect(await recoveryStore.get(records[0].id)).toBeNull();
      expect(sendAgentMessage).not.toHaveBeenCalled();
      expect(composer.container.querySelector('[data-testid="user-message"]')).toBeNull();

      // Hold the last coherent preparing tuple, then promote while hidden.
      render(false, true);
      await act(async () => reservation.resolve());
      await waitForReact(() => sendAgentMessage.mock.calls.length === 1);
      expect(onClaim).toHaveBeenCalledTimes(1);
      expect(await recoveryStore.get(records[0].id)).toMatchObject({
        state: "dispatching",
        clientMessageId: records[0].clientMessageId,
      });
      expect(useSessionStore.getState().sessions.server?.agentStreamTail.get("agent-a")?.[0]).toBe(
        row,
      );
      expect(composer.container.querySelector('[data-testid="user-message"]')).toBeNull();
      render(true, true);
      await settleReact();
      expect(composer.container.querySelector('[data-testid="user-message"]')).toBeNull();
      // Deliver fresh promoted props while inactive: the view must retain the
      // previous hidden snapshot until the panel is actually revealed.
      render(false);
      await settleReact();
      expect(composer.container.querySelector('[data-testid="user-message"]')).toBeNull();
      render(true);
      await waitForReact(
        () => composer.container.querySelectorAll('[data-testid="user-message"]').length === 1,
      );
      expect(
        composer.container.querySelector('[data-testid="user-message"]')?.textContent,
      ).toContain("promote after retained preflight");
      expect(
        composer.container.querySelector('[data-testid="turn-working-indicator"]'),
      ).not.toBeNull();
      expect(composer.container.querySelector('[aria-label="Stop agent"]')).not.toBeNull();
      expect(sendAgentMessage).toHaveBeenCalledTimes(1);
      await act(async () => sent.resolve());
    } finally {
      useSessionStore.getState().clearSession("server");
    }
  });

  it("clears the native editor after durable bind when a controlled owner publishes its target next turn", async () => {
    const source = createTextSource("controlled source publishes later");
    let pendingText: string | undefined;
    const delayedSource: MutableTextSource & { publish: () => void } = {
      textSource: source.textSource,
      set: (text) => {
        pendingText = text;
      },
      publish: () => {
        if (pendingText === undefined) throw new Error("Expected a controlled publication");
        source.set(pendingText);
        pendingText = undefined;
      },
    };
    const submitted = createDeferred<void>();
    const onSubmit = vi.fn(async () => await submitted.promise);
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: Promise.resolve(), onPut: () => {} }),
    );
    const composer = mountComposer();

    try {
      composer.render({ agentId: "agent-a", source: delayedSource, onSubmit });
      await settleReact();
      act(() => submitButton(composer.container).click());
      await waitForReact(() => onSubmit.mock.calls.length === 1);

      // The raw owner callback has not published yet, but the exact durable
      // CAS has. The native surface must clear without going through the
      // public source-lock callback.
      expect(source.textSource.getSnapshot()).toBe("controlled source publishes later");
      const textarea = composer.container.querySelector("textarea");
      if (!(textarea instanceof HTMLTextAreaElement))
        throw new Error("composer textarea not found");
      expect(textarea.value).toBe("");

      act(() => delayedSource.publish());
      await act(async () => submitted.resolve());
      await waitForReact(() => pendingText === "");
      act(() => delayedSource.publish());
    } finally {
      // Keep a failed assertion from leaking an intentionally deferred owner
      // publication into the next mounted test composer.
      if (pendingText !== undefined) act(() => delayedSource.publish());
    }
  });

  it("clears a synchronously publishing controlled owner after durable bind", async () => {
    const source = createTextSource("controlled source publishes immediately");
    const submitted = createDeferred<void>();
    const onSubmit = vi.fn(async () => await submitted.promise);
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: Promise.resolve(), onPut: () => {} }),
    );
    const composer = mountComposer();

    composer.render({ agentId: "agent-a", source, onSubmit });
    await settleReact();
    act(() => submitButton(composer.container).click());
    await waitForReact(() => onSubmit.mock.calls.length === 1);

    expect(source.textSource.getSnapshot()).toBe("");
    const textarea = composer.container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("composer textarea not found");
    expect(textarea.value).toBe("");

    await act(async () => submitted.resolve());
  });

  it("refuses an old attempt's native clear and reconciles distinct controlled text", async () => {
    const source = createTextSource("B outgoing source");
    const publish = source.set;
    let nativeTextWhenOwnerPublishedC: string | undefined;
    let nativeInput: HTMLTextAreaElement | null = null;
    source.set = (text) => {
      if (text === "") nativeTextWhenOwnerPublishedC = nativeInput?.value;
      publish(text === "" ? "C newer controlled source" : text);
    };
    const submitted = createDeferred<void>();
    const onSubmit = vi.fn(async () => await submitted.promise);
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: Promise.resolve(), onPut: () => {} }),
    );
    const composer = mountComposer();

    composer.render({ agentId: "agent-a", source, onSubmit });
    await settleReact();
    const textarea = composer.container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("composer textarea not found");
    nativeInput = textarea;
    act(() => submitButton(composer.container).click());
    await waitForReact(() => onSubmit.mock.calls.length === 1);

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ text: "B outgoing source" }));
    expect(source.textSource.getSnapshot()).toBe("C newer controlled source");
    // The old B executor may not clear C. A subsequent controlled-source
    // render must instead reconcile the DOM-owned input to C; otherwise the
    // logical next draft and native surface would remain split indefinitely.
    await waitForReact(() => textarea.value === "C newer controlled source");
    expect(nativeTextWhenOwnerPublishedC).toBe("B outgoing source");

    await act(async () => submitted.resolve());
  });

  it("keeps a captured steer turn on the early row through delayed durable preflight", async () => {
    const reservation = createDeferred<void>();
    const onPut = vi.fn();
    const sendAgentMessage = vi.fn(async () => undefined);
    const client = { sendAgentMessage };
    const source = createTextSource("steer against the original turn");
    const composer = mountComposer();
    const expectedError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sessionStore = useSessionStore.getState();
    sessionStore.clearSession("server");
    sessionStore.initializeSession("server", client as never);
    sessionStore.updateSessionServerInfo("server", {
      serverId: "server",
      hostname: null,
      version: "0.2.6",
      features: { canonicalSubmittedPrompts: true },
    });
    sessionStore.setAgents("server", new Map([["agent-a", createRunningAgent("agent-a")]]));
    hostRuntimeTestState.client = client;
    hostRuntimeTestState.isConnected = true;
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: reservation.promise, onPut }),
    );

    try {
      composer.render({
        agentId: "agent-a",
        source,
        onSubmit: vi.fn(async () => undefined),
        runtimeSubmit: true,
        sendBehavior: "steer",
      });
      await waitForReact(
        () =>
          composer.container
            .querySelector('[data-testid="composer-root"]')
            ?.getAttribute("data-submission-recovery-state") === "ready",
      );

      act(() => submitButton(composer.container).click());
      await waitForReact(() => onPut.mock.calls.length === 1);
      expect(
        useSessionStore.getState().sessions.server?.agentStreamTail.get("agent-a"),
      ).toMatchObject([{ text: "steer against the original turn", turnId: "running-turn" }]);

      // The local optimistic row retains click-time turn metadata and the
      // captured steer behavior while durable binding is pending. Provider
      // target selection remains the daemon's existing semantics.
      act(() => setOpenAgentTurn("agent-a", "later-turn"));

      await act(async () => reservation.resolve());
      await waitForReact(() => sendAgentMessage.mock.calls.length === 1);
      expect(sendAgentMessage).toHaveBeenCalledWith(
        "agent-a",
        "steer against the original turn",
        expect.objectContaining({ activeTurnBehavior: "steer" }),
      );
      expect(
        useSessionStore.getState().sessions.server?.agentStreamTail.get("agent-a"),
      ).toMatchObject([{ text: "steer against the original turn", turnId: "running-turn" }]);
    } finally {
      expectedError.mockRestore();
      sessionStore.clearSession("server");
    }
  });

  it("blocks an unchanged persisted retry after an aborted preparation admits its canonical occurrence", async () => {
    const reservation = createDeferred<void>();
    const records: SubmissionRecoveryRecord[] = [];
    const sendAgentMessage = vi.fn(async () => undefined);
    const client = { sendAgentMessage };
    const draftKey = "test:canonical-after-abort";
    useDraftStore.getState().saveDraftInput({
      draftKey,
      draft: { text: "B must not resend after canonical A", attachments: [] },
    });
    const composer = mountComposer();
    const expectedError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sessionStore = useSessionStore.getState();
    sessionStore.clearSession("server");
    sessionStore.initializeSession("server", client as never);
    sessionStore.updateSessionServerInfo("server", {
      serverId: "server",
      hostname: null,
      version: "0.2.6",
      features: { canonicalSubmittedPrompts: true },
    });
    hostRuntimeTestState.client = client;
    hostRuntimeTestState.isConnected = true;
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({
        putGate: reservation.promise,
        onPut: (record) => records.push(record),
      }),
    );

    try {
      composer.render({
        agentId: "agent-a",
        persistedDraftKey: draftKey,
        source: createTextSource(""),
        onSubmit: vi.fn(async () => undefined),
        runtimeSubmit: true,
      });
      await waitForReact(
        () =>
          composer.container
            .querySelector('[data-testid="composer-root"]')
            ?.getAttribute("data-submission-recovery-state") === "ready",
      );

      act(() => submitButton(composer.container).click());
      await waitForReact(() => records.length === 1);
      const record = records[0];
      if (!record) throw new Error("Expected the aborted preparation record");
      await waitForReact(() => {
        const submissions =
          useSessionStore.getState().sessions.server?.messageSubmissions.get("agent-a") ?? [];
        return submissions[0]?.presentation?.phase === "preparing";
      });
      act(() =>
        sessionStore.setAgentStreamState("server", "agent-a", {
          deferredCanonicalItems: [
            {
              key: "canonical-a-after-abort",
              protectedClientMessageId: record.clientMessageId,
              item: {
                kind: "user_message",
                id: "canonical-a-after-abort",
                messageId: "canonical-a-after-abort",
                clientMessageId: record.clientMessageId,
                text: "A canonical prompt",
                timestamp: new Date(0),
              },
            },
          ],
        }),
      );

      await act(async () => reservation.reject(new Error("reservation unavailable")));
      await waitForReact(() => {
        const tail =
          useSessionStore.getState().sessions.server?.agentStreamTail.get("agent-a") ?? [];
        const submissions =
          useSessionStore.getState().sessions.server?.messageSubmissions.get("agent-a") ?? [];
        return tail[0]?.id === "canonical-a-after-abort" && submissions.length === 0;
      });
      expect(useDraftStore.getState().getDraftInput(draftKey)?.text).toBe(
        "B must not resend after canonical A",
      );

      act(() => submitButton(composer.container).click());
      await waitForReact(
        () =>
          composer.container
            .querySelector('[role="alert"]')
            ?.textContent?.includes("already observed") === true,
      );
      expect(records).toHaveLength(1);
      expect(sendAgentMessage).not.toHaveBeenCalled();
      expect(
        useSessionStore.getState().sessions.server?.agentStreamTail.get("agent-a"),
      ).toMatchObject([{ id: "canonical-a-after-abort", text: "A canonical prompt" }]);
    } finally {
      expectedError.mockRestore();
      sessionStore.clearSession("server");
      useDraftStore.getState().clearDraftInput({ draftKey });
    }
  });

  it("keeps the bound source and suppresses transport when deferred canonical input wins promotion", async () => {
    const reservation = createDeferred<void>();
    const records: SubmissionRecoveryRecord[] = [];
    const marked: SubmissionRecoveryRecord[] = [];
    const sendAgentMessage = vi.fn(async () => undefined);
    const client = { sendAgentMessage };
    const parentSubmit = vi.fn(async () => undefined);
    const recoveryStore = createRecoveryStore({
      putGate: reservation.promise,
      onPut: (record) => records.push(record),
      onMarkNeedsReview: (record) => marked.push(record),
    });
    __setSubmissionRecoveryStoreForTests(recoveryStore);
    const draftKey = "test:canonical-promotion-collision";
    useDraftStore.getState().saveDraftInput({
      draftKey,
      draft: { text: "B source remains reviewable", attachments: [] },
    });
    const composer = mountComposer();
    const expectedError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sessionStore = useSessionStore.getState();
    sessionStore.clearSession("server");
    sessionStore.initializeSession("server", client as never);
    sessionStore.updateSessionServerInfo("server", {
      serverId: "server",
      hostname: null,
      version: "0.2.6",
      features: { canonicalSubmittedPrompts: true },
    });
    hostRuntimeTestState.client = client;
    hostRuntimeTestState.isConnected = true;

    try {
      composer.render({
        agentId: "agent-a",
        persistedDraftKey: draftKey,
        source: createTextSource(""),
        onSubmit: parentSubmit,
        runtimeSubmit: true,
      });
      await waitForReact(
        () =>
          composer.container
            .querySelector('[data-testid="composer-root"]')
            ?.getAttribute("data-submission-recovery-state") === "ready",
      );

      act(() => submitButton(composer.container).click());
      await waitForReact(() => records.length === 1);
      await waitForReact(() => {
        const submissions =
          useSessionStore.getState().sessions.server?.messageSubmissions.get("agent-a") ?? [];
        return submissions[0]?.presentation?.phase === "preparing";
      });
      const record = records[0];
      if (!record) throw new Error("Expected durable record for the preparation");

      act(() =>
        sessionStore.setAgentStreamState("server", "agent-a", {
          deferredCanonicalItems: [
            {
              key: "canonical-a",
              protectedClientMessageId: record.clientMessageId,
              item: {
                kind: "user_message",
                id: "canonical-a",
                messageId: "canonical-a",
                clientMessageId: record.clientMessageId,
                text: "A canonical message",
                timestamp: new Date(0),
              },
            },
          ],
        }),
      );
      expect(
        useSessionStore.getState().sessions.server?.deferredCanonicalAdmissions.get("agent-a"),
      ).toHaveLength(1);

      await act(async () => reservation.resolve());
      await waitForReact(() => marked.length === 1);

      expect(sendAgentMessage).not.toHaveBeenCalled();
      expect(parentSubmit).not.toHaveBeenCalled();
      expect(
        useSessionStore.getState().sessions.server?.queuedMessages?.get("agent-a") ?? [],
      ).toEqual([]);
      expect(useDraftStore.getState().getDraftInput(draftKey)?.text).toBe(
        "B source remains reviewable",
      );
      expect(useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId).toBe(record.id);
      expect(await recoveryStore.get(record.id)).toMatchObject({ state: "needs_review" });
      const textarea = composer.container.querySelector("textarea");
      if (!(textarea instanceof HTMLTextAreaElement))
        throw new Error("composer textarea not found");
      expect(textarea.value).toBe("B source remains reviewable");
      expect(textarea.selectionStart).toBe("B source remains reviewable".length);
      expect(textarea.selectionEnd).toBe("B source remains reviewable".length);
      expect(
        useSessionStore.getState().sessions.server?.agentStreamTail.get("agent-a"),
      ).toMatchObject([{ id: "canonical-a", text: "A canonical message" }]);
      expect(composer.container.querySelector('[role="alert"]')?.textContent).toContain(
        "already observed",
      );
    } finally {
      expectedError.mockRestore();
      sessionStore.clearSession("server");
      useDraftStore.getState().clearDraftInput({ draftKey });
    }
  });

  it("unmasks current bound source after a canonical collision even when review persistence rejects", async () => {
    const reservation = createDeferred<void>();
    const reviewWrite = createDeferred<void>();
    const records: SubmissionRecoveryRecord[] = [];
    const sendAgentMessage = vi.fn(async () => undefined);
    const client = { sendAgentMessage };
    const parentSubmit = vi.fn(async () => undefined);
    const recoveryStore = createRecoveryStore({
      putGate: reservation.promise,
      markNeedsReviewGate: reviewWrite.promise,
      onPut: (record) => records.push(record),
    });
    __setSubmissionRecoveryStoreForTests(recoveryStore);
    const draftKey = "test:canonical-promotion-review-write-failure";
    const editingSession = new ComposerEditingSession();
    useDraftStore.getState().saveDraftInput({
      draftKey,
      draft: { text: "B survives failed review write", attachments: [] },
    });
    let composer = mountComposer();
    const expectedError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const expectedWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sessionStore = useSessionStore.getState();
    sessionStore.clearSession("server");
    sessionStore.initializeSession("server", client as never);
    sessionStore.updateSessionServerInfo("server", {
      serverId: "server",
      hostname: null,
      version: "0.2.6",
      features: { canonicalSubmittedPrompts: true },
    });
    hostRuntimeTestState.client = client;
    hostRuntimeTestState.isConnected = true;

    try {
      composer.render({
        agentId: "agent-a",
        persistedDraftKey: draftKey,
        source: createTextSource(""),
        onSubmit: parentSubmit,
        editingSession,
        runtimeSubmit: true,
      });
      await waitForReact(
        () =>
          composer.container
            .querySelector('[data-testid="composer-root"]')
            ?.getAttribute("data-submission-recovery-state") === "ready",
      );
      act(() => submitButton(composer.container).click());
      await waitForReact(() => records.length === 1);
      const record = records[0];
      if (!record) throw new Error("Expected durable record for the preparation");
      await waitForReact(() => {
        const submissions =
          useSessionStore.getState().sessions.server?.messageSubmissions.get("agent-a") ?? [];
        return submissions[0]?.presentation?.phase === "preparing";
      });
      act(() =>
        sessionStore.setAgentStreamState("server", "agent-a", {
          deferredCanonicalItems: [
            {
              key: "canonical-a-write-failure",
              protectedClientMessageId: record.clientMessageId,
              item: {
                kind: "user_message",
                id: "canonical-a-write-failure",
                messageId: "canonical-a-write-failure",
                clientMessageId: record.clientMessageId,
                text: "A canonical message",
                timestamp: new Date(0),
              },
            },
          ],
        }),
      );

      await act(async () => reservation.resolve());
      await waitForReact(() => {
        const textarea = composer.container.querySelector("textarea");
        return (
          textarea instanceof HTMLTextAreaElement &&
          textarea.value === "B survives failed review write"
        );
      });
      const unmaskedTextarea = composer.container.querySelector("textarea");
      if (!(unmaskedTextarea instanceof HTMLTextAreaElement)) {
        throw new Error("composer textarea not found");
      }
      expect(unmaskedTextarea.selectionStart).toBe("B survives failed review write".length);
      expect(unmaskedTextarea.selectionEnd).toBe("B survives failed review write".length);
      expect(sendAgentMessage).not.toHaveBeenCalled();
      expect(parentSubmit).not.toHaveBeenCalled();
      expect(
        useSessionStore.getState().sessions.server?.queuedMessages?.get("agent-a") ?? [],
      ).toEqual([]);

      await act(async () => reviewWrite.reject(new Error("review storage unavailable")));
      await waitForReact(
        () =>
          composer.container
            .querySelector('[role="alert"]')
            ?.textContent?.includes("could not be marked") ?? false,
      );
      expect(await recoveryStore.get(record.id)).toMatchObject({ state: "dispatching" });
      expect(useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId).toBe(record.id);

      disposeComposer(composer);
      composer = mountComposer();
      composer.render({
        agentId: "agent-a",
        persistedDraftKey: draftKey,
        source: createTextSource(""),
        onSubmit: parentSubmit,
        editingSession,
        runtimeSubmit: true,
      });
      await waitForReact(() => {
        const textarea = composer.container.querySelector("textarea");
        return (
          textarea instanceof HTMLTextAreaElement &&
          textarea.value === "B survives failed review write"
        );
      });
      const remountedTextarea = composer.container.querySelector("textarea");
      if (!(remountedTextarea instanceof HTMLTextAreaElement)) {
        throw new Error("composer textarea not found");
      }
      expect(remountedTextarea.selectionStart).toBe("B survives failed review write".length);
      expect(remountedTextarea.selectionEnd).toBe("B survives failed review write".length);
      expect(sendAgentMessage).not.toHaveBeenCalled();
      expect(parentSubmit).not.toHaveBeenCalled();
      expect(
        useSessionStore.getState().sessions.server?.queuedMessages?.get("agent-a") ?? [],
      ).toEqual([]);
      expect(
        useSessionStore.getState().sessions.server?.agentStreamTail.get("agent-a"),
      ).toMatchObject([{ id: "canonical-a-write-failure", text: "A canonical message" }]);
    } finally {
      expectedError.mockRestore();
      expectedWarn.mockRestore();
      sessionStore.clearSession("server");
      useDraftStore.getState().clearDraftInput({ draftKey });
    }
  });

  it("keeps a legacy direct presentation masked across remount and rejects only its exact token", async () => {
    const transport = createDeferred<void>();
    const onPut = vi.fn();
    const sendAgentMessage = vi.fn(async () => await transport.promise);
    const client = { sendAgentMessage };
    const source = createTextSource("legacy source must survive remount");
    const expectedError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sessionStore = useSessionStore.getState();
    sessionStore.clearSession("server");
    sessionStore.initializeSession("server", client as never);
    sessionStore.updateSessionServerInfo("server", {
      serverId: "server",
      hostname: null,
      version: "0.2.5",
      features: { canonicalSubmittedPrompts: false },
    });
    hostRuntimeTestState.client = client;
    hostRuntimeTestState.isConnected = true;
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: Promise.resolve(), onPut }),
    );

    let initialComposer = mountComposer();
    try {
      initialComposer.render({
        agentId: "agent-a",
        source,
        onSubmit: vi.fn(async () => undefined),
        runtimeSubmit: true,
      });
      await waitForReact(
        () =>
          initialComposer.container
            .querySelector('[data-testid="composer-root"]')
            ?.getAttribute("data-submission-recovery-state") === "ready",
      );

      act(() => submitButton(initialComposer.container).click());
      await waitForReact(() => onPut.mock.calls.length === 1);
      await waitForReact(() => sendAgentMessage.mock.calls.length === 1);
      await waitForReact(() => {
        const submissions =
          useSessionStore.getState().sessions.server?.messageSubmissions.get("agent-a") ?? [];
        return submissions[0]?.presentation?.phase === "dispatching";
      });

      // The durable handoff has now physically cleared the source. The
      // in-flight callback retains its exact token, and the next composer
      // must recover the same owner-scoped lock from SessionState rather than
      // exposing an editable duplicate during a host remount.
      disposeComposer(initialComposer);
      initialComposer = mountComposer();
      initialComposer.render({
        agentId: "agent-a",
        source,
        onSubmit: vi.fn(async () => undefined),
        runtimeSubmit: true,
      });
      await waitForReact(() => {
        const textarea = initialComposer.container.querySelector("textarea");
        return textarea instanceof HTMLTextAreaElement && textarea.value === "";
      });
      expect(source.textSource.getSnapshot()).toBe("");
      replaceInputText(initialComposer.container, "unsafe remount edit");
      await settleReact();
      expect(source.textSource.getSnapshot()).toBe("");
      const lockedTextarea = initialComposer.container.querySelector("textarea");
      if (!(lockedTextarea instanceof HTMLTextAreaElement)) {
        throw new Error("composer textarea not found");
      }
      expect(lockedTextarea.value).toBe("");
      expect(
        useSessionStore.getState().sessions.server?.agentStreamTail.get("agent-a") ?? [],
      ).toMatchObject([{ kind: "user_message", text: "legacy source must survive remount" }]);

      await act(async () => transport.reject(new Error("legacy transport rejected")));
      await waitForReact(() => {
        const submissions =
          useSessionStore.getState().sessions.server?.messageSubmissions.get("agent-a") ?? [];
        const textarea = initialComposer.container.querySelector("textarea");
        return (
          submissions.length === 0 &&
          source.textSource.getSnapshot() === "legacy source must survive remount" &&
          textarea instanceof HTMLTextAreaElement &&
          textarea.value === "legacy source must survive remount"
        );
      });

      const textarea = initialComposer.container.querySelector("textarea");
      if (!(textarea instanceof HTMLTextAreaElement))
        throw new Error("composer textarea not found");
      expect(textarea.value).toBe("legacy source must survive remount");
      expect(source.textSource.getSnapshot()).toBe("legacy source must survive remount");
      expect(
        useSessionStore.getState().sessions.server?.agentStreamTail.get("agent-a") ?? [],
      ).toEqual([]);
    } finally {
      expectedError.mockRestore();
      useSessionStore.getState().clearSession("server");
    }
  });

  it("locks pasted text before its bytes exist and delays the row until the real payload is prepared", async () => {
    const encoding = createDeferred<string>();
    const reservation = createDeferred<void>();
    const onPut = vi.fn();
    const sendAgentMessage = vi.fn(async () => undefined);
    const client = { sendAgentMessage };
    const attachmentStore = createAttachmentStoreForPaste();
    const encodeBase64 = vi.fn(async () => await encoding.promise);
    attachmentStore.store.encodeBase64 = encodeBase64;
    __setAttachmentStoreForTests(attachmentStore.store);
    const pasted = await persistPastedTextAttachment({
      text: "pasted bytes must be truthful",
      codePointCount: 29,
      logicalLineCount: 1,
    });
    const attachments = createAttachmentSource([pasted]);
    const source = createTextSource("");
    const composer = mountComposer();
    const expectedError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sessionStore = useSessionStore.getState();
    sessionStore.clearSession("server");
    sessionStore.initializeSession("server", client as never);
    sessionStore.updateSessionServerInfo("server", {
      serverId: "server",
      hostname: null,
      version: "0.2.6",
      features: { canonicalSubmittedPrompts: true },
    });
    hostRuntimeTestState.client = client;
    hostRuntimeTestState.isConnected = true;
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: reservation.promise, onPut }),
    );

    try {
      composer.render({
        agentId: "agent-a",
        source,
        attachmentSource: attachments,
        onSubmit: vi.fn(async () => undefined),
        runtimeSubmit: true,
      });
      await waitForReact(
        () =>
          composer.container
            .querySelector('[data-testid="composer-root"]')
            ?.getAttribute("data-submission-recovery-state") === "ready",
      );

      act(() => submitButton(composer.container).click());
      await waitForReact(() => encodeBase64.mock.calls.length === 1);

      expect(
        useSessionStore.getState().sessions.server?.agentStreamTail.get("agent-a") ?? [],
      ).toEqual([]);
      expect(
        useSessionStore.getState().sessions.server?.messageSubmissions.get("agent-a") ?? [],
      ).toEqual([]);
      expect(attachments.getSnapshot()).toEqual([pasted]);
      expect(
        composer.container.querySelectorAll('[data-testid="composer-pasted-text-attachment-pill"]'),
      ).toHaveLength(1);
      expect(sendAgentMessage).not.toHaveBeenCalled();

      await act(async () => encoding.resolve(btoa("pasted bytes must be truthful")));
      await waitForReact(() => onPut.mock.calls.length === 1);
      await waitForReact(() => {
        const submissions =
          useSessionStore.getState().sessions.server?.messageSubmissions.get("agent-a") ?? [];
        return submissions.length === 1 && submissions[0]?.presentation?.phase === "preparing";
      });

      expect(
        useSessionStore.getState().sessions.server?.agentStreamTail.get("agent-a"),
      ).toMatchObject([
        {
          kind: "user_message",
          attachments: [
            expect.objectContaining({ type: "text", text: "pasted bytes must be truthful" }),
          ],
        },
      ]);
      expect(
        composer.container.querySelectorAll('[data-testid="composer-pasted-text-attachment-pill"]'),
      ).toHaveLength(0);

      await act(async () => reservation.reject(new Error("reservation unavailable")));
      await waitForReact(() => {
        const submissions =
          useSessionStore.getState().sessions.server?.messageSubmissions.get("agent-a") ?? [];
        return submissions.length === 0;
      });

      expect(attachments.getSnapshot()).toEqual([pasted]);
      expect(
        composer.container.querySelectorAll('[data-testid="composer-pasted-text-attachment-pill"]'),
      ).toHaveLength(1);
      expect(sendAgentMessage).not.toHaveBeenCalled();
    } finally {
      expectedError.mockRestore();
      useSessionStore.getState().clearSession("server");
    }
  });

  it("blocks a pasted-text send when the same occurrence becomes canonical during byte preparation", async () => {
    const encoding = createDeferred<string>();
    const onPut = vi.fn();
    const sendAgentMessage = vi.fn(async () => undefined);
    const parentSubmit = vi.fn(async () => undefined);
    const client = { sendAgentMessage };
    const attachmentStore = createAttachmentStoreForPaste();
    const encodeBase64 = vi.fn(async () => await encoding.promise);
    attachmentStore.store.encodeBase64 = encodeBase64;
    __setAttachmentStoreForTests(attachmentStore.store);
    const exactPastedText = "canonical arrives before pasted bytes";
    const pasted = await persistPastedTextAttachment({
      text: exactPastedText,
      codePointCount: Array.from(exactPastedText).length,
      logicalLineCount: 1,
    });
    const draftKey = "test:pasted-canonical-before-begin";
    useDraftStore.getState().saveDraftInput({
      draftKey,
      draft: { text: "", attachments: [pasted] },
    });
    const draftSnapshot = useDraftStore.getState().getDraftSubmissionSnapshot(draftKey);
    if (!draftSnapshot) throw new Error("Expected pasted draft snapshot");
    const identity = resolveComposerSubmissionIdentity({
      clientMessageId: "unused-local-id",
      draftOccurrenceKey: draftSnapshot.draftOccurrenceKey,
      kind: "agent_message",
      serverId: "server",
      agentId: "agent-a",
      workspaceId: "workspace",
      draftId: null,
      cwd: "/repo",
    });
    const composer = mountComposer();
    const expectedError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sessionStore = useSessionStore.getState();
    sessionStore.clearSession("server");
    sessionStore.initializeSession("server", client as never);
    sessionStore.updateSessionServerInfo("server", {
      serverId: "server",
      hostname: null,
      version: "0.2.6",
      features: { canonicalSubmittedPrompts: true },
    });
    hostRuntimeTestState.client = client;
    hostRuntimeTestState.isConnected = true;
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: Promise.resolve(), onPut }),
    );

    try {
      composer.render({
        agentId: "agent-a",
        persistedDraftKey: draftKey,
        source: createTextSource(""),
        onSubmit: parentSubmit,
        runtimeSubmit: true,
      });
      await waitForReact(
        () =>
          composer.container
            .querySelector('[data-testid="composer-root"]')
            ?.getAttribute("data-submission-recovery-state") === "ready",
      );
      act(() => submitButton(composer.container).click());
      await waitForReact(() => encodeBase64.mock.calls.length === 1);

      act(() =>
        sessionStore.setAgentStreamState("server", "agent-a", {
          tail: [
            {
              kind: "user_message",
              id: "canonical-pasted-a",
              messageId: "canonical-pasted-a",
              clientMessageId: identity.clientMessageId,
              text: "A observed canonical prompt",
              timestamp: new Date(0),
            },
          ],
        }),
      );
      await act(async () => encoding.resolve(btoa(exactPastedText)));
      await waitForReact(
        () =>
          composer.container
            .querySelector('[role="alert"]')
            ?.textContent?.includes("already observed") === true,
      );

      expect(onPut).not.toHaveBeenCalled();
      expect(sendAgentMessage).not.toHaveBeenCalled();
      expect(parentSubmit).not.toHaveBeenCalled();
      expect(
        useSessionStore.getState().sessions.server?.queuedMessages?.get("agent-a") ?? [],
      ).toEqual([]);
      expect(useDraftStore.getState().getDraftInput(draftKey)).toMatchObject({
        text: "",
        attachments: [pasted],
      });
      expect(
        useSessionStore.getState().sessions.server?.agentStreamTail.get("agent-a"),
      ).toMatchObject([{ id: "canonical-pasted-a", text: "A observed canonical prompt" }]);
    } finally {
      expectedError.mockRestore();
      sessionStore.clearSession("server");
      useDraftStore.getState().clearDraftInput({ draftKey });
    }
  });

  it("retains an ambiguous parent-create outcome instead of submitting it a second time", async () => {
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: Promise.resolve(), onPut: () => {} }),
    );
    const draftKey = "test:ambiguous-parent-create";
    useDraftStore.getState().saveDraftInput({
      draftKey,
      draft: { text: "create this workspace agent", attachments: [] },
    });
    const onCreate = vi.fn(async () => {
      throw new Error("The create request may have reached the provider.");
    });
    const composer = mountComposer();
    composer.render({
      agentId: "workspace-create",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit: onCreate,
    });
    await settleReact();

    act(() => submitButton(composer.container).click());
    await settleReact();
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(useDraftStore.getState().getDraftInput(draftKey)?.text).toBe(
      "create this workspace agent",
    );
    expect(useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId).toBeTruthy();
    expect(
      composer.container.querySelectorAll('[data-testid="composer-submission-needs-review"]'),
    ).toHaveLength(1);

    // Recovery records never auto-retry uncertain creates. The identical
    // snapshot remains blocked until the user explicitly inspects it.
    act(() => submitButton(composer.container).click());
    await settleReact();
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(
      composer.container.querySelectorAll('[data-testid="composer-submission-needs-review"]'),
    ).toHaveLength(1);
  });

  it("dispatches a prepared snapshot through its captured origin after an agent switch", async () => {
    const gate = createDeferred<void>();
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: gate.promise, onPut: () => {} }),
    );
    const firstSource = createTextSource("send to first");
    const secondSource = createTextSource("second draft");
    const firstSubmit = vi.fn(async () => undefined);
    const secondSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({ agentId: "agent-a", source: firstSource, onSubmit: firstSubmit });
    await settleReact();

    act(() => submitButton(composer.container).click());
    await settleReact();
    composer.render({ agentId: "agent-b", source: secondSource, onSubmit: secondSubmit });

    gate.resolve();
    await settleReact();

    expect(firstSubmit).toHaveBeenCalledWith(expect.objectContaining({ text: "send to first" }));
    expect(secondSubmit).not.toHaveBeenCalled();
  });

  it("keeps a newer origin attachment when an older prepared send completes after a switch", async () => {
    const gate = createDeferred<void>();
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: gate.promise, onPut: () => {} }),
    );
    const originalAttachment: UserComposerAttachment = {
      kind: "file",
      attachment: {
        type: "uploaded_file",
        id: "original-file",
        fileName: "original.txt",
        mimeType: "text/plain",
        size: 1,
        path: "/uploads/original.txt",
      },
    };
    const newerAttachment: UserComposerAttachment = {
      kind: "file",
      attachment: {
        type: "uploaded_file",
        id: "newer-file",
        fileName: "newer.txt",
        mimeType: "text/plain",
        size: 1,
        path: "/uploads/newer.txt",
      },
    };
    const firstSource = createTextSource("send original attachment");
    const firstAttachments = createAttachmentSource([originalAttachment]);
    const secondSource = createTextSource("second draft");
    const secondAttachments = createAttachmentSource();
    const firstSubmit = vi.fn(async () => undefined);
    const secondSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: firstSource,
      attachmentSource: firstAttachments,
      onSubmit: firstSubmit,
    });
    await settleReact();

    act(() => submitButton(composer.container).click());
    await settleReact();
    composer.render({
      agentId: "agent-b",
      source: secondSource,
      attachmentSource: secondAttachments,
      onSubmit: secondSubmit,
    });
    act(() => firstAttachments.set([originalAttachment, newerAttachment]));

    gate.resolve();
    await settleReact();

    expect(firstSubmit).toHaveBeenCalledTimes(1);
    expect(secondSubmit).not.toHaveBeenCalled();
    expect(firstAttachments.getSnapshot()).toEqual([newerAttachment]);
    expect(secondAttachments.getSnapshot()).toEqual([]);
  });

  it("exposes reload-hydrated queued and stale records for manual inspection without claiming them", async () => {
    const attachmentStore = createAttachmentStoreForPaste();
    __setAttachmentStoreForTests(attachmentStore.store);
    const exactPastedText = "attachment-only recoverable text";
    const pastedText = await persistPastedTextAttachment({
      text: exactPastedText,
      codePointCount: Array.from(exactPastedText).length,
      logicalLineCount: 1,
    });
    const queued = createSubmissionRecoveryRecord({
      id: "queued-after-reload",
      clientMessageId: "queued-after-reload",
      now: 100,
      submission: {
        kind: "agent_message",
        serverId: "server",
        agentId: "agent-a",
        workspaceId: "workspace",
        draftId: null,
        cwd: "/repo",
        text: "",
        attachments: [pastedText],
      },
      originalDraft: {
        ownerKey: "server:agent-a",
        text: "",
        attachments: [pastedText],
        selection: { start: 0, end: 0 },
      },
    });
    const staleLease: SubmissionRecoveryLease = {
      ownerId: "closed-window",
      fence: "expired-fence",
      expiresAt: Date.now() - 1,
    };
    const stale = {
      ...createSubmissionRecoveryRecord({
        id: "stale-after-reload",
        clientMessageId: "stale-after-reload",
        now: 100,
        submission: {
          kind: "agent_message",
          serverId: "server",
          agentId: "agent-a",
          workspaceId: "workspace",
          draftId: null,
          cwd: "/repo",
          text: "possibly sent",
          attachments: [],
        },
        originalDraft: {
          ownerKey: "server:agent-a",
          text: "possibly sent",
          attachments: [],
          selection: { start: 13, end: 13 },
        },
      }),
      state: "dispatching" as const,
      lease: staleLease,
      dispatchLease: staleLease,
    };
    const onClaim = vi.fn();
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({
        putGate: Promise.resolve(),
        onPut: () => {},
        onClaim,
        initialRecords: [queued, stale],
      }),
    );
    const source = createTextSource("");
    const composer = mountComposer();
    composer.render({ agentId: "agent-a", source, onSubmit: vi.fn(async () => undefined) });
    await settleReact();

    const recoveryPills = Array.from(
      composer.container.querySelectorAll('[data-testid="composer-submission-needs-review"]'),
    );
    expect(recoveryPills).toHaveLength(2);
    expect(onClaim).not.toHaveBeenCalled();

    const [queuedPill] = recoveryPills;
    if (!(queuedPill instanceof HTMLElement)) throw new Error("Queued recovery pill not found");
    act(() => queuedPill.click());
    await settleReact();
    expect(
      document.querySelector('[data-testid="composer-submission-recovery-pasted-text-preview"]')
        ?.textContent,
    ).toContain(exactPastedText);
  });

  it("keeps fresh repeated text separate from a historical accepted checkpoint", async () => {
    const text = "ok proceed";
    const historicalClientMessageId = "accepted-ok-proceed";
    const historicalRecord: SubmissionRecoveryRecord = {
      ...createSubmissionRecoveryRecord({
        id: historicalClientMessageId,
        clientMessageId: historicalClientMessageId,
        now: 100,
        submission: {
          kind: "agent_message",
          serverId: "server",
          agentId: "agent-a",
          workspaceId: "workspace",
          draftId: null,
          cwd: "/repo",
          text,
          attachments: [],
        },
        originalDraft: {
          ownerKey: "server:agent-a",
          text,
          attachments: [],
          selection: { start: text.length, end: text.length },
        },
      }),
      state: "settled",
      acceptedAt: 101,
    };
    const reservedRecords: SubmissionRecoveryRecord[] = [];
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({
        putGate: Promise.resolve(),
        onPut: (record) => reservedRecords.push(record),
        initialRecords: [historicalRecord],
      }),
    );
    const draftKey = "test:fresh-ok-proceed-after-accepted-history";
    useDraftStore.getState().clearDraftInput({ draftKey });
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit,
    });
    await settleReact();

    // The draft hook creates a new local draft. It deliberately has the same
    // bytes as a historical accepted submission, but has never been sent.
    replaceInputText(composer.container, text);
    await waitForReact(() => useDraftStore.getState().getDraftInput(draftKey)?.text === text);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(reservedRecords).toHaveLength(0);
    expect(
      composer.container.querySelectorAll('[data-testid="composer-submission-needs-review"]'),
    ).toHaveLength(0);

    // Deliberately sending that fresh draft, then typing the same text again,
    // reserves two new identities rather than claiming the accepted history.
    act(() => submitButton(composer.container).click());
    await waitForReact(() => onSubmit.mock.calls.length === 1);
    await waitForReact(() => useDraftStore.getState().drafts[draftKey]?.lifecycle === "sent");
    replaceInputText(composer.container, text);
    await waitForReact(() => useDraftStore.getState().getDraftInput(draftKey)?.text === text);
    act(() => submitButton(composer.container).click());
    await waitForReact(() => onSubmit.mock.calls.length === 2);

    expect(reservedRecords).toHaveLength(2);
    expect(reservedRecords[0]?.clientMessageId).not.toBe(historicalClientMessageId);
    expect(reservedRecords[1]?.clientMessageId).not.toBe(historicalClientMessageId);
    expect(reservedRecords[1]?.clientMessageId).not.toBe(reservedRecords[0]?.clientMessageId);
  });

  it("keeps a bound draft blocked when recovery inspection fails", async () => {
    const checkpointId = "unreadable-bound-checkpoint";
    const draftKey = "test:unreadable-bound-checkpoint";
    const onPut = vi.fn();
    const onClaim = vi.fn();
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({
        putGate: Promise.resolve(),
        onPut,
        onClaim,
        listError: new Error("corrupt recovery index"),
      }),
    );
    useDraftStore.getState().saveDraftInput({
      draftKey,
      draft: { text: "must remain linked", attachments: [] },
    });
    const snapshot = useDraftStore.getState().getDraftSubmissionSnapshot(draftKey);
    if (!snapshot) throw new Error("Expected active draft snapshot");
    const bound = useDraftStore.getState().bindDraftSubmissionCheckpoint({
      draftKey,
      expectedVersion: snapshot.version,
      submissionCheckpointId: checkpointId,
    });
    if (!bound) throw new Error("Expected checkpoint binding");

    const onSubmit = vi.fn(async () => undefined);
    const expectedWarning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const composer = mountComposer();
      composer.render({
        agentId: "agent-a",
        source: createTextSource(""),
        persistedDraftKey: draftKey,
        onSubmit,
      });
      await waitForReact(
        () =>
          composer.container
            .querySelector('[data-testid="composer-root"]')
            ?.getAttribute("data-submission-recovery-state") === "error",
      );

      expect(
        composer.container.querySelectorAll(
          '[data-testid="composer-submission-checkpoint-unresolved"]',
        ),
      ).toHaveLength(1);
      act(() => submitButton(composer.container).click());
      await settleReact();

      expect(onPut).not.toHaveBeenCalled();
      expect(onClaim).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      expectedWarning.mockRestore();
    }
  });

  it("keeps a bound draft blocked when its checkpoint belongs to another composer scope", async () => {
    const checkpointId = "bound-checkpoint-in-other-workspace";
    const foreignRecord = createSubmissionRecoveryRecord({
      id: checkpointId,
      clientMessageId: checkpointId,
      now: 100,
      submission: {
        kind: "agent_message",
        serverId: "server",
        agentId: "agent-a",
        workspaceId: "other-workspace",
        draftId: null,
        cwd: "/repo",
        text: "foreign scope source",
        attachments: [],
      },
      originalDraft: {
        ownerKey: "server:agent-a",
        text: "foreign scope source",
        attachments: [],
        selection: { start: 20, end: 20 },
      },
    });
    const onPut = vi.fn();
    const onClaim = vi.fn();
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({
        putGate: Promise.resolve(),
        onPut,
        onClaim,
        initialRecords: [foreignRecord],
      }),
    );
    const draftKey = "test:bound-checkpoint-in-other-workspace";
    useDraftStore.getState().saveDraftInput({
      draftKey,
      draft: { text: "local draft must not replace checkpoint", attachments: [] },
    });
    const snapshot = useDraftStore.getState().getDraftSubmissionSnapshot(draftKey);
    if (!snapshot) throw new Error("Expected active draft snapshot");
    const bound = useDraftStore.getState().bindDraftSubmissionCheckpoint({
      draftKey,
      expectedVersion: snapshot.version,
      submissionCheckpointId: checkpointId,
    });
    if (!bound) throw new Error("Expected checkpoint binding");

    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit,
    });
    await waitForReact(
      () =>
        composer.container
          .querySelector('[data-testid="composer-root"]')
          ?.getAttribute("data-submission-recovery-state") === "ready",
    );

    expect(
      composer.container.querySelectorAll(
        '[data-testid="composer-submission-checkpoint-unresolved"]',
      ),
    ).toHaveLength(1);
    act(() => submitButton(composer.container).click());
    await settleReact();

    expect(onPut).not.toHaveBeenCalled();
    expect(onClaim).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("allows an unbound fresh draft to send after recovery inspection fails", async () => {
    const onPut = vi.fn();
    const onClaim = vi.fn();
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({
        putGate: Promise.resolve(),
        onPut,
        onClaim,
        listError: new Error("historic recovery index unavailable"),
      }),
    );
    const onSubmit = vi.fn(async () => undefined);
    const expectedWarning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const composer = mountComposer();
      composer.render({
        agentId: "agent-a",
        source: createTextSource("independent fresh content"),
        onSubmit,
      });
      await waitForReact(
        () =>
          composer.container
            .querySelector('[data-testid="composer-root"]')
            ?.getAttribute("data-submission-recovery-state") === "error",
      );

      act(() => submitButton(composer.container).click());
      await waitForReact(() => onSubmit.mock.calls.length === 1);

      expect(onPut).toHaveBeenCalledTimes(1);
      expect(onClaim).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ text: "independent fresh content" }),
      );
    } finally {
      expectedWarning.mockRestore();
    }
  });

  it("submits an intentionally empty New Workspace draft exactly once with a durable binding", async () => {
    const reserved: SubmissionRecoveryRecord[] = [];
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({
        putGate: Promise.resolve(),
        onPut: (record) => reserved.push(record),
      }),
    );
    const draftKey = "test:new-workspace-empty-create";
    useDraftStore.getState().clearDraftInput({ draftKey });
    const onCreate = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({
      agentId: "new-workspace",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit: onCreate,
      allowEmptySubmit: true,
    });
    await waitForReact(
      () =>
        composer.container
          .querySelector('[data-testid="composer-root"]')
          ?.getAttribute("data-submission-recovery-state") === "ready",
    );

    const button = submitButton(composer.container);
    act(() => {
      button.click();
      button.click();
    });
    await waitForReact(() => onCreate.mock.calls.length === 1);
    await waitForReact(() => useDraftStore.getState().drafts[draftKey]?.lifecycle === "sent");

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ text: "", attachments: [] }));
    expect(reserved).toHaveLength(1);
    expect(reserved[0]?.submission.kind).toBe("workspace_create");
    expect(useDraftStore.getState().drafts[draftKey]).toEqual(
      expect.objectContaining({
        lifecycle: "sent",
        submissionCheckpointId: reserved[0]?.id,
      }),
    );
  });

  it("binds and sends a workspace-context-only draft without typed input", async () => {
    const reserved: SubmissionRecoveryRecord[] = [];
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({
        putGate: Promise.resolve(),
        onPut: (record) => reserved.push(record),
      }),
    );
    const scopeKey = "test:workspace-context-only";
    const contextAttachment = {
      kind: "chat_history" as const,
      id: "context-only-history",
      attachment: {
        type: "text" as const,
        mimeType: "text/plain",
        contextKind: "chat_history" as const,
        title: "Chat history",
        text: "Context supplied outside the draft input",
      },
      source: { serverId: "server", agentId: "agent-a" },
    } satisfies ChatHistoryContextAttachment;
    useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
      scopeKey,
      attachments: [contextAttachment],
    });
    const draftKey = "test:workspace-context-only";
    useDraftStore.getState().clearDraftInput({ draftKey });
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit,
      attachmentScopeKeys: [scopeKey],
    });
    await waitForReact(
      () =>
        composer.container
          .querySelector('[data-testid="composer-root"]')
          ?.getAttribute("data-submission-recovery-state") === "ready",
    );

    act(() => submitButton(composer.container).click());
    await waitForReact(() => onSubmit.mock.calls.length === 1);
    await waitForReact(() => useDraftStore.getState().drafts[draftKey]?.lifecycle === "sent");

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ text: "", attachments: [contextAttachment] }),
    );
    expect(reserved).toHaveLength(1);
    expect(useDraftStore.getState().drafts[draftKey]).toEqual(
      expect.objectContaining({
        lifecycle: "sent",
        submissionCheckpointId: reserved[0]?.id,
      }),
    );
  });

  it("does not dispatch a context-only snapshot after its workspace context is replaced", async () => {
    const preparation = createDeferred<void>();
    const onPut = vi.fn();
    const recoveryStore = createRecoveryStore({ putGate: preparation.promise, onPut });
    __setSubmissionRecoveryStoreForTests(recoveryStore);
    const scopeKey = "test:workspace-context-replaced";
    const originalContext = {
      kind: "chat_history" as const,
      id: "original-history",
      attachment: {
        type: "text" as const,
        mimeType: "text/plain",
        contextKind: "chat_history" as const,
        title: "Original chat history",
        text: "The original context",
      },
      source: { serverId: "server", agentId: "agent-a" },
    } satisfies ChatHistoryContextAttachment;
    const replacementContext: ChatHistoryContextAttachment = {
      ...originalContext,
      id: "replacement-history",
      attachment: { ...originalContext.attachment, text: "The newer context" },
    };
    useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
      scopeKey,
      attachments: [originalContext],
    });
    const draftKey = "test:workspace-context-replaced";
    useDraftStore.getState().clearDraftInput({ draftKey });
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit,
      attachmentScopeKeys: [scopeKey],
    });
    await waitForReact(
      () =>
        composer.container
          .querySelector('[data-testid="composer-root"]')
          ?.getAttribute("data-submission-recovery-state") === "ready",
    );

    act(() => submitButton(composer.container).click());
    await waitForReact(() => onPut.mock.calls.length === 1);
    act(() => {
      useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
        scopeKey,
        attachments: [replacementContext],
      });
    });
    await act(async () => preparation.resolve());
    await settleReact();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(useDraftStore.getState().drafts[draftKey]?.lifecycle).toBe("active");
    expect(useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId).toBeUndefined();
    await expect(recoveryStore.list()).resolves.toEqual([]);
  });

  it("does not dispatch after a workspace browser screenshot is replaced during durable preflight", async () => {
    const preparation = createDeferred<void>();
    const onPut = vi.fn();
    const recoveryStore = createRecoveryStore({ putGate: preparation.promise, onPut });
    __setSubmissionRecoveryStoreForTests(recoveryStore);
    const attachmentStore = createAttachmentStoreForPaste();
    __setAttachmentStoreForTests(attachmentStore.store);
    const originalScreenshot = await attachmentStore.store.save({
      mimeType: "image/png",
      source: { kind: "bytes", bytes: new Uint8Array([1, 2, 3]) },
    });
    const replacementScreenshot = await attachmentStore.store.save({
      mimeType: "image/png",
      source: { kind: "bytes", bytes: new Uint8Array([4, 5, 6]) },
    });
    const scopeKey = "test:workspace-browser-screenshot-replaced";
    const originalBrowserElement = {
      kind: "browser_element" as const,
      attachment: {
        url: "https://example.test/original",
        selector: "#original",
        tag: "BUTTON",
        text: "Original browser element",
        outerHTML: '<button id="original">Original</button>',
        computedStyles: {},
        boundingRect: { x: 0, y: 0, width: 1, height: 1 },
        reactSource: null,
        parentChain: [],
        children: [],
        screenshot: originalScreenshot,
        formatted: "Original browser element",
      },
    } satisfies WorkspaceComposerAttachment;
    const replacementBrowserElement: WorkspaceComposerAttachment = {
      ...originalBrowserElement,
      attachment: {
        ...originalBrowserElement.attachment,
        url: "https://example.test/replacement",
        screenshot: replacementScreenshot,
      },
    };
    useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
      scopeKey,
      attachments: [originalBrowserElement],
    });
    const draftKey = "test:workspace-browser-screenshot-replaced";
    useDraftStore.getState().clearDraftInput({ draftKey });
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit,
      attachmentScopeKeys: [scopeKey],
    });
    await waitForReact(
      () =>
        composer.container
          .querySelector('[data-testid="composer-root"]')
          ?.getAttribute("data-submission-recovery-state") === "ready",
    );

    act(() => submitButton(composer.container).click());
    await waitForReact(() => onPut.mock.calls.length === 1);
    act(() => {
      useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
        scopeKey,
        attachments: [replacementBrowserElement],
      });
    });
    await act(async () => preparation.resolve());
    await settleReact();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(useDraftStore.getState().drafts[draftKey]?.lifecycle).toBe("active");
    expect(useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId).toBeUndefined();
    await expect(recoveryStore.list()).resolves.toEqual([]);
  });

  it("restores and binds a queued checkpoint without claiming or dispatching it", async () => {
    const checkpointId = "restore-without-dispatch";
    const record = createSubmissionRecoveryRecord({
      id: checkpointId,
      clientMessageId: checkpointId,
      now: 100,
      submission: {
        kind: "agent_message",
        serverId: "server",
        agentId: "agent-a",
        workspaceId: "workspace",
        draftId: null,
        cwd: "/repo",
        text: "queued draft",
        attachments: [],
      },
      originalDraft: {
        ownerKey: "server:agent-a",
        text: "queued draft",
        attachments: [],
        selection: { start: 12, end: 12 },
      },
    });
    const onClaim = vi.fn();
    const recoveryStore = createRecoveryStore({
      putGate: Promise.resolve(),
      onPut: () => {},
      onClaim,
      initialRecords: [record],
    });
    __setSubmissionRecoveryStoreForTests(recoveryStore);
    const draftKey = "test:restore-known-checkpoint";
    useDraftStore.getState().saveDraftInput({ draftKey, draft: { text: "", attachments: [] } });
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit,
    });
    await waitForReact(
      () =>
        composer.container.querySelectorAll('[data-testid="composer-submission-needs-review"]')
          .length === 1,
    );

    const pill = composer.container.querySelector(
      '[data-testid="composer-submission-needs-review"]',
    );
    if (!(pill instanceof HTMLElement)) throw new Error("Recovery pill not found");
    act(() => pill.click());
    await settleReact();
    const restore = document.querySelector('[aria-label="Restore original draft snapshot"]');
    if (!(restore instanceof HTMLElement)) throw new Error("Restore checkpoint button not found");
    act(() => restore.click());
    await waitForReact(
      () => useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId === checkpointId,
    );

    expect(useDraftStore.getState().getDraftInput(draftKey)).toEqual({
      text: "queued draft",
      attachments: [],
    });
    expect(onClaim).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();

    act(() => submitButton(composer.container).click());
    await settleReact();
    expect(onClaim).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();

    const discard = document.querySelector('[aria-label="Discard submission checkpoint"]');
    if (!(discard instanceof HTMLElement)) throw new Error("Discard checkpoint button not found");
    act(() => discard.click());
    await waitForReact(
      () => useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId === undefined,
    );
    await waitForReact(
      () =>
        composer.container.querySelectorAll('[data-testid="composer-submission-needs-review"]')
          .length === 0,
    );
    await expect(recoveryStore.get(checkpointId)).resolves.toBeNull();
  });

  it("keeps a restored draft bound when a stale inspector loses to a late accepted outcome", async () => {
    const checkpointId = "stale-discard-late-ack";
    const dispatchLease: SubmissionRecoveryLease = {
      ownerId: "other-tab",
      fence: "late-ack-fence",
      expiresAt: Date.now() - 1,
    };
    const uncertain: SubmissionRecoveryRecord = {
      ...createSubmissionRecoveryRecord({
        id: checkpointId,
        clientMessageId: checkpointId,
        now: 100,
        submission: {
          kind: "agent_message",
          serverId: "server",
          agentId: "agent-a",
          workspaceId: "workspace",
          draftId: null,
          cwd: "/repo",
          text: "retain the accepted provenance",
          attachments: [],
        },
        originalDraft: {
          ownerKey: "server:agent-a",
          text: "retain the accepted provenance",
          attachments: [],
          selection: { start: 29, end: 29 },
        },
      }),
      revision: 3,
      state: "needs_review",
      lease: null,
      dispatchLease,
      errorMessage: "The previous send may have reached the provider.",
    };
    const recoveryStore = createRecoveryStore({
      putGate: Promise.resolve(),
      onPut: () => {},
      initialRecords: [uncertain],
      onDiscardInspected: (record) => ({
        ...record,
        revision: record.revision + 1,
        state: "settled",
        lease: null,
        acceptedAt: 200,
        updatedAt: 200,
        errorMessage: undefined,
      }),
    });
    __setSubmissionRecoveryStoreForTests(recoveryStore);
    const draftKey = "test:stale-discard-late-ack";
    useDraftStore.getState().saveDraftInput({ draftKey, draft: { text: "", attachments: [] } });
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit: vi.fn(async () => undefined),
    });
    await waitForReact(
      () =>
        composer.container.querySelectorAll('[data-testid="composer-submission-needs-review"]')
          .length === 1,
    );

    const pill = composer.container.querySelector(
      '[data-testid="composer-submission-needs-review"]',
    );
    if (!(pill instanceof HTMLElement)) throw new Error("Recovery pill not found");
    act(() => pill.click());
    await settleReact();
    const restore = document.querySelector('[aria-label="Restore original draft snapshot"]');
    if (!(restore instanceof HTMLElement)) throw new Error("Restore checkpoint button not found");
    act(() => restore.click());
    await waitForReact(
      () => useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId === checkpointId,
    );

    const discard = document.querySelector('[aria-label="Discard submission checkpoint"]');
    if (!(discard instanceof HTMLElement)) throw new Error("Discard checkpoint button not found");
    act(() => discard.click());
    await waitForReact(
      () =>
        document
          .querySelector('[data-testid="composer-submission-recovery-error"]')
          ?.textContent?.includes("dispatch provenance") ?? false,
    );

    // The atomic recovery comparison wins before the draft CAS. A stale tab
    // must not detach the source that is now tied to accepted provenance.
    expect(useDraftStore.getState().drafts[draftKey]).toMatchObject({
      submissionCheckpointId: checkpointId,
    });
    await expect(recoveryStore.get(checkpointId)).resolves.toMatchObject({
      state: "settled",
      dispatchLease,
      acceptedAt: 200,
    });
  });

  it("keeps a recovery checkpoint inspectable in fullscreen without exposing ordinary attachments", async () => {
    const checkpointId = "fullscreen-recovery-checkpoint";
    const record: SubmissionRecoveryRecord = {
      ...createSubmissionRecoveryRecord({
        id: checkpointId,
        clientMessageId: "fullscreen-recovery-wire-id",
        now: 100,
        submission: {
          kind: "agent_message",
          serverId: "server",
          agentId: "agent-a",
          workspaceId: "workspace",
          draftId: null,
          cwd: "/repo",
          text: "inspect this checkpoint in fullscreen",
          attachments: [],
        },
        originalDraft: {
          ownerKey: "server:agent-a",
          text: "inspect this checkpoint in fullscreen",
          attachments: [],
          selection: { start: 37, end: 37 },
        },
      }),
      state: "needs_review",
      errorMessage: "The prior submission needs review.",
    };
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({
        putGate: Promise.resolve(),
        onPut: () => {},
        initialRecords: [record],
      }),
    );
    const ordinaryAttachment: UserComposerAttachment = {
      kind: "file",
      attachment: {
        type: "uploaded_file",
        id: "ordinary-fullscreen-file",
        fileName: "ordinary.txt",
        mimeType: "text/plain",
        size: 1,
        path: "/uploads/ordinary.txt",
      },
    };
    const editingSession = new ComposerEditingSession();
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource("ordinary editor text"),
      attachmentSource: createAttachmentSource([ordinaryAttachment]),
      editingSession,
      onSubmit: vi.fn(async () => undefined),
    });
    await waitForReact(
      () =>
        composer.container.querySelectorAll('[data-testid="composer-submission-needs-review"]')
          .length === 1,
    );
    expect(
      composer.container.querySelectorAll('[data-testid="composer-file-attachment-pill"]'),
    ).toHaveLength(1);

    act(() => editingSession.setFullscreen(true));
    await waitForReact(
      () => composer.container.querySelector('[data-testid="composer-fullscreen"]') !== null,
    );

    expect(
      composer.container.querySelectorAll(
        '[data-testid="composer-fullscreen-submission-recovery-tray"]',
      ),
    ).toHaveLength(1);
    expect(
      composer.container.querySelectorAll('[data-testid="composer-submission-needs-review"]'),
    ).toHaveLength(1);
    expect(
      composer.container.querySelectorAll('[data-testid="composer-file-attachment-pill"]'),
    ).toHaveLength(0);

    const recoveryPill = composer.container.querySelector(
      '[data-testid="composer-submission-needs-review"]',
    );
    if (!(recoveryPill instanceof HTMLElement))
      throw new Error("Fullscreen recovery pill not found");
    act(() => recoveryPill.click());
    await waitForReact(
      () => document.querySelector('[data-testid="composer-submission-recovery-sheet"]') !== null,
    );
    expect(
      document.querySelector('[data-testid="composer-submission-recovery-preview"]')?.textContent,
    ).toContain("inspect this checkpoint in fullscreen");
  });

  it("keeps fullscreen open for the synchronous recovery-checkpoint send block", async () => {
    const checkpointId = "fullscreen-blocked-recovery-checkpoint";
    const draftKey = "test:fullscreen-blocked-recovery-checkpoint";
    const record: SubmissionRecoveryRecord = {
      ...createSubmissionRecoveryRecord({
        id: checkpointId,
        clientMessageId: "fullscreen-blocked-recovery-wire-id",
        now: 100,
        submission: {
          kind: "agent_message",
          serverId: "server",
          agentId: "agent-a",
          workspaceId: "workspace",
          draftId: null,
          cwd: "/repo",
          text: "retain fullscreen while blocked",
          attachments: [],
        },
        originalDraft: {
          ownerKey: "server:agent-a",
          text: "retain fullscreen while blocked",
          attachments: [],
          selection: { start: 5, end: 5 },
        },
      }),
      state: "needs_review",
      errorMessage: "This retained checkpoint needs review.",
    };
    const onPut = vi.fn();
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: Promise.resolve(), onPut, initialRecords: [record] }),
    );
    useDraftStore.getState().saveDraftInput({
      draftKey,
      draft: { text: "retain fullscreen while blocked", attachments: [] },
    });
    const snapshot = useDraftStore.getState().getDraftSubmissionSnapshot(draftKey);
    if (!snapshot) throw new Error("Expected active draft snapshot");
    const bound = useDraftStore.getState().bindDraftSubmissionCheckpoint({
      draftKey,
      expectedVersion: snapshot.version,
      submissionCheckpointId: checkpointId,
    });
    if (!bound) throw new Error("Expected recovery binding");

    const editingSession = new ComposerEditingSession();
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    try {
      composer.render({
        agentId: "agent-a",
        persistedDraftKey: draftKey,
        source: createTextSource(""),
        onSubmit,
        editingSession,
      });
      await waitForReact(
        () =>
          composer.container
            .querySelector('[data-testid="composer-root"]')
            ?.getAttribute("data-submission-recovery-state") === "ready",
      );
      act(() => editingSession.setFullscreen(true));
      await waitForReact(
        () => composer.container.querySelector('[data-testid="composer-fullscreen"]') !== null,
      );

      act(() => submitButton(composer.container).click());
      await waitForReact(
        () =>
          composer.container.querySelector('[data-testid="composer-fullscreen"]') !== null &&
          composer.container
            .querySelector('[role="alert"]')
            ?.textContent?.includes("linked to a recovery checkpoint") === true,
      );

      expect(onPut).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      useDraftStore.getState().clearDraftInput({ draftKey });
    }
  });

  it("does not restore fullscreen for an asynchronous durable-preflight failure", async () => {
    const reservation = createDeferred<void>();
    const onPut = vi.fn();
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: reservation.promise, onPut }),
    );
    const editingSession = new ComposerEditingSession();
    const source = createTextSource("ordinary durable failure");
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    const expectedError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      composer.render({ agentId: "agent-a", source, onSubmit, editingSession });
      await waitForReact(
        () =>
          composer.container
            .querySelector('[data-testid="composer-root"]')
            ?.getAttribute("data-submission-recovery-state") === "ready",
      );
      act(() => editingSession.setFullscreen(true));
      await waitForReact(
        () => composer.container.querySelector('[data-testid="composer-fullscreen"]') !== null,
      );

      act(() => submitButton(composer.container).click());
      await waitForReact(() => onPut.mock.calls.length === 1);
      expect(composer.container.querySelector('[data-testid="composer-fullscreen"]')).toBeNull();

      await act(async () => reservation.reject(new Error("durable reservation unavailable")));
      await waitForReact(
        () =>
          composer.container
            .querySelector('[role="alert"]')
            ?.textContent?.includes("durable reservation unavailable") === true,
      );
      expect(composer.container.querySelector('[data-testid="composer-fullscreen"]')).toBeNull();
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      expectedError.mockRestore();
    }
  });

  it("does not restore or bind a checkpoint from a different composer scope", async () => {
    const checkpointId = "restore-wrong-workspace";
    const record = createSubmissionRecoveryRecord({
      id: checkpointId,
      clientMessageId: checkpointId,
      now: 100,
      submission: {
        kind: "agent_message",
        serverId: "server",
        agentId: "agent-a",
        workspaceId: "other-workspace",
        draftId: null,
        cwd: "/repo",
        text: "wrong owner draft",
        attachments: [],
      },
      originalDraft: {
        ownerKey: "server:agent-a",
        text: "wrong owner draft",
        attachments: [],
        selection: { start: 17, end: 17 },
      },
    });
    const onClaim = vi.fn();
    const recoveryStore = createRecoveryStore({
      putGate: Promise.resolve(),
      onPut: () => {},
      onClaim,
      initialRecords: [record],
    });
    __setSubmissionRecoveryStoreForTests(recoveryStore);
    const draftKey = "test:restore-wrong-scope";
    useDraftStore.getState().saveDraftInput({ draftKey, draft: { text: "", attachments: [] } });
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit,
    });
    await waitForReact(
      () =>
        composer.container.querySelectorAll('[data-testid="composer-submission-needs-review"]')
          .length === 1,
    );

    const pill = composer.container.querySelector(
      '[data-testid="composer-submission-needs-review"]',
    );
    if (!(pill instanceof HTMLElement)) throw new Error("Recovery pill not found");
    act(() => pill.click());
    await settleReact();
    const restore = document.querySelector('[aria-label="Restore original draft snapshot"]');
    if (!(restore instanceof HTMLElement)) throw new Error("Restore checkpoint button not found");
    act(() => restore.click());
    await settleReact();

    expect(useDraftStore.getState().getDraftInput(draftKey)).toEqual({ text: "", attachments: [] });
    expect(useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId).toBeUndefined();
    expect(onClaim).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    await expect(recoveryStore.get(checkpointId)).resolves.toEqual(record);
  });

  it("keeps a restored uncertain attempt bound when its persistence flush fails", async () => {
    const checkpointId = "restore-flush-failure";
    const restoredAttachment: UserComposerAttachment = {
      kind: "workspace_file",
      path: "restored-context.md",
      selection: { kind: "whole_file" },
    };
    const record = createSubmissionRecoveryRecord({
      id: checkpointId,
      clientMessageId: checkpointId,
      now: 100,
      submission: {
        kind: "agent_message",
        serverId: "server",
        agentId: "agent-a",
        workspaceId: "workspace",
        draftId: null,
        cwd: "/repo",
        text: "restored uncertain draft",
        attachments: [restoredAttachment],
      },
      originalDraft: {
        ownerKey: "server:agent-a",
        text: "restored uncertain draft",
        attachments: [restoredAttachment],
        selection: { start: 22, end: 22 },
      },
    });
    const onClaim = vi.fn();
    const recoveryStore = createRecoveryStore({
      putGate: Promise.resolve(),
      onPut: () => {},
      onClaim,
      initialRecords: [record],
    });
    __setSubmissionRecoveryStoreForTests(recoveryStore);
    const draftKey = "test:restore-flush-failure";
    useDraftStore.getState().saveDraftInput({ draftKey, draft: { text: "", attachments: [] } });
    const observedRestoredRecords: Array<{ submissionCheckpointId?: string }> = [];
    const unsubscribe = useDraftStore.subscribe((state) => {
      const draft = state.drafts[draftKey];
      if (draft?.input.text === record.originalDraft.text) {
        observedRestoredRecords.push({ submissionCheckpointId: draft.submissionCheckpointId });
      }
    });
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit,
    });
    await waitForReact(
      () =>
        composer.container.querySelectorAll('[data-testid="composer-submission-needs-review"]')
          .length === 1,
    );
    flushDraftPersistStorageOrThrowMock.mockRejectedValueOnce(
      new Error("restored draft flush failed"),
    );
    const expectedWarning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const pill = composer.container.querySelector(
        '[data-testid="composer-submission-needs-review"]',
      );
      if (!(pill instanceof HTMLElement)) throw new Error("Recovery pill not found");
      act(() => pill.click());
      await settleReact();
      const restore = document.querySelector('[aria-label="Restore original draft snapshot"]');
      if (!(restore instanceof HTMLElement)) throw new Error("Restore checkpoint button not found");
      act(() => restore.click());
      await waitForReact(
        () => useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId === checkpointId,
      );
      await waitForReact(() => expectedWarning.mock.calls.length > 0);
      await settleReact();

      expect(useDraftStore.getState().getDraftInput(draftKey)).toEqual({
        text: record.originalDraft.text,
        attachments: [restoredAttachment],
      });
      expect(observedRestoredRecords).not.toHaveLength(0);
      expect(observedRestoredRecords).toEqual(
        expect.arrayContaining([{ submissionCheckpointId: checkpointId }]),
      );
      expect(
        observedRestoredRecords.every((draft) => draft.submissionCheckpointId === checkpointId),
      ).toBe(true);

      // No edit happened after Restore. The explicit ID therefore continues
      // to block a send even though the explicit flush reported an error.
      act(() => submitButton(composer.container).click());
      await settleReact();
      expect(onClaim).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();

      // A failed flush can still have written the atomic record before it
      // reports failure. Simulate that partial-write reload: it remains bound
      // and inspectable rather than exposing restored bytes as a new draft.
      const partiallyPersisted = useDraftStore.getState().drafts[draftKey];
      if (!partiallyPersisted) throw new Error("Expected restored draft record");
      disposeComposer(composer);
      useDraftStore.setState({ drafts: { [draftKey]: partiallyPersisted } });
      const reloadedSubmit = vi.fn(async () => undefined);
      const reloadedComposer = mountComposer();
      reloadedComposer.render({
        agentId: "agent-a",
        source: createTextSource(""),
        persistedDraftKey: draftKey,
        onSubmit: reloadedSubmit,
      });
      await settleReact();
      act(() => submitButton(reloadedComposer.container).click());
      await settleReact();
      expect(onClaim).not.toHaveBeenCalled();
      expect(reloadedSubmit).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      expectedWarning.mockRestore();
    }
  });

  it("does not dispatch when the durable checkpoint binding cannot be flushed", async () => {
    const recoveryStore = createRecoveryStore({ putGate: Promise.resolve(), onPut: () => {} });
    __setSubmissionRecoveryStoreForTests(recoveryStore);
    const draftKey = "test:checkpoint-binding-flush-failure";
    useDraftStore
      .getState()
      .saveDraftInput({ draftKey, draft: { text: "wait for durable binding", attachments: [] } });
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit,
    });
    await settleReact();
    flushDraftPersistStorageOrThrowMock.mockRejectedValueOnce(
      new Error("checkpoint storage unavailable"),
    );

    act(() => submitButton(composer.container).click());
    await settleReact();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId).toBeUndefined();
    await expect(recoveryStore.list()).resolves.toEqual([]);
  });

  it("does not dispatch a prepared snapshot after text changes away and back before publication", async () => {
    const preparation = createDeferred<void>();
    const onPut = vi.fn();
    const recoveryStore = createRecoveryStore({ putGate: preparation.promise, onPut });
    __setSubmissionRecoveryStoreForTests(recoveryStore);
    const text = "prepare this snapshot";
    const draftKey = "test:stale-preparation-after-away-and-back";
    useDraftStore.getState().saveDraftInput({ draftKey, draft: { text, attachments: [] } });
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit,
    });
    await settleReact();

    act(() => submitButton(composer.container).click());
    await waitForReact(() => onPut.mock.calls.length === 1);
    replaceInputText(composer.container, `${text} edited`);
    replaceInputText(composer.container, text);

    await act(async () => preparation.resolve());
    await settleReact();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(useDraftStore.getState().getDraftInput(draftKey)).toEqual({ text, attachments: [] });
    expect(useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId).toBeUndefined();
    await expect(recoveryStore.list()).resolves.toEqual([]);
  });

  it("does not dispatch a prepared snapshot after a newer attachment is saved", async () => {
    const preparation = createDeferred<void>();
    const onPut = vi.fn();
    const recoveryStore = createRecoveryStore({ putGate: preparation.promise, onPut });
    __setSubmissionRecoveryStoreForTests(recoveryStore);
    const text = "prepare attachment snapshot";
    const draftKey = "test:stale-preparation-after-newer-attachment";
    const newerAttachment: UserComposerAttachment = {
      kind: "workspace_file",
      path: "newer-context.md",
      selection: { kind: "whole_file" },
    };
    useDraftStore.getState().saveDraftInput({ draftKey, draft: { text, attachments: [] } });
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit,
    });
    await settleReact();

    act(() => submitButton(composer.container).click());
    await waitForReact(() => onPut.mock.calls.length === 1);
    useDraftStore
      .getState()
      .saveDraftInput({ draftKey, draft: { text, attachments: [newerAttachment] } });

    await act(async () => preparation.resolve());
    await settleReact();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(useDraftStore.getState().getDraftInput(draftKey)).toEqual({
      text,
      attachments: [newerAttachment],
    });
    await expect(recoveryStore.list()).resolves.toEqual([]);
  });

  it("does not dispatch after a draft edit lands between claim and dispatch", async () => {
    const draftKey = "test:stale-after-claim-before-dispatch";
    const initialText = "claim this draft";
    const nextText = "new draft after claim";
    const applyPostClaimDraftEdit = () => {
      useDraftStore
        .getState()
        .saveDraftInput({ draftKey, draft: { text: nextText, attachments: [] } });
    };
    const onClaim = vi.fn(() => {
      // The claim result reaches bind through two promise reactions. Queue
      // three turns so this edit follows bindAndClaimRecovery's final guard
      // but precedes the caller's dispatch continuation.
      queueMicrotaskTurns(3, applyPostClaimDraftEdit);
    });
    const recoveryStore = createRecoveryStore({
      putGate: Promise.resolve(),
      onPut: () => {},
      onClaim,
    });
    __setSubmissionRecoveryStoreForTests(recoveryStore);
    useDraftStore
      .getState()
      .saveDraftInput({ draftKey, draft: { text: initialText, attachments: [] } });
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit,
    });
    await settleReact();

    act(() => submitButton(composer.container).click());
    await waitForReact(() => onClaim.mock.calls.length === 1);
    await settleReact();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(useDraftStore.getState().getDraftInput(draftKey)).toEqual({
      text: nextText,
      attachments: [],
    });
    expect(useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId).toBeUndefined();
    await expect(recoveryStore.list()).resolves.toEqual([
      expect.objectContaining({ state: "needs_review" }),
    ]);
  });

  it("does not clear a newer draft when an earlier submission acknowledges late", async () => {
    const recoveryStore = createRecoveryStore({ putGate: Promise.resolve(), onPut: () => {} });
    __setSubmissionRecoveryStoreForTests(recoveryStore);
    const draftKey = "test:late-ack-preserves-newer-draft";
    useDraftStore
      .getState()
      .saveDraftInput({ draftKey, draft: { text: "first submission", attachments: [] } });
    const acknowledgement = createDeferred<void>();
    const onSubmit = vi.fn(() => acknowledgement.promise);
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit,
    });
    await settleReact();

    act(() => submitButton(composer.container).click());
    await waitForReact(() => onSubmit.mock.calls.length === 1);
    const newerAttachment: UserComposerAttachment = {
      kind: "workspace_file",
      path: "newer-draft.md",
      selection: { kind: "whole_file" },
    };
    replaceInputText(composer.container, "newer typed draft");
    useDraftStore.getState().saveDraftInput({
      draftKey,
      draft: { text: "newer typed draft", attachments: [newerAttachment] },
    });

    await act(async () => acknowledgement.resolve());
    await settleReact();

    expect(useDraftStore.getState().getDraftInput(draftKey)).toEqual({
      text: "newer typed draft",
      attachments: [newerAttachment],
    });
    expect(useDraftStore.getState().drafts[draftKey]?.lifecycle).toBe("active");
    expect(useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId).toBeUndefined();
    expect(
      composer.container.querySelectorAll('[data-testid="composer-submission-needs-review"]'),
    ).toHaveLength(0);
  });

  it("does not show a recovery notice for the current delayed submission", async () => {
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: Promise.resolve(), onPut: () => {} }),
    );
    const draftKey = "test:current-delayed-submission-notice";
    useDraftStore.getState().saveDraftInput({
      draftKey,
      draft: { text: "send without a recovery warning", attachments: [] },
    });
    const acknowledgement = createDeferred<void>();
    const onSubmit = vi.fn(() => acknowledgement.promise);
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit,
    });
    await waitForReact(
      () =>
        composer.container
          .querySelector('[data-testid="composer-root"]')
          ?.getAttribute("data-submission-recovery-state") === "ready",
    );

    act(() => submitButton(composer.container).click());
    await waitForReact(() => onSubmit.mock.calls.length === 1);

    expect(useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId).toEqual(
      expect.any(String),
    );
    expect(
      composer.container.querySelectorAll(
        '[data-testid="composer-submission-checkpoint-unresolved"]',
      ),
    ).toHaveLength(0);
    expect(
      composer.container.querySelectorAll('[data-testid="composer-submission-needs-review"]'),
    ).toHaveLength(0);

    await act(async () => acknowledgement.resolve());
    await waitForReact(() => useDraftStore.getState().drafts[draftKey]?.lifecycle === "sent");
    expect(
      composer.container.querySelectorAll(
        '[data-testid="composer-submission-checkpoint-unresolved"]',
      ),
    ).toHaveLength(0);
  });

  it("keeps a restored checkpoint visible while an earlier submission is delayed", async () => {
    const restoredCheckpointId = "restored-needs-review-checkpoint";
    const restoredRecord = {
      ...createSubmissionRecoveryRecord({
        id: restoredCheckpointId,
        clientMessageId: restoredCheckpointId,
        now: 100,
        submission: {
          kind: "agent_message",
          serverId: "server",
          agentId: "agent-a",
          workspaceId: "workspace",
          draftId: null,
          cwd: "/repo",
          text: "restored checkpoint source",
          attachments: [],
        },
        originalDraft: {
          ownerKey: "server:agent-a",
          text: "restored checkpoint source",
          attachments: [],
          selection: { start: 26, end: 26 },
        },
      }),
      state: "needs_review" as const,
      errorMessage: "The restored checkpoint needs review.",
    };
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({
        putGate: Promise.resolve(),
        onPut: () => {},
        initialRecords: [restoredRecord],
      }),
    );
    const draftKey = "test:current-delayed-submission-with-restored-checkpoint";
    useDraftStore
      .getState()
      .saveDraftInput({ draftKey, draft: { text: "send a new message", attachments: [] } });
    const acknowledgement = createDeferred<void>();
    const onSubmit = vi.fn(() => acknowledgement.promise);
    const composer = mountComposer();
    composer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit,
    });
    await waitForReact(
      () =>
        composer.container
          .querySelector('[data-testid="composer-root"]')
          ?.getAttribute("data-submission-recovery-state") === "ready",
    );
    await waitForReact(
      () =>
        composer.container.querySelectorAll('[data-testid="composer-submission-needs-review"]')
          .length === 1,
    );

    act(() => submitButton(composer.container).click());
    await waitForReact(() => onSubmit.mock.calls.length === 1);

    const executingSnapshot = useDraftStore.getState().getDraftSubmissionSnapshot(draftKey);
    if (!executingSnapshot?.submissionCheckpointId) {
      throw new Error("Expected executing checkpoint binding");
    }
    act(() => {
      const detached = useDraftStore.getState().detachDraftSubmissionCheckpoint({
        draftKey,
        expectedVersion: executingSnapshot.version,
        submissionCheckpointId: executingSnapshot.submissionCheckpointId,
      });
      if (!detached) throw new Error("Expected executing checkpoint detach");
    });
    await waitForReact(
      () => useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId === undefined,
    );

    const pill = composer.container.querySelector(
      '[data-testid="composer-submission-needs-review"]',
    );
    if (!(pill instanceof HTMLElement)) throw new Error("Recovery pill not found");
    act(() => pill.click());
    await settleReact();
    const restore = document.querySelector('[aria-label="Restore original draft snapshot"]');
    if (!(restore instanceof HTMLElement)) throw new Error("Restore checkpoint button not found");
    act(() => restore.click());
    await waitForReact(
      () =>
        useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId === restoredCheckpointId,
    );

    await waitForReact(
      () =>
        composer.container.querySelectorAll('[data-testid="composer-submission-needs-review"]')
          .length === 1,
    );

    await act(async () => acknowledgement.resolve());
    await settleReact();
    expect(useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId).toBe(
      restoredCheckpointId,
    );
    expect(
      composer.container.querySelectorAll('[data-testid="composer-submission-needs-review"]'),
    ).toHaveLength(1);
  });

  it("keeps a bound accepted snapshot settled across a failed draft-clear flush and reload", async () => {
    const recoveryStore = createRecoveryStore({ putGate: Promise.resolve(), onPut: () => {} });
    __setSubmissionRecoveryStoreForTests(recoveryStore);
    const originalText = "accepted before draft cleanup";
    const draftKey = "test:accepted-checkpoint-after-clear-flush-failure";
    useDraftStore
      .getState()
      .saveDraftInput({ draftKey, draft: { text: originalText, attachments: [] } });
    const initialSubmit = vi.fn(async () => undefined);
    const firstComposer = mountComposer();
    // Provider acceptance is authoritative. Only the subsequent local cleanup
    // barrier fails, leaving the durable checkpoint binding for the simulated
    // reload below.
    flushDraftPersistStorageOrThrowMock.mockResolvedValueOnce(undefined);
    flushDraftPersistStorageOrThrowMock.mockRejectedValueOnce(
      new Error("draft clear storage unavailable"),
    );
    firstComposer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit: initialSubmit,
    });
    await settleReact();

    act(() => submitButton(firstComposer.container).click());
    await waitForReact(() => initialSubmit.mock.calls.length === 1);
    await waitForReact(() => useDraftStore.getState().drafts[draftKey]?.lifecycle === "sent");
    const sentRecord = useDraftStore.getState().drafts[draftKey];
    if (!sentRecord?.submissionCheckpointId) {
      throw new Error("Expected accepted draft checkpoint binding");
    }

    // Simulate a reload which rehydrates the older draft record because the
    // accepted send's clear flush failed. The persisted checkpoint ID, rather
    // than matching bytes, remains the evidence that this draft was accepted.
    disposeComposer(firstComposer);
    const reloadedDrafts = {
      ...useDraftStore.getState().drafts,
      [draftKey]: {
        ...sentRecord,
        input: { text: originalText, attachments: [] },
        lifecycle: "active" as const,
        version: sentRecord.version + 1,
      },
    };
    act(() => {
      useDraftStore.setState({ drafts: reloadedDrafts });
    });
    const reloadedSubmit = vi.fn(async () => undefined);
    const reloadedComposer = mountComposer();
    reloadedComposer.render({
      agentId: "agent-a",
      source: createTextSource(""),
      persistedDraftKey: draftKey,
      onSubmit: reloadedSubmit,
    });
    await settleReact();

    expect(
      reloadedComposer.container.querySelectorAll(
        '[data-testid="composer-submission-needs-review"]',
      ),
    ).toHaveLength(1);
    act(() => submitButton(reloadedComposer.container).click());
    await settleReact();
    expect(reloadedSubmit).not.toHaveBeenCalled();
    expect(useDraftStore.getState().getDraftInput(draftKey)?.text).toBe(originalText);

    // A genuine edit detaches the checkpoint before the after-paint
    // publication. Returning to the same bytes never rebinds it.
    replaceInputText(reloadedComposer.container, `${originalText} detour`);
    await settleReact();
    expect(useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId).toBeUndefined();
    replaceInputText(reloadedComposer.container, originalText);
    await settleReact();
    expect(useDraftStore.getState().drafts[draftKey]?.submissionCheckpointId).toBeUndefined();
    expect(
      reloadedComposer.container.querySelectorAll(
        '[data-testid="composer-submission-needs-review"]',
      ),
    ).toHaveLength(0);
    act(() => submitButton(reloadedComposer.container).click());
    await waitForReact(() => reloadedSubmit.mock.calls.length === 1);
    expect(reloadedSubmit).toHaveBeenCalledWith(expect.objectContaining({ text: originalText }));
  });

  it("keeps a successful file upload singular when its draft-reference flush fails", async () => {
    const uploadFile = vi.fn(async () => ({
      requestId: "upload-1",
      file: {
        type: "uploaded_file" as const,
        id: "uploaded-1",
        fileName: "notes.txt",
        mimeType: "text/plain",
        size: 5,
        path: "/uploads/notes.txt",
      },
      error: null,
    }));
    hostRuntimeTestState.client = {
      isConnected: true,
      uploadFile,
      subscribeRawMessages: () => () => undefined,
      subscribeConnectionStatus: () => () => undefined,
      on: () => () => undefined,
    };
    hostRuntimeTestState.isConnected = true;
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: Promise.resolve(), onPut: () => {} }),
    );
    const source = createTextSource("");
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({ agentId: "agent-a", source, onSubmit });
    await settleReact();

    flushDraftPersistStorageOrThrowMock.mockRejectedValueOnce(
      new Error("draft reference flush failed"),
    );
    const paste = pasteFile(
      composer.container,
      new File(["notes"], "notes.txt", { type: "text/plain" }),
    );
    expect(paste.defaultPrevented).toBe(true);
    await waitFor(
      () =>
        uploadFile.mock.calls.length === 1 &&
        composer.container.querySelectorAll('[data-testid="composer-file-attachment-pill"]')
          .length === 1,
    );
    await settleReact();

    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(
      composer.container.querySelectorAll('[data-testid="composer-file-attachment-pill"]'),
    ).toHaveLength(1);

    // Sending retries only the pending draft-reference barrier. It neither
    // uploads the source file again nor appends a second attachment.
    act(() => submitButton(composer.container).click());
    await settleReact();
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "",
        attachments: [
          {
            kind: "file",
            attachment: expect.objectContaining({ id: "uploaded-1", fileName: "notes.txt" }),
          },
        ],
      }),
    );
  });

  it("keeps a successful pasted-text blob singular when its draft-reference flush fails", async () => {
    const attachmentStore = createAttachmentStoreForPaste();
    __setAttachmentStoreForTests(attachmentStore.store);
    __setSubmissionRecoveryStoreForTests(
      createRecoveryStore({ putGate: Promise.resolve(), onPut: () => {} }),
    );
    const source = createTextSource("");
    const onSubmit = vi.fn(async () => undefined);
    const composer = mountComposer();
    composer.render({ agentId: "agent-a", source, onSubmit });
    await settleReact();

    flushDraftPersistStorageOrThrowMock.mockRejectedValueOnce(
      new Error("draft reference flush failed"),
    );
    const exactText = "x".repeat(8_000);
    const paste = pasteText(composer.container, exactText);
    expect(paste.defaultPrevented).toBe(true);
    await waitForReact(
      () =>
        attachmentStore.saved.length === 1 &&
        composer.container.querySelectorAll('[data-testid="composer-pasted-text-attachment-pill"]')
          .length === 1,
    );
    await settleReact();

    expect(attachmentStore.saved).toHaveLength(1);
    expect(attachmentStore.saved[0]?.source).toMatchObject({ kind: "bytes" });
    expect(
      composer.container.querySelectorAll('[data-testid="composer-pasted-text-attachment-pill"]'),
    ).toHaveLength(1);

    act(() => submitButton(composer.container).click());
    await settleReact();
    expect(attachmentStore.saved).toHaveLength(1);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "",
        attachments: [
          expect.objectContaining({
            kind: "pasted_text",
            codePointCount: 8_000,
            logicalLineCount: 1,
          }),
        ],
      }),
    );
  });
});

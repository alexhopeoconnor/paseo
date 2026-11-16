import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { flushDraftPersistStorageOrThrowMock } = vi.hoisted(() => ({
  flushDraftPersistStorageOrThrowMock: vi.fn(),
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
vi.mock("@/runtime/host-runtime", () => {
  const connectionStatuses = new Map();
  const hosts: never[] = [];
  return {
    getHostRuntimeStore: () => ({
      beginAgentCancellation: () => "test-cancellation",
      settleAgentCancellation: () => undefined,
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
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { KeyboardShiftProvider } from "@/keyboard/shift";
import type {
  AttachmentStore,
  ChatHistoryContextAttachment,
  ComposerAttachment,
  SaveAttachmentInput,
  UserComposerAttachment,
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
import { Composer } from "./index";
import { persistPastedTextAttachment } from "./pasted-text";
import { useAgentInputDraft } from "./draft/input-draft";
import { useDraftStore } from "@/stores/draft-store";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { i18n } from "@/i18n/i18next";

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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
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
      const lease: SubmissionRecoveryLease = {
        ownerId,
        fence: `fence:${id}`,
        expiresAt: now + leaseMs,
      };
      const claimed: SubmissionRecoveryRecord = {
        ...record,
        state: "dispatching",
        lease,
        dispatchLease: lease,
        updatedAt: now,
      };
      records.set(id, claimed);
      return { status: "acquired", record: claimed, lease };
    },
    markNeedsReview: async ({ id, lease, errorMessage, now }) => {
      const record = records.get(id) ?? null;
      if (!record) return null;
      const next: SubmissionRecoveryRecord = {
        ...record,
        state: "needs_review",
        lease: null,
        dispatchLease: lease,
        errorMessage,
        updatedAt: now,
      };
      records.set(id, next);
      return next;
    },
    markSettled: async ({ id, now }) => {
      const record = records.get(id) ?? null;
      if (!record) return null;
      const next: SubmissionRecoveryRecord = {
        ...record,
        state: "settled",
        lease: null,
        acceptedAt: now,
        updatedAt: now,
      };
      records.set(id, next);
      return next;
    },
    remove: async (id) => {
      records.delete(id);
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
}: Pick<
  ComposerRenderInput,
  "agentId" | "onSubmit" | "allowEmptySubmit" | "hasExternalContent" | "attachmentScopeKeys"
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
      onSubmitMessage={onSubmit}
      allowEmptySubmit={allowEmptySubmit}
      hasExternalContent={hasExternalContent}
      attachmentScopeKeys={attachmentScopeKeys}
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
      onSubmitMessage={handleSubmitMessage}
      allowEmptySubmit={allowEmptySubmit}
      hasExternalContent={hasExternalContent}
      attachmentScopeKeys={attachmentScopeKeys}
      submitButtonTestID="submit"
    />
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
  }) => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <KeyboardActionDispatcherProvider>
            <KeyboardShiftProvider>
              <ToastApiProvider api={testToastApi}>
                {persistedDraftKey ? (
                  <PersistedDraftComposer
                    agentId={agentId}
                    draftKey={persistedDraftKey}
                    onSubmit={onSubmit}
                    allowEmptySubmit={allowEmptySubmit}
                    hasExternalContent={hasExternalContent}
                    attachmentScopeKeys={attachmentScopeKeys}
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
                  />
                )}
              </ToastApiProvider>
            </KeyboardShiftProvider>
          </KeyboardActionDispatcherProvider>
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
    useDraftStore
      .getState()
      .saveDraftInput({
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

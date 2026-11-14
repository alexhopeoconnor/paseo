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
import type { ComposerAttachment, UserComposerAttachment } from "@/attachments/types";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import type { AttachmentStore, SaveAttachmentInput } from "@/attachments/types";
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
  onPut: () => void;
  onClaim?: () => void;
  initialRecords?: SubmissionRecoveryRecord[];
}): SubmissionRecoveryStore {
  const records = new Map<string, SubmissionRecoveryRecord>(
    input.initialRecords?.map((record): [string, SubmissionRecoveryRecord] => [record.id, record]),
  );
  return {
    putIfAbsent: async (record) => {
      input.onPut();
      await input.putGate;
      const existing = records.get(record.id);
      if (existing) return existing;
      records.set(record.id, record);
      return record;
    },
    get: async (id) => records.get(id) ?? null,
    list: async () => Array.from(records.values()),
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
  source: MutableTextSource;
  attachmentSource?: MutableAttachmentSource;
  onSubmit: (payload: { text: string; attachments: ComposerAttachment[] }) => Promise<void>;
  clearDraft?: () => void;
}

interface MountedComposer {
  root: Root;
  container: HTMLDivElement;
  render: (input: ComposerRenderInput) => void;
}

const mounted: MountedComposer[] = [];
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
    source,
    attachmentSource,
    onSubmit,
    clearDraft,
  }) => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <KeyboardActionDispatcherProvider>
            <KeyboardShiftProvider>
              <ToastApiProvider api={testToastApi}>
                <ControlledComposer
                  agentId={agentId}
                  source={source}
                  attachmentSource={attachmentSource}
                  onSubmit={onSubmit}
                  clearDraft={clearDraft}
                />
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
    const source = createTextSource("create this workspace agent");
    const onCreate = vi.fn(async () => {
      throw new Error("The create request may have reached the provider.");
    });
    const composer = mountComposer();
    composer.render({ agentId: "workspace-create", source, onSubmit: onCreate });
    await settleReact();

    act(() => submitButton(composer.container).click());
    await settleReact();
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(source.textSource.getSnapshot()).toBe("create this workspace agent");
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

  it("keeps an accepted snapshot settled across a failed draft-clear flush and reload", async () => {
    const recoveryStore = createRecoveryStore({ putGate: Promise.resolve(), onPut: () => {} });
    __setSubmissionRecoveryStoreForTests(recoveryStore);
    const originalText = "accepted before draft cleanup";
    const initialSource = createTextSource(originalText);
    const initialSubmit = vi.fn(async () => undefined);
    const firstComposer = mountComposer();
    // Provider acceptance is authoritative. Only the subsequent local cleanup
    // barrier fails, leaving the old persisted draft bytes for the simulated
    // reload below.
    flushDraftPersistStorageOrThrowMock.mockRejectedValueOnce(
      new Error("draft clear storage unavailable"),
    );
    firstComposer.render({ agentId: "agent-a", source: initialSource, onSubmit: initialSubmit });
    await settleReact();

    act(() => submitButton(firstComposer.container).click());
    await settleReact();
    expect(initialSubmit).toHaveBeenCalledTimes(1);
    expect(initialSource.textSource.getSnapshot()).toBe("");

    // Simulate a reload which rehydrates the older draft record because the
    // accepted send's clear flush failed. The settled checkpoint remains the
    // immutable evidence that those exact bytes were already accepted.
    disposeComposer(firstComposer);
    const reloadedSource = createTextSource(originalText);
    const reloadedSubmit = vi.fn(async () => undefined);
    const reloadedComposer = mountComposer();
    reloadedComposer.render({
      agentId: "agent-a",
      source: reloadedSource,
      onSubmit: reloadedSubmit,
    });
    await settleReact();

    act(() => submitButton(reloadedComposer.container).click());
    await settleReact();
    expect(reloadedSubmit).not.toHaveBeenCalled();
    expect(reloadedSource.textSource.getSnapshot()).toBe(originalText);

    // A genuine newer edit is not conflated with the settled snapshot and
    // receives a new ordinary submission path.
    replaceInputText(reloadedComposer.container, `${originalText} with newer user edits`);
    await settleReact();
    act(() => submitButton(reloadedComposer.container).click());
    await settleReact();
    expect(reloadedSubmit).toHaveBeenCalledTimes(1);
    expect(reloadedSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ text: `${originalText} with newer user edits` }),
    );
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

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AttachmentMetadata,
  AttachmentStore,
  ComposerAttachment,
  SaveAttachmentInput,
} from "@/attachments/types";

const agedAttachment: AttachmentMetadata = {
  id: "aged-future-draft-paste",
  mimeType: "text/plain",
  storageType: "web-indexeddb",
  storageKey: "attachments/aged-future-draft-paste",
  createdAt: 0,
  fileName: null,
  byteSize: 42,
};

const { asyncStorage, controls, rawStorage } = vi.hoisted(() => {
  const storedValues = new Map<string, string>();
  const mockControls = {
    read: async (key: string) => storedValues.get(key) ?? null,
    recoveryList: async () => [] as unknown[],
    writes: 0,
  };
  return {
    asyncStorage: storedValues,
    controls: mockControls,
    rawStorage: {
      getItem: (key: string) => storedValues.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storedValues.set(key, value);
      },
      removeItem: (key: string) => {
        storedValues.delete(key);
      },
      clear: () => {
        storedValues.clear();
      },
    },
  };
});

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installWebRawStorage(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: globalThis,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: rawStorage,
  });
}

afterAll(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => controls.read(key),
    setItem: async (key: string, value: string) => {
      controls.writes += 1;
      asyncStorage.set(key, value);
    },
    removeItem: async (key: string) => {
      controls.writes += 1;
      asyncStorage.delete(key);
    },
  },
}));

// Keep the test focused on the draft envelope. Without this, the node test
// runtime has no IndexedDB and the recovery-store read would independently
// fail closed before the draft collector has a chance to demonstrate its own
// preservation guarantee.
vi.mock("@/stores/workspace-draft-submission-recovery", () => ({
  collectRecoveryAttachmentIds: () => new Set<string>(),
  getSubmissionRecoveryStore: () => ({
    list: () => controls.recoveryList(),
  }),
}));

function futureEnvelope(): string {
  return JSON.stringify({
    state: {
      drafts: {
        "agent:future:owner": {
          input: {
            text: "",
            attachments: [
              {
                kind: "pasted_text",
                metadata: agedAttachment,
                codePointCount: 42,
                logicalLineCount: 1,
              },
            ],
          },
          lifecycle: "active",
          updatedAt: 1,
          version: 1,
        },
      },
      createModalDraft: null,
    },
    // This must remain newer than the currently supported v8 envelope.
    version: 9,
  });
}

function currentEnvelopeWithAttachment(): string {
  return JSON.stringify({
    state: {
      drafts: {
        "agent:safe:owner": {
          input: {
            text: "",
            attachments: [
              {
                kind: "pasted_text",
                metadata: agedAttachment,
                codePointCount: 42,
                logicalLineCount: 1,
              },
            ],
          },
          lifecycle: "active",
          updatedAt: 1,
          version: 1,
          draftOccurrenceKey: "safe-occurrence",
        },
      },
      createModalDraft: null,
    },
    version: 8,
  });
}

function supportedEmptyEnvelope(): string {
  return JSON.stringify({
    state: {
      drafts: {},
      createModalDraft: null,
    },
    version: 8,
  });
}

function legacyQueuedBrowserElementWithScreenshot(): Extract<
  ComposerAttachment,
  { kind: "browser_element" }
> {
  return {
    kind: "browser_element",
    attachment: {
      url: "https://example.test/queued-element",
      selector: "button.save",
      tag: "button",
      text: "Save",
      outerHTML: '<button class="save">Save</button>',
      computedStyles: {},
      boundingRect: { x: 0, y: 0, width: 10, height: 10 },
      reactSource: null,
      parentChain: [],
      children: [],
      formatted: "Save button",
      screenshot: agedAttachment,
    },
  };
}

function currentV8LegacyModalEnvelope(): string {
  return JSON.stringify({
    state: {
      drafts: {},
      createModalDraft: {
        input: {
          text: "visible modal",
          images: [
            {
              uri: "data:text/plain;base64,bW9kYWw=",
              mimeType: "text/plain",
            },
          ],
        },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
        draftOccurrenceKey: "modal-occurrence",
      },
    },
    version: 8,
  });
}

function createAgedAttachmentStore(
  input: { failSave?: boolean; deferSave?: boolean } = {},
): AttachmentStore & {
  deletedIds: string[];
  garbageCollectionReferenceSnapshots: string[][];
  saveSources: SaveAttachmentInput["source"]["kind"][];
  saveStarted: Promise<void>;
  releaseSave: () => void;
} {
  const deletedIds: string[] = [];
  const garbageCollectionReferenceSnapshots: string[][] = [];
  const saveSources: SaveAttachmentInput["source"]["kind"][] = [];
  let resolveSaveStarted!: () => void;
  const saveStarted = new Promise<void>((resolve) => {
    resolveSaveStarted = resolve;
  });
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let didStartSave = false;

  return {
    storageType: "web-indexeddb",
    deletedIds,
    garbageCollectionReferenceSnapshots,
    saveSources,
    saveStarted,
    releaseSave,
    async save(value) {
      saveSources.push(value.source.kind);
      if (!didStartSave) {
        didStartSave = true;
        resolveSaveStarted();
      }
      if (input.deferSave) {
        await saveGate;
      }
      if (input.failSave) {
        throw new Error("attachment quota rejected migration");
      }
      return agedAttachment;
    },
    async encodeBase64() {
      return "";
    },
    async resolvePreviewUrl() {
      return "blob:aged-future-draft-paste";
    },
    async delete({ attachment }) {
      deletedIds.push(attachment.id);
    },
    async garbageCollect({ referencedIds }) {
      garbageCollectionReferenceSnapshots.push([...referencedIds]);
      if (!referencedIds.has(agedAttachment.id)) {
        deletedIds.push(agedAttachment.id);
      }
    },
  };
}

let clearAttachmentStore: (() => void) | null = null;

async function createHarness(input?: { failSave?: boolean; deferSave?: boolean }) {
  // Each case needs its own Zustand/persistence module state: a future or
  // failed migration deliberately latches that state for its whole session.
  installWebRawStorage();
  vi.resetModules();
  const attachmentStore = createAgedAttachmentStore(input);
  const attachmentStoreModule = await import("@/attachments/store");
  attachmentStoreModule.__setAttachmentStoreForTests(attachmentStore);
  clearAttachmentStore = () => attachmentStoreModule.__setAttachmentStoreForTests(null);
  const { deleteAttachments } = await import("@/attachments/service");
  const { useSessionStore } = await import("@/stores/session-store");
  const { flushDraftPersistStorageOrThrow, scheduleAttachmentGarbageCollection, useDraftStore } =
    await import("./index");
  return {
    attachmentStore,
    deleteAttachments,
    flushDraftPersistStorageOrThrow,
    scheduleAttachmentGarbageCollection,
    useDraftStore,
    useSessionStore,
  };
}

async function waitForFinalization(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

interface WarningSpy {
  mock: { calls: readonly (readonly unknown[])[] };
}

function suppressWarning(): void {}

function warningIncludes(spy: WarningSpy, text: string): boolean {
  return spy.mock.calls.some((call) => String(call[0]).includes(text));
}

async function waitForWarning(spy: WarningSpy, text: string, description: string): Promise<void> {
  await waitForFinalization(() => warningIncludes(spy, text), description);
}

function hasAgedAttachmentSnapshot(
  store: Pick<ReturnType<typeof createAgedAttachmentStore>, "garbageCollectionReferenceSnapshots">,
): boolean {
  return store.garbageCollectionReferenceSnapshots.some((ids) => ids.includes(agedAttachment.id));
}

async function waitForAgedAttachmentSnapshot(
  store: Pick<ReturnType<typeof createAgedAttachmentStore>, "garbageCollectionReferenceSnapshots">,
  description: string,
): Promise<void> {
  await waitForFinalization(() => hasAgedAttachmentSnapshot(store), description);
}

function includesAgedImage(attachments: readonly ComposerAttachment[] | undefined): boolean {
  return (
    attachments?.some(
      (attachment) => attachment.kind === "image" && attachment.metadata.id === agedAttachment.id,
    ) ?? false
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function establishSafeHydration(input: {
  attachmentStore: ReturnType<typeof createAgedAttachmentStore>;
}): Promise<void> {
  await waitForFinalization(
    // This is intentionally source-driven: the persisted, supported v8
    // envelope must become safe and the hydration finalizer itself must
    // schedule GC. A recorded store call proves an authority reached actual
    // destructive admission; no test-issued collector request can hide a
    // liveness regression in that handoff.
    () => input.attachmentStore.garbageCollectionReferenceSnapshots.length > 0,
    "source-driven safe hydration collector",
  );
  input.attachmentStore.garbageCollectionReferenceSnapshots.length = 0;
  input.attachmentStore.deletedIds.length = 0;
}

describe("draft attachment retention when persisted references are unknown", () => {
  afterEach(() => {
    clearAttachmentStore?.();
    clearAttachmentStore = null;
    asyncStorage.clear();
    controls.read = async (key: string) => asyncStorage.get(key) ?? null;
    controls.recoveryList = async () => [];
    controls.writes = 0;
    vi.restoreAllMocks();
  });

  describe("v7 migration fixture", () => {
    const draftKey = "agent:migrated:owner";
    const checkpointId = "retained-v7-checkpoint";
    const originalDraft = {
      text: "Keep this prompt through the upgrade.",
      attachments: [
        {
          kind: "pasted_text",
          metadata: agedAttachment,
          codePointCount: 42,
          logicalLineCount: 1,
        },
      ],
    };
    let harness: Awaited<ReturnType<typeof createHarness>>;

    beforeEach(async () => {
      asyncStorage.set(
        "paseo-drafts",
        JSON.stringify({
          state: {
            drafts: {
              [draftKey]: {
                input: originalDraft,
                lifecycle: "active",
                updatedAt: 1,
                version: 1,
                submissionCheckpointId: checkpointId,
              },
            },
            createModalDraft: null,
          },
          version: 7,
        }),
      );
      harness = await createHarness();
    }, 10_000);

    it("finishes real Zustand migration before a later submission durability barrier", async () => {
      const { attachmentStore, flushDraftPersistStorageOrThrow, useDraftStore } = harness;

      // Exercise persist's real migration write and post-hydration callback.
      // Calling the storage finalizer directly would hide their circular wait.
      await waitForFinalization(useDraftStore.persist.hasHydrated, "v7 draft hydration");
      await flushDraftPersistStorageOrThrow();
      await waitForAgedAttachmentSnapshot(attachmentStore, "migrated draft attachment collector");

      const migrated = useDraftStore.getState().drafts[draftKey];
      expect(migrated).toMatchObject({
        input: originalDraft,
        submissionCheckpointId: checkpointId,
        draftOccurrenceKey: expect.any(String),
      });
      const persisted = JSON.parse(asyncStorage.get("paseo-drafts") ?? "{}");
      expect(persisted.version).toBe(8);
      expect(persisted.state.drafts[draftKey]).toEqual(migrated);
      expect(attachmentStore.deletedIds).toEqual([]);

      const nextDraftKey = "agent:next:owner";
      useDraftStore.getState().saveDraftInput({
        draftKey: nextDraftKey,
        draft: { text: "The next deliberate message.", attachments: [] },
      });
      const snapshot = useDraftStore.getState().getDraftSubmissionSnapshot(nextDraftKey);
      if (!snapshot) throw new Error("Expected the next draft submission snapshot");
      const bound = useDraftStore.getState().bindDraftSubmissionCheckpoint({
        draftKey: nextDraftKey,
        expectedVersion: snapshot.version,
        submissionCheckpointId: "next-checkpoint",
      });
      expect(bound?.submissionCheckpointId).toBe("next-checkpoint");
      await flushDraftPersistStorageOrThrow();

      const afterBinding = JSON.parse(asyncStorage.get("paseo-drafts") ?? "{}");
      expect(afterBinding.state.drafts[nextDraftKey].submissionCheckpointId).toBe(
        "next-checkpoint",
      );
      expect(afterBinding.state.drafts[draftKey]).toEqual(migrated);
      expect(attachmentStore.deletedIds).toEqual([]);
    });
  });

  describe("future-envelope fixture", () => {
    const raw = futureEnvelope();
    let harness: Awaited<ReturnType<typeof createHarness>>;

    beforeEach(async () => {
      // The import starts automatic hydration, so seed the exact source before
      // creating the session-latched harness. Its finite hook budget keeps
      // dynamic module setup outside the retention assertion budget.
      asyncStorage.set("paseo-drafts", raw);
      harness = await createHarness();
    }, 10_000);

    it("retains an aged future-envelope paste from automatic GC and direct deletion", async () => {
      const {
        attachmentStore,
        deleteAttachments,
        scheduleAttachmentGarbageCollection,
        useDraftStore,
      } = harness;
      const warn = vi.spyOn(console, "warn").mockImplementation(suppressWarning);

      // Initial module hydration also sees the future envelope. Rehydrate here
      // so this remains deterministic if a runner imported the store before its
      // first queued hydration pass completed.
      await useDraftStore.persist.rehydrate();
      await waitForWarning(
        warn,
        "hydration did not become durable",
        "future-envelope hydration failure",
      );
      scheduleAttachmentGarbageCollection();
      await waitForWarning(
        warn,
        "Skipping attachment garbage collection",
        "future-envelope GC guard",
      );

      // Unknown bytes must stop before `garbageCollectAttachments`; passing an
      // empty set would erase this old attachment in the recording store.
      expect(attachmentStore.garbageCollectionReferenceSnapshots).toEqual([]);
      expect(attachmentStore.deletedIds).toEqual([]);
      expect(asyncStorage.get("paseo-drafts")).toBe(raw);

      // The same reference uncertainty must fail closed in the legacy direct
      // delete path, which is still used by Composer Discard/pill removal.
      await deleteAttachments([agedAttachment]);
      expect(attachmentStore.deletedIds).toEqual([]);
      expect(warn).toHaveBeenCalled();
    });
  });

  describe("legacy queued screenshot fixture", () => {
    let harness: Awaited<ReturnType<typeof createHarness>>;

    beforeEach(async () => {
      // This case needs a separately initialized module graph, but it must
      // expose its supported empty envelope before imports begin.
      asyncStorage.set("paseo-drafts", supportedEmptyEnvelope());
      harness = await createHarness();
    }, 10_000);

    it("retains a legacy queued browser-element screenshot from automatic GC and direct deletion", async () => {
      const {
        attachmentStore,
        deleteAttachments,
        scheduleAttachmentGarbageCollection,
        useSessionStore,
      } = harness;
      await establishSafeHydration({ attachmentStore });

      const serverId = "legacy-queue-server";
      const agentId = "legacy-queue-agent";
      const sessionStore = useSessionStore.getState();
      const legacyQueuedRow = {
        id: "legacy-browser-element-row",
        text: "Keep the queued screenshot.",
        // Intentionally no clientMessageId/submissionRecoveryId: this is the
        // pre-v8 in-memory queue shape whose screenshot must still be retained.
        attachments: [legacyQueuedBrowserElementWithScreenshot()],
      };
      sessionStore.initializeSession(serverId, null as never);
      sessionStore.setQueuedMessages(serverId, new Map([[agentId, [legacyQueuedRow]]]));

      try {
        await deleteAttachments([agedAttachment]);
        expect(attachmentStore.deletedIds).toEqual([]);

        scheduleAttachmentGarbageCollection();
        await waitForAgedAttachmentSnapshot(
          attachmentStore,
          "legacy queued screenshot attachment collector",
        );

        expect(attachmentStore.garbageCollectionReferenceSnapshots).toContainEqual([
          agedAttachment.id,
        ]);
        expect(attachmentStore.deletedIds).toEqual([]);
      } finally {
        sessionStore.clearSession(serverId);
      }
    });
  });

  it("keeps a legacy queued attachment in an automatic-GC snapshot after a failed handoff restores its row", async () => {
    asyncStorage.set("paseo-drafts", supportedEmptyEnvelope());
    const { attachmentStore, scheduleAttachmentGarbageCollection, useSessionStore } =
      await createHarness();
    await establishSafeHydration({ attachmentStore });
    const { sendQueuedComposerMessageNow } = await import("@/composer/actions");
    const { collectRetainedAttachmentIds } = await import("@/attachments/gc-retention");
    const serverId = "legacy-queue-gc-tail-server";
    const agentId = "legacy-queue-gc-tail-agent";
    const sessionStore = useSessionStore.getState();
    const item = {
      id: "legacy-queue-gc-tail-row",
      text: "Keep this image through the recovery-list tail.",
      attachments: [{ kind: "image" as const, metadata: agedAttachment }],
    };
    sessionStore.initializeSession(serverId, null as never);
    sessionStore.setQueuedMessages(serverId, new Map([[agentId, [item]]]));
    const submitStarted = deferred<void>();
    const submitGate = deferred<void>();
    const recoveryListStarted = deferred<void>();
    const releaseRecoveryList = deferred<unknown[]>();
    const storeSetupStarted = deferred<void>();
    const releaseStoreSetup = deferred<void>();
    const originalGarbageCollect = attachmentStore.garbageCollect.bind(attachmentStore);
    const admittedReferences: string[][] = [];
    attachmentStore.garbageCollect = async (input) => {
      admittedReferences.push([...input.referencedIds]);
      storeSetupStarted.resolve();
      await releaseStoreSetup.promise;
      await originalGarbageCollect(input);
    };
    controls.recoveryList = async () => {
      recoveryListStarted.resolve();
      return await releaseRecoveryList.promise;
    };

    try {
      const sending = sendQueuedComposerMessageNow({
        agentId,
        messageId: item.id,
        queue: {
          read: (queuedAgentId) =>
            useSessionStore.getState().sessions[serverId]?.queuedMessages.get(queuedAgentId) ?? [],
          write: (updater) => useSessionStore.getState().setQueuedMessages(serverId, updater),
        },
        submitMessage: async () => {
          submitStarted.resolve();
          await submitGate.promise;
        },
      });
      await submitStarted.promise;
      expect(useSessionStore.getState().sessions[serverId]?.queuedMessages.get(agentId)).toEqual(
        [],
      );
      expect(collectRetainedAttachmentIds()).toEqual(new Set([agedAttachment.id]));

      // The collector sees the row absent but copies the temporary hold before
      // its recovery-store await. The send then fails, restores the row, and
      // releases that temporary hold before the stale collector resumes.
      scheduleAttachmentGarbageCollection();
      await recoveryListStarted.promise;
      submitGate.reject(new Error("legacy reservation rejected"));
      await expect(sending).resolves.toEqual({
        status: "failed",
        errorMessage: "legacy reservation rejected",
      });
      expect(useSessionStore.getState().sessions[serverId]?.queuedMessages.get(agentId)).toEqual([
        item,
      ]);
      expect(collectRetainedAttachmentIds()).toEqual(new Set());

      releaseRecoveryList.resolve([]);
      await storeSetupStarted.promise;
      // The service reached its store-load boundary after the hold had gone;
      // the returned lifecycle snapshot itself must still carry the ID.
      expect(admittedReferences).toEqual([[agedAttachment.id]]);
      releaseStoreSetup.resolve();
      await waitForFinalization(
        () => attachmentStore.garbageCollectionReferenceSnapshots.length === 1,
        "legacy failed-handoff automatic collector",
      );
      expect(attachmentStore.deletedIds).toEqual([]);
    } finally {
      releaseRecoveryList.resolve([]);
      releaseStoreSetup.resolve();
      sessionStore.clearSession(serverId);
    }
  });

  it("keeps a legacy queued attachment out of direct deletion after a delayed recovery-list tail", async () => {
    asyncStorage.set("paseo-drafts", supportedEmptyEnvelope());
    const { attachmentStore, deleteAttachments, useSessionStore } = await createHarness();
    await establishSafeHydration({ attachmentStore });
    const { sendQueuedComposerMessageNow } = await import("@/composer/actions");
    const { collectRetainedAttachmentIds } = await import("@/attachments/gc-retention");
    const serverId = "legacy-queue-delete-tail-server";
    const agentId = "legacy-queue-delete-tail-agent";
    const sessionStore = useSessionStore.getState();
    const item = {
      id: "legacy-queue-delete-tail-row",
      text: "Keep this image through direct delete.",
      attachments: [{ kind: "image" as const, metadata: agedAttachment }],
    };
    sessionStore.initializeSession(serverId, null as never);
    sessionStore.setQueuedMessages(serverId, new Map([[agentId, [item]]]));
    const submitStarted = deferred<void>();
    const submitGate = deferred<void>();
    const recoveryListStarted = deferred<void>();
    const releaseRecoveryList = deferred<unknown[]>();
    controls.recoveryList = async () => {
      recoveryListStarted.resolve();
      return await releaseRecoveryList.promise;
    };

    try {
      const sending = sendQueuedComposerMessageNow({
        agentId,
        messageId: item.id,
        queue: {
          read: (queuedAgentId) =>
            useSessionStore.getState().sessions[serverId]?.queuedMessages.get(queuedAgentId) ?? [],
          write: (updater) => useSessionStore.getState().setQueuedMessages(serverId, updater),
        },
        submitMessage: async () => {
          submitStarted.resolve();
          await submitGate.promise;
        },
      });
      await submitStarted.promise;
      expect(collectRetainedAttachmentIds()).toEqual(new Set([agedAttachment.id]));

      const deletion = deleteAttachments([agedAttachment]);
      await recoveryListStarted.promise;
      submitGate.reject(new Error("legacy direct-delete reservation rejected"));
      await expect(sending).resolves.toEqual({
        status: "failed",
        errorMessage: "legacy direct-delete reservation rejected",
      });
      expect(collectRetainedAttachmentIds()).toEqual(new Set());

      releaseRecoveryList.resolve([]);
      await deletion;
      expect(attachmentStore.deletedIds).toEqual([]);
      expect(useSessionStore.getState().sessions[serverId]?.queuedMessages.get(agentId)).toEqual([
        item,
      ]);
    } finally {
      releaseRecoveryList.resolve([]);
      sessionStore.clearSession(serverId);
    }
  });

  it("aborts automatic GC when a delayed recovery read overlaps a future rehydrate", async () => {
    asyncStorage.set("paseo-drafts", supportedEmptyEnvelope());
    const { attachmentStore, scheduleAttachmentGarbageCollection, useDraftStore } =
      await createHarness();
    await establishSafeHydration({ attachmentStore });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const recoveryStarted = deferred<void>();
    const releaseRecovery = deferred<unknown[]>();
    let recoveryReads = 0;
    controls.recoveryList = async () => {
      recoveryReads += 1;
      if (recoveryReads === 1) {
        recoveryStarted.resolve();
        return await releaseRecovery.promise;
      }
      return [];
    };

    scheduleAttachmentGarbageCollection();
    await recoveryStarted.promise;

    const raw = futureEnvelope();
    asyncStorage.set("paseo-drafts", raw);
    const futureReadStarted = deferred<void>();
    const releaseFutureRead = deferred<string | null>();
    controls.read = async () => {
      futureReadStarted.resolve();
      return await releaseFutureRead.promise;
    };
    const rehydrate = useDraftStore.persist.rehydrate();
    await futureReadStarted.promise;
    releaseFutureRead.resolve(raw);
    await rehydrate;
    await waitForWarning(
      warn,
      "hydration did not become durable",
      "future overlap hydration failure",
    );

    releaseRecovery.resolve([]);
    await waitForWarning(
      warn,
      "Attachment garbage collection reference retention failed",
      "stale automatic collector refusal",
    );

    expect(attachmentStore.garbageCollectionReferenceSnapshots).toEqual([]);
    expect(attachmentStore.deletedIds).toEqual([]);
    expect(asyncStorage.get("paseo-drafts")).toBe(raw);
  });

  it("does not reschedule source-driven GC when empty drafts need no pruning", async () => {
    const raw = supportedEmptyEnvelope();
    asyncStorage.set("paseo-drafts", raw);
    const { attachmentStore } = await createHarness();

    await waitForFinalization(
      () => attachmentStore.garbageCollectionReferenceSnapshots.length > 0,
      "source-driven safe-hydration collector",
    );
    const collectorsAtHandoff = attachmentStore.garbageCollectionReferenceSnapshots.length;
    const writesAtHandoff = controls.writes;

    // Let the persistence and microtask queues drain after the real,
    // source-driven handoff. The test never schedules GC or changes raw bytes
    // itself: a second pass here would be a self-triggered no-op state write.
    for (let turn = 0; turn < 4; turn += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    expect(attachmentStore.garbageCollectionReferenceSnapshots).toHaveLength(collectorsAtHandoff);
    expect(controls.writes).toBe(writesAtHandoff);
    expect(asyncStorage.get("paseo-drafts")).toBe(raw);
  });

  it("refuses direct deletion when a delayed recovery read overlaps a future rehydrate", async () => {
    asyncStorage.set("paseo-drafts", supportedEmptyEnvelope());
    const { attachmentStore, deleteAttachments, useDraftStore } = await createHarness();
    await establishSafeHydration({ attachmentStore });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const recoveryStarted = deferred<void>();
    const releaseRecovery = deferred<unknown[]>();
    controls.recoveryList = async () => {
      recoveryStarted.resolve();
      return await releaseRecovery.promise;
    };

    const deletion = deleteAttachments([agedAttachment]);
    await recoveryStarted.promise;

    const raw = futureEnvelope();
    asyncStorage.set("paseo-drafts", raw);
    const futureReadStarted = deferred<void>();
    const releaseFutureRead = deferred<string | null>();
    controls.read = async () => {
      futureReadStarted.resolve();
      return await releaseFutureRead.promise;
    };
    const rehydrate = useDraftStore.persist.rehydrate();
    await futureReadStarted.promise;
    releaseFutureRead.resolve(raw);
    await rehydrate;
    await waitForWarning(
      warn,
      "hydration did not become durable",
      "future overlap hydration failure",
    );

    releaseRecovery.resolve([]);
    await deletion;

    expect(attachmentStore.deletedIds).toEqual([]);
    expect(asyncStorage.get("paseo-drafts")).toBe(raw);
  });

  it("invalidates an old collector after a newer valid hydration completes", async () => {
    asyncStorage.set("paseo-drafts", supportedEmptyEnvelope());
    const { attachmentStore, scheduleAttachmentGarbageCollection, useDraftStore } =
      await createHarness();
    await establishSafeHydration({ attachmentStore });
    const recoveryStarted = deferred<void>();
    const releaseFirstRecovery = deferred<unknown[]>();
    let recoveryReads = 0;
    controls.recoveryList = async () => {
      recoveryReads += 1;
      if (recoveryReads === 1) {
        recoveryStarted.resolve();
        return await releaseFirstRecovery.promise;
      }
      return [];
    };

    // G1 has an empty reference snapshot and is now waiting in durable
    // recovery. G2 publishes a newer *valid* reference generation containing
    // the blob; G1 must still be rejected by token identity, not merely a
    // currently-safe boolean.
    scheduleAttachmentGarbageCollection();
    await recoveryStarted.promise;
    asyncStorage.set("paseo-drafts", currentEnvelopeWithAttachment());
    await useDraftStore.persist.rehydrate();
    await waitForFinalization(
      () => useDraftStore.getState().collectActiveAttachmentIds().includes(agedAttachment.id),
      "new valid hydration references",
    );
    releaseFirstRecovery.resolve([]);
    await waitForFinalization(
      () => attachmentStore.garbageCollectionReferenceSnapshots.length > 0,
      "new-generation attachment collector",
    );

    expect(attachmentStore.garbageCollectionReferenceSnapshots).not.toEqual([]);
    expect(
      attachmentStore.garbageCollectionReferenceSnapshots.every((ids) =>
        ids.includes(agedAttachment.id),
      ),
    ).toBe(true);
    expect(attachmentStore.deletedIds).toEqual([]);
  });

  it("refuses automatic GC when another web tab writes future raw bytes before admission", async () => {
    asyncStorage.set("paseo-drafts", supportedEmptyEnvelope());
    const { attachmentStore, scheduleAttachmentGarbageCollection } = await createHarness();
    await establishSafeHydration({ attachmentStore });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const recoveryStarted = deferred<void>();
    const releaseRecovery = deferred<unknown[]>();
    controls.recoveryList = async () => {
      recoveryStarted.resolve();
      return await releaseRecovery.promise;
    };

    // A has safely hydrated an empty envelope and is collecting. B writes a
    // future envelope directly to origin-shared raw storage; A never begins a
    // local rehydrate, so only the raw-identity admission check can catch it.
    scheduleAttachmentGarbageCollection();
    await recoveryStarted.promise;
    const raw = futureEnvelope();
    asyncStorage.set("paseo-drafts", raw);
    releaseRecovery.resolve([]);
    await waitForWarning(
      warn,
      "Attachment garbage collection reference retention failed",
      "future raw identity collector refusal",
    );

    expect(attachmentStore.garbageCollectionReferenceSnapshots).toEqual([]);
    expect(attachmentStore.deletedIds).toEqual([]);
    expect(asyncStorage.get("paseo-drafts")).toBe(raw);
  });

  it("does not accept a different but valid other-tab envelope for an old collector", async () => {
    asyncStorage.set("paseo-drafts", supportedEmptyEnvelope());
    const { attachmentStore, scheduleAttachmentGarbageCollection } = await createHarness();
    await establishSafeHydration({ attachmentStore });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const recoveryStarted = deferred<void>();
    const releaseRecovery = deferred<unknown[]>();
    controls.recoveryList = async () => {
      recoveryStarted.resolve();
      return await releaseRecovery.promise;
    };

    scheduleAttachmentGarbageCollection();
    await recoveryStarted.promise;
    // This is syntactically/current-version valid, but only B has hydrated
    // it. It cannot bless A's old empty reference set.
    asyncStorage.set("paseo-drafts", currentEnvelopeWithAttachment());
    releaseRecovery.resolve([]);
    await waitForWarning(
      warn,
      "Attachment garbage collection reference retention failed",
      "valid raw identity collector refusal",
    );

    expect(attachmentStore.garbageCollectionReferenceSnapshots).toEqual([]);
    expect(attachmentStore.deletedIds).toEqual([]);
  });

  it("invalidates an old collector after its own durable draft write", async () => {
    asyncStorage.set("paseo-drafts", supportedEmptyEnvelope());
    const {
      attachmentStore,
      flushDraftPersistStorageOrThrow,
      scheduleAttachmentGarbageCollection,
      useDraftStore,
    } = await createHarness();
    await establishSafeHydration({ attachmentStore });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const recoveryStarted = deferred<void>();
    const releaseRecovery = deferred<unknown[]>();
    controls.recoveryList = async () => {
      recoveryStarted.resolve();
      return await releaseRecovery.promise;
    };

    scheduleAttachmentGarbageCollection();
    await recoveryStarted.promise;
    useDraftStore.getState().saveDraftInput({
      draftKey: "agent:own-write",
      // The fresh collector that follows this confirmed write must see this
      // attachment and retain it. The older collector is still stale and must
      // fail before it reaches the attachment store.
      draft: {
        text: "durably changed while collection waited",
        attachments: [
          {
            kind: "pasted_text",
            metadata: agedAttachment,
            codePointCount: 42,
            logicalLineCount: 1,
          },
        ],
      },
    });
    await flushDraftPersistStorageOrThrow();
    releaseRecovery.resolve([]);
    await waitForWarning(
      warn,
      "Attachment garbage collection reference retention failed",
      "own-write raw authority collector refusal",
    );

    await waitForAgedAttachmentSnapshot(attachmentStore, "fresh own-write attachment collector");
    expect(attachmentStore.garbageCollectionReferenceSnapshots).toContainEqual([agedAttachment.id]);
    expect(
      attachmentStore.garbageCollectionReferenceSnapshots.every((ids) =>
        ids.includes(agedAttachment.id),
      ),
    ).toBe(true);
    expect(attachmentStore.deletedIds).toEqual([]);
  });

  it("canonicalizes a current-v8 legacy modal image before GC and keeps it visible", async () => {
    asyncStorage.set("paseo-drafts", currentV8LegacyModalEnvelope());
    const { attachmentStore, useDraftStore } = await createHarness();

    await useDraftStore.persist.rehydrate();
    await waitForFinalization(
      () => includesAgedImage(useDraftStore.getState().getCreateModalDraft()?.attachments),
      "legacy modal canonicalization",
    );
    // The startup finalizer itself must schedule this collector after the
    // canonical modal has safely crossed the durability/reference gate. A
    // manual request here could hide a handoff that leaves GC permanently
    // unscheduled even though references eventually become safe.
    await waitForFinalization(
      () => attachmentStore.garbageCollectionReferenceSnapshots.length > 0,
      "startup canonical modal attachment GC",
    );

    expect(attachmentStore.saveSources).toContain("data_url");
    expect(useDraftStore.getState().getCreateModalDraft()).toEqual({
      text: "visible modal",
      attachments: [{ kind: "image", metadata: agedAttachment }],
    });
    expect(attachmentStore.garbageCollectionReferenceSnapshots).toContainEqual([agedAttachment.id]);
    expect(attachmentStore.deletedIds).toEqual([]);

    const persisted = JSON.parse(asyncStorage.get("paseo-drafts") ?? "{}");
    expect(persisted.state.createModalDraft).toMatchObject({
      draftOccurrenceKey: "modal-occurrence",
      input: {
        text: "visible modal",
        attachments: [{ kind: "image", metadata: agedAttachment }],
      },
    });
  });

  it("preserves current-v8 legacy modal bytes and blocks GC when attachment migration fails", async () => {
    const raw = currentV8LegacyModalEnvelope();
    asyncStorage.set("paseo-drafts", raw);
    const { attachmentStore, scheduleAttachmentGarbageCollection, useDraftStore } =
      await createHarness({ failSave: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await useDraftStore.persist.rehydrate();
    await waitForWarning(
      warn,
      "hydration did not become durable",
      "legacy modal migration failure",
    );
    scheduleAttachmentGarbageCollection();
    await waitForWarning(
      warn,
      "Skipping attachment garbage collection",
      "failed legacy modal GC guard",
    );

    expect(useDraftStore.getState().getCreateModalDraft()).toBeNull();
    expect(asyncStorage.get("paseo-drafts")).toBe(raw);
    expect(attachmentStore.garbageCollectionReferenceSnapshots).toEqual([]);
    expect(attachmentStore.deletedIds).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("does not overwrite a modal prompt edited while legacy attachment migration awaits", async () => {
    asyncStorage.set("paseo-drafts", currentV8LegacyModalEnvelope());
    const { attachmentStore, useDraftStore } = await createHarness({ deferSave: true });

    const rehydrate = useDraftStore.persist.rehydrate();
    await attachmentStore.saveStarted;
    useDraftStore.getState().saveCreateModalDraft({
      text: "edited while migration waited",
      attachments: [],
    });
    attachmentStore.releaseSave();
    await rehydrate;
    await waitForFinalization(
      () =>
        useDraftStore.getState().getCreateModalDraft()?.text === "edited while migration waited",
      "modal edit after migration race",
    );

    expect(useDraftStore.getState().getCreateModalDraft()).toEqual({
      text: "edited while migration waited",
      attachments: [],
    });
  });
});

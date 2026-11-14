import { indexedDB as fakeIndexedDb, IDBKeyRange as FakeIDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import type { ComposerAttachment } from "@/attachments/types";
import {
  collectRecoveryAttachmentIds,
  createIndexedDbSubmissionRecoveryStore,
  createNativeAsyncStorageSubmissionRecoveryStore,
  createSubmissionRecoveryRecord,
  createUnavailableSubmissionRecoveryStore,
  getSubmissionRecoveryInspectionState,
  hasEquivalentOriginalDraftSnapshot,
} from "./workspace-draft-submission-recovery";

globalThis.indexedDB = fakeIndexedDb;
globalThis.IDBKeyRange = FakeIDBKeyRange;

let sequence = 0;

async function overwriteRawRecord(input: {
  databaseName: string;
  id: string;
  value: unknown;
}): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = fakeIndexedDb.open(input.databaseName);
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("submissions", "readwrite");
      transaction.objectStore("submissions").put(input.value);
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () => reject(transaction.error));
      transaction.addEventListener("abort", () => reject(transaction.error));
    });
  } finally {
    database.close();
  }
}

function createRecord(attachments: ComposerAttachment[] = []) {
  const id = `submission-${sequence++}`;
  return createSubmissionRecoveryRecord({
    id,
    clientMessageId: `client-${id}`,
    now: 100,
    submission: {
      kind: "agent_message",
      serverId: "server",
      agentId: "agent",
      workspaceId: "workspace",
      draftId: null,
      cwd: "/repo",
      text: "send this",
      attachments,
    },
    originalDraft: {
      ownerKey: "server:agent",
      text: "send this",
      attachments,
      selection: { start: 4, end: 4 },
    },
  });
}

describe("submission recovery store", () => {
  it("claims atomically across two windows and turns an expired dispatch into needs review", async () => {
    const databaseName = `submission-recovery-${sequence++}`;
    const firstWindow = createIndexedDbSubmissionRecoveryStore({ databaseName });
    const secondWindow = createIndexedDbSubmissionRecoveryStore({ databaseName });
    const record = createRecord();
    await firstWindow.putIfAbsent(record);

    const firstClaim = await firstWindow.claimForDispatch({
      id: record.id,
      ownerId: "window-a",
      now: 1_000,
      leaseMs: 50,
    });
    expect(firstClaim.status).toBe("acquired");

    const overlapping = await secondWindow.claimForDispatch({
      id: record.id,
      ownerId: "window-b",
      now: 1_025,
      leaseMs: 50,
    });
    expect(overlapping.status).toBe("busy");

    const stale = await secondWindow.claimForDispatch({
      id: record.id,
      ownerId: "window-b",
      now: 1_051,
      leaseMs: 50,
    });
    expect(stale).toMatchObject({ status: "needs_review", record: { state: "needs_review" } });

    // An uncertain expired send is never converted into a retryable claim.
    await expect(
      firstWindow.claimForDispatch({
        id: record.id,
        ownerId: "window-a",
        now: 1_100,
        leaseMs: 50,
      }),
    ).resolves.toMatchObject({ status: "needs_review" });
  });

  it("settles a late ACK after another window marks its expired dispatch uncertain", async () => {
    const databaseName = `late-ack-${sequence++}`;
    const sendingWindow = createIndexedDbSubmissionRecoveryStore({ databaseName });
    const observingWindow = createIndexedDbSubmissionRecoveryStore({ databaseName });
    const record = createRecord();
    await sendingWindow.putIfAbsent(record);
    const claim = await sendingWindow.claimForDispatch({
      id: record.id,
      ownerId: "sender",
      now: 100,
      leaseMs: 10,
    });
    if (claim.status !== "acquired") throw new Error("Expected send claim");

    await expect(
      observingWindow.claimForDispatch({
        id: record.id,
        ownerId: "observer",
        now: 111,
        leaseMs: 10,
      }),
    ).resolves.toMatchObject({
      status: "needs_review",
      record: { state: "needs_review", dispatchLease: claim.lease },
    });

    await expect(
      sendingWindow.markSettled({ id: record.id, lease: claim.lease, now: 120 }),
    ).resolves.toMatchObject({ state: "settled", acceptedAt: 120, dispatchLease: claim.lease });
    await expect(
      observingWindow.claimForDispatch({
        id: record.id,
        ownerId: "observer",
        now: 121,
        leaseMs: 10,
      }),
    ).resolves.toMatchObject({ status: "settled" });
  });

  it("does not settle a queued checkpoint without its dispatch fence", async () => {
    const store = createIndexedDbSubmissionRecoveryStore({
      databaseName: `no-fence-${sequence++}`,
    });
    const record = createRecord();
    await store.putIfAbsent(record);

    await expect(
      store.markSettled({ id: record.id, lease: null, now: 101 }),
    ).resolves.toMatchObject({ state: "queued" });
  });

  it("only deletes a queued checkpoint when it still matches the exact queue snapshot", async () => {
    const databaseName = `queued-discard-${sequence++}`;
    const editorWindow = createIndexedDbSubmissionRecoveryStore({ databaseName });
    const sendingWindow = createIndexedDbSubmissionRecoveryStore({ databaseName });
    const record = createRecord();
    await editorWindow.putIfAbsent(record);

    const activeClaim = await sendingWindow.claimForDispatch({
      id: record.id,
      ownerId: "sender",
      now: 10,
      leaseMs: 100,
    });
    if (activeClaim.status !== "acquired") throw new Error("Expected active claim");

    await expect(
      editorWindow.discardQueued({
        id: record.id,
        clientMessageId: record.clientMessageId,
        submission: { text: record.submission.text, attachments: record.submission.attachments },
      }),
    ).resolves.toMatchObject({ status: "not_queued", record: { state: "dispatching" } });
    await expect(editorWindow.get(record.id)).resolves.toMatchObject({ state: "dispatching" });

    const queuedRecord = createRecord();
    await editorWindow.putIfAbsent(queuedRecord);
    await expect(
      editorWindow.discardQueued({
        id: queuedRecord.id,
        clientMessageId: queuedRecord.clientMessageId,
        submission: {
          text: `${queuedRecord.submission.text} edited`,
          attachments: queuedRecord.submission.attachments,
        },
      }),
    ).resolves.toMatchObject({ status: "mismatch" });
    await expect(editorWindow.get(queuedRecord.id)).resolves.toMatchObject({ state: "queued" });

    await expect(
      editorWindow.discardQueued({
        id: queuedRecord.id,
        clientMessageId: queuedRecord.clientMessageId,
        submission: {
          text: queuedRecord.submission.text,
          attachments: queuedRecord.submission.attachments,
        },
      }),
    ).resolves.toEqual({ status: "removed" });
    await expect(editorWindow.get(queuedRecord.id)).resolves.toBeNull();
  });

  it("keeps an accepted record settled when later cleanup/review work fails", async () => {
    const store = createIndexedDbSubmissionRecoveryStore({ databaseName: `settled-${sequence++}` });
    const record = createRecord();
    await store.putIfAbsent(record);
    const claim = await store.claimForDispatch({
      id: record.id,
      ownerId: "window-a",
      now: 10,
      leaseMs: 50,
    });
    if (claim.status !== "acquired") throw new Error("Expected claim");

    await store.markSettled({ id: record.id, lease: claim.lease, now: 20 });
    const afterFailedCleanup = await store.markNeedsReview({
      id: record.id,
      lease: claim.lease,
      errorMessage: "cleanup failed",
      now: 30,
    });

    expect(afterFailedCleanup).toMatchObject({ state: "settled", acceptedAt: 20 });
  });

  it("exposes queued and expired dispatch records for inspection without claiming either", () => {
    const queued = createRecord();
    expect(getSubmissionRecoveryInspectionState(queued, 1_000)).toBe("queued");

    const dispatchLease = { ownerId: "sender", fence: "fence", expiresAt: 100 };
    const expiredDispatch = {
      ...createRecord(),
      state: "dispatching" as const,
      lease: dispatchLease,
      dispatchLease,
    };
    expect(getSubmissionRecoveryInspectionState(expiredDispatch, 101)).toBe("dispatching_unknown");
    // Classification is read-only; the fence stays available for a late ACK.
    expect(expiredDispatch.dispatchLease).toEqual(dispatchLease);
  });

  it("recognizes a settled snapshot after failed draft cleanup without blocking newer edits", async () => {
    const databaseName = `accepted-reload-${sequence++}`;
    const beforeReload = createIndexedDbSubmissionRecoveryStore({ databaseName });
    const record = createRecord();
    await beforeReload.putIfAbsent(record);
    const claim = await beforeReload.claimForDispatch({
      id: record.id,
      ownerId: "sender",
      now: 10,
      leaseMs: 20,
    });
    if (claim.status !== "acquired") throw new Error("Expected claim");
    await beforeReload.markSettled({ id: record.id, lease: claim.lease, now: 11 });

    // Simulate reload after the accepted send's draft-clear write failed: the
    // old source bytes remain in the draft store while this settled record
    // remains durable in IndexedDB.
    const afterReload = createIndexedDbSubmissionRecoveryStore({ databaseName });
    const settled = await afterReload.get(record.id);
    if (!settled) throw new Error("Expected settled checkpoint after reload");
    expect(getSubmissionRecoveryInspectionState(settled)).toBe("accepted");
    expect(
      hasEquivalentOriginalDraftSnapshot(settled, {
        text: record.originalDraft.text,
        attachments: record.originalDraft.attachments,
      }),
    ).toBe(true);
    expect(
      hasEquivalentOriginalDraftSnapshot(settled, {
        text: `${record.originalDraft.text} newer edit`,
        attachments: record.originalDraft.attachments,
      }),
    ).toBe(false);
  });

  it("rejects a changed payload that attempts to reuse an existing client message id", async () => {
    const store = createIndexedDbSubmissionRecoveryStore({
      databaseName: `immutable-${sequence++}`,
    });
    const record = createRecord();
    await store.putIfAbsent(record);

    await expect(
      store.putIfAbsent({
        ...record,
        submission: { ...record.submission, text: "edited after identity reservation" },
      }),
    ).rejects.toThrow("already reserved for different draft content");
    await expect(store.get(record.id)).resolves.toMatchObject({
      submission: { text: "send this" },
    });
  });

  it("fails closed when an existing IndexedDB identity has an unreadable record", async () => {
    const databaseName = `corrupt-${sequence++}`;
    const store = createIndexedDbSubmissionRecoveryStore({ databaseName });
    const record = createRecord();
    await store.putIfAbsent(record);
    await overwriteRawRecord({
      databaseName,
      id: record.id,
      value: { id: record.id, schemaVersion: 999, bad: true },
    });

    await expect(store.putIfAbsent(record)).rejects.toThrow(
      "unreadable or from an unsupported schema",
    );
    await expect(
      store.claimForDispatch({
        id: record.id,
        ownerId: "window-a",
        now: 1,
        leaseMs: 10,
      }),
    ).rejects.toThrow("unreadable or from an unsupported schema");
  });

  it("does not treat unavailable browser storage as a durable in-memory checkpoint", async () => {
    const store = createUnavailableSubmissionRecoveryStore();
    await expect(store.putIfAbsent(createRecord())).rejects.toThrow("storage is unavailable");
    await expect(store.list()).rejects.toThrow("storage is unavailable");
  });

  it("uses the explicit native AsyncStorage policy durably within the native runtime", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: async (key: string) => {
        values.delete(key);
      },
    };
    const storageKey = `native-submission-recovery-${sequence++}`;
    const firstRuntime = createNativeAsyncStorageSubmissionRecoveryStore({ storage, storageKey });
    const secondRuntime = createNativeAsyncStorageSubmissionRecoveryStore({ storage, storageKey });
    const record = createRecord();
    await firstRuntime.putIfAbsent(record);

    await expect(secondRuntime.get(record.id)).resolves.toMatchObject({
      clientMessageId: record.clientMessageId,
      submission: { text: "send this" },
    });
  });

  it("retains image and pasted-text bytes for queued or reviewable recovery records", () => {
    const metadata = {
      id: "text-bytes",
      mimeType: "text/plain",
      storageType: "web-indexeddb" as const,
      storageKey: "text-bytes",
      createdAt: 1,
    };
    const record = createRecord([
      { kind: "image", metadata: { ...metadata, id: "image-bytes", mimeType: "image/png" } },
      { kind: "pasted_text", metadata, codePointCount: 8_000, logicalLineCount: 1 },
    ]);

    expect(collectRecoveryAttachmentIds([record])).toEqual(new Set(["image-bytes", "text-bytes"]));
    expect(collectRecoveryAttachmentIds([{ ...record, state: "settled" }])).toEqual(new Set());
  });

  it("matches an attachment-only pasted-text draft for inspection and restore", () => {
    const metadata = {
      id: "attachment-only-text",
      mimeType: "text/plain",
      storageType: "web-indexeddb" as const,
      storageKey: "attachment-only-text",
      createdAt: 1,
    };
    const attachments: ComposerAttachment[] = [
      { kind: "pasted_text", metadata, codePointCount: 8_000, logicalLineCount: 1 },
    ];
    const base = createRecord(attachments);
    const record = {
      ...base,
      submission: { ...base.submission, text: "", attachments },
      originalDraft: {
        ownerKey: "server:agent",
        text: "",
        attachments,
        selection: { start: 0, end: 0 },
      },
    };

    expect(getSubmissionRecoveryInspectionState(record)).toBe("queued");
    expect(hasEquivalentOriginalDraftSnapshot(record, { text: "", attachments })).toBe(true);
    expect(collectRecoveryAttachmentIds([record])).toEqual(new Set([metadata.id]));
  });

  it("round-trips valid fork history alongside pasted-text attachment metadata", async () => {
    const store = createIndexedDbSubmissionRecoveryStore({ databaseName: `history-${sequence++}` });
    const history: ComposerAttachment = {
      kind: "chat_history",
      id: "fork-history",
      attachment: {
        type: "text",
        mimeType: "text/plain",
        contextKind: "chat_history",
        title: "Prior conversation",
        text: "Keep this fork context exactly.",
      },
      source: {
        serverId: "server",
        agentId: "source-agent",
        boundaryMessageId: "boundary-1",
        itemCount: 3,
      },
    };
    const pastedText: ComposerAttachment = {
      kind: "pasted_text",
      metadata: {
        id: "pasted-history-text",
        mimeType: "text/plain",
        storageType: "web-indexeddb",
        storageKey: "pasted-history-text",
        createdAt: 1,
      },
      codePointCount: 8_000,
      logicalLineCount: 1,
    };
    const record = createRecord([history, pastedText]);

    await store.putIfAbsent(record);

    await expect(store.get(record.id)).resolves.toEqual(record);
  });
});

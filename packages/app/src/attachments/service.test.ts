import { afterEach, describe, expect, it } from "vitest";
import type { AttachmentMetadata, AttachmentStore, SaveAttachmentInput } from "@/attachments/types";
import { __setAttachmentStoreForTests } from "./store";
import {
  __setAttachmentReferenceCollectorForTests,
  deleteAttachments,
  encodeAttachmentsForSend,
  garbageCollectAttachments,
  persistAttachmentFromBytes,
} from "./service";

function createAttachment(input: Partial<AttachmentMetadata> = {}): AttachmentMetadata {
  return {
    id: input.id ?? "att_1",
    mimeType: input.mimeType ?? "image/png",
    storageType: input.storageType ?? "web-indexeddb",
    storageKey: input.storageKey ?? "att_1",
    fileName: input.fileName,
    byteSize: input.byteSize,
    createdAt: input.createdAt ?? 1700000000000,
  };
}

function createRecordingStore(): AttachmentStore & {
  deletedIds: string[];
  savedSources: SaveAttachmentInput[];
  releasedUrls: string[];
} {
  const savedSources: SaveAttachmentInput[] = [];
  const releasedUrls: string[] = [];
  const deletedIds: string[] = [];

  return {
    storageType: "web-indexeddb",
    savedSources,
    releasedUrls,
    deletedIds,
    async save(input) {
      savedSources.push(input);
      return createAttachment({
        id: input.id,
        mimeType: input.mimeType,
        fileName: input.fileName,
        byteSize: 4,
      });
    },
    async encodeBase64({ attachment }) {
      return `${attachment.id}:base64`;
    },
    async resolvePreviewUrl({ attachment }) {
      return `blob:${attachment.id}`;
    },
    async releasePreviewUrl({ url }) {
      releasedUrls.push(url);
    },
    async delete({ attachment }) {
      deletedIds.push(attachment.id);
    },
    async garbageCollect() {},
  };
}

describe("attachment service", () => {
  afterEach(() => {
    __setAttachmentStoreForTests(null);
    __setAttachmentReferenceCollectorForTests(null);
  });

  it("persists raw bytes without requiring a base64 wrapper", async () => {
    const store = createRecordingStore();
    __setAttachmentStoreForTests(store);
    const bytes = new Uint8Array([0, 1, 2, 3]);

    const attachment = await persistAttachmentFromBytes({
      id: "att_bytes",
      bytes,
      mimeType: "image/png",
      fileName: "image.png",
    });

    expect(attachment).toEqual({
      id: "att_bytes",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "att_1",
      fileName: "image.png",
      byteSize: 4,
      createdAt: 1700000000000,
    });
    expect(store.savedSources).toEqual([
      {
        id: "att_bytes",
        mimeType: "image/png",
        fileName: "image.png",
        source: { kind: "bytes", bytes },
      },
    ]);
  });

  it("keeps provider send output byte-compatible", async () => {
    const store = createRecordingStore();
    __setAttachmentStoreForTests(store);
    const attachment = createAttachment({ id: "att_send", mimeType: "image/jpeg" });

    await expect(encodeAttachmentsForSend([attachment])).resolves.toEqual([
      { data: "att_send:base64", mimeType: "image/jpeg" },
    ]);
  });

  it("refuses to delete bytes still referenced by queued or recovery lifecycle state", async () => {
    const store = createRecordingStore();
    __setAttachmentStoreForTests(store);
    __setAttachmentReferenceCollectorForTests(async () => ({
      referencedIds: new Set(["queued-image", "recovery-pasted-text"]),
      assertCurrent: () => undefined,
    }));

    await deleteAttachments([
      createAttachment({ id: "queued-image" }),
      createAttachment({ id: "recovery-pasted-text", mimeType: "text/plain" }),
      createAttachment({ id: "unreferenced" }),
    ]);

    expect(store.deletedIds).toEqual(["unreferenced"]);
  });

  it("does not issue a direct delete when a store-local await invalidates references", async () => {
    let referencesCurrent = true;
    let releaseDelete!: () => void;
    let reportDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>((resolve) => {
      reportDeleteStarted = resolve;
    });
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const recording = createRecordingStore();
    const store: AttachmentStore = {
      ...recording,
      async delete({ attachment, assertCurrent }) {
        reportDeleteStarted();
        await deleteGate;
        // This mirrors the platform-store contract: admission happens after
        // its own asynchronous setup, immediately before destructive I/O.
        assertCurrent?.();
        recording.deletedIds.push(attachment.id);
      },
    };
    __setAttachmentStoreForTests(store);
    __setAttachmentReferenceCollectorForTests(async () => ({
      referencedIds: new Set(),
      assertCurrent: () => {
        if (!referencesCurrent) {
          throw new Error("draft hydration generation changed");
        }
      },
    }));

    const deletion = deleteAttachments([createAttachment({ id: "late-reference" })]);
    await deleteStarted;
    referencesCurrent = false;
    releaseDelete();
    await deletion;

    expect(recording.deletedIds).toEqual([]);
  });

  it("does not collect an attachment persisted while garbage collection is starting", async () => {
    let releaseSave: () => void = () => undefined;
    let reportSaveStarted: () => void = () => undefined;
    const saveStarted = new Promise<void>((resolve) => {
      reportSaveStarted = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const garbageCollections: string[][] = [];
    const store: AttachmentStore = {
      ...createRecordingStore(),
      async save(input) {
        reportSaveStarted();
        await saveGate;
        return createAttachment({ id: input.id });
      },
      async garbageCollect({ referencedIds }) {
        garbageCollections.push([...referencedIds]);
      },
    };
    __setAttachmentStoreForTests(store);

    const persist = persistAttachmentFromBytes({
      id: "assistant-preview",
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
    });
    await saveStarted;
    const collect = garbageCollectAttachments({ referencedIds: new Set() });

    try {
      await Promise.resolve();
      expect(garbageCollections).toEqual([]);
    } finally {
      releaseSave();
      await Promise.all([persist, collect]);
    }

    expect(garbageCollections).toEqual([["assistant-preview"]]);
  });

  it("rechecks reference authority after waiting behind another service GC", async () => {
    let releaseFirstCollection!: () => void;
    let reportFirstCollectionStarted!: () => void;
    const firstCollectionStarted = new Promise<void>((resolve) => {
      reportFirstCollectionStarted = resolve;
    });
    const firstCollectionGate = new Promise<void>((resolve) => {
      releaseFirstCollection = resolve;
    });
    let garbageCollectionCalls = 0;
    const store: AttachmentStore = {
      ...createRecordingStore(),
      async garbageCollect() {
        garbageCollectionCalls += 1;
        if (garbageCollectionCalls === 1) {
          reportFirstCollectionStarted();
          await firstCollectionGate;
        }
      },
    };
    __setAttachmentStoreForTests(store);

    const first = garbageCollectAttachments({ referencedIds: new Set() });
    await firstCollectionStarted;
    let referencesCurrent = true;
    const second = garbageCollectAttachments({
      referencedIds: new Set(),
      assertCurrent: () => {
        if (!referencesCurrent) {
          throw new Error("draft hydration generation changed");
        }
      },
    });
    referencesCurrent = false;
    releaseFirstCollection();

    await first;
    await expect(second).rejects.toThrow("draft hydration generation changed");
    expect(garbageCollectionCalls).toBe(1);
  });
});

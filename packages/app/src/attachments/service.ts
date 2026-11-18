import { collectRetainedAttachmentIds } from "@/attachments/gc-retention";
import { getAttachmentStore } from "@/attachments/store";
import type {
  AttachmentStore,
  AttachmentMetadata,
  GarbageCollectInput,
  SaveAttachmentInput,
} from "@/attachments/types";

const activePersistence = new Set<Promise<AttachmentMetadata>>();
const persistedDuringGarbageCollection = new Set<string>();
let pendingGarbageCollections = 0;
let garbageCollectionTail: Promise<void> = Promise.resolve();
let persistenceBarrier: Promise<void> | null = null;
let releasePersistenceBarrier: (() => void) | null = null;
export interface AttachmentReferenceSnapshot {
  referencedIds: ReadonlySet<string>;
  /** Proves this exact lifecycle reference view still belongs to a safe generation. */
  assertCurrent: () => void;
}

let collectLifecycleReferencedAttachmentIds: (() => Promise<AttachmentReferenceSnapshot>) | null =
  null;

/**
 * Draft/session ownership lives above the attachment store. Registering this
 * collector lets the legacy direct-delete helper fail closed when an image or
 * pasted-text blob is still reachable from a queue or recovery record.
 */
export function registerAttachmentReferenceCollector(
  collector: (() => Promise<AttachmentReferenceSnapshot>) | null,
): void {
  collectLifecycleReferencedAttachmentIds = collector;
}

async function waitForPersistenceBarrier(): Promise<void> {
  const barrier = persistenceBarrier;
  if (!barrier) {
    return;
  }
  await barrier;
  await waitForPersistenceBarrier();
}

async function persistAttachment(input: SaveAttachmentInput): Promise<AttachmentMetadata> {
  await waitForPersistenceBarrier();
  const pending = (async () => {
    const store = await getAttachmentStore();
    const attachment = await store.save(input);
    if (pendingGarbageCollections > 0) {
      persistedDuringGarbageCollection.add(attachment.id);
    }
    return attachment;
  })();
  activePersistence.add(pending);
  try {
    return await pending;
  } finally {
    activePersistence.delete(pending);
  }
}

export async function persistAttachmentFromBlob(input: {
  blob: Blob;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  return await persistAttachment({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "blob", blob: input.blob },
  });
}

export async function persistAttachmentFromDataUrl(input: {
  dataUrl: string;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  return await persistAttachment({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "data_url", dataUrl: input.dataUrl },
  });
}

export async function persistAttachmentFromBytes(input: {
  bytes: Uint8Array;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  return await persistAttachment({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "bytes", bytes: input.bytes },
  });
}

/**
 * Read UTF-8 attachment bytes without normalizing the text. In particular,
 * `ignoreBOM` preserves an intentional leading U+FEFF from a clipboard paste.
 */
export async function readAttachmentTextExact(attachment: AttachmentMetadata): Promise<string> {
  const store = await getAttachmentStore();
  const base64 = await store.encodeBase64({ attachment });
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

export async function persistAttachmentFromFileUri(input: {
  uri: string;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  return await persistAttachment({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "file_uri", uri: input.uri },
  });
}

export async function encodeAttachmentsForSend(
  attachments: readonly AttachmentMetadata[] | undefined,
): Promise<Array<{ data: string; mimeType: string }> | undefined> {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  const store = await getAttachmentStore();
  const encoded = await Promise.all(
    attachments.map(async (attachment) => {
      try {
        const data = await store.encodeBase64({ attachment });
        return {
          data,
          mimeType: attachment.mimeType,
        };
      } catch (error) {
        console.error("[attachments] Failed to encode attachment for send", {
          id: attachment.id,
          error,
        });
        return null;
      }
    }),
  );

  const valid = encoded.filter(
    (entry): entry is { data: string; mimeType: string } => entry !== null,
  );
  return valid.length > 0 ? valid : undefined;
}

export async function resolveAttachmentPreviewUrl(attachment: AttachmentMetadata): Promise<string> {
  const store = await getAttachmentStore();
  return await store.resolvePreviewUrl({ attachment });
}

export async function releaseAttachmentPreviewUrl(input: {
  attachment: AttachmentMetadata;
  url: string;
}): Promise<void> {
  const store = await getAttachmentStore();
  if (!store.releasePreviewUrl) {
    return;
  }
  await store.releasePreviewUrl({ attachment: input.attachment, url: input.url });
}

export async function deleteAttachments(
  attachments: readonly AttachmentMetadata[] | undefined,
): Promise<void> {
  if (!attachments || attachments.length === 0) {
    return;
  }
  const collector = collectLifecycleReferencedAttachmentIds;
  if (!collector) {
    // Deleting without a lifecycle reference snapshot can erase a queued or
    // recovery-owned blob. Leave it for the normal GC path instead.
    console.warn("[attachments] Refusing direct delete before lifecycle references are available");
    return;
  }
  let references: AttachmentReferenceSnapshot;
  try {
    references = await collector();
    // The collector checks after its recovery-store read. Reassert at this
    // boundary before deciding whether any blob is deletable.
    references.assertCurrent();
  } catch (error) {
    // A failed recovery-store read is deliberately fail-closed; otherwise a
    // temporary storage failure could turn an uncertain send into data loss.
    console.warn(
      "[attachments] Refusing direct delete because lifecycle references are unavailable",
      error,
    );
    return;
  }
  const retainedIds = collectRetainedAttachmentIds();
  const deletable = attachments.filter(
    (attachment) => !references.referencedIds.has(attachment.id) && !retainedIds.has(attachment.id),
  );
  if (deletable.length === 0) return;
  let store: AttachmentStore;
  try {
    store = await getAttachmentStore();
    // Loading a platform store can yield. Do not let an old reference snapshot
    // cross that await into a destructive store request.
    references.assertCurrent();
  } catch (error) {
    console.warn(
      "[attachments] Refusing direct delete because lifecycle references changed",
      error,
    );
    return;
  }
  await Promise.all(
    deletable.map(async (attachment) => {
      try {
        // Stores repeat this synchronous assertion after their own internal
        // awaits, immediately before the physical delete request.
        references.assertCurrent();
        await store.delete({ attachment, assertCurrent: references.assertCurrent });
      } catch (error) {
        console.warn("[attachments] Failed to delete attachment", {
          id: attachment.id,
          error,
        });
      }
    }),
  );
}

/** Test seam for the fail-closed direct-delete guard. */
export function __setAttachmentReferenceCollectorForTests(
  collector: (() => Promise<AttachmentReferenceSnapshot>) | null,
): void {
  collectLifecycleReferencedAttachmentIds = collector;
}

export async function garbageCollectAttachments(input: GarbageCollectInput): Promise<void> {
  pendingGarbageCollections += 1;
  if (!persistenceBarrier) {
    persistenceBarrier = new Promise<void>((resolve) => {
      releasePersistenceBarrier = resolve;
    });
  }

  const previousGarbageCollection = garbageCollectionTail;
  const currentGarbageCollection = (async () => {
    await previousGarbageCollection;
    while (activePersistence.size > 0) {
      await Promise.allSettled(activePersistence);
    }
    input.assertCurrent?.();
    const referencedIds = new Set(input.referencedIds);
    for (const id of collectRetainedAttachmentIds()) {
      referencedIds.add(id);
    }
    for (const id of persistedDuringGarbageCollection) {
      referencedIds.add(id);
    }
    const store = await getAttachmentStore();
    // The service cannot know what asynchronous setup a platform store needs.
    // Pass the authority through so it is checked at the actual delete site.
    input.assertCurrent?.();
    await store.garbageCollect({ referencedIds, assertCurrent: input.assertCurrent });
  })();
  garbageCollectionTail = currentGarbageCollection.catch(() => undefined);

  try {
    await currentGarbageCollection;
  } finally {
    pendingGarbageCollections -= 1;
    if (pendingGarbageCollections === 0) {
      persistedDuringGarbageCollection.clear();
      const release = releasePersistenceBarrier;
      releasePersistenceBarrier = null;
      persistenceBarrier = null;
      release?.();
    }
  }
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import type { AttachmentStore, ComposerAttachment } from "@/attachments/types";
import {
  persistPastedTextAttachment,
  readPastedTextAttachment,
  PASTED_TEXT_ATTACHMENT_TITLE,
} from "./pasted-text-attachment";
import { prepareComposerSendPayload } from "./attachments/submit";

function createStore(): AttachmentStore {
  const values = new Map<string, string>();
  let sequence = 0;
  return {
    storageType: "web-indexeddb",
    async save(input) {
      sequence += 1;
      const id = input.id ?? `text-${sequence}`;
      if (input.source.kind !== "bytes") throw new Error("Expected bytes");
      values.set(id, btoa(String.fromCharCode(...input.source.bytes)));
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
    async encodeBase64({ attachment }) {
      const value = values.get(attachment.storageKey);
      if (!value) throw new Error("Missing bytes");
      return value;
    },
    async resolvePreviewUrl() {
      throw new Error("not used");
    },
    async delete() {},
    async garbageCollect() {},
  };
}

beforeEach(() => {
  __setAttachmentStoreForTests(createStore());
});

afterEach(() => {
  __setAttachmentStoreForTests(null);
});

describe("pasted text attachments", () => {
  it("stores and reads exact clipboard text without trimming or BOM removal", async () => {
    const text = "\uFEFF  first\r\nsecond  \n";
    const attachment = await persistPastedTextAttachment({
      text,
      codePointCount: Array.from(text).length,
      logicalLineCount: 3,
    });

    expect(attachment).toMatchObject({
      kind: "pasted_text",
      codePointCount: Array.from(text).length,
      logicalLineCount: 3,
      metadata: { mimeType: "text/plain", fileName: "pasted-text.txt" },
    });
    await expect(readPastedTextAttachment(attachment)).resolves.toBe(text);
    expect(PASTED_TEXT_ATTACHMENT_TITLE).toBe("Pasted text");
  });

  it("emits pasted text as an exact plain-text attachment without chat-history context", async () => {
    const text = "\uFEFF  exact\r\ntext  ";
    const attachment = await persistPastedTextAttachment({
      text,
      codePointCount: Array.from(text).length,
      logicalLineCount: 2,
    });
    const payload = await prepareComposerSendPayload({
      attachments: [attachment],
      encodeImages: async (images) => {
        expect(images).toEqual([]);
        return [];
      },
    });

    expect(payload).toEqual({
      images: [],
      imageData: [],
      attachments: [
        {
          type: "text",
          mimeType: "text/plain",
          title: "Pasted text",
          text,
        },
      ],
    });
    expect(payload.attachments[0]).not.toHaveProperty("contextKind");
  });

  it("preserves fork history and attachment ordering when a pasted-text payload is mixed in", async () => {
    const pastedText = await persistPastedTextAttachment({
      text: "exact pasted payload",
      codePointCount: 20,
      logicalLineCount: 1,
    });
    const history: ComposerAttachment = {
      kind: "chat_history",
      id: "history-1",
      attachment: {
        type: "text",
        mimeType: "text/plain",
        contextKind: "chat_history",
        title: "Chat history",
        text: "fork context",
      },
      source: { serverId: "server", agentId: "agent" },
    };

    const payload = await prepareComposerSendPayload({
      attachments: [history, pastedText],
      encodeImages: async () => [],
    });

    expect(payload.attachments).toEqual([
      history.attachment,
      {
        type: "text",
        mimeType: "text/plain",
        title: "Pasted text",
        text: "exact pasted payload",
      },
    ]);
  });
});

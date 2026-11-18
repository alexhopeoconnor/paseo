import { persistAttachmentFromBytes, readAttachmentTextExact } from "@/attachments/service";
import type { PastedTextComposerAttachment } from "@/attachments/types";

export const PASTED_TEXT_ATTACHMENT_TITLE = "Pasted text";

export async function persistPastedTextAttachment(input: {
  text: string;
  codePointCount: number;
  logicalLineCount: number;
}): Promise<PastedTextComposerAttachment> {
  const metadata = await persistAttachmentFromBytes({
    bytes: new TextEncoder().encode(input.text),
    mimeType: "text/plain",
    fileName: "pasted-text.txt",
  });
  return {
    kind: "pasted_text",
    metadata,
    codePointCount: input.codePointCount,
    logicalLineCount: input.logicalLineCount,
  };
}

export async function readPastedTextAttachment(
  attachment: PastedTextComposerAttachment,
): Promise<string> {
  return await readAttachmentTextExact(attachment.metadata);
}

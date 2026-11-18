import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";
import type { PreparedComposerSendPayload } from "@/composer/attachments/submit";

export type ImageAttachment = AttachmentMetadata;

export interface MessagePayload {
  text: string;
  attachments: ComposerAttachment[];
  cwd: string;
  forceSend?: boolean;
  /** Stable identity and prepared wire payload captured before any async send work. */
  clientMessageId?: string;
  preparedPayload?: PreparedComposerSendPayload;
}

/**
 * Text the draft owner hands the editor. `hydrated` is the owner's answer to a mount:
 * the draft's text as persisted or still pending from the editor that unmounted.
 */
export interface TextReplacement {
  kind: "initial" | "hydrated" | "replace";
  key: string;
  text: string;
}

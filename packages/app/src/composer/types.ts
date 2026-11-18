import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";
import type { PreparedComposerSendPayload } from "@/composer/attachments/submit";
import type { MessageSubmissionPresentation } from "@/composer/submission/model";

export type ImageAttachment = AttachmentMetadata;

export interface MessagePayload {
  text: string;
  attachments: ComposerAttachment[];
  cwd: string;
  forceSend?: boolean;
  /** Stable identity and prepared wire payload captured before any async send work. */
  clientMessageId?: string;
  preparedPayload?: PreparedComposerSendPayload;
  /** Local-only owner/token fencing an immediate submission presentation. */
  presentation?: MessageSubmissionPresentation;
}

/**
 * Workspace creation has no session stream yet, but it needs the same exact
 * local presentation lease as an established agent. This is intentionally
 * UI-local; it is not a protocol or durable draft field.
 */
export interface ComposerSubmissionPresentationController {
  begin: (input: {
    clientMessageId: string;
    text: string;
    images?: AttachmentMetadata[];
    attachments?: import("@getpaseo/protocol/messages").AgentAttachment[];
    presentation: MessageSubmissionPresentation;
  }) => boolean;
  promote: (input: { clientMessageId: string; presentationToken: string }) => boolean;
  abort: (input: {
    clientMessageId: string;
    presentationToken: string;
    errorMessage?: string;
  }) => boolean;
  isCurrent: (input: {
    clientMessageId: string;
    ownerIdentity: string;
    presentationToken: string;
  }) => boolean;
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

import {
  DEFAULT_ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT,
  type AssistantMessageRenderInput,
  type CappedAssistantMessage,
} from "./assistant-message-render-limit.shared";
export type { CappedAssistantMessage } from "./assistant-message-render-limit.shared";

const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export const ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT =
  DEFAULT_ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT;

export function capAssistantMessageForRender({
  message,
  characterLimit = DEFAULT_ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT,
}: AssistantMessageRenderInput): CappedAssistantMessage {
  if (characterLimit === null || message.length <= characterLimit) {
    return { text: message, capped: false };
  }

  let end = characterLimit;
  if (graphemeSegmenter) {
    end = graphemeSegmenter.segment(message).containing(end)!.index;
  } else {
    const finalCodeUnit = message.charCodeAt(end - 1);
    if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
      end -= 1;
    }
  }

  return { text: message.slice(0, end), capped: true };
}

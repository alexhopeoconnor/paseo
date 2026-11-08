import type {
  AssistantMessageRenderInput,
  CappedAssistantMessage,
} from "./assistant-message-render-limit.shared";
export type { CappedAssistantMessage } from "./assistant-message-render-limit.shared";

// Native passes a single string to the C++ parser, without the web renderer's
// React-node fan-out. Keep complete messages selectable across all paragraphs.
export function capAssistantMessageForRender({
  message,
}: AssistantMessageRenderInput): CappedAssistantMessage {
  return { text: message, capped: false };
}

export const DEFAULT_ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT = 32_000;

export interface AssistantMessageRenderInput {
  message: string;
  characterLimit?: number | null;
}

export interface CappedAssistantMessage {
  text: string;
  capped: boolean;
}

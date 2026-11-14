import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWebClipboardPasteEvent, type WebClipboardPasteEvent } from "./input";

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ show: vi.fn(), copied: vi.fn(), error: vi.fn() }),
}));

const mountedElements: HTMLElement[] = [];

function dispatchPaste(input: {
  textarea: HTMLTextAreaElement;
  clipboardData: DataTransfer;
  isConnected: boolean;
  received: WebClipboardPasteEvent[];
}): ClipboardEvent {
  const event = new ClipboardEvent("paste", {
    clipboardData: input.clipboardData,
    bubbles: true,
    cancelable: true,
  });
  input.textarea.addEventListener("paste", (nativeEvent) => {
    handleWebClipboardPasteEvent({
      event: nativeEvent as ClipboardEvent,
      isConnected: input.isConnected,
      disabled: false,
      isDictating: false,
      isRealtimeVoiceForCurrentAgent: false,
      onWebPaste: (paste) => input.received.push(paste),
    });
  });
  input.textarea.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const element of mountedElements.splice(0)) element.remove();
});

describe("MessageInput web clipboard surface", () => {
  it("delivers an offline long-text paste to the local persistence owner", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "before ";
    textarea.setSelectionRange(7, 7);
    document.body.appendChild(textarea);
    mountedElements.push(textarea);
    const clipboardData = new DataTransfer();
    const pastedText = "😀".repeat(8_000);
    clipboardData.setData("text/plain", pastedText);
    const received: WebClipboardPasteEvent[] = [];

    const event = dispatchPaste({
      textarea,
      clipboardData,
      isConnected: false,
      received,
    });

    expect(event.defaultPrevented).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      isConnected: false,
      paste: {
        text: pastedText,
        codePointCount: 8_000,
        shouldCreatePastedTextAttachment: true,
      },
      inputSnapshot: { text: "before ", selection: { start: 7, end: 7 } },
    });
  });
});

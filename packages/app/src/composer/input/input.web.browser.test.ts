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
  vi.restoreAllMocks();
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
    clipboardData.setData("text/html", '<a href="https://example.com/ignored">ignored</a>');
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

  it("keeps short linked HTML on the upstream rich-text branch", () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    mountedElements.push(textarea);
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/html", '<a href="https://example.com/ticket">external ticket</a>');
    clipboardData.setData("text/plain", "external ticket");
    const received: WebClipboardPasteEvent[] = [];
    const insertText = vi
      .spyOn(document, "execCommand")
      .mockImplementation((_command, _showUi, value) => {
        textarea.setRangeText(String(value));
        return true;
      });

    const event = dispatchPaste({
      textarea,
      clipboardData,
      isConnected: true,
      received,
    });

    expect(event.defaultPrevented).toBe(true);
    expect(received).toEqual([]);
    expect(insertText).toHaveBeenCalledWith(
      "insertText",
      false,
      "[external ticket](https://example.com/ticket)",
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT,
  capAssistantMessageForRender,
  getUtf8ByteLength,
} from "./assistant-message-render-limit";
import { countMessageCharacters } from "./assistant-message-render-limit.shared";

describe("assistant message character counts", () => {
  it("counts the displayed prefix separately from the complete received source", () => {
    expect(countMessageCharacters("", 0)).toEqual({ shown: 0, received: 0 });
    expect(countMessageCharacters("hello world", 5)).toEqual({ shown: 5, received: 11 });
    expect(countMessageCharacters("hello world", 11)).toEqual({ shown: 11, received: 11 });
  });

  it("counts surrogate pairs once and excludes a pair cut by the prefix boundary", () => {
    expect(countMessageCharacters("a😀b", 2)).toEqual({ shown: 1, received: 3 });
    expect(countMessageCharacters("a😀b", 3)).toEqual({ shown: 2, received: 3 });
  });

  it("counts Markdown source and combining code points rather than rendered glyphs", () => {
    const message = "# A😀é\n";
    expect(countMessageCharacters(message, message.length)).toEqual({ shown: 7, received: 7 });
  });

  it("counts replacement and shorter sources without retaining previous totals", () => {
    expect(countMessageCharacters("abcd", 4)).toEqual({ shown: 4, received: 4 });
    expect(countMessageCharacters("😀😀", 4)).toEqual({ shown: 2, received: 2 });
    expect(countMessageCharacters("x", 1)).toEqual({ shown: 1, received: 1 });
  });
});

describe("assistant message render limit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("leaves messages at the limit unchanged", () => {
    const message = "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT);

    expect(capAssistantMessageForRender(message)).toEqual({ text: message, capped: false });
  });

  it("caps oversized messages before markdown rendering", () => {
    const message = "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT + 1);

    expect(capAssistantMessageForRender(message)).toEqual({
      text: "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT),
      capped: true,
    });
  });

  it.each(["😀", "é", "👨‍👩‍👧‍👦", "👍🏽", "❤️", "🇺🇸", "가", "कः"])(
    "does not split %s at the render limit",
    (cluster) => {
      for (let offset = 1; offset < cluster.length; offset++) {
        const prefix = "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT - offset);
        expect(capAssistantMessageForRender(`${prefix}${cluster}tail`)).toEqual({
          text: prefix,
          capped: true,
        });
      }
    },
  );

  it("counts the complete message size in UTF-8 bytes", () => {
    expect(getUtf8ByteLength("aé😀")).toBe(7);
  });

  it("keeps a bounded prefix when grapheme segmentation is unavailable", async () => {
    vi.resetModules();
    vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
    const { capAssistantMessageForRender: capWithoutSegmenter } =
      await import("./assistant-message-render-limit");
    const message = "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT + 1);

    expect(capWithoutSegmenter(message)).toEqual({
      text: "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT),
      capped: true,
    });
  });
});

it("preserves complete native multi-paragraph messages and the newline-heavy repro", async () => {
  const native = await import("./assistant-message-render-limit.native");
  const message = "Paragraph.\n\n".repeat(3000) + "Section 60";
  expect(native.capAssistantMessageForRender(message)).toEqual({ text: message, capped: false });
  const lines = "x\n".repeat(16_000) + "HIDDEN_OVERSIZED_MESSAGE_TAIL";
  expect(native.capAssistantMessageForRender(lines)).toEqual({ text: lines, capped: false });
});

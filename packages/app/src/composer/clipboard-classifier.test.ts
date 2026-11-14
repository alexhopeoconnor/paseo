import { describe, expect, it } from "vitest";
import {
  PASTED_TEXT_CODE_POINT_THRESHOLD,
  classifyClipboardPaste,
  clipboardFileToSelectedFile,
  collectActualClipboardFiles,
  countLogicalLines,
} from "./clipboard-classifier";

function fileItem(file: File | null, type = file?.type ?? "") {
  return { kind: "file", type, getAsFile: () => file };
}

describe("clipboard paste classification", () => {
  it("uses Unicode code points instead of UTF-16 units at the text threshold", () => {
    const below = classifyClipboardPaste({
      // These strings are well above the boundary in UTF-16 code units, but
      // their classification must use Unicode code points.
      getData: () => "😀".repeat(PASTED_TEXT_CODE_POINT_THRESHOLD - 1),
    });
    const atLimit = classifyClipboardPaste({
      getData: () => "😀".repeat(PASTED_TEXT_CODE_POINT_THRESHOLD),
    });

    expect(below.codePointCount).toBe(PASTED_TEXT_CODE_POINT_THRESHOLD - 1);
    expect(below.shouldCreatePastedTextAttachment).toBe(false);
    expect(atLimit.codePointCount).toBe(PASTED_TEXT_CODE_POINT_THRESHOLD);
    expect(atLimit.shouldCreatePastedTextAttachment).toBe(true);
    expect(atLimit.shouldPreventDefault).toBe(true);
  });

  it("counts CRLF as one logical line boundary", () => {
    expect(countLogicalLines("one\r\ntwo\r\nthree")).toBe(3);

    const below = classifyClipboardPaste({
      getData: () => Array.from({ length: 99 }, (_, index) => String(index)).join("\r\n"),
    });
    const atLimit = classifyClipboardPaste({
      getData: () => Array.from({ length: 100 }, (_, index) => String(index)).join("\r\n"),
    });

    expect(below.logicalLineCount).toBe(99);
    expect(below.shouldCreatePastedTextAttachment).toBe(false);
    expect(atLimit.logicalLineCount).toBe(100);
    expect(atLimit.shouldCreatePastedTextAttachment).toBe(true);
  });

  it("leaves short text on the native paste path", () => {
    const paste = classifyClipboardPaste({ getData: () => "preserve undo and IME" });

    expect(paste.text).toBe("preserve undo and IME");
    expect(paste.shouldCreatePastedTextAttachment).toBe(false);
    expect(paste.shouldPreventDefault).toBe(false);
  });

  it("keeps meaningful mixed text once while routing image and non-image Files separately", () => {
    const image = new File([new Uint8Array([1])], "paste.png", { type: "image/png" });
    const document = new File(["notes"], "notes.txt", { type: "text/plain" });
    const paste = classifyClipboardPaste({
      items: [fileItem(image), fileItem(document), { kind: "string", type: "text/plain" }],
      getData: () => "keep this native text once",
    });

    expect(paste.text).toBe("keep this native text once");
    expect(paste.imageFiles).toEqual([{ file: image, mimeType: "image/png" }]);
    expect(paste.uploadFiles).toEqual([document]);
    expect(paste.shouldPreventDefault).toBe(false);
  });

  it("uses item Files first, falls back to files, and only deduplicates object identity", () => {
    const first = new File(["one"], "same.txt", { type: "text/plain" });
    const second = new File(["two"], "same.txt", { type: "text/plain" });
    const fromItems = collectActualClipboardFiles({
      items: [fileItem(first), fileItem(second)],
      files: [first],
    });
    const fallback = collectActualClipboardFiles({ files: [first, first, second] });

    expect(fromItems.map(({ file }) => file)).toEqual([first, second]);
    expect(fallback.map(({ file }) => file)).toEqual([first, second]);
  });

  it("recognizes a raster image with an empty MIME type from its file name", async () => {
    const image = new File([new Uint8Array([1, 2])], "clipboard.PNG", { type: "" });
    const paste = classifyClipboardPaste({ items: [fileItem(image, "")] });

    expect(paste.imageFiles).toEqual([{ file: image, mimeType: "image/png" }]);
    expect(paste.uploadFiles).toEqual([]);
    expect(await clipboardFileToSelectedFile(image).readBytes()).toEqual(new Uint8Array([1, 2]));
  });

  it("does not mistake path or URI strings for remote file bytes", () => {
    const paste = classifyClipboardPaste({
      items: [{ kind: "string", type: "text/uri-list" }],
      getData: () => "file:///private/notes.txt\nhttps://example.test/file.txt",
    });

    expect(paste.imageFiles).toEqual([]);
    expect(paste.uploadFiles).toEqual([]);
    expect(paste.shouldPreventDefault).toBe(false);
  });
});

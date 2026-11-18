import { resolveRasterImageMimeType } from "@/attachments/file-types";
import type { SelectedFile } from "@/attachments/selected-file";

/** Clipboard text at or above either limit is kept as a durable text attachment. */
export const PASTED_TEXT_CODE_POINT_THRESHOLD = 8_000;
export const PASTED_TEXT_LOGICAL_LINE_THRESHOLD = 100;

export interface ClipboardItemLike {
  kind?: string;
  type?: string;
  getAsFile?: () => File | null;
}

export interface ClipboardDataLike {
  items?: ArrayLike<ClipboardItemLike> | null;
  files?: ArrayLike<File> | null;
  getData?: (format: string) => string;
}

export interface ClipboardImageFile {
  file: File;
  mimeType: string;
}

export interface ClipboardPasteClassification {
  /** Exact `text/plain` clipboard content. It is never trimmed or normalized. */
  text: string;
  codePointCount: number;
  logicalLineCount: number;
  imageFiles: ClipboardImageFile[];
  uploadFiles: File[];
  /** Long clipboard text is captured as a `pasted_text` attachment instead of native paste. */
  shouldCreatePastedTextAttachment: boolean;
  /** Whether the browser's native paste must be suppressed for this event. */
  shouldPreventDefault: boolean;
}

function isActualFile(value: unknown): value is File {
  return typeof File !== "undefined" && value instanceof File;
}

/**
 * Extract actual File objects only. DataTransferItem is authoritative when it
 * yielded at least one File; `clipboardData.files` is a browser fallback.
 *
 * Deduplication deliberately uses object identity. Two separate clipboard
 * files can have identical names and sizes and must remain separate uploads.
 */
export function collectActualClipboardFiles(
  clipboardData?: ClipboardDataLike | null,
): Array<{ file: File; itemType: string }> {
  if (!clipboardData) return [];

  const fromItems: Array<{ file: File; itemType: string }> = [];
  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item?.kind !== "file") continue;
    const file = item.getAsFile?.();
    if (!isActualFile(file)) continue;
    fromItems.push({ file, itemType: item.type ?? "" });
  }

  const candidates =
    fromItems.length > 0
      ? fromItems
      : Array.from(clipboardData.files ?? [])
          .filter(isActualFile)
          .map((file) => ({ file, itemType: file.type }));
  const seen = new Set<File>();
  return candidates.filter(({ file }) => {
    if (seen.has(file)) return false;
    seen.add(file);
    return true;
  });
}

export function countUnicodeCodePoints(text: string): number {
  return Array.from(text).length;
}

/** Treat CRLF as one logical line break. */
export function countLogicalLines(text: string): number {
  return text.split(/\r\n|[\r\n]/u).length;
}

export function isLargeClipboardText(input: {
  codePointCount: number;
  logicalLineCount: number;
}): boolean {
  return (
    input.codePointCount >= PASTED_TEXT_CODE_POINT_THRESHOLD ||
    input.logicalLineCount >= PASTED_TEXT_LOGICAL_LINE_THRESHOLD
  );
}

export function classifyClipboardPaste(
  clipboardData?: ClipboardDataLike | null,
): ClipboardPasteClassification {
  const text = clipboardData?.getData?.("text/plain") ?? "";
  const codePointCount = countUnicodeCodePoints(text);
  const logicalLineCount = countLogicalLines(text);
  const shouldCreatePastedTextAttachment = isLargeClipboardText({
    codePointCount,
    logicalLineCount,
  });
  const imageFiles: ClipboardImageFile[] = [];
  const uploadFiles: File[] = [];

  for (const { file, itemType } of collectActualClipboardFiles(clipboardData)) {
    const mimeType = resolveRasterImageMimeType({
      mimeType: file.type || itemType,
      path: file.name,
    });
    if (mimeType) {
      imageFiles.push({ file, mimeType });
    } else {
      uploadFiles.push(file);
    }
  }

  const hasFiles = imageFiles.length > 0 || uploadFiles.length > 0;
  const hasMeaningfulText = text.trim().length > 0;
  return {
    text,
    codePointCount,
    logicalLineCount,
    imageFiles,
    uploadFiles,
    shouldCreatePastedTextAttachment,
    // Short text stays on the browser's native path, retaining undo and IME
    // behavior. Files without meaningful native text are handled here.
    shouldPreventDefault: shouldCreatePastedTextAttachment || (hasFiles && !hasMeaningfulText),
  };
}

/** Adapt a browser File to the existing non-image file-upload path. */
export function clipboardFileToSelectedFile(file: File): SelectedFile {
  return {
    fileName: file.name || "clipboard-file",
    mimeType: file.type || "application/octet-stream",
    readBytes: async () => new Uint8Array(await file.arrayBuffer()),
  };
}

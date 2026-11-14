import type { AttachmentMetadata } from "@/attachments/types";
import { persistAttachmentFromBlob } from "@/attachments/service";
import { resolveRasterImageMimeType } from "@/attachments/file-types";

export interface ClipboardItemLike {
  kind?: string;
  type?: string;
  getAsFile?: () => File | null;
}

export interface ClipboardDataLike {
  items?: ArrayLike<ClipboardItemLike> | null;
}

export type ImageAttachmentFromFile = AttachmentMetadata;

export interface ClipboardImageFile {
  file: File;
  mimeType: string;
}

export interface ClipboardImagePersistenceFailure extends ClipboardImageFile {
  error: unknown;
}

export function collectImageFilesFromClipboardData(
  clipboardData?: ClipboardDataLike | null,
): ClipboardImageFile[] {
  if (!clipboardData?.items) {
    return [];
  }

  const files: ClipboardImageFile[] = [];
  for (const item of Array.from(clipboardData.items)) {
    if (item?.kind !== "file") {
      continue;
    }
    const mimeType = resolveRasterImageMimeType({ mimeType: item.type });
    if (!mimeType) {
      continue;
    }
    const file = item.getAsFile?.();
    if (!file) {
      continue;
    }
    files.push({ file, mimeType });
  }

  return files;
}

export async function filesToImageAttachments(
  files: readonly ClipboardImageFile[],
): Promise<ImageAttachmentFromFile[]> {
  const result = await persistClipboardImageFiles(files);
  return result.attachments;
}

/**
 * Keep each source File beside its result so a mixed clipboard paste can
 * retain only the images that were not persisted while continuing with the
 * unrelated non-image files.
 */
export async function persistClipboardImageFiles(files: readonly ClipboardImageFile[]): Promise<{
  attachments: ImageAttachmentFromFile[];
  failed: ClipboardImagePersistenceFailure[];
}> {
  const results = await Promise.all(
    files.map(async ({ file, mimeType }) => {
      try {
        return {
          attachment: await persistAttachmentFromBlob({
            blob: file,
            mimeType,
            fileName: file.name,
          }),
          file,
          mimeType,
        };
      } catch (error) {
        console.error("[attachments] Failed to persist file attachment", {
          fileName: file.name,
          error,
        });
        return { attachment: null, file, mimeType, error };
      }
    }),
  );

  return {
    attachments: results.flatMap((entry) => (entry.attachment ? [entry.attachment] : [])),
    failed: results.flatMap((entry) =>
      entry.attachment
        ? []
        : [
            {
              file: entry.file,
              mimeType: entry.mimeType,
              error: "error" in entry ? entry.error : new Error("Image persistence failed."),
            },
          ],
    ),
  };
}

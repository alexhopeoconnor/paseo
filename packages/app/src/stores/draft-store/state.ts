import {
  NEW_WORKSPACE_PICKER_ATTACHMENT_OWNER,
  type AttachmentMetadata,
  type UserComposerAttachment,
} from "@/attachments/types";
import { PluginResourceComposerAttachmentSchema } from "@/plugins/attachments";
import { z } from "zod";
import { shallow } from "zustand/vanilla/shallow";

/** v7 is the first envelope with a durable recovery-record association. */
export const DRAFT_SUBMISSION_CHECKPOINT_VERSION = 7;
/** v8 adds a durable occurrence identity for cross-tab submission reservation. */
export const DRAFT_OCCURRENCE_VERSION = 8;
export const DRAFT_STORE_VERSION = DRAFT_OCCURRENCE_VERSION;
export const FINALIZED_DRAFT_TTL_MS = 5 * 60 * 1000;

export interface LegacyDraftImage {
  uri: string;
  mimeType?: string;
}

export type PersistedDraftImage = AttachmentMetadata | LegacyDraftImage;

export interface DraftInput {
  text: string;
  attachments: UserComposerAttachment[];
}

export type DraftLifecycleState = "active" | "abandoned" | "sent";

export type CanonicalDraftInput = DraftInput;

export interface DraftRecord {
  input: CanonicalDraftInput;
  lifecycle: DraftLifecycleState;
  updatedAt: number;
  version: number;
  /**
   * Durable identity of this exact user-authored occurrence. v6/v7 records
   * are upgraded deterministically during migration; newly written records
   * always carry one. It is deliberately unrelated to equal source bytes.
   */
  draftOccurrenceKey?: string;
  /** Durable identity of the recovery record that owns this draft snapshot. */
  submissionCheckpointId?: string;
}

export function createDraftOccurrenceKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `draft-occurrence:${Date.now()}:${Math.random().toString(36).slice(2)}`
  );
}

function haveSameAttachmentIdentity(
  left: readonly UserComposerAttachment[],
  right: readonly UserComposerAttachment[],
): boolean {
  return (
    left.length === right.length && left.every((attachment, index) => attachment === right[index])
  );
}

function normalizeDraftInput(input: DraftInput): CanonicalDraftInput {
  return {
    text: input.text,
    attachments: input.attachments.map(normalizeComposerAttachment),
  };
}

/** A user mutation always begins a new draft occurrence, even when bytes repeat. */
export function saveDraftRecordInput(
  record: DraftRecord | undefined,
  draft: DraftInput,
  now: number,
): DraftRecord {
  const input = normalizeDraftInput(draft);
  if (
    record?.lifecycle === "active" &&
    record.submissionCheckpointId === undefined &&
    record.input.text === input.text &&
    haveSameAttachmentIdentity(record.input.attachments, input.attachments)
  ) {
    return record;
  }
  return {
    input,
    lifecycle: "active",
    updatedAt: now,
    version: (record?.version ?? 0) + 1,
    draftOccurrenceKey: createDraftOccurrenceKey(),
  };
}

/**
 * Deliberate empty/context-only Send is the sole path that may materialize an
 * active empty draft. It starts a fresh occurrence, never reviving a sent
 * tombstone's checkpoint.
 */
export function ensureEmptyDraftRecordForSubmission(
  record: DraftRecord | undefined,
  now: number,
): DraftRecord {
  if (record?.lifecycle === "active") {
    return record;
  }
  return {
    input: { text: "", attachments: [] },
    lifecycle: "active",
    updatedAt: now,
    version: (record?.version ?? 0) + 1,
    draftOccurrenceKey: createDraftOccurrenceKey(),
  };
}

export function editDraftRecordText(
  record: DraftRecord | undefined,
  text: string,
  now: number,
): DraftRecord {
  if (
    record?.lifecycle === "active" &&
    record.submissionCheckpointId === undefined &&
    record.input.text === text
  ) {
    return record;
  }
  const attachments = record?.lifecycle === "active" ? record.input.attachments : [];
  return {
    input: { text, attachments },
    lifecycle: text.length > 0 || attachments.length > 0 ? "active" : "abandoned",
    updatedAt: now,
    version: (record?.version ?? 0) + 1,
    draftOccurrenceKey: createDraftOccurrenceKey(),
  };
}

/** CAS-bind a recovery identity only to the draft version that reserved it. */
export function bindDraftRecordSubmissionCheckpoint(input: {
  record: DraftRecord | undefined;
  expectedVersion: number;
  submissionCheckpointId: string;
  now: number;
}): DraftRecord | null {
  const { record, expectedVersion, submissionCheckpointId, now } = input;
  if (!record || record.lifecycle !== "active" || record.version !== expectedVersion) {
    return null;
  }
  if (
    record.submissionCheckpointId !== undefined &&
    record.submissionCheckpointId !== submissionCheckpointId
  ) {
    return null;
  }
  if (record.submissionCheckpointId === submissionCheckpointId) {
    return record;
  }
  return {
    ...record,
    submissionCheckpointId,
    updatedAt: now,
    version: record.version + 1,
  };
}

/** Keep the same checkpoint while a submission-owned clear or restore updates its source. */
export function replaceDraftRecordForSubmission(input: {
  record: DraftRecord | undefined;
  expectedVersion: number;
  submissionCheckpointId: string;
  draft: DraftInput;
  now: number;
}): DraftRecord | null {
  const { record, expectedVersion, submissionCheckpointId, draft, now } = input;
  if (
    !record ||
    record.lifecycle !== "active" ||
    record.version !== expectedVersion ||
    record.submissionCheckpointId !== submissionCheckpointId
  ) {
    return null;
  }
  const nextInput = normalizeDraftInput(draft);
  if (
    record.input.text === nextInput.text &&
    haveSameAttachmentIdentity(record.input.attachments, nextInput.attachments)
  ) {
    return record;
  }
  return {
    ...record,
    input: nextInput,
    updatedAt: now,
    version: record.version + 1,
  };
}

/**
 * Restore a known checkpoint in one state transition. The restored bytes must
 * never be published as an ordinary unbound draft, even briefly.
 */
export function restoreDraftRecordForSubmission(input: {
  record: DraftRecord | undefined;
  expectedVersion: number | null;
  expectedSubmissionCheckpointId: string | undefined;
  submissionCheckpointId: string;
  draftOccurrenceKey?: string;
  draft: DraftInput;
  now: number;
}): DraftRecord | null {
  const {
    record,
    expectedVersion,
    expectedSubmissionCheckpointId,
    submissionCheckpointId,
    draftOccurrenceKey,
    draft,
    now,
  } = input;
  if (
    (record?.version ?? null) !== expectedVersion ||
    record?.submissionCheckpointId !== expectedSubmissionCheckpointId ||
    (record?.submissionCheckpointId !== undefined &&
      record.submissionCheckpointId !== submissionCheckpointId)
  ) {
    return null;
  }
  const nextInput = normalizeDraftInput(draft);
  if (
    record?.lifecycle === "active" &&
    record.submissionCheckpointId === submissionCheckpointId &&
    record.input.text === nextInput.text &&
    haveSameAttachmentIdentity(record.input.attachments, nextInput.attachments)
  ) {
    return record;
  }
  return {
    input: nextInput,
    lifecycle: "active",
    updatedAt: now,
    version: (record?.version ?? 0) + 1,
    draftOccurrenceKey:
      draftOccurrenceKey ?? record?.draftOccurrenceKey ?? createDraftOccurrenceKey(),
    submissionCheckpointId,
  };
}

/** Invalidate before deferred text publication so a same-byte edit cannot regain ownership. */
export function detachDraftRecordSubmissionCheckpoint(
  record: DraftRecord | undefined,
  now: number,
): DraftRecord | undefined {
  if (!record || record.submissionCheckpointId === undefined) {
    return record;
  }
  const { submissionCheckpointId: _submissionCheckpointId, ...withoutCheckpoint } = record;
  return {
    ...withoutCheckpoint,
    updatedAt: now,
    version: record.version + 1,
    draftOccurrenceKey: createDraftOccurrenceKey(),
  };
}

/** A deliberate hidden/external replacement is a new attempt even when bytes repeat. */
export function beginFreshDraftRecordOccurrence(
  record: DraftRecord | undefined,
  now: number,
): DraftRecord | undefined {
  if (!record) return record;
  const { submissionCheckpointId: _submissionCheckpointId, ...withoutCheckpoint } = record;
  return {
    ...withoutCheckpoint,
    updatedAt: now,
    version: record.version + 1,
    draftOccurrenceKey: createDraftOccurrenceKey(),
  };
}

export interface DraftStoreState {
  drafts: Record<string, DraftRecord>;
  createModalDraft: DraftRecord | null;
}

export const AttachmentMetadataSchema = z.strictObject({
  id: z.string(),
  mimeType: z.string(),
  storageType: z.enum(["web-indexeddb", "desktop-file", "native-file"]),
  storageKey: z.string(),
  fileName: z.string().nullable().optional(),
  byteSize: z.number().nullable().optional(),
  createdAt: z.number(),
}) satisfies z.ZodType<AttachmentMetadata>;
export const LegacyDraftImageSchema: z.ZodType<LegacyDraftImage> = z.strictObject({
  uri: z.string(),
  mimeType: z.string().optional(),
});
const UploadedFileSchema = z.strictObject({
  type: z.literal("uploaded_file"),
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  path: z.string(),
});
const ForgeItemFields = {
  forge: z.string().optional(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  body: z.string().nullable(),
  labels: z.array(z.string()),
  projectPath: z.string().optional(),
  baseRefName: z.string().nullable().optional(),
  headRefName: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
};
const IssueItemSchema = z.strictObject({ kind: z.literal("issue"), ...ForgeItemFields });
const ChangeRequestItemSchema = z.strictObject({
  kind: z.literal("change_request"),
  ...ForgeItemFields,
});
export const UserComposerAttachmentSchema: z.ZodType<UserComposerAttachment> = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ kind: z.literal("image"), metadata: AttachmentMetadataSchema }),
    z.strictObject({
      kind: z.literal("pasted_text"),
      metadata: AttachmentMetadataSchema,
      codePointCount: z.number().int().nonnegative(),
      logicalLineCount: z.number().int().positive(),
    }),
    z.strictObject({ kind: z.literal("file"), attachment: UploadedFileSchema }),
    z.strictObject({
      kind: z.literal("workspace_file"),
      path: z.string(),
      selection: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("whole_file") }),
        z.strictObject({
          kind: z.literal("line_range"),
          startLine: z.number().int().positive(),
          endLine: z.number().int().positive(),
        }),
      ]),
    }),
    z.strictObject({ kind: z.literal("forge_issue"), item: IssueItemSchema }),
    z.strictObject({ kind: z.literal("forge_change_request"), item: ChangeRequestItemSchema }),
    z.strictObject({ kind: z.literal("github_issue"), item: IssueItemSchema }),
    PluginResourceComposerAttachmentSchema,
    z.strictObject({
      kind: z.literal("github_pr"),
      item: ChangeRequestItemSchema,
      owner: z.literal(NEW_WORKSPACE_PICKER_ATTACHMENT_OWNER).optional(),
    }),
  ],
);
export const CanonicalDraftInputSchema = z.strictObject({
  text: z.string(),
  attachments: z.array(UserComposerAttachmentSchema),
  // COMPAT(draft-cwd): accept legacy persisted drafts that include cwd. Stop accepting after 2026-11-09.
  cwd: z.string().optional(),
});
const DraftRecordSchema: z.ZodType<DraftRecord> = z.strictObject({
  input: CanonicalDraftInputSchema,
  lifecycle: z.enum(["active", "abandoned", "sent"]),
  updatedAt: z.number(),
  version: z.number().int().positive(),
  draftOccurrenceKey: z.string().optional(),
  submissionCheckpointId: z.string().optional(),
});
export const DraftStoreStateSchema: z.ZodType<DraftStoreState> = z.strictObject({
  drafts: z.record(z.string(), DraftRecordSchema),
  createModalDraft: DraftRecordSchema.nullable(),
});

export function isAttachmentMetadata(value: unknown): value is AttachmentMetadata {
  return AttachmentMetadataSchema.safeParse(value).success;
}

export function isLegacyDraftImage(value: unknown): value is LegacyDraftImage {
  return LegacyDraftImageSchema.safeParse(value).success;
}

export function normalizeAttachmentMetadata(image: AttachmentMetadata): AttachmentMetadata {
  const normalized: AttachmentMetadata = {
    id: image.id,
    mimeType: image.mimeType,
    storageType: image.storageType,
    storageKey: image.storageKey,
    createdAt: image.createdAt,
    ...(typeof image.fileName === "string" || image.fileName === null
      ? { fileName: image.fileName }
      : {}),
    ...(typeof image.byteSize === "number" || image.byteSize === null
      ? { byteSize: image.byteSize }
      : {}),
  };
  return shallow(image, normalized) ? image : normalized;
}

export function isUserComposerAttachment(value: unknown): value is UserComposerAttachment {
  return UserComposerAttachmentSchema.safeParse(value).success;
}

export function normalizeComposerAttachment(
  attachment: UserComposerAttachment,
): UserComposerAttachment {
  // Draft cleanup consumes captured attachment objects. Re-reading or saving
  // an already canonical attachment must preserve that object's identity;
  // a separately added attachment remains a distinct edit even with equal data.
  if (attachment.kind === "image") {
    const normalized: UserComposerAttachment = {
      kind: "image",
      metadata: normalizeAttachmentMetadata(attachment.metadata),
    };
    return shallow(attachment, normalized) ? attachment : normalized;
  }
  if (attachment.kind === "pasted_text") {
    const normalized: UserComposerAttachment = {
      kind: "pasted_text",
      metadata: normalizeAttachmentMetadata(attachment.metadata),
      codePointCount: attachment.codePointCount,
      logicalLineCount: attachment.logicalLineCount,
    };
    return shallow(attachment, normalized) ? attachment : normalized;
  }
  if (attachment.kind === "workspace_file") {
    const normalized: UserComposerAttachment = {
      kind: "workspace_file",
      path: attachment.path.trim().replace(/^\.\//, ""),
      selection: attachment.selection,
    };
    return shallow(attachment, normalized) ? attachment : normalized;
  }
  return attachment;
}

export function isCanonicalDraftInput(value: unknown): value is CanonicalDraftInput {
  return CanonicalDraftInputSchema.safeParse(value).success;
}

export function toDraftInputIfReady(
  record: DraftRecord | null | undefined,
): DraftInput | undefined {
  if (!record) {
    return undefined;
  }
  if (record.lifecycle !== "active") {
    return undefined;
  }
  if (!isCanonicalDraftInput(record.input)) {
    return undefined;
  }
  return {
    text: record.input.text,
    attachments: record.input.attachments.map(normalizeComposerAttachment),
  };
}

export function collectReferencedAttachmentIdsFromState(state: DraftStoreState): Set<string> {
  const referencedIds = new Set<string>();

  for (const draftRecord of Object.values(state.drafts)) {
    if (draftRecord.lifecycle !== "active") {
      continue;
    }
    if (!isCanonicalDraftInput(draftRecord.input)) {
      continue;
    }
    for (const attachment of draftRecord.input.attachments) {
      if (attachment.kind === "image" || attachment.kind === "pasted_text") {
        referencedIds.add(attachment.metadata.id);
      }
    }
  }

  const modalRecord = state.createModalDraft;
  if (modalRecord?.lifecycle === "active" && isCanonicalDraftInput(modalRecord.input)) {
    for (const attachment of modalRecord.input.attachments) {
      if (attachment.kind === "image" || attachment.kind === "pasted_text") {
        referencedIds.add(attachment.metadata.id);
      }
    }
  }

  return referencedIds;
}

export function pruneFinalizedDraftRecords(input: {
  drafts: Record<string, DraftRecord>;
  nowMs: number;
}): Record<string, DraftRecord> {
  let changed = false;
  const next: Record<string, DraftRecord> = {};
  for (const [draftKey, record] of Object.entries(input.drafts)) {
    if (record.lifecycle !== "active" && input.nowMs - record.updatedAt >= FINALIZED_DRAFT_TTL_MS) {
      changed = true;
      continue;
    }
    next[draftKey] = record;
  }
  return changed ? next : input.drafts;
}

export function applyClearDraftRecord(input: {
  record: DraftRecord;
  lifecycle?: Exclude<DraftLifecycleState, "active">;
  nowMs: number;
}): DraftRecord | null {
  if (!input.lifecycle) {
    return null;
  }

  const checkpoint =
    input.lifecycle === "sent" && input.record.submissionCheckpointId
      ? { submissionCheckpointId: input.record.submissionCheckpointId }
      : {};
  const { submissionCheckpointId: _submissionCheckpointId, ...record } = input.record;
  return {
    ...record,
    input: { text: "", attachments: [] },
    lifecycle: input.lifecycle,
    updatedAt: input.nowMs,
    version: input.record.version + 1,
    ...checkpoint,
  };
}

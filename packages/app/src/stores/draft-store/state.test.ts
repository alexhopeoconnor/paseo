import { describe, expect, it } from "vitest";
import {
  applyClearDraftRecord,
  beginFreshDraftRecordOccurrence,
  bindDraftRecordSubmissionCheckpoint,
  detachDraftRecordSubmissionCheckpoint,
  pruneFinalizedDraftRecords,
  replaceDraftRecordForSubmission,
  restoreDraftRecordForSubmission,
  saveDraftRecordInput,
  toDraftInputIfReady,
  editDraftRecordText,
  normalizeComposerAttachment,
  type DraftRecord,
} from "./state";
import type { UserComposerAttachment } from "@/attachments/types";

describe("draft-store lifecycle", () => {
  it("preserves canonical attachment identity without merging separately added copies", () => {
    const metadata = {
      id: "context-1",
      mimeType: "text/plain",
      storageType: "web-indexeddb" as const,
      storageKey: "context-1",
      createdAt: 1,
    };
    const attachments: UserComposerAttachment[] = [
      { kind: "image", metadata },
      { kind: "pasted_text", metadata, codePointCount: 12, logicalLineCount: 1 },
      { kind: "workspace_file", path: "README.md", selection: { kind: "whole_file" } },
    ];
    for (const attachment of attachments) {
      expect(normalizeComposerAttachment(attachment)).toBe(attachment);
      const separatelyAddedCopy = { ...attachment };
      expect(normalizeComposerAttachment(separatelyAddedCopy)).toBe(separatelyAddedCopy);
      expect(normalizeComposerAttachment(separatelyAddedCopy)).not.toBe(attachment);
    }
  });

  it("still normalizes paths and strips unsupported metadata without mutating the source", () => {
    const attachment: UserComposerAttachment = {
      kind: "workspace_file",
      path: " ./README.md ",
      selection: { kind: "whole_file" },
    };
    const normalized = normalizeComposerAttachment(attachment);
    expect(normalized).toEqual({ ...attachment, path: "README.md" });
    expect(attachment.path).toBe(" ./README.md ");
    expect(normalizeComposerAttachment(normalized)).toBe(normalized);
    const metadata = {
      id: "image-1",
      mimeType: "image/png",
      storageType: "web-indexeddb" as const,
      storageKey: "image-1",
      createdAt: 1,
      unsupported: true,
    };
    const image: UserComposerAttachment = { kind: "image", metadata };
    const canonicalImage = normalizeComposerAttachment(image);
    expect(canonicalImage).not.toBe(image);
    expect(canonicalImage).toEqual({
      kind: "image",
      metadata: {
        id: "image-1",
        mimeType: "image/png",
        storageType: "web-indexeddb",
        storageKey: "image-1",
        createdAt: 1,
      },
    });
    expect(metadata.unsupported).toBe(true);
    expect(normalizeComposerAttachment(canonicalImage)).toBe(canonicalImage);
  });

  it("edits text without invalidating attachment subscribers", () => {
    const draft: DraftRecord = {
      input: {
        text: "hello",
        attachments: [
          { kind: "workspace_file", path: "README.md", selection: { kind: "whole_file" } },
        ],
      },
      lifecycle: "active",
      updatedAt: 1,
      version: 1,
    };
    const edited = editDraftRecordText(draft, "hello\n", 2);
    expect(edited.input.text).toBe("hello\n");
    expect(edited.input.attachments).toBe(draft.input.attachments);
    expect(edited.version).toBe(2);
    expect(editDraftRecordText(edited, "hello\n", 3)).toBe(edited);
    expect(editDraftRecordText(edited, "", 3).lifecycle).toBe("active");
    expect(editDraftRecordText(undefined, "", 3).lifecycle).toBe("abandoned");
  });
  it("prunes finalized tombstones after TTL", () => {
    const nowMs = 1_000_000;
    const drafts = {
      oldSent: {
        input: { text: "", attachments: [] },
        lifecycle: "sent" as const,
        updatedAt: 0,
        version: 2,
      },
      recentAbandoned: {
        input: { text: "", attachments: [] },
        lifecycle: "abandoned" as const,
        updatedAt: nowMs + 2 * 60 * 1000,
        version: 2,
      },
      active: {
        input: { text: "a", attachments: [] },
        lifecycle: "active" as const,
        updatedAt: 0,
        version: 1,
      },
    };

    const pruned = pruneFinalizedDraftRecords({
      drafts,
      nowMs: nowMs + 6 * 60 * 1000,
    });

    expect(pruned.oldSent).toBeUndefined();
    expect(pruned.recentAbandoned).toBeDefined();
    expect(pruned.active).toBeDefined();
  });

  it("normalizes clear-with-lifecycle into a tombstone without attachments", () => {
    const cleared = applyClearDraftRecord({
      record: {
        input: {
          text: "hello",
          attachments: [
            {
              kind: "image",
              metadata: {
                id: "att-1",
                mimeType: "image/jpeg",
                storageType: "web-indexeddb",
                storageKey: "att-1",
                createdAt: 1,
              },
            },
          ],
        },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      },
      lifecycle: "sent",
      nowMs: 2,
    });

    expect(cleared).toEqual({
      input: { text: "", attachments: [] },
      lifecycle: "sent",
      updatedAt: 2,
      version: 2,
    });
  });

  it("detaches a checkpoint for user edits but preserves it through submission-owned cleanup", () => {
    const original: DraftRecord = {
      input: { text: "ok proceed", attachments: [] },
      lifecycle: "active",
      updatedAt: 1,
      version: 1,
      draftOccurrenceKey: "occurrence-original",
    };
    const invalidatedBeforeBinding = detachDraftRecordSubmissionCheckpoint(original, 2);
    expect(invalidatedBeforeBinding).toBe(original);

    const bound = bindDraftRecordSubmissionCheckpoint({
      record: original,
      expectedVersion: 1,
      submissionCheckpointId: "message-1",
      now: 2,
    });
    if (!bound) throw new Error("Expected checkpoint binding");

    // An external replacement that happens to use the same bytes is still a
    // new occurrence; it must not inherit the in-flight checkpoint.
    const sameByteEdit = editDraftRecordText(bound, "ok proceed", 3);
    expect(sameByteEdit.submissionCheckpointId).toBeUndefined();
    expect(sameByteEdit.version).toBe(bound.version + 1);
    expect(sameByteEdit.draftOccurrenceKey).not.toBe(bound.draftOccurrenceKey);
    const sameInputReplacement = saveDraftRecordInput(
      bound,
      { text: "ok proceed", attachments: [] },
      3,
    );
    expect(sameInputReplacement.submissionCheckpointId).toBeUndefined();
    expect(sameInputReplacement.version).toBe(bound.version + 1);
    expect(sameInputReplacement.draftOccurrenceKey).not.toBe(bound.draftOccurrenceKey);

    const submissionClear = replaceDraftRecordForSubmission({
      record: bound,
      expectedVersion: bound.version,
      submissionCheckpointId: "message-1",
      draft: { text: "", attachments: [] },
      now: 3,
    });
    if (!submissionClear) throw new Error("Expected submission-owned clear");
    expect(submissionClear.submissionCheckpointId).toBe("message-1");

    const sent = applyClearDraftRecord({
      record: submissionClear,
      lifecycle: "sent",
      nowMs: 4,
    });
    expect(sent?.submissionCheckpointId).toBe("message-1");

    const fresh = saveDraftRecordInput(
      sent ?? undefined,
      { text: "ok proceed", attachments: [] },
      5,
    );
    expect(fresh.submissionCheckpointId).toBeUndefined();
    expect(editDraftRecordText(fresh, "different", 6).submissionCheckpointId).toBeUndefined();

    const detached = detachDraftRecordSubmissionCheckpoint(bound, 7);
    expect(detached?.submissionCheckpointId).toBeUndefined();
    expect(detached?.version).toBe(bound.version + 1);
    expect(detached?.draftOccurrenceKey).not.toBe(bound.draftOccurrenceKey);

    const deliberateSameByteReplacement = beginFreshDraftRecordOccurrence(fresh, 8);
    expect(deliberateSameByteReplacement?.draftOccurrenceKey).not.toBe(fresh.draftOccurrenceKey);
  });

  it("restores input and its checkpoint in one CAS record update", () => {
    const attachment: UserComposerAttachment = {
      kind: "workspace_file",
      path: "restored-context.md",
      selection: { kind: "whole_file" },
    };
    const current: DraftRecord = {
      input: { text: "", attachments: [] },
      lifecycle: "abandoned",
      updatedAt: 1,
      version: 4,
    };

    const restored = restoreDraftRecordForSubmission({
      record: current,
      expectedVersion: 4,
      expectedSubmissionCheckpointId: undefined,
      submissionCheckpointId: "restore-checkpoint",
      draftOccurrenceKey: "restored-occurrence",
      draft: { text: "restored uncertain draft", attachments: [attachment] },
      now: 2,
    });
    expect(restored).toMatchObject({
      input: { text: "restored uncertain draft", attachments: [attachment] },
      lifecycle: "active",
      version: 5,
      submissionCheckpointId: "restore-checkpoint",
      draftOccurrenceKey: "restored-occurrence",
    });
    expect(
      restoreDraftRecordForSubmission({
        record: current,
        expectedVersion: 3,
        expectedSubmissionCheckpointId: undefined,
        submissionCheckpointId: "restore-checkpoint",
        draft: { text: "must not overwrite newer state", attachments: [] },
        now: 3,
      }),
    ).toBeNull();
  });
});

describe("draft-store normalization", () => {
  it("preserves plugin resources when hydrating a draft", () => {
    const attachment = {
      kind: "plugin_resource" as const,
      pluginId: "linear",
      sourceId: "issues",
      sourceTitle: "Linear issue",
      sourceIcon: "CircleDot",
      item: {
        id: "issue-uuid",
        identifier: "ENG-123",
        title: "Plugin attachments",
        subtitle: "In progress",
        url: "https://linear.app/acme/issue/ENG-123/plugin-attachments",
        text: "Linear issue ENG-123: Plugin attachments",
        resourceType: "issue",
      },
    };

    expect(
      toDraftInputIfReady({
        input: { text: "Implement this", attachments: [attachment] },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      }),
    ).toEqual({ text: "Implement this", attachments: [attachment] });
  });

  it("preserves uploaded file attachments when hydrating a draft", () => {
    const attachment = {
      kind: "file" as const,
      attachment: {
        type: "uploaded_file" as const,
        id: "file-1",
        fileName: "context.json",
        mimeType: "application/json",
        size: 42,
        path: "/tmp/context.json",
      },
    };

    expect(
      toDraftInputIfReady({
        input: { text: "Review this", attachments: [attachment] },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      }),
    ).toEqual({ text: "Review this", attachments: [attachment] });
  });

  it("preserves workspace file selections when hydrating a draft", () => {
    const attachment = {
      kind: "workspace_file" as const,
      path: "src/app.ts",
      selection: { kind: "line_range" as const, startLine: 12, endLine: 24 },
    };

    expect(
      toDraftInputIfReady({
        input: { text: "Review this", attachments: [attachment] },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      }),
    ).toEqual({ text: "Review this", attachments: [attachment] });
  });

  it("preserves New Workspace picker ownership when hydrating a draft", () => {
    const pickerAttachment = {
      kind: "github_pr" as const,
      owner: "new-workspace-picker" as const,
      item: {
        kind: "change_request" as const,
        number: 202,
        title: "Persist picker ownership",
        url: "https://example.com/pull/202",
        state: "open" as const,
        body: null,
        labels: [],
        baseRefName: "main",
        headRefName: "feature/picker-ownership",
      },
    };

    expect(
      toDraftInputIfReady({
        input: { text: "Keep this prompt", attachments: [pickerAttachment] },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      }),
    ).toEqual({
      text: "Keep this prompt",
      attachments: [pickerAttachment],
    });
  });
});

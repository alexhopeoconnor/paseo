import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import type { ComposerAttachment, UserComposerAttachment } from "@/attachments/types";
import {
  migratePersistedState,
  type MigrateLegacyImages,
  PersistedDraftStoreSchema,
} from "./migration";
import { createPreservingDraftPersistStorage } from "./persistence";
import { DRAFT_STORE_VERSION, isAttachmentMetadata, type DraftRecord } from "./state";

const passThroughMigrateLegacyImages: MigrateLegacyImages = async (images) =>
  images.filter(isAttachmentMetadata);

function createMemoryStorage(): StateStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
}

function activeDraft(
  text: string,
  updatedAt: number,
  attachments: UserComposerAttachment[] = [],
): DraftRecord {
  return {
    input: { text, attachments },
    lifecycle: "active",
    updatedAt,
    version: 1,
  };
}

function githubIssueAttachment(
  number: number,
): Extract<UserComposerAttachment, { kind: "github_issue" }> {
  return {
    kind: "github_issue",
    item: {
      kind: "issue",
      number,
      title: `Review item ${number}`,
      url: `https://example.com/issues/${number}`,
      state: "open",
      body: null,
      labels: [],
    },
  };
}

function githubPrAttachment(
  number: number,
): Extract<UserComposerAttachment, { kind: "github_pr" }> {
  return {
    kind: "github_pr",
    item: {
      kind: "change_request",
      number,
      title: `Review item ${number}`,
      url: `https://example.com/pulls/${number}`,
      state: "open",
      body: null,
      labels: [],
      baseRefName: "main",
      headRefName: "feature/legacy",
    },
  };
}

function workspaceReviewAttachment(): Extract<ComposerAttachment, { kind: "review" }> {
  return {
    kind: "review",
    reviewDraftKey: "review:key",
    commentCount: 1,
    attachment: {
      type: "review",
      mimeType: "application/paseo-review",
      cwd: "/repo",
      mode: "uncommitted",
      baseRef: null,
      comments: [
        {
          filePath: "src/example.ts",
          side: "new",
          lineNumber: 41,
          body: "Please simplify this.",
          context: {
            hunkHeader: "@@ -40,1 +40,1 @@",
            targetLine: {
              oldLineNumber: null,
              newLineNumber: 41,
              type: "add",
              content: "const value = newValue;",
            },
            lines: [
              {
                oldLineNumber: null,
                newLineNumber: 41,
                type: "add",
                content: "const value = newValue;",
              },
            ],
          },
        },
      ],
    },
  };
}

describe("draft-store migration", () => {
  it("migrates v6 drafts without inferring a submission checkpoint", async () => {
    const backing = createMemoryStorage();
    const attachment = githubIssueAttachment(7);
    const legacyDraft = {
      ...activeDraft("keep this v6 draft", 100, [attachment]),
      // An injected field in a v6 envelope is not an ownership association.
      submissionCheckpointId: "must-not-bind-legacy-draft",
    };
    backing.values.set(
      "paseo-drafts",
      JSON.stringify({
        state: {
          drafts: { "agent:server:agent": legacyDraft },
          createModalDraft: null,
        },
        version: 6,
      }),
    );
    const storage = createPreservingDraftPersistStorage({
      backingStorage: backing,
      stateSchema: PersistedDraftStoreSchema,
      maxVersion: DRAFT_STORE_VERSION,
    });
    const stored = await storage.getItem("paseo-drafts");
    const migrated = await migratePersistedState(
      stored?.state,
      {
        migrateLegacyImages: passThroughMigrateLegacyImages,
        nowMs: 101,
      },
      6,
    );

    expect(migrated.drafts["agent:server:agent"]).toMatchObject(
      activeDraft("keep this v6 draft", 100, [attachment]),
    );
    expect(migrated.drafts["agent:server:agent"]?.submissionCheckpointId).toBeUndefined();
    expect(migrated.drafts["agent:server:agent"]?.draftOccurrenceKey).toMatch(
      /^legacy-draft-occurrence:/,
    );
  });

  it("preserves an explicit checkpoint only from a v7 persisted envelope", async () => {
    const persisted = {
      drafts: {
        "agent:server:agent": {
          ...activeDraft("bound v7 draft", 100),
          submissionCheckpointId: "checkpoint-v7",
        },
      },
      createModalDraft: null,
    };

    await expect(
      migratePersistedState(
        persisted,
        { migrateLegacyImages: passThroughMigrateLegacyImages, nowMs: 101 },
        7,
      ),
    ).resolves.toMatchObject({
      drafts: {
        "agent:server:agent": {
          input: { text: "bound v7 draft", attachments: [] },
          submissionCheckpointId: "checkpoint-v7",
          draftOccurrenceKey: expect.stringMatching(/^legacy-draft-occurrence:/),
        },
      },
    });
  });

  it("keeps a supported legacy draft for migration", async () => {
    const backing = createMemoryStorage();
    const legacyState = {
      drafts: {
        "draft:unsent": {
          text: "do not lose this",
          attachments: [],
        },
      },
      createModalDraft: null,
    };
    backing.values.set("paseo-drafts", JSON.stringify({ state: legacyState, version: 4 }));
    const storage = createPreservingDraftPersistStorage({
      backingStorage: backing,
      stateSchema: PersistedDraftStoreSchema,
      maxVersion: DRAFT_STORE_VERSION,
    });

    const stored = await storage.getItem("paseo-drafts");
    const migrated = await migratePersistedState(stored?.state, {
      migrateLegacyImages: passThroughMigrateLegacyImages,
      nowMs: 1,
    });

    expect(migrated.drafts["draft:unsent"]?.input.text).toBe("do not lose this");
    expect(backing.values.has("paseo-drafts")).toBe(true);
  });

  it("promotes the newest legacy New Workspace draft into the singleton surface", async () => {
    const forkDraft = activeDraft("fork context", 1700000000003);
    const agentDraft = activeDraft("agent prompt", 1700000000004);

    const migrated = await migratePersistedState(
      {
        drafts: {
          "new-workspace:server-a:/project/older": activeDraft(
            "older new workspace prompt",
            1700000000001,
          ),
          "new-workspace:server-b:/project/newer": activeDraft(
            "newer new workspace prompt",
            1700000000002,
          ),
          "new-workspace:draft:fork-1": forkDraft,
          "agent:server-a:agent-1": agentDraft,
        },
        createModalDraft: null,
      },
      { migrateLegacyImages: passThroughMigrateLegacyImages, nowMs: 1700000000005 },
    );

    expect(migrated.drafts).toMatchObject({
      "new-workspace": activeDraft("newer new workspace prompt", 1700000000002),
      "new-workspace:draft:fork-1": forkDraft,
      "agent:server-a:agent-1": agentDraft,
    });
  });

  it("drops unowned checkout PR context when promoting a scoped New Workspace draft", async () => {
    const issue = githubIssueAttachment(101);
    const migrated = await migratePersistedState(
      {
        drafts: {
          "new-workspace:server-a:/project/a": activeDraft("keep the prompt", 2, [
            issue,
            githubPrAttachment(202),
          ]),
        },
        createModalDraft: null,
      },
      { migrateLegacyImages: passThroughMigrateLegacyImages, nowMs: 3 },
    );

    expect(migrated.drafts["new-workspace"]?.input).toEqual({
      text: "keep the prompt",
      attachments: [issue],
    });
  });

  it("normalizes legacy image metadata into image attachments and strips persisted preview URLs", async () => {
    const migrated = await migratePersistedState(
      {
        drafts: {
          "agent:server:agent": {
            input: {
              text: "hello",
              images: [
                {
                  id: "att-1",
                  mimeType: "image/png",
                  storageType: "desktop-file",
                  storageKey: "/tmp/att-1.png",
                  createdAt: 1700000000000,
                  previewUri: "asset://should-not-persist",
                },
              ],
            },
            lifecycle: "active",
            updatedAt: 1700000000001,
            version: 1,
          },
        },
        createModalDraft: null,
      },
      { migrateLegacyImages: passThroughMigrateLegacyImages, nowMs: 1700000000002 },
    );

    expect(migrated.drafts["agent:server:agent"]?.input).toEqual({
      text: "hello",
      attachments: [
        {
          kind: "image",
          metadata: {
            id: "att-1",
            mimeType: "image/png",
            storageType: "desktop-file",
            storageKey: "/tmp/att-1.png",
            createdAt: 1700000000000,
          },
        },
      ],
    });
  });

  it("hydrates old persisted drafts that still include cwd", async () => {
    const original = {
      drafts: {
        "agent:server:agent": {
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
                  createdAt: 1700000000000,
                },
              },
            ],
            cwd: "/repo",
          },
          lifecycle: "active",
          updatedAt: 1700000000001,
          version: 2,
        },
      },
      createModalDraft: null,
    };

    const ports = { migrateLegacyImages: passThroughMigrateLegacyImages, nowMs: 1700000000002 };
    const once = await migratePersistedState(original, ports);
    const twice = await migratePersistedState(once, ports);

    expect(twice).toEqual(once);
    expect(twice.drafts["agent:server:agent"]?.input).toEqual({
      text: "hello",
      attachments: [
        {
          kind: "image",
          metadata: {
            id: "att-1",
            mimeType: "image/jpeg",
            storageType: "web-indexeddb",
            storageKey: "att-1",
            createdAt: 1700000000000,
          },
        },
      ],
    });
  });

  it("drops a legacy workspace review attachment without deleting its draft", async () => {
    const backing = createMemoryStorage();
    const persistedState = {
      drafts: {
        "agent:server:agent": {
          input: {
            text: "hello",
            attachments: [workspaceReviewAttachment()],
          },
          lifecycle: "active",
          updatedAt: 1700000000001,
          version: 2,
        },
      },
      createModalDraft: null,
    };
    backing.values.set("paseo-drafts", JSON.stringify({ state: persistedState, version: 4 }));
    const storage = createPreservingDraftPersistStorage({
      backingStorage: backing,
      stateSchema: PersistedDraftStoreSchema,
      maxVersion: DRAFT_STORE_VERSION,
    });

    const stored = await storage.getItem("paseo-drafts");
    const migrated = await migratePersistedState(stored?.state, {
      migrateLegacyImages: passThroughMigrateLegacyImages,
      nowMs: 1700000000002,
    });

    expect(migrated.drafts["agent:server:agent"]?.input).toEqual({
      text: "hello",
      attachments: [],
    });
    expect(backing.values.has("paseo-drafts")).toBe(true);
  });

  it("propagates supported legacy attachment persistence failure without compacting raw bytes", async () => {
    const backing = createMemoryStorage();
    const raw = JSON.stringify({
      state: {
        drafts: {
          "agent:server:agent": {
            input: {
              text: "keep the data URL until it is durably migrated",
              images: [{ uri: "data:image/png;base64,AA==", mimeType: "image/png" }],
            },
            lifecycle: "active",
            updatedAt: 1,
            version: 1,
          },
        },
        createModalDraft: null,
      },
      version: 7,
    });
    backing.values.set("paseo-drafts", raw);
    const storage = createPreservingDraftPersistStorage({
      backingStorage: backing,
      stateSchema: PersistedDraftStoreSchema,
      maxVersion: DRAFT_STORE_VERSION,
    });

    const stored = await storage.getItem("paseo-drafts");
    await expect(
      migratePersistedState(
        stored?.state,
        {
          migrateLegacyImages: async () => {
            throw new Error("IndexedDB quota exceeded");
          },
          nowMs: 2,
        },
        7,
      ),
    ).rejects.toThrow(/quota exceeded/);
    expect(backing.values.get("paseo-drafts")).toBe(raw);
  });
});

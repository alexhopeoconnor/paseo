import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAttachment, ForgeSearchItem } from "@getpaseo/protocol/messages";
import type {
  AttachmentMetadata,
  ComposerAttachment,
  UserComposerAttachment,
  WorkspaceComposerAttachment,
} from "@/attachments/types";
import { collectRetainedAttachmentIds } from "@/attachments/gc-retention";
import {
  appendSubmittedUserMessage,
  removeSubmittedUserMessage,
  type StreamItem,
} from "@/types/stream";
import {
  acceptMessageSubmission,
  beginMessageSubmission,
  rejectMessageSubmission,
  type MessageSubmissionRecord,
} from "@/composer/submission/model";
import {
  uploadFileAttachments,
  uploadFileAttachmentBatch,
  cancelComposerAgent,
  dispatchComposerAgentMessage,
  editQueuedComposerMessage,
  findForgeItemByOption,
  isAttachmentSelectedForForgeItem,
  openComposerAttachment,
  pickAndPersistImages,
  queueComposerMessage,
  removeQueuedComposerMessage,
  removeComposerAttachmentAtIndex,
  sendQueuedComposerMessageNow,
  toggleForgeAttachment,
  toggleForgeAttachmentFromPicker,
  type MessageSubmissionWriter,
  type AttachmentPersister,
  type ComposerCancelClient,
  type ComposerSendClient,
  type QueueWriter,
  type QueuedComposerMessage,
} from "./actions";
import {
  __setSubmissionRecoveryStoreForTests,
  createSubmissionRecoveryRecord,
  type SubmissionRecoveryLease,
  type SubmissionRecoveryStore,
} from "@/stores/workspace-draft-submission-recovery";

afterEach(() => {
  __setSubmissionRecoveryStoreForTests(null);
});

const imageMetadata: AttachmentMetadata = {
  id: "img-1",
  mimeType: "image/png",
  storageType: "web-indexeddb",
  storageKey: "img-1",
  fileName: "img-1.png",
  byteSize: 42,
  createdAt: 1,
};

const issueItem: ForgeSearchItem = {
  kind: "issue",
  number: 101,
  title: "Fix composer attachments",
  url: "https://github.com/acme/paseo/issues/101",
  state: "open",
  body: "Issue body",
  labels: ["composer"],
  baseRefName: null,
  headRefName: null,
};

const prItem: ForgeSearchItem = {
  kind: "change_request",
  number: 202,
  title: "Refactor composer attachments",
  url: "https://github.com/acme/paseo/pull/202",
  state: "open",
  body: "PR body",
  labels: ["composer"],
  baseRefName: "main",
  headRefName: "composer-attachments",
};

function imageWithId(id: string): AttachmentMetadata {
  return { ...imageMetadata, id, storageKey: id, fileName: `${id}.png` };
}

function reviewWorkspaceAttachment(
  body: string,
): Extract<WorkspaceComposerAttachment, { kind: "review" }> {
  const attachment: Extract<AgentAttachment, { type: "review" }> = {
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
        body,
        context: {
          hunkHeader: "@@ -40,2 +40,2 @@",
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
  };
  return {
    kind: "review",
    reviewDraftKey: `review:${body}`,
    commentCount: 1,
    attachment,
  };
}

function browserElementWorkspaceAttachment(
  screenshot?: AttachmentMetadata,
): Extract<WorkspaceComposerAttachment, { kind: "browser_element" }> {
  return {
    kind: "browser_element",
    attachment: {
      url: "https://example.com/page",
      selector: "button.primary",
      tag: "button",
      text: "Save",
      outerHTML: '<button class="primary">Save</button>',
      computedStyles: { display: "flex" },
      boundingRect: { x: 1, y: 2, width: 80, height: 32 },
      reactSource: null,
      parentChain: ["form.settings"],
      children: [],
      formatted: '<browser-element url="https://example.com/page">button.primary</browser-element>',
      ...(screenshot ? { screenshot } : {}),
    },
  };
}

function createFakePersister(): AttachmentPersister & {
  blobCalls: Array<{ blob: Blob; mimeType: string; fileName: string | null }>;
  dataUrlCalls: Array<{ dataUrl: string; mimeType: string; fileName: string | null }>;
  fileUriCalls: Array<{ uri: string; mimeType: string; fileName: string | null }>;
  deletedBatches: AttachmentMetadata[][];
} {
  const blobCalls: Array<{ blob: Blob; mimeType: string; fileName: string | null }> = [];
  const dataUrlCalls: Array<{ dataUrl: string; mimeType: string; fileName: string | null }> = [];
  const fileUriCalls: Array<{ uri: string; mimeType: string; fileName: string | null }> = [];
  const deletedBatches: AttachmentMetadata[][] = [];
  return {
    blobCalls,
    dataUrlCalls,
    fileUriCalls,
    deletedBatches,
    persistFromBlob: async ({ blob, mimeType, fileName }) => {
      blobCalls.push({ blob, mimeType, fileName });
      return { ...imageMetadata, id: `blob-${blobCalls.length}` };
    },
    persistFromDataUrl: async ({ dataUrl, mimeType, fileName }) => {
      dataUrlCalls.push({ dataUrl, mimeType, fileName });
      return { ...imageMetadata, id: `data-url-${dataUrlCalls.length}` };
    },
    persistFromFileUri: async ({ uri, mimeType, fileName }) => {
      fileUriCalls.push({ uri, mimeType, fileName });
      return { ...imageMetadata, id: `uri-${fileUriCalls.length}` };
    },
    deleteAttachments: (metadata) => {
      deletedBatches.push(metadata);
    },
  };
}

interface FakeSendCall {
  agentId: string;
  text: string;
  options: {
    messageId: string;
    activeTurnBehavior?: "interrupt" | "steer";
    images: Array<{ data: string; mimeType: string }>;
    attachments: AgentAttachment[];
  };
}

function createFakeSendClient(
  options: { rejection?: Error; beforeRejection?: (call: FakeSendCall) => void } = {},
): ComposerSendClient & { calls: FakeSendCall[] } {
  const calls: FakeSendCall[] = [];
  return {
    calls,
    sendAgentMessage: async (agentId, text, opts) => {
      const call = { agentId, text, options: opts };
      calls.push(call);
      if (options.rejection) {
        options.beforeRejection?.(call);
        throw options.rejection;
      }
    },
    uploadFile: async () => ({ requestId: "test", file: null, error: null }),
  };
}

interface FakeStream extends MessageSubmissionWriter {
  head: Map<string, StreamItem[]>;
  tail: Map<string, StreamItem[]>;
}

function createFakeStream(initialHead: Map<string, StreamItem[]> = new Map()): FakeStream {
  const fake: FakeStream = {
    head: new Map(initialHead),
    tail: new Map(),
    begin: (agentId, message) => {
      const current = readSubmission(fake, agentId);
      const stream = appendSubmittedUserMessage({
        tail: current.tail,
        head: current.head,
        message,
      });
      writeSubmission(fake, agentId, {
        ...stream,
        submissions: beginMessageSubmission(current.submissions, {
          clientMessageId: message.clientMessageId!,
        }),
      });
    },
    accept: (agentId, clientMessageId) => {
      const current = readSubmission(fake, agentId);
      writeSubmission(fake, agentId, {
        ...current,
        submissions: acceptMessageSubmission(current.submissions, clientMessageId),
      });
    },
    reject: (agentId, clientMessageId) => {
      const current = readSubmission(fake, agentId);
      const result = rejectMessageSubmission(current.submissions, clientMessageId);
      const stream =
        result.outcome === "rejected"
          ? removeSubmittedUserMessage({
              tail: current.tail,
              head: current.head,
              clientMessageId,
            })
          : current;
      writeSubmission(fake, agentId, { ...stream, submissions: result.submissions });
      return result.outcome;
    },
  };
  return fake;
}

const submissionsByFakeStream = new WeakMap<FakeStream, Map<string, MessageSubmissionRecord[]>>();

interface FakeSubmissionState {
  tail: StreamItem[];
  head: StreamItem[];
  submissions: MessageSubmissionRecord[];
}

function readSubmission(fake: FakeStream, agentId: string): FakeSubmissionState {
  return {
    tail: fake.tail.get(agentId) ?? [],
    head: fake.head.get(agentId) ?? [],
    submissions: submissionsByFakeStream.get(fake)?.get(agentId) ?? [],
  };
}

function writeSubmission(fake: FakeStream, agentId: string, state: FakeSubmissionState): void {
  fake.tail = new Map(fake.tail).set(agentId, state.tail);
  fake.head = new Map(fake.head).set(agentId, state.head);
  const submissions = submissionsByFakeStream.get(fake) ?? new Map();
  submissions.set(agentId, state.submissions);
  submissionsByFakeStream.set(fake, submissions);
}

function createFakeQueue(
  initial: Map<string, QueuedComposerMessage[]> = new Map(),
): QueueWriter & { state: Map<string, QueuedComposerMessage[]> } {
  const fake: QueueWriter & { state: Map<string, QueuedComposerMessage[]> } = {
    state: new Map(initial),
    read: (agentId) => fake.state.get(agentId) ?? [],
    write: (updater) => {
      fake.state = updater(fake.state);
    },
  };
  return fake;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const passthroughEncodeImages = async (images: AttachmentMetadata[]) =>
  images.map((image) => ({ data: image.id, mimeType: image.mimeType }));

describe("cancelComposerAgent", () => {
  function baseInput(): {
    client: ComposerCancelClient & { canceledIds: string[] };
    agentId: string;
    isAgentRunning: boolean;
    isCancellingAgent: boolean;
    isConnected: boolean;
  } {
    const canceledIds: string[] = [];
    return {
      client: {
        canceledIds,
        cancelAgent: async (id) => {
          canceledIds.push(id);
        },
      },
      agentId: "agent",
      isAgentRunning: true,
      isCancellingAgent: false,
      isConnected: true,
    };
  }

  it("returns the cancel request when the agent is running, connected, and not already canceling", async () => {
    const input = baseInput();
    const result = cancelComposerAgent(input);
    expect(result).not.toBeNull();
    await result;
    expect(input.client.canceledIds).toEqual(["agent"]);
  });

  it("returns a rejected cancel request to the composer", async () => {
    const cancellationError = new Error("Provider rejected the interrupt");
    const input = baseInput();
    input.client.cancelAgent = async () => {
      throw cancellationError;
    };

    await expect(cancelComposerAgent(input)).rejects.toBe(cancellationError);
  });

  it("does nothing when the agent is not running", () => {
    const input = baseInput();
    const result = cancelComposerAgent({ ...input, isAgentRunning: false });
    expect(result).toBeNull();
    expect(input.client.canceledIds).toEqual([]);
  });

  it("does nothing when the agent is already being canceled", () => {
    const input = baseInput();
    const result = cancelComposerAgent({ ...input, isCancellingAgent: true });
    expect(result).toBeNull();
    expect(input.client.canceledIds).toEqual([]);
  });

  it("does nothing when disconnected or the client is null", () => {
    const input = baseInput();
    expect(cancelComposerAgent({ ...input, isConnected: false })).toBeNull();
    expect(cancelComposerAgent({ ...input, client: null })).toBeNull();
    expect(input.client.canceledIds).toEqual([]);
  });
});

describe("pickAndPersistImages", () => {
  it("returns [] when the picker yields nothing", async () => {
    const persister = createFakePersister();
    const result = await pickAndPersistImages({
      pickImages: async () => null,
      persister,
    });
    expect(result).toEqual([]);
    expect(persister.blobCalls).toEqual([]);
    expect(persister.fileUriCalls).toEqual([]);
  });

  it("persists blob sources via persistFromBlob with the picked mime type and file name", async () => {
    const persister = createFakePersister();
    const blob = new Blob(["image"]);
    const result = await pickAndPersistImages({
      pickImages: async () => [
        { source: { kind: "blob", blob }, mimeType: "image/png", fileName: "img-1.png" },
      ],
      persister,
    });
    expect(persister.blobCalls).toEqual([{ blob, mimeType: "image/png", fileName: "img-1.png" }]);
    expect(result.map((m) => m.id)).toEqual(["blob-1"]);
  });

  it("persists file_uri sources via persistFromFileUri", async () => {
    const persister = createFakePersister();
    const result = await pickAndPersistImages({
      pickImages: async () => [
        {
          source: { kind: "file_uri", uri: "/tmp/x.jpg" },
          mimeType: "image/jpeg",
          fileName: null,
        },
      ],
      persister,
    });
    expect(persister.fileUriCalls).toEqual([
      { uri: "/tmp/x.jpg", mimeType: "image/jpeg", fileName: null },
    ]);
    expect(result).toHaveLength(1);
  });

  it("persists data_url sources via persistFromDataUrl", async () => {
    const persister = createFakePersister();
    const dataUrl = "data:image/png;base64,AAEC";
    const result = await pickAndPersistImages({
      pickImages: async () => [
        {
          source: { kind: "data_url", dataUrl },
          mimeType: "image/png",
          fileName: "clipboard.png",
        },
      ],
      persister,
    });
    expect(persister.dataUrlCalls).toEqual([
      { dataUrl, mimeType: "image/png", fileName: "clipboard.png" },
    ]);
    expect(result).toHaveLength(1);
  });
});

describe("dispatchComposerAgentMessage", () => {
  it("forwards the configured active-turn intent without provider capability checks", async () => {
    const client = createFakeSendClient();
    const stream = createFakeStream();

    await dispatchComposerAgentMessage({
      client,
      agentId: "agent",
      text: "steer this turn",
      attachments: [],
      encodeImages: async () => [],
      submission: stream,
      activeTurnBehavior: "steer",
    });

    expect(client.calls[0]?.options.activeTurnBehavior).toBe("steer");
  });

  it("stamps only a steer optimistic row with the daemon active turn ID", async () => {
    const client = createFakeSendClient();
    const stream = createFakeStream();
    await dispatchComposerAgentMessage({
      client,
      agentId: "agent",
      text: "hello",
      attachments: [],
      encodeImages: async () => [],
      submission: stream,
      activeTurnBehavior: "steer",
      activeTurnId: "turn-1",
    });
    expect(stream.tail.get("agent")?.[0]).toMatchObject({ turnId: "turn-1" });
    const legacy = createFakeStream();
    await dispatchComposerAgentMessage({
      client,
      agentId: "legacy",
      text: "hello",
      attachments: [],
      encodeImages: async () => [],
      submission: legacy,
      activeTurnBehavior: "steer",
    });
    expect(legacy.tail.get("legacy")?.[0]?.turnId).toBeUndefined();
  });

  it("removes the submitted prompt when the host rejects it", async () => {
    const rejection = new Error("Host rejected prompt");
    const client = createFakeSendClient({ rejection });
    const stream = createFakeStream();

    await expect(
      dispatchComposerAgentMessage({
        client,
        agentId: "agent",
        text: "rejected prompt",
        attachments: [],
        encodeImages: passthroughEncodeImages,
        submission: stream,
      }),
    ).rejects.toBe(rejection);

    expect(stream.head.get("agent")).toEqual([]);
    expect(stream.tail.get("agent") ?? []).toEqual([]);
  });

  it("rolls back an already-running force send when its RPC fails", async () => {
    const stream = createFakeStream();
    const transportError = new Error("Force send failed while the prior turn was running");
    const client = createFakeSendClient({ rejection: transportError });

    await expect(
      dispatchComposerAgentMessage({
        client,
        agentId: "agent",
        text: "force send",
        attachments: [],
        encodeImages: passthroughEncodeImages,
        submission: stream,
      }),
    ).rejects.toBe(transportError);

    expect(stream.tail.get("agent") ?? []).toEqual([]);
  });

  it("does not swallow a transport error when submission state is missing", async () => {
    const transportError = new Error("Connection lost with unknown submission state");
    const client = createFakeSendClient({ rejection: transportError });
    const submission: MessageSubmissionWriter = {
      begin: () => {},
      accept: () => {},
      reject: () => "unknown",
    };

    await expect(
      dispatchComposerAgentMessage({
        client,
        agentId: "agent",
        text: "unknown state",
        attachments: [],
        encodeImages: passthroughEncodeImages,
        submission,
      }),
    ).rejects.toBe(transportError);
  });

  it("surfaces an ambiguous failure even when a concurrent canonical echo was observed", async () => {
    const transportError = new Error("Connection lost after delivery may have occurred");
    const client = createFakeSendClient({ rejection: transportError });
    const submission: MessageSubmissionWriter = {
      begin: () => {},
      accept: () => {},
      reject: () => "accepted",
    };

    await expect(
      dispatchComposerAgentMessage({
        client,
        agentId: "agent",
        text: "ambiguous steer",
        attachments: [],
        encodeImages: passthroughEncodeImages,
        submission,
        activeTurnBehavior: "steer",
      }),
    ).rejects.toBe(transportError);
  });

  it("sends text + image data + structured attachments and appends user_message to the tail when head is empty", async () => {
    const client = createFakeSendClient();
    const stream = createFakeStream();
    const image = imageWithId("img-2");

    await dispatchComposerAgentMessage({
      client,
      agentId: "agent",
      text: "send attachments",
      attachments: [
        { kind: "image", metadata: image },
        { kind: "github_pr", item: prItem },
      ],
      encodeImages: passthroughEncodeImages,
      submission: stream,
    });

    expect(client.calls).toHaveLength(1);
    const [call] = client.calls;
    expect(call.agentId).toBe("agent");
    expect(call.text).toBe("send attachments");
    expect(call.options.images).toEqual([{ data: image.id, mimeType: image.mimeType }]);
    expect(call.options.attachments).toEqual([
      {
        type: "forge_change_request",
        mimeType: "application/paseo-forge-change-request",
        forge: "github",
        number: 202,
        title: "Refactor composer attachments",
        url: "https://github.com/acme/paseo/pull/202",
        body: "PR body",
        baseRefName: "main",
        headRefName: "composer-attachments",
      },
    ]);

    expect(stream.head.get("agent")).toEqual([]);
    const tail = stream.tail.get("agent");
    expect(tail).toHaveLength(1);
    const userMessage = tail?.[0] as Extract<StreamItem, { kind: "user_message" }>;
    expect(userMessage.kind).toBe("user_message");
    expect(userMessage.text).toBe("send attachments");
    expect(userMessage.images).toEqual([image]);
    expect(userMessage.attachments).toEqual(call.options.attachments);
    expect(userMessage.id).toBe(call.options.messageId);
    expect(userMessage.clientMessageId).toBe(call.options.messageId);
    expect(userMessage.messageId).toBeUndefined();
  });

  it("can send legacy GitHub attachment payloads for old daemons", async () => {
    const client = createFakeSendClient();
    const stream = createFakeStream();

    await dispatchComposerAgentMessage({
      client,
      agentId: "agent",
      text: "send old attachment",
      attachments: [{ kind: "forge_change_request", item: prItem }],
      attachmentSubmitFormat: "legacy-github",
      encodeImages: passthroughEncodeImages,
      submission: stream,
    });

    expect(client.calls[0].options.attachments).toEqual([
      {
        type: "github_pr",
        mimeType: "application/github-pr",
        number: 202,
        title: "Refactor composer attachments",
        url: "https://github.com/acme/paseo/pull/202",
        body: "PR body",
        baseRefName: "main",
        headRefName: "composer-attachments",
      },
    ]);
  });

  it("appends to the existing head when one is present", async () => {
    const existingItem: StreamItem = {
      kind: "user_message",
      id: "prior",
      text: "prior",
      timestamp: new Date(0),
    };
    const stream = createFakeStream(new Map([["agent", [existingItem]]]));
    const client = createFakeSendClient();

    await dispatchComposerAgentMessage({
      client,
      agentId: "agent",
      text: "next message",
      attachments: [],
      encodeImages: passthroughEncodeImages,
      submission: stream,
    });

    expect(stream.head.get("agent")).toHaveLength(2);
    expect(stream.tail.get("agent")).toEqual([]);
  });

  it("submits empty wire arrays when no attachments are provided", async () => {
    const client = createFakeSendClient();
    const stream = createFakeStream();

    await dispatchComposerAgentMessage({
      client,
      agentId: "agent",
      text: "plain message",
      attachments: [],
      encodeImages: passthroughEncodeImages,
      submission: stream,
    });

    expect(client.calls[0]?.options).toMatchObject({
      images: [],
      attachments: [],
    });
  });

  it("serializes workspace review attachments through the structured attachment path", async () => {
    const client = createFakeSendClient();
    const stream = createFakeStream();
    const review = reviewWorkspaceAttachment("Please simplify this.");

    await dispatchComposerAgentMessage({
      client,
      agentId: "agent",
      text: "review this",
      attachments: [review],
      encodeImages: passthroughEncodeImages,
      submission: stream,
    });

    expect(client.calls[0]?.options.attachments).toEqual([review.attachment]);
    expect(client.calls[0]?.options.images).toEqual([]);
  });

  it("serializes browser_element workspace attachments as text attachments at the wire boundary", async () => {
    const client = createFakeSendClient();
    const stream = createFakeStream();
    const browserElement = browserElementWorkspaceAttachment();

    await dispatchComposerAgentMessage({
      client,
      agentId: "agent",
      text: "inspect element",
      attachments: [browserElement],
      encodeImages: passthroughEncodeImages,
      submission: stream,
    });

    expect(client.calls[0]?.options.attachments).toEqual([
      {
        type: "text",
        mimeType: "text/plain",
        title: "Browser element · button",
        text: browserElement.attachment.formatted,
      },
    ]);
  });
});

describe("queueComposerMessage", () => {
  it("queues a trimmed message under the agent id and returns the new entry", () => {
    const queue = createFakeQueue();
    const result = queueComposerMessage({
      agentId: "agent",
      text: "  draft  ",
      attachments: [],
      queue,
    });

    expect(result.queued?.text).toBe("draft");
    expect(queue.state.get("agent")).toEqual([
      {
        id: result.queued?.id,
        clientMessageId: result.queued?.clientMessageId,
        text: "draft",
        attachments: [],
      },
    ]);
  });

  it("does not queue an empty message with no attachments", () => {
    const queue = createFakeQueue();
    const result = queueComposerMessage({
      agentId: "agent",
      text: "   ",
      attachments: [],
      queue,
    });
    expect(result.queued).toBeNull();
    expect(queue.state.get("agent")).toBeUndefined();
  });

  it("retains a v8 recovery record ID separately from its stable wire identity", () => {
    const queue = createFakeQueue();
    queueComposerMessage({
      agentId: "agent",
      text: "queue durable occurrence",
      attachments: [],
      queue,
      clientMessageId: "draft-message:queue-occurrence",
      submissionRecoveryId: "draft-occurrence:queue-occurrence",
    });

    expect(queue.state.get("agent")).toEqual([
      {
        id: "draft-message:queue-occurrence",
        clientMessageId: "draft-message:queue-occurrence",
        submissionRecoveryId: "draft-occurrence:queue-occurrence",
        text: "queue durable occurrence",
        attachments: [],
      },
    ]);
  });

  it("captures workspace review attachments at queue time alongside user attachments", () => {
    const queue = createFakeQueue();
    const review = reviewWorkspaceAttachment("Initial queued review.");
    const image = imageWithId("img-queue");
    queueComposerMessage({
      agentId: "agent",
      text: "queue this",
      attachments: [{ kind: "image", metadata: image }, review],
      queue,
    });

    expect(queue.state.get("agent")?.[0]?.attachments).toEqual([
      { kind: "image", metadata: image },
      review,
    ]);
  });
});

describe("editQueuedComposerMessage", () => {
  it("returns missing and leaves the queue untouched when the message id is missing", async () => {
    const queue = createFakeQueue(
      new Map([["agent", [{ id: "other", text: "other", attachments: [] }]]]),
    );
    const result = await editQueuedComposerMessage({
      agentId: "agent",
      messageId: "missing",
      queue,
    });
    expect(result).toEqual({ status: "missing" });
    expect(queue.state.get("agent")).toHaveLength(1);
  });

  it("returns the text and only user attachments, removing the queued entry", async () => {
    const review = reviewWorkspaceAttachment("Queued snapshot.");
    const image = imageWithId("img-queued-edit");
    const queue = createFakeQueue(
      new Map([
        [
          "agent",
          [
            {
              id: "msg-1",
              text: "queued draft",
              attachments: [{ kind: "image", metadata: image }, review],
            },
          ],
        ],
      ]),
    );

    const result = await editQueuedComposerMessage({ agentId: "agent", messageId: "msg-1", queue });
    expect(result).toEqual({
      status: "edited",
      text: "queued draft",
      attachments: [{ kind: "image", metadata: image }],
    });
    expect(queue.state.get("agent")).toEqual([]);
  });

  it("removes a matching known-unsent checkpoint before editing its queue item", async () => {
    const record = createSubmissionRecoveryRecord({
      id: "draft-occurrence:queued-edit",
      clientMessageId: "draft-message:queued-edit",
      submission: {
        kind: "agent_message",
        serverId: "server",
        agentId: "agent",
        workspaceId: null,
        draftId: null,
        cwd: "/repo",
        text: "edit this",
        attachments: [],
      },
      originalDraft: {
        ownerKey: "server:agent",
        text: "edit this",
        attachments: [],
        selection: { start: 0, end: 0 },
      },
    });
    const discardQueued = vi.fn(async () => ({ status: "removed" as const }));
    __setSubmissionRecoveryStoreForTests({
      putIfAbsent: async (value) => value,
      get: async () => record,
      list: async () => [record],
      discardQueued,
      claimForDispatch: async () => ({ status: "needs_review", record }),
      markNeedsReview: async () => null,
      markSettled: async () => null,
      discardInspected: async () => ({ status: "missing" }),
    });
    const queue = createFakeQueue(
      new Map([
        [
          "agent",
          [
            {
              id: "queue-row",
              clientMessageId: "draft-message:queued-edit",
              submissionRecoveryId: "draft-occurrence:queued-edit",
              text: "edit this",
              attachments: [],
            },
          ],
        ],
      ]),
    );

    await expect(
      editQueuedComposerMessage({ agentId: "agent", messageId: "queue-row", queue }),
    ).resolves.toMatchObject({ status: "edited", text: "edit this" });
    expect(discardQueued).toHaveBeenCalledWith({
      id: "draft-occurrence:queued-edit",
      clientMessageId: "draft-message:queued-edit",
      submission: { text: "edit this", attachments: [] },
    });
    expect(queue.state.get("agent")).toEqual([]);
  });

  it("discards a v8 queue item by occurrence record ID, not its wire ID", async () => {
    const record = createSubmissionRecoveryRecord({
      id: "draft-occurrence:queued-discard",
      clientMessageId: "draft-message:queued-discard",
      submission: {
        kind: "agent_message",
        serverId: "server",
        agentId: "agent",
        workspaceId: null,
        draftId: null,
        cwd: "/repo",
        text: "discard this",
        attachments: [],
      },
      originalDraft: {
        ownerKey: "server:agent",
        text: "discard this",
        attachments: [],
        selection: { start: 0, end: 0 },
      },
    });
    const discardQueued = vi.fn(async () => ({ status: "removed" as const }));
    __setSubmissionRecoveryStoreForTests({
      putIfAbsent: async (value) => value,
      get: async () => record,
      list: async () => [record],
      discardQueued,
      claimForDispatch: async () => ({ status: "needs_review", record }),
      markNeedsReview: async () => null,
      markSettled: async () => null,
      discardInspected: async () => ({ status: "missing" }),
    });
    const queue = createFakeQueue(
      new Map([
        [
          "agent",
          [
            {
              id: "queue-row",
              clientMessageId: record.clientMessageId,
              submissionRecoveryId: record.id,
              text: record.submission.text,
              attachments: [],
            },
          ],
        ],
      ]),
    );

    await expect(
      removeQueuedComposerMessage({ agentId: "agent", messageId: "queue-row", queue }),
    ).resolves.toEqual({ status: "removed" });
    expect(discardQueued).toHaveBeenCalledWith({
      id: record.id,
      clientMessageId: record.clientMessageId,
      submission: { text: record.submission.text, attachments: [] },
    });
    expect(queue.state.get("agent")).toEqual([]);
  });

  it("leaves a queue item intact when another window has begun its durable dispatch", async () => {
    const record = createSubmissionRecoveryRecord({
      id: "dispatching-edit-id",
      clientMessageId: "dispatching-edit-id",
      submission: {
        kind: "agent_message",
        serverId: "server",
        agentId: "agent",
        workspaceId: null,
        draftId: null,
        cwd: "/repo",
        text: "do not erase",
        attachments: [],
      },
      originalDraft: {
        ownerKey: "server:agent",
        text: "do not erase",
        attachments: [],
        selection: { start: 0, end: 0 },
      },
    });
    const dispatching = { ...record, state: "dispatching" as const };
    __setSubmissionRecoveryStoreForTests({
      putIfAbsent: async (value) => value,
      get: async () => dispatching,
      list: async () => [dispatching],
      discardQueued: async () => ({ status: "not_queued", record: dispatching }),
      claimForDispatch: async () => ({ status: "busy", record: dispatching }),
      markNeedsReview: async () => null,
      markSettled: async () => null,
      discardInspected: async () => ({ status: "missing" }),
    });
    const queue = createFakeQueue(
      new Map([
        [
          "agent",
          [
            {
              id: "queue-row",
              clientMessageId: "dispatching-edit-id",
              text: "do not erase",
              attachments: [],
            },
          ],
        ],
      ]),
    );

    await expect(
      removeQueuedComposerMessage({ agentId: "agent", messageId: "queue-row", queue }),
    ).resolves.toMatchObject({
      status: "needs_review",
      errorMessage: expect.stringContaining("dispatching"),
    });
    expect(queue.state.get("agent")).toHaveLength(1);
  });
});

describe("sendQueuedComposerMessageNow", () => {
  it("returns missing without submitting when the message id is gone", async () => {
    const queue = createFakeQueue();
    const submitted: Array<{ text: string; attachments: ComposerAttachment[] }> = [];
    const result = await sendQueuedComposerMessageNow({
      agentId: "agent",
      messageId: "msg-1",
      queue,
      submitMessage: async (input) => {
        submitted.push(input);
      },
    });
    expect(result).toEqual({ status: "missing" });
    expect(submitted).toEqual([]);
  });

  it("removes the queued entry and submits its text + attachments", async () => {
    const review = reviewWorkspaceAttachment("Queued for send.");
    const queue = createFakeQueue(
      new Map([["agent", [{ id: "msg-1", text: "send me", attachments: [review] }]]]),
    );
    const submitted: Array<{ text: string; attachments: ComposerAttachment[] }> = [];
    const result = await sendQueuedComposerMessageNow({
      agentId: "agent",
      messageId: "msg-1",
      queue,
      submitMessage: async (input) => {
        submitted.push(input);
      },
    });
    expect(result).toEqual({ status: "submitted" });
    expect(queue.state.get("agent")).toEqual([]);
    expect(submitted).toEqual([
      { text: "send me", attachments: [review], clientMessageId: "msg-1" },
    ]);
  });

  it("retains every local attachment byte while a legacy queued row is dispatched", async () => {
    const image = imageWithId("legacy-queued-image");
    const pastedText = imageWithId("legacy-queued-pasted-text");
    const screenshot = imageWithId("legacy-queued-browser-screenshot");
    const attachments: ComposerAttachment[] = [
      { kind: "image", metadata: image },
      { kind: "pasted_text", metadata: pastedText, codePointCount: 20, logicalLineCount: 1 },
      browserElementWorkspaceAttachment(screenshot),
    ];
    const item = {
      id: "legacy-queued-row",
      text: "send retained bytes",
      // Deliberately no clientMessageId/submissionRecoveryId: this exact
      // legacy shape has no durable owner until the callback reserves one.
      attachments,
    };
    const queue = createFakeQueue(new Map([["agent", [item]]]));
    const submitStarted = createDeferred<void>();
    const submitGate = createDeferred<void>();

    const sending = sendQueuedComposerMessageNow({
      agentId: "agent",
      messageId: item.id,
      queue,
      submitMessage: async () => {
        submitStarted.resolve();
        await submitGate.promise;
      },
    });

    await submitStarted.promise;
    expect(queue.state.get("agent")).toEqual([]);
    expect(collectRetainedAttachmentIds()).toEqual(
      new Set([image.id, pastedText.id, screenshot.id]),
    );

    // Removing the exact row is still the duplicate-send guard while its
    // attachment ownership is temporarily held out of band.
    await expect(
      sendQueuedComposerMessageNow({
        agentId: "agent",
        messageId: item.id,
        queue,
        submitMessage: async () => {
          throw new Error("must not dispatch twice");
        },
      }),
    ).resolves.toEqual({ status: "missing" });

    submitGate.resolve();
    await expect(sending).resolves.toEqual({ status: "submitted" });
    expect(queue.state.get("agent")).toEqual([]);
    expect(collectRetainedAttachmentIds()).toEqual(new Set());
  });

  it("keeps a shared attachment retained until overlapping legacy handoffs both finish", async () => {
    const sharedImage = imageWithId("legacy-overlapping-image");
    const first = {
      id: "legacy-overlap-first",
      text: "first",
      attachments: [{ kind: "image" as const, metadata: sharedImage }],
    };
    const second = {
      id: "legacy-overlap-second",
      text: "second",
      attachments: [{ kind: "image" as const, metadata: sharedImage }],
    };
    const queue = createFakeQueue(new Map([["agent", [first, second]]]));
    const firstStarted = createDeferred<void>();
    const secondStarted = createDeferred<void>();
    const firstGate = createDeferred<void>();
    const secondGate = createDeferred<void>();

    const sendFirst = sendQueuedComposerMessageNow({
      agentId: "agent",
      messageId: first.id,
      queue,
      submitMessage: async () => {
        firstStarted.resolve();
        await firstGate.promise;
      },
    });
    await firstStarted.promise;
    const sendSecond = sendQueuedComposerMessageNow({
      agentId: "agent",
      messageId: second.id,
      queue,
      submitMessage: async () => {
        secondStarted.resolve();
        await secondGate.promise;
      },
    });
    await secondStarted.promise;

    expect(collectRetainedAttachmentIds()).toEqual(new Set([sharedImage.id]));
    firstGate.resolve();
    await expect(sendFirst).resolves.toEqual({ status: "submitted" });
    expect(collectRetainedAttachmentIds()).toEqual(new Set([sharedImage.id]));

    secondGate.resolve();
    await expect(sendSecond).resolves.toEqual({ status: "submitted" });
    expect(collectRetainedAttachmentIds()).toEqual(new Set());
  });

  it("restores a legacy queued row before releasing its temporary attachment ownership", async () => {
    const image = imageWithId("legacy-failure-image");
    const pastedText = imageWithId("legacy-failure-pasted-text");
    const screenshot = imageWithId("legacy-failure-browser-screenshot");
    const expectedIds = new Set([image.id, pastedText.id, screenshot.id]);
    const item = {
      id: "legacy-failure-row",
      text: "restore before release",
      attachments: [
        { kind: "image" as const, metadata: image },
        {
          kind: "pasted_text" as const,
          metadata: pastedText,
          codePointCount: 24,
          logicalLineCount: 1,
        },
        browserElementWorkspaceAttachment(screenshot),
      ],
    };
    const queue = createFakeQueue(new Map([["agent", [item]]]));
    const write = queue.write;
    const ownershipAtEachQueueWrite: Array<{ ids: string[]; retained: ReadonlySet<string> }> = [];
    queue.write = (updater) => {
      write(updater);
      ownershipAtEachQueueWrite.push({
        ids: (queue.state.get("agent") ?? []).map((queued) => queued.id),
        retained: collectRetainedAttachmentIds(),
      });
    };
    const submitStarted = createDeferred<void>();
    const submitGate = createDeferred<void>();
    const sending = sendQueuedComposerMessageNow({
      agentId: "agent",
      messageId: item.id,
      queue,
      submitMessage: async () => {
        submitStarted.resolve();
        await submitGate.promise;
      },
    });

    await submitStarted.promise;
    expect(collectRetainedAttachmentIds()).toEqual(expectedIds);
    submitGate.reject(new Error("durable reservation rejected"));

    await expect(sending).resolves.toEqual({
      status: "failed",
      errorMessage: "durable reservation rejected",
    });
    expect(queue.state.get("agent")?.map((queued) => queued.id)).toEqual([item.id]);
    expect(ownershipAtEachQueueWrite.find(({ ids }) => ids.includes(item.id))?.retained).toEqual(
      expectedIds,
    );
    expect(collectRetainedAttachmentIds()).toEqual(new Set());
  });

  it("keeps a durable queue item blocked when its checkpoint is missing", async () => {
    const queue = createFakeQueue(
      new Map([
        [
          "agent",
          [
            {
              id: "row-1",
              clientMessageId: "stable-missing",
              text: "do not dispatch",
              attachments: [],
            },
          ],
        ],
      ]),
    );
    const submitted: unknown[] = [];
    const recoveryStore: SubmissionRecoveryStore = {
      putIfAbsent: async (record) => record,
      get: async () => null,
      list: async () => [],
      discardQueued: async () => ({ status: "missing" }),
      claimForDispatch: async () => ({ status: "missing" }),
      markNeedsReview: async () => null,
      markSettled: async () => null,
      discardInspected: async () => ({ status: "missing" }),
    };
    __setSubmissionRecoveryStoreForTests(recoveryStore);

    const result = await sendQueuedComposerMessageNow({
      agentId: "agent",
      messageId: "row-1",
      queue,
      submitMessage: async (input) => {
        submitted.push(input);
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("missing"),
    });
    expect(submitted).toEqual([]);
    expect(queue.state.get("agent")).toHaveLength(1);
  });

  it("keeps a v8 queue item blocked when its durable checkpoint does not match", async () => {
    const checkpoint = createSubmissionRecoveryRecord({
      id: "draft-occurrence:queue-mismatch",
      clientMessageId: "draft-message:other-attempt",
      submission: {
        kind: "agent_message",
        serverId: "server",
        agentId: "agent",
        workspaceId: null,
        draftId: null,
        cwd: "/repo",
        text: "other snapshot",
        attachments: [],
      },
      originalDraft: {
        ownerKey: "server:agent",
        text: "other snapshot",
        attachments: [],
        selection: { start: 0, end: 0 },
      },
    });
    const claimForDispatch = vi.fn(async () => ({ status: "missing" as const }));
    __setSubmissionRecoveryStoreForTests({
      putIfAbsent: async (record) => record,
      get: async () => checkpoint,
      list: async () => [checkpoint],
      discardQueued: async () => ({ status: "mismatch", record: checkpoint }),
      claimForDispatch,
      markNeedsReview: async () => null,
      markSettled: async () => null,
      discardInspected: async () => ({ status: "missing" }),
    });
    const queue = createFakeQueue(
      new Map([
        [
          "agent",
          [
            {
              id: "draft-message:expected-attempt",
              clientMessageId: "draft-message:expected-attempt",
              submissionRecoveryId: "draft-occurrence:queue-mismatch",
              text: "expected snapshot",
              attachments: [],
            },
          ],
        ],
      ]),
    );
    const submitted: unknown[] = [];

    await expect(
      sendQueuedComposerMessageNow({
        agentId: "agent",
        messageId: "draft-message:expected-attempt",
        queue,
        submitMessage: async (input) => {
          submitted.push(input);
        },
      }),
    ).resolves.toMatchObject({
      status: "needs_review",
      errorMessage: expect.stringContaining("differs"),
    });

    expect(claimForDispatch).not.toHaveBeenCalled();
    expect(submitted).toEqual([]);
    expect(queue.state.get("agent")).toHaveLength(1);
  });

  it("claims and settles a v8 queue record by recovery ID while sending its wire identity", async () => {
    const record = createSubmissionRecoveryRecord({
      id: "draft-occurrence:queue-send",
      clientMessageId: "draft-message:queue-send",
      submission: {
        kind: "agent_message",
        serverId: "server",
        agentId: "agent",
        workspaceId: null,
        draftId: null,
        cwd: "/repo",
        text: "v8 queued message",
        attachments: [],
      },
      originalDraft: {
        ownerKey: "server:agent",
        text: "v8 queued message",
        attachments: [],
        selection: { start: 0, end: 0 },
      },
    });
    const lease: SubmissionRecoveryLease = {
      ownerId: "window",
      fence: "v8-fence",
      expiresAt: Date.now() + 30_000,
    };
    const get = vi.fn(async (id: string) => (id === record.id ? record : null));
    const claimForDispatch = vi.fn(async (input: { id: string }) => ({
      status: "acquired" as const,
      record: { ...record, state: "dispatching" as const, lease, dispatchLease: lease },
      lease,
    }));
    const markSettled = vi.fn(async () => null);
    __setSubmissionRecoveryStoreForTests({
      putIfAbsent: async (value) => value,
      get,
      list: async () => [record],
      discardQueued: async () => ({ status: "not_queued", record }),
      claimForDispatch,
      markNeedsReview: async () => null,
      markSettled,
      discardInspected: async () => ({ status: "missing" }),
    });
    const queue = createFakeQueue(
      new Map([
        [
          "agent",
          [
            {
              id: record.clientMessageId,
              clientMessageId: record.clientMessageId,
              submissionRecoveryId: record.id,
              text: record.submission.text,
              attachments: [],
            },
          ],
        ],
      ]),
    );
    const submitted: Array<{ clientMessageId: string }> = [];

    await expect(
      sendQueuedComposerMessageNow({
        agentId: "agent",
        messageId: record.clientMessageId,
        queue,
        submitMessage: async (input) => {
          submitted.push({ clientMessageId: input.clientMessageId });
        },
      }),
    ).resolves.toEqual({ status: "submitted" });

    expect(get).toHaveBeenCalledWith(record.id);
    expect(claimForDispatch).toHaveBeenCalledWith(expect.objectContaining({ id: record.id }));
    expect(markSettled).toHaveBeenCalledWith(expect.objectContaining({ id: record.id, lease }));
    expect(submitted).toEqual([{ clientMessageId: record.clientMessageId }]);
    expect(queue.state.get("agent")).toEqual([]);
  });

  it("keeps legacy queue rows compatible when wire and recovery identities are the same", async () => {
    const record = createSubmissionRecoveryRecord({
      id: "stable-accepted",
      clientMessageId: "stable-accepted",
      submission: {
        kind: "agent_message",
        serverId: "server",
        agentId: "agent",
        workspaceId: null,
        draftId: null,
        cwd: "/repo",
        text: "accepted message",
        attachments: [],
      },
      originalDraft: {
        ownerKey: "server:agent",
        text: "accepted message",
        attachments: [],
        selection: { start: 0, end: 0 },
      },
    });
    const lease: SubmissionRecoveryLease = {
      ownerId: "window",
      fence: "fence",
      expiresAt: Date.now() + 30_000,
    };
    const markSettled = vi.fn(async () => {
      throw new Error("cleanup storage failed");
    });
    const recoveryStore: SubmissionRecoveryStore = {
      putIfAbsent: async (value) => value,
      get: async () => record,
      list: async () => [record],
      discardQueued: async () => ({ status: "not_queued", record }),
      claimForDispatch: async () => ({
        status: "acquired",
        record: { ...record, state: "dispatching", lease, dispatchLease: lease },
        lease,
      }),
      markNeedsReview: async () => null,
      markSettled,
      discardInspected: async () => ({ status: "missing" }),
    };
    __setSubmissionRecoveryStoreForTests(recoveryStore);
    const queue = createFakeQueue(
      new Map([
        [
          "agent",
          [
            {
              id: "row-accepted",
              clientMessageId: "stable-accepted",
              text: "accepted message",
              attachments: [],
            },
          ],
        ],
      ]),
    );
    const submitted: Array<{ clientMessageId: string }> = [];

    await expect(
      sendQueuedComposerMessageNow({
        agentId: "agent",
        messageId: "row-accepted",
        queue,
        submitMessage: async (input) => {
          submitted.push({ clientMessageId: input.clientMessageId });
        },
      }),
    ).resolves.toEqual({ status: "submitted" });

    expect(submitted).toEqual([{ clientMessageId: "stable-accepted" }]);
    expect(markSettled).toHaveBeenCalledWith(
      expect.objectContaining({ id: "stable-accepted", lease }),
    );
    expect(queue.state.get("agent")).toEqual([]);
  });

  it("restores the queued entry to the front and surfaces the error message on failure", async () => {
    const queue = createFakeQueue(
      new Map([
        [
          "agent",
          [
            { id: "msg-1", text: "first", attachments: [] },
            { id: "msg-2", text: "second", attachments: [] },
          ],
        ],
      ]),
    );
    const result = await sendQueuedComposerMessageNow({
      agentId: "agent",
      messageId: "msg-1",
      queue,
      submitMessage: async () => {
        throw new Error("network down");
      },
    });
    expect(result).toEqual({ status: "failed", errorMessage: "network down" });
    const state = queue.state.get("agent");
    expect(state?.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
  });
});

describe("removeComposerAttachmentAtIndex", () => {
  it("removes an image attachment without deleting bytes that may be queued or recoverable", () => {
    const image = imageWithId("img-remove");
    const persister = createFakePersister();
    const next = removeComposerAttachmentAtIndex({
      attachments: [{ kind: "image", metadata: image }] satisfies UserComposerAttachment[],
      index: 0,
      deleteAttachments: persister.deleteAttachments,
    });
    expect(next).toEqual([]);
    expect(persister.deletedBatches).toEqual([]);
  });

  it("removes a github attachment without scheduling any storage deletes", () => {
    const persister = createFakePersister();
    const next = removeComposerAttachmentAtIndex({
      attachments: [
        { kind: "github_issue", item: issueItem },
        { kind: "github_pr", item: prItem },
      ] satisfies UserComposerAttachment[],
      index: 0,
      deleteAttachments: persister.deleteAttachments,
    });
    expect(next).toEqual([{ kind: "github_pr", item: prItem }]);
    expect(persister.deletedBatches).toEqual([]);
  });
});

describe("openComposerAttachment", () => {
  it("opens the lightbox for image attachments", () => {
    const image = imageWithId("img-body");
    const lightboxCalls: AttachmentMetadata[] = [];
    const externalUrlCalls: string[] = [];
    openComposerAttachment({
      attachment: { kind: "image", metadata: image },
      setLightboxMetadata: (metadata) => {
        lightboxCalls.push(metadata);
      },
      openWorkspaceAttachment: () => false,
      openExternalUrl: (url) => {
        externalUrlCalls.push(url);
      },
    });
    expect(lightboxCalls).toEqual([image]);
    expect(externalUrlCalls).toEqual([]);
  });

  it("delegates workspace review attachments to the workspace opener", () => {
    const review = reviewWorkspaceAttachment("Open me.");
    const workspaceCalls: ComposerAttachment[] = [];
    openComposerAttachment({
      attachment: review,
      setLightboxMetadata: () => {
        throw new Error("unexpected lightbox call");
      },
      openWorkspaceAttachment: ({ attachment }) => {
        workspaceCalls.push(attachment);
        return true;
      },
      openExternalUrl: () => {
        throw new Error("unexpected external url call");
      },
    });
    expect(workspaceCalls).toEqual([review]);
  });

  it("opens GitHub item URLs through the external url opener", () => {
    const externalUrlCalls: string[] = [];
    openComposerAttachment({
      attachment: { kind: "github_issue", item: issueItem },
      setLightboxMetadata: () => {
        throw new Error("unexpected lightbox call");
      },
      openWorkspaceAttachment: () => false,
      openExternalUrl: (url) => {
        externalUrlCalls.push(url);
      },
    });
    expect(externalUrlCalls).toEqual([issueItem.url]);
  });

  it("opens plugin resource URLs through the external url opener", () => {
    const externalUrlCalls: string[] = [];
    openComposerAttachment({
      attachment: {
        kind: "plugin_resource",
        pluginId: "linear",
        sourceId: "issues",
        sourceTitle: "Linear issue",
        sourceIcon: "CircleDot",
        item: {
          id: "issue-uuid",
          identifier: "ENG-123",
          title: "Plugin attachments",
          url: "https://linear.app/acme/issue/ENG-123/plugin-attachments",
          text: "Linear issue ENG-123: Plugin attachments",
          resourceType: "issue",
        },
      },
      setLightboxMetadata: () => {
        throw new Error("unexpected lightbox call");
      },
      openWorkspaceAttachment: () => false,
      openExternalUrl: (url) => {
        externalUrlCalls.push(url);
      },
    });
    expect(externalUrlCalls).toEqual(["https://linear.app/acme/issue/ENG-123/plugin-attachments"]);
  });
});

describe("toggleForgeAttachment", () => {
  it("appends a GitHub issue when not already attached", () => {
    const next = toggleForgeAttachment([], issueItem);
    expect(next).toEqual([{ kind: "forge_issue", item: issueItem }]);
  });

  it("appends a GitHub PR when not already attached", () => {
    const next = toggleForgeAttachment([], prItem);
    expect(next).toEqual([{ kind: "forge_change_request", item: prItem }]);
  });

  it("removes an existing GitHub item with the same kind+number", () => {
    const next = toggleForgeAttachment([{ kind: "github_issue", item: issueItem }], issueItem);
    expect(next).toEqual([]);
  });

  it("does not affect other items with different kind or number", () => {
    const start: UserComposerAttachment[] = [
      { kind: "github_issue", item: issueItem },
      { kind: "github_pr", item: prItem },
    ];
    const otherIssue: ForgeSearchItem = { ...issueItem, number: 999 };
    const next = toggleForgeAttachment(start, otherIssue);
    expect(next).toEqual([
      { kind: "github_issue", item: issueItem },
      { kind: "github_pr", item: prItem },
      { kind: "forge_issue", item: otherIssue },
    ]);
  });
});

describe("toggleForgeAttachmentFromPicker", () => {
  it("marks an existing GitHub item as removed when picker toggle removes it", () => {
    const markForgeAttachmentRemoved = vi.fn();
    const attachment: UserComposerAttachment = { kind: "github_pr", item: prItem };

    const next = toggleForgeAttachmentFromPicker({
      current: [attachment],
      item: prItem,
      markForgeAttachmentRemoved,
    });

    expect(next).toEqual([]);
    expect(markForgeAttachmentRemoved).toHaveBeenCalledTimes(1);
    expect(markForgeAttachmentRemoved).toHaveBeenCalledWith(attachment);
  });

  it("does not mark a GitHub item removed when picker toggle adds it", () => {
    const markForgeAttachmentRemoved = vi.fn();

    const next = toggleForgeAttachmentFromPicker({
      current: [],
      item: issueItem,
      markForgeAttachmentRemoved,
    });

    expect(next).toEqual([{ kind: "forge_issue", item: issueItem }]);
    expect(markForgeAttachmentRemoved).not.toHaveBeenCalled();
  });
});

describe("findForgeItemByOption / isAttachmentSelectedForForgeItem", () => {
  it("locates items via their composite kind:number id", () => {
    expect(findForgeItemByOption([issueItem, prItem], "issue:101")).toBe(issueItem);
    expect(findForgeItemByOption([issueItem, prItem], "change_request:202")).toBe(prItem);
    expect(findForgeItemByOption([issueItem], "change_request:404")).toBeUndefined();
  });

  it("recognizes when an attachment list already contains a matching GitHub item", () => {
    const attachments: ComposerAttachment[] = [
      { kind: "image", metadata: imageWithId("img-x") },
      { kind: "github_issue", item: issueItem },
      reviewWorkspaceAttachment("ignored"),
    ];
    expect(isAttachmentSelectedForForgeItem(attachments, issueItem)).toBe(true);
    expect(isAttachmentSelectedForForgeItem(attachments, prItem)).toBe(false);
  });
});

describe("file upload preparation", () => {
  it("waits for file bytes and daemon acknowledgement before returning the attachment", async () => {
    let resolveRead!: (bytes: Uint8Array) => void;
    const read = new Promise<Uint8Array>((resolve) => {
      resolveRead = resolve;
    });
    let acknowledge!: (result: Awaited<ReturnType<ComposerSendClient["uploadFile"]>>) => void;
    const response = new Promise<Awaited<ReturnType<ComposerSendClient["uploadFile"]>>>(
      (resolve) => {
        acknowledge = resolve;
      },
    );
    const sent: string[] = [];
    const upload = uploadFileAttachments({
      client: {
        sendAgentMessage: async () => {},
        uploadFile: async (file) => {
          sent.push(file.fileName);
          expect(file.bytes).toEqual(new Uint8Array([1, 2]));
          return response;
        },
      },
      files: [
        { fileName: "sample.bin", mimeType: "application/octet-stream", readBytes: () => read },
      ],
    });
    let completed = false;
    void upload.then(() => {
      completed = true;
      return undefined;
    });
    expect(sent).toEqual([]);
    resolveRead(new Uint8Array([1, 2]));
    await Promise.resolve();
    expect(sent).toEqual(["sample.bin"]);
    expect(completed).toBe(false);
    const file = {
      type: "uploaded_file" as const,
      id: "file-1",
      fileName: "sample.bin",
      mimeType: "application/octet-stream",
      size: 2,
      path: "/uploads/sample.bin",
    };
    acknowledge({ requestId: "req-1", file, error: null });
    await expect(upload).resolves.toEqual([{ kind: "file", attachment: file }]);
  });

  it.each(["unreadable", "oversized"])(
    "does not upload a batch containing a later %s file",
    async (failure) => {
      let sends = 0;
      await expect(
        uploadFileAttachments({
          client: {
            sendAgentMessage: async () => {},
            uploadFile: async () => {
              sends++;
              throw new Error("unexpected send");
            },
          },
          files: [
            {
              fileName: "valid.bin",
              mimeType: "application/octet-stream",
              readBytes: async () => new Uint8Array([1]),
            },
            {
              fileName: "missing.bin",
              mimeType: "application/octet-stream",
              readBytes: async () => {
                if (failure === "oversized") return new Uint8Array(50 * 1024 * 1024 + 1);
                throw new Error("read failed");
              },
            },
          ],
        }),
      ).rejects.toThrow(failure === "unreadable" ? "read failed" : "too large");
      expect(sends).toBe(0);
    },
  );

  it("keeps all unattempted sources recoverable when one file fails preflight", async () => {
    const valid = {
      fileName: "valid.bin",
      mimeType: "application/octet-stream",
      readBytes: async () => new Uint8Array([1]),
    };
    const invalid = {
      fileName: "invalid.bin",
      mimeType: "application/octet-stream",
      readBytes: async () => {
        throw new Error("cannot read invalid.bin");
      },
    };
    const uploadFile = vi.fn();

    const result = await uploadFileAttachmentBatch({
      client: { sendAgentMessage: async () => {}, uploadFile },
      files: [valid, invalid],
    });

    expect(uploadFile).not.toHaveBeenCalled();
    expect(result.uploaded).toEqual([]);
    expect(result.failed).toEqual([
      { file: invalid, errorMessage: "cannot read invalid.bin" },
      {
        file: valid,
        errorMessage: "Upload was not started because another file failed preflight.",
      },
    ]);
  });
});

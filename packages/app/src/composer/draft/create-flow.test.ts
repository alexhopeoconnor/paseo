/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import type { UserMessageImageAttachment } from "@/types/stream";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { PreparedComposerSendPayload } from "@/composer/attachments/submit";
import { useDraftAgentCreateFlow, type DraftCreateAttempt } from "./create-flow";

const { encodeImagesMock } = vi.hoisted(() => ({ encodeImagesMock: vi.fn() }));

vi.mock("@/utils/encode-images", () => ({ encodeImages: encodeImagesMock }));

describe("useDraftAgentCreateFlow", () => {
  beforeEach(() => {
    useCreateFlowStore.setState({ pendingByDraftId: {} });
    encodeImagesMock.mockReset();
    encodeImagesMock.mockResolvedValue([]);
  });

  it("reserves a direct create before asynchronous payload preparation completes", async () => {
    let releasePreparation!: (value: Array<{ data: string; mimeType: string }>) => void;
    const preparation = new Promise<Array<{ data: string; mimeType: string }>>((resolve) => {
      releasePreparation = resolve;
    });
    encodeImagesMock.mockReturnValueOnce(preparation);
    const image: UserMessageImageAttachment = {
      id: "single-flight-image",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "single-flight-image",
      createdAt: 1,
    };
    const createRequest = vi.fn(async () => ({ agentId: "agent-1", result: { id: "agent-1" } }));
    const { result } = renderHook(() =>
      useDraftAgentCreateFlow({
        draftId: "draft-single-flight",
        getPendingServerId: () => "server-1",
        buildDraftAgent: (attempt) => ({ attempt }),
        createRequest,
        onCreateSuccess: () => undefined,
      }),
    );

    let first!: Promise<void>;
    await act(async () => {
      first = result.current.handleCreateFromInput({
        text: "create once",
        attachments: [{ kind: "image", metadata: image }],
        cwd: "/repo",
      });
      await expect(
        result.current.handleCreateFromInput({
          text: "create twice",
          attachments: [{ kind: "image", metadata: image }],
          cwd: "/repo",
        }),
      ).rejects.toThrow(/already/i);
    });

    releasePreparation([{ data: "encoded-once", mimeType: "image/png" }]);
    await act(async () => {
      await first;
    });
    expect(encodeImagesMock).toHaveBeenCalledTimes(1);
    expect(createRequest).toHaveBeenCalledTimes(1);
    expect(createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "create once",
        imageData: [{ data: "encoded-once", mimeType: "image/png" }],
      }),
    );
  });

  it("renders a prepared new-workspace submission before continuing it", async () => {
    const image: UserMessageImageAttachment = {
      id: "image-1",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "image-key",
      createdAt: 123,
    };
    const attachment = {
      type: "review",
      cwd: "/repo",
      summary: "Review",
    } as unknown as AgentAttachment;
    const attempt: DraftCreateAttempt = {
      clientMessageId: "msg-prepared",
      text: "build this",
      timestamp: new Date("2026-05-25T00:00:00.000Z"),
      images: [image],
      attachments: [attachment],
    };
    const createRequest = vi.fn(
      async (ctx: {
        attempt: DraftCreateAttempt;
        text: string;
        images?: UserMessageImageAttachment[];
        attachments?: AgentAttachment[];
        cwd: string;
      }) => ({
        agentId: "agent-1",
        result: { id: "agent-1", ctx },
      }),
    );
    const onCreateSuccess = vi.fn();

    const { result } = renderHook(() =>
      useDraftAgentCreateFlow({
        draftId: "draft-1",
        getPendingServerId: () => "server-1",
        initialAttempt: attempt,
        buildDraftAgent: (currentAttempt) => ({ currentAttempt }),
        createRequest,
        onCreateSuccess,
      }),
    );

    expect(result.current.isSubmitting).toBe(true);
    expect(result.current.draftAgent).toEqual({ currentAttempt: attempt });
    expect(createRequest).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.continueCreateFromAttempt({ attempt, cwd: "/repo" });
    });

    expect(createRequest).toHaveBeenCalledTimes(1);
    expect(createRequest).toHaveBeenCalledWith({
      attempt,
      text: "build this",
      images: [image],
      attachments: [attachment],
      cwd: "/repo",
    });
    expect(onCreateSuccess).toHaveBeenCalledTimes(1);
  });

  it("reuses the caller-prepared wire payload and stable identity without re-encoding", async () => {
    const image: UserMessageImageAttachment = {
      id: "prepared-image",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "prepared-image",
      createdAt: 1,
    };
    const preparedPayload: PreparedComposerSendPayload = {
      images: [image],
      imageData: [{ data: "prepared-image-bytes", mimeType: "image/png" }],
      attachments: [
        {
          type: "text",
          mimeType: "text/plain",
          title: "Pasted text",
          text: "exact\r\nbytes",
        },
      ],
    };
    const createRequest = vi.fn(
      async (ctx: {
        attempt: DraftCreateAttempt;
        text: string;
        images?: UserMessageImageAttachment[];
        imageData?: Array<{ data: string; mimeType: string }>;
        attachments?: AgentAttachment[];
        cwd: string;
      }) => ({ agentId: "agent-1", result: ctx }),
    );
    const { result } = renderHook(() =>
      useDraftAgentCreateFlow({
        draftId: "draft-prepared-wire",
        getPendingServerId: () => "server-1",
        buildDraftAgent: (attempt) => ({ attempt }),
        createRequest,
        onCreateSuccess: () => undefined,
      }),
    );

    await act(async () => {
      await result.current.handleCreateFromInput({
        text: "create this",
        attachments: [{ kind: "image", metadata: image }],
        cwd: "/repo",
        clientMessageId: "stable-create-message",
        preparedPayload,
      });
    });

    expect(createRequest).toHaveBeenCalledWith({
      attempt: expect.objectContaining({
        clientMessageId: "stable-create-message",
        imageData: preparedPayload.imageData,
      }),
      text: "create this",
      images: [image],
      imageData: preparedPayload.imageData,
      attachments: preparedPayload.attachments,
      cwd: "/repo",
    });
    expect(preparedPayload.attachments[0]).not.toHaveProperty("contextKind");
  });

  it("keeps the submitted preview when the pending provider selection disappears", () => {
    const attempt: DraftCreateAttempt = {
      clientMessageId: "msg-provider-handoff",
      text: "build this",
      timestamp: new Date("2026-05-25T00:00:00.000Z"),
    };
    const { result, rerender } = renderHook(
      ({ provider }: { provider: string | null }) =>
        useDraftAgentCreateFlow({
          draftId: "draft-handoff",
          getPendingServerId: () => "server-1",
          initialAttempt: attempt,
          buildDraftAgent: () => {
            if (!provider) throw new Error("Select a model");
            return { provider, model: "selected-model" };
          },
          createRequest: async () => ({ agentId: "agent-1", result: { id: "agent-1" } }),
          onCreateSuccess: () => undefined,
        }),
      { initialProps: { provider: "codex" } as { provider: string | null } },
    );
    expect(result.current.draftAgent).toEqual({ provider: "codex", model: "selected-model" });
    rerender({ provider: null });
    expect(result.current.isSubmitting).toBe(true);
    expect(result.current.draftAgent).toEqual({ provider: "codex", model: "selected-model" });
  });

  it("shows an invalid prepared selection as a form error instead of throwing in render", () => {
    const createRequest = vi.fn(async () => ({ agentId: "agent-1", result: { id: "agent-1" } }));
    const { result } = renderHook(() =>
      useDraftAgentCreateFlow({
        draftId: "draft-invalid",
        getPendingServerId: () => "server-1",
        initialAttempt: {
          clientMessageId: "msg-invalid",
          text: "build this",
          timestamp: new Date(0),
        },
        buildDraftAgent: () => {
          throw new Error("Select a model");
        },
        createRequest,
        onCreateSuccess: () => undefined,
      }),
    );
    expect(result.current.isSubmitting).toBe(false);
    expect(result.current.draftAgent).toBeNull();
    expect(result.current.formErrorMessage).toBe("Select a model");
    expect(createRequest).not.toHaveBeenCalled();
  });

  it("keeps a manual submission stable and lets a failed request retry with a new selection", async () => {
    let failRequest!: (error: Error) => void;
    const request = new Promise<never>((_resolve, reject) => {
      failRequest = reject;
    });
    let requestCount = 0;
    const { result, rerender } = renderHook(
      ({ provider }: { provider: string | null }) =>
        useDraftAgentCreateFlow({
          draftId: "draft-manual",
          getPendingServerId: () => "server-1",
          buildDraftAgent: () => {
            if (!provider) throw new Error("Select a model");
            return { provider };
          },
          createRequest: async () => {
            requestCount++;
            if (requestCount === 1) return await request;
            return { agentId: "agent-1", result: { id: "agent-1" } };
          },
          onCreateSuccess: () => undefined,
        }),
      { initialProps: { provider: "codex" } as { provider: string | null } },
    );
    let submission!: Promise<unknown>;
    const captureError = (error: unknown) => error;
    await act(async () => {
      submission = result.current
        .handleCreateFromInput({ text: "build this", attachments: [], cwd: "/repo" })
        .catch(captureError);
    });
    rerender({ provider: null });
    expect(result.current.draftAgent).toEqual({ provider: "codex" });
    await act(async () => {
      failRequest(new Error("Provider unavailable"));
      await submission;
    });
    expect(result.current.isSubmitting).toBe(false);
    expect(result.current.draftAgent).toBeNull();
    expect(result.current.formErrorMessage).toBe("Provider unavailable");
    rerender({ provider: "claude" });
    await act(async () => {
      await result.current.handleCreateFromInput({
        text: "try again",
        attachments: [],
        cwd: "/repo",
      });
    });
    expect(result.current.draftAgent).toEqual({ provider: "claude" });
    expect(result.current.formErrorMessage).toBe("");
    expect(requestCount).toBe(2);
  });

  it("does not hand off a late create completion into a newer same-wire-id presentation", async () => {
    let resolveCreate!: (value: { agentId: string; result: { id: string } }) => void;
    const createGate = new Promise<{ agentId: string; result: { id: string } }>((resolve) => {
      resolveCreate = resolve;
    });
    const onCreateSuccess = vi.fn();
    const onCreateError = vi.fn();
    const draftId = "draft-late-presentation";
    const clientMessageId = "deterministic-wire-id";
    const firstPresentation = {
      presentationToken: "presentation-a",
      ownerIdentity: "owner-a",
      phase: "preparing" as const,
    };
    const secondPresentation = {
      presentationToken: "presentation-b",
      ownerIdentity: "owner-b",
      phase: "preparing" as const,
    };
    const createRequest = vi.fn(async () => await createGate);
    const { result } = renderHook(() =>
      useDraftAgentCreateFlow({
        draftId,
        getPendingServerId: () => "server-1",
        buildDraftAgent: (attempt) => ({ attempt }),
        createRequest,
        onCreateSuccess,
        onCreateError,
      }),
    );

    expect(
      result.current.beginSubmissionPresentation({
        clientMessageId,
        text: "first attempt",
        presentation: firstPresentation,
      }),
    ).toBe(true);
    let firstAttempt!: Promise<void>;
    await act(async () => {
      firstAttempt = result.current.handleCreateFromInput({
        text: "first attempt",
        attachments: [],
        cwd: "/repo",
        clientMessageId,
        presentation: firstPresentation,
        preparedPayload: { images: [], imageData: [], attachments: [] },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createRequest).toHaveBeenCalledTimes(1);

    const store = useCreateFlowStore.getState();
    act(() => {
      store.markLifecycle({
        draftId,
        lifecycle: "abandoned",
        presentationToken: firstPresentation.presentationToken,
      });
      expect(
        store.beginPresentation({
          draftId,
          serverId: "server-1",
          agentId: null,
          clientMessageId,
          text: "newer attempt",
          timestamp: 2,
          presentation: secondPresentation,
        }),
      ).toBe(true);
      expect(
        store.promotePresentation({
          draftId,
          presentationToken: secondPresentation.presentationToken,
        }),
      ).toBe(true);
    });

    await act(async () => {
      resolveCreate({
        agentId: "agent-from-first-attempt",
        result: { id: "agent-from-first-attempt" },
      });
      await expect(firstAttempt).rejects.toThrow(/no longer current/i);
    });

    // The same deterministic wire ID is not enough authority for A to
    // consume B. A's durable checkpoint remains for the outer lifecycle to
    // retain as reviewable; it does not install an agent or an error on B.
    expect(onCreateSuccess).not.toHaveBeenCalled();
    expect(onCreateError).not.toHaveBeenCalled();
    expect(useCreateFlowStore.getState().pendingByDraftId[draftId]).toMatchObject({
      clientMessageId,
      text: "newer attempt",
      agentId: null,
      lifecycle: "active",
      presentation: {
        presentationToken: secondPresentation.presentationToken,
        ownerIdentity: secondPresentation.ownerIdentity,
        phase: "dispatching",
      },
    });
  });

  it("allows retrying an empty prompt when the draft still has context attachments", async () => {
    const attachment = {
      kind: "chat_history",
      id: "chat-history-1",
      attachment: {
        type: "text",
        mimeType: "text/plain",
        contextKind: "chat_history",
        title: "Chat history",
        text: "Previous conversation",
      },
      source: {
        serverId: "server-1",
        agentId: "agent-source",
      },
    } as const;
    const createRequest = vi.fn(async () => ({
      agentId: "agent-1",
      result: { id: "agent-1" },
    }));
    const onCreateSuccess = vi.fn();
    const validateBeforeSubmit = vi.fn(() => null);

    const { result } = renderHook(() =>
      useDraftAgentCreateFlow({
        draftId: "draft-1",
        getPendingServerId: () => "server-1",
        buildDraftAgent: (currentAttempt) => ({ currentAttempt }),
        createRequest,
        onCreateSuccess,
        validateBeforeSubmit,
      }),
    );

    await act(async () => {
      await result.current.handleCreateFromInput({
        text: "   ",
        attachments: [attachment],
        cwd: "/repo",
      });
    });

    expect(validateBeforeSubmit).toHaveBeenCalledWith({
      text: "",
      attachments: [attachment],
      cwd: "/repo",
    });
    expect(createRequest).toHaveBeenCalledWith({
      attempt: expect.objectContaining({
        text: "",
        attachments: [attachment.attachment],
      }),
      text: "",
      attachments: [attachment.attachment],
      cwd: "/repo",
    });
    expect(onCreateSuccess).toHaveBeenCalledTimes(1);
  });
});

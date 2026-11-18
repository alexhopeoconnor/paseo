import { beforeEach, describe, expect, it } from "vitest";
import { isActiveCreateFlowForDraft, useCreateFlowStore } from "./create-flow-store";

describe("create-flow-store", () => {
  beforeEach(() => {
    useCreateFlowStore.setState({ pendingByDraftId: {} });
  });

  it("accepts a retry after failure while rejecting repeated active or completed submissions", () => {
    const store = useCreateFlowStore.getState();
    const submission = {
      draftId: "draft-retry",
      serverId: "server-1",
      workspaceId: "workspace-1",
      agentId: null,
      clientMessageId: "draft-retry:initial-message",
      text: "hello",
      timestamp: 1,
    };
    expect(store.trySetPending(submission)).toBe(true);
    expect(store.trySetPending(submission)).toBe(false);
    store.markLifecycle({
      draftId: submission.draftId,
      lifecycle: "abandoned",
      errorMessage: "Disconnected",
    });
    expect(store.trySetPending(submission)).toBe(true);
    expect(useCreateFlowStore.getState().pendingByDraftId[submission.draftId]).toEqual({
      ...submission,
      lifecycle: "active",
    });
    store.markLifecycle({ draftId: submission.draftId, lifecycle: "sent" });
    expect(store.trySetPending(submission)).toBe(false);
  });

  it("tracks lifecycle transitions explicitly", () => {
    const store = useCreateFlowStore.getState();
    store.setPending({
      draftId: "draft-1",
      serverId: "server-1",
      agentId: null,
      clientMessageId: "msg-1",
      text: "hello",
      timestamp: Date.now(),
      images: [],
    });

    expect(useCreateFlowStore.getState().pendingByDraftId["draft-1"]?.lifecycle).toBe("active");

    useCreateFlowStore.getState().markLifecycle({ draftId: "draft-1", lifecycle: "abandoned" });
    expect(useCreateFlowStore.getState().pendingByDraftId["draft-1"]?.lifecycle).toBe("abandoned");
  });

  it("rekeys draft id idempotently", () => {
    useCreateFlowStore.getState().setPending({
      draftId: "draft-a",
      serverId: "server-1",
      agentId: null,
      clientMessageId: "msg-1",
      text: "hello",
      timestamp: Date.now(),
      images: [],
    });

    useCreateFlowStore.getState().rekeyDraft({
      fromDraftId: "draft-a",
      toDraftId: "draft-b",
    });
    useCreateFlowStore.getState().rekeyDraft({
      fromDraftId: "draft-a",
      toDraftId: "draft-b",
    });

    expect(useCreateFlowStore.getState().pendingByDraftId["draft-b"]?.draftId).toBe("draft-b");
  });

  it("supports multiple pending attempts", () => {
    useCreateFlowStore.getState().setPending({
      draftId: "draft-1",
      serverId: "server-1",
      agentId: null,
      clientMessageId: "msg-1",
      text: "one",
      timestamp: Date.now(),
    });
    useCreateFlowStore.getState().setPending({
      draftId: "draft-2",
      serverId: "server-1",
      agentId: null,
      clientMessageId: "msg-2",
      text: "two",
      timestamp: Date.now(),
    });

    const state = useCreateFlowStore.getState();
    expect(Object.keys(state.pendingByDraftId).sort()).toEqual(["draft-1", "draft-2"]);

    useCreateFlowStore.getState().clear({ draftId: "draft-1" });
    expect(useCreateFlowStore.getState().pendingByDraftId["draft-1"]).toBeUndefined();
  });

  it("clears pending handoff state by agent", () => {
    useCreateFlowStore.getState().setPending({
      draftId: "draft-1",
      serverId: "server-1",
      agentId: null,
      clientMessageId: "msg-1",
      text: "hello",
      timestamp: Date.now(),
    });
    useCreateFlowStore.getState().updateAgentId({ draftId: "draft-1", agentId: "agent-1" });
    useCreateFlowStore.getState().markLifecycle({ draftId: "draft-1", lifecycle: "sent" });

    useCreateFlowStore.getState().clearByAgent({ serverId: "server-1", agentId: "agent-1" });

    expect(useCreateFlowStore.getState().pendingByDraftId["draft-1"]).toBeUndefined();
  });

  it("matches only active pending create flows for a draft and server", () => {
    useCreateFlowStore.getState().setPending({
      draftId: "draft-1",
      serverId: "server-1",
      agentId: null,
      clientMessageId: "msg-1",
      text: "hello",
      timestamp: Date.now(),
    });
    const pending = useCreateFlowStore.getState().pendingByDraftId["draft-1"];

    expect(
      isActiveCreateFlowForDraft({
        pending,
        serverId: "server-1",
        draftId: " draft-1 ",
      }),
    ).toBe(true);
    expect(
      isActiveCreateFlowForDraft({
        pending,
        serverId: "server-2",
        draftId: "draft-1",
      }),
    ).toBe(false);

    useCreateFlowStore.getState().markLifecycle({ draftId: "draft-1", lifecycle: "sent" });
    expect(
      isActiveCreateFlowForDraft({
        pending: useCreateFlowStore.getState().pendingByDraftId["draft-1"],
        serverId: "server-1",
        draftId: "draft-1",
      }),
    ).toBe(false);
  });

  it("uses an exact presentation token to reject late create completion after a retry", () => {
    const store = useCreateFlowStore.getState();
    const first = {
      draftId: "draft-token",
      serverId: "server-1",
      agentId: null,
      clientMessageId: "stable-wire-id",
      text: "first",
      timestamp: 1,
      presentation: {
        presentationToken: "attempt-a",
        ownerIdentity: "owner-a",
        phase: "preparing" as const,
      },
    };
    expect(store.beginPresentation(first)).toBe(true);
    expect(
      store.promotePresentation({ draftId: first.draftId, presentationToken: "attempt-a" }),
    ).toBe(true);
    store.markLifecycle({
      draftId: first.draftId,
      lifecycle: "abandoned",
      presentationToken: "attempt-a",
    });

    const second = {
      ...first,
      text: "second",
      presentation: {
        ...first.presentation,
        presentationToken: "attempt-b",
        ownerIdentity: "owner-b",
      },
    };
    expect(store.beginPresentation(second)).toBe(true);
    expect(
      store.completePresentation({
        draftId: first.draftId,
        clientMessageId: first.clientMessageId,
        ownerIdentity: first.presentation.ownerIdentity,
        presentationToken: "attempt-a",
        agentId: "agent-a",
      }),
    ).toBe(false);
    expect(
      store.completePresentation({
        draftId: second.draftId,
        clientMessageId: second.clientMessageId,
        ownerIdentity: second.presentation.ownerIdentity,
        presentationToken: "attempt-b",
        agentId: "agent-b",
      }),
    ).toBe(false);
    expect(
      store.promotePresentation({ draftId: second.draftId, presentationToken: "attempt-b" }),
    ).toBe(true);
    expect(
      store.completePresentation({
        draftId: second.draftId,
        clientMessageId: second.clientMessageId,
        ownerIdentity: first.presentation.ownerIdentity,
        presentationToken: "attempt-b",
        agentId: "agent-a",
      }),
    ).toBe(false);
    expect(
      store.completePresentation({
        draftId: second.draftId,
        clientMessageId: second.clientMessageId,
        ownerIdentity: second.presentation.ownerIdentity,
        presentationToken: "attempt-b",
        agentId: "agent-b",
      }),
    ).toBe(true);
    expect(useCreateFlowStore.getState().pendingByDraftId[second.draftId]).toMatchObject({
      clientMessageId: "stable-wire-id",
      text: "second",
      agentId: "agent-b",
      lifecycle: "sent",
    });
  });
});

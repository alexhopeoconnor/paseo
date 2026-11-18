import { describe, expect, test } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";

describe("provider subagent protocol", () => {
  test("accepts a scoped timeline request and structured live update", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.provider_subagents.timeline.get.request",
        parentAgentId: "parent-1",
        subagentId: "child-1",
        requestId: "request-1",
      }),
    ).toMatchObject({ parentAgentId: "parent-1", subagentId: "child-1" });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_subagents.update",
        payload: {
          kind: "timeline",
          parentAgentId: "parent-1",
          subagentId: "child-1",
          provider: "claude",
          epoch: "epoch-1",
          seq: 4,
          timestamp: "2026-07-12T10:00:00.000Z",
          item: { type: "assistant_message", text: "Found it." },
        },
      }),
    ).toMatchObject({
      payload: {
        kind: "timeline",
        parentAgentId: "parent-1",
        subagentId: "child-1",
        seq: 4,
      },
    });
  });

  test("accepts a provider child working directory while remaining compatible when absent", () => {
    const descriptor = {
      id: "child-1",
      parentAgentId: "parent-1",
      provider: "opencode",
      title: "Explore",
      description: null,
      status: "running",
      createdAt: "2026-07-12T10:00:00.000Z",
      updatedAt: "2026-07-12T10:00:00.000Z",
      toolCallId: null,
    };

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_subagents.list.response",
        payload: {
          requestId: "request-1",
          parentAgentId: "parent-1",
          subagents: [{ ...descriptor, cwd: "/workspace/child" }],
          error: null,
        },
      }),
    ).toMatchObject({ payload: { subagents: [{ cwd: "/workspace/child" }] } });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_subagents.list.response",
        payload: {
          requestId: "request-2",
          parentAgentId: "parent-1",
          subagents: [descriptor],
          error: null,
        },
      }),
    ).toMatchObject({ payload: { subagents: [{ id: "child-1" }] } });
  });
});

test("passive roster snapshots and descriptor cursors survive protocol parsing", () => {
  expect(
    SessionInboundMessageSchema.parse({
      type: "agent.provider_subagents.snapshot.request",
      parentAgentId: "parent",
      requestId: "read",
    }),
  ).toMatchObject({ parentAgentId: "parent" });
  const cursor = { generation: "store-1", revision: 7 };
  expect(
    SessionOutboundMessageSchema.parse({
      type: "agent.provider_subagents.snapshot.response",
      payload: {
        parentAgentId: "parent",
        requestId: "read",
        availability: "not_resident",
        cursor,
        subagents: [],
        error: null,
      },
    }),
  ).toMatchObject({ payload: { availability: "not_resident", cursor } });
  expect(
    SessionOutboundMessageSchema.parse({
      type: "agent.provider_subagents.update",
      payload: {
        kind: "remove",
        parentAgentId: "parent",
        subagentId: "child",
        cursor,
        replayed: true,
      },
    }),
  ).toMatchObject({ payload: { cursor, replayed: true } });
  expect(
    SessionOutboundMessageSchema.safeParse({
      type: "agent.provider_subagents.snapshot.response",
      payload: {
        parentAgentId: "parent",
        requestId: "read",
        availability: "resident",
        cursor: { ...cursor, revision: -1 },
        subagents: [],
        error: null,
      },
    }).success,
  ).toBe(false);
});

import { expect, test, vi } from "vitest";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { AgentArchiveOperation } from "@getpaseo/protocol/messages";
import type { AgentManager, ManagedAgent } from "../../agent-manager.js";
import type { AgentStorage } from "../../agent-storage.js";
import type { AgentMessageDelivery } from "../../agent-messages/index.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import {
  HostObservationError,
  createHostObservationResolver,
  type ToolHosts,
  type HostObservation,
} from "../../host-operations/index.js";
import { buildStoredAgentPayload } from "../../agent-projections.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { createStub } from "../../../test-utils/class-mocks.js";
import { openFinishObservation } from "./observation-stream.js";
import { createFinishObservation } from "./observation.js";

class Host implements HostObservation {
  handler?: Parameters<HostObservation["observe"]>[1];
  released = false;
  failure?: (error: unknown) => void;
  baseline = Promise.withResolvers<WaitForFinishResult>();
  async wait() {
    return this.baseline.promise;
  }
  async observe(
    _id: string,
    handler: Parameters<HostObservation["observe"]>[1],
    _signal: AbortSignal,
    onError: (error: unknown) => void,
  ) {
    this.handler = handler;
    this.failure = onError;
    return async () => {
      this.released = true;
    };
  }
  emit(status: "idle" | "running", event?: AgentStreamEvent) {
    this.handler!(
      buildStoredAgentPayload(
        {
          id: "child",
          cwd: "/tmp",
          provider: "codex",
          labels: {},
          lastStatus: status,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
        ["codex"],
        (_provider, own) => own ?? {},
      ),
      event,
      "Last response",
    );
  }
}
function permission(id: string): AgentStreamEvent {
  return {
    type: "permission_requested",
    provider: "codex",
    request: { id, provider: "codex", name: "Write", kind: "tool", input: { path: id } },
  };
}
async function scenario() {
  const host = new Host();
  const controller = new AbortController();
  const observation = await openFinishObservation(
    { use: async (_server, action) => action(host) },
    { id: "watch", callerAgentId: "parent", childAgentId: "child" },
    controller.signal,
  );
  return { host, observation, controller };
}

type ManagerEvent = Parameters<Parameters<AgentManager["subscribe"]>[0]>[0];

function createLiveAgent(updatedAt: Date): ManagedAgent {
  return {
    id: "child",
    provider: "codex",
    cwd: "/tmp/finish-observation",
    session: {} as import("../../agent-sdk-types.js").AgentSession,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    config: { provider: "codex", cwd: "/tmp/finish-observation", model: "gpt-5.4-mini" },
    lifecycle: "idle",
    createdAt: new Date("2026-11-17T09:00:00.000Z"),
    updatedAt,
    availableModes: [],
    currentModeId: null,
    pendingPermissions: new Map(),
    activeForegroundTurnId: null,
    activeTurnId: null,
    activeTurnStartedAt: null,
    foregroundTurnWaiters: new Set(),
    finalizedForegroundTurnIds: new Set(),
    unsubscribeSession: null,
    timeline: [],
    runtimeInfo: undefined,
    persistence: null,
    historyPrimed: true,
    lastUserMessageAt: null,
    attention: { requiresAttention: false },
    labels: {},
  } as ManagedAgent;
}

test("publishes an idle recovery summary after queued reads without stale callbacks", async () => {
  const stateSummary = Promise.withResolvers<AgentArchiveOperation | null>();
  const permissionSummary = Promise.withResolvers<AgentArchiveOperation | null>();
  const terminalSummary = Promise.withResolvers<AgentArchiveOperation | null>();
  const summaries = [stateSummary, permissionSummary, terminalSummary];
  let current = createLiveAgent(new Date("2026-11-17T09:00:01.000Z"));
  let listener: Parameters<AgentManager["subscribe"]>[0] | null = null;
  const getArchiveOperation = vi.fn(() => {
    const next = summaries.shift();
    if (!next) throw new Error("Unexpected archive summary lookup");
    return next.promise;
  });
  const manager = createStub<AgentManager>({
    getAgent: vi.fn(() => current),
    getArchiveOperation,
    getLastAssistantMessage: vi.fn(async () => null),
    waitForAgentEvent: vi.fn(
      (_agentId: string, options: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
        }),
    ),
    subscribe: vi.fn((handler: Parameters<AgentManager["subscribe"]>[0]) => {
      listener = handler;
      return () => undefined;
    }),
  });
  const storage = createStub<AgentStorage>({ get: vi.fn(async () => null) });
  const messages = createStub<AgentMessageDelivery>({
    waitForDispatch: vi.fn(async () => undefined),
  });
  const hosts = createStub<ToolHosts>({});
  const controller = new AbortController();
  const observation = await createFinishObservation({
    agentManager: manager,
    agentStorage: storage,
    waitForResume: async () => {},
    messages: () => messages,
    hosts: () => hosts,
    serverId: "local",
    logger: createTestLogger(),
  }).open(
    { id: "watch", callerAgentId: "parent", childAgentId: "child", serverId: "local" },
    controller.signal,
  );

  try {
    // An archive recovery is an idle-to-idle manager update, so it must not
    // depend on a fabricated turn event to get its summary projected.
    expect(getArchiveOperation).not.toHaveBeenCalled();
    listener!({ type: "agent_state", agent: current } as ManagerEvent);
    await vi.waitFor(() => expect(getArchiveOperation).toHaveBeenCalledTimes(1));
    listener!({
      type: "agent_stream",
      agentId: "child",
      event: permission("permission-1"),
    } as ManagerEvent);

    // The first read belongs to the idle summary. Before it resolves, the
    // resident agent changes and two later callbacks arrive. Every emitted
    // snapshot must use this fresh state, while callbacks retain their order.
    const latestUpdatedAt = new Date("2026-11-17T09:00:02.000Z");
    current = createLiveAgent(latestUpdatedAt);
    listener!({
      type: "agent_stream",
      agentId: "child",
      event: { type: "turn_completed", provider: "codex" },
    } as ManagerEvent);

    stateSummary.resolve({ state: "children_pending", canRetry: true });
    await vi.waitFor(() => expect(getArchiveOperation).toHaveBeenCalledTimes(2));
    permissionSummary.resolve({ state: "children_pending", canRetry: true });
    await vi.waitFor(() => expect(getArchiveOperation).toHaveBeenCalledTimes(3));
    terminalSummary.resolve({ state: "children_pending", canRetry: true });

    await expect(observation.next()).resolves.toMatchObject({
      status: "permission",
      final: {
        updatedAt: latestUpdatedAt.toISOString(),
        archiveOperation: { state: "children_pending", canRetry: true },
      },
    });
    await expect(observation.next()).resolves.toMatchObject({
      status: "idle",
      final: {
        updatedAt: latestUpdatedAt.toISOString(),
        archiveOperation: { state: "children_pending", canRetry: true },
      },
    });
  } finally {
    controller.abort();
    await observation.close();
  }
});

test("permission resolution followed by transient idle waits for resumed work to settle", async () => {
  const { host, observation } = await scenario();
  try {
    host.emit("running", permission("first"));
    expect((await observation.next()).status).toBe("permission");
    host.emit("idle", { type: "permission_resolved", provider: "codex", requestId: "first" });
    let settled = false;
    const next = observation.next().then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    host.emit("running", { type: "turn_started", provider: "codex" });
    await Promise.resolve();
    expect(settled).toBe(false);
    host.emit("idle", { type: "turn_completed", provider: "codex" });
    expect(await next).toMatchObject({ status: "idle", lastMessage: "Last response" });
  } finally {
    await observation.close();
  }
  expect(host.released).toBe(true);
});

test("second checkpoint and terminal outcome remain buffered while the first callback is pending", async () => {
  const { host, observation } = await scenario();
  try {
    host.emit("running", permission("first"));
    expect((await observation.next()).status).toBe("permission");
    // The recipient has not acknowledged the first callback; no next() is in flight.
    host.emit("running", permission("second"));
    host.emit("idle", { type: "turn_completed", provider: "codex" });
    expect((await observation.next()).final?.pendingPermissions[0]?.id).toBe("second");
    expect((await observation.next()).status).toBe("idle");
  } finally {
    await observation.close();
  }
});

test("abort releases continuous observation even with a pending initial wait", async () => {
  const { host, observation, controller } = await scenario();
  const next = observation.next();
  controller.abort();
  await expect(next).rejects.toThrow();
  await observation.close();
  expect(host.released).toBe(true);
});

test("late initial permission snapshot cannot resurrect an already resolved request", async () => {
  const { host, observation } = await scenario();
  try {
    const requestEvent = permission("resolved");
    host.emit("running", requestEvent);
    await observation.next();
    host.emit("idle", { type: "permission_resolved", provider: "codex", requestId: "resolved" });
    const final = buildStoredAgentPayload(
      {
        id: "child",
        cwd: "/tmp",
        provider: "codex",
        labels: {},
        lastStatus: "running",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
      ["codex"],
      (_provider, own) => own ?? {},
    );
    if (requestEvent.type !== "permission_requested") throw new Error("Expected permission");
    final.pendingPermissions = [requestEvent.request];
    host.baseline.resolve({ status: "permission", final, lastMessage: null, error: null });
    await host.baseline.promise;
    await Promise.resolve();
    host.emit("idle", { type: "turn_completed", provider: "codex" });
    expect((await observation.next()).status).toBe("idle");
  } finally {
    await observation.close();
  }
});

test("lookup failure uses its error channel and never fabricates a missing-child result", async () => {
  const { host, observation } = await scenario();
  try {
    host.failure!(new Error("Route disconnected"));
    await expect(observation.next()).rejects.toThrow("Route disconnected");
  } finally {
    await observation.close();
  }
});

test("a terminal event observed after newer work starts waits for that running work", async () => {
  const { host, observation } = await scenario();
  try {
    host.emit("running", { type: "turn_completed", provider: "codex" });
    let settled = false;
    const next = observation.next().then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    host.emit("idle", { type: "turn_completed", provider: "codex" });
    expect((await next).status).toBe("idle");
  } finally {
    await observation.close();
  }
});

test.each([
  { status: "connecting", reason: "connecting" },
  { status: "offline", reason: "unreachable" },
  { status: "disabled", reason: "unreachable" },
  { status: "removed", reason: "removed" },
] as const)(
  "remote observation classifies $status from the authoritative directory, ignoring arbitrary error codes",
  async ({ status, reason }) => {
    const row = {
      registrationId: "registration",
      serverId: "remote",
      label: null,
      source: { id: "owner", key: "remote" },
      metadata: {},
      enabled: status !== "disabled",
      status: status === "removed" ? ("offline" as const) : status,
      targetDescription: "Remote",
      lastOnlineAt: null,
      nextRetryAt: null,
      error: null,
    };
    const hosts: ToolHosts = {
      directory: async () => ({
        self: { serverId: "origin", label: "Origin" },
        hosts: status === "removed" ? [] : [row],
      }),
      async use() {
        throw Object.assign(new Error("Untrusted remote error"), { code: "host_unknown" });
      },
    };
    const local = new Host();
    const resolver = createHostObservationResolver({
      serverId: "origin",
      local,
      hosts: () => hosts,
    });
    const error = await resolver.use("remote", async () => {}).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(HostObservationError);
    expect(error).toMatchObject({ reason });
  },
);

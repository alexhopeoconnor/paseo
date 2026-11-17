/** @vitest-environment jsdom */
import React, { type ReactNode } from "react";
import { seedSessionHosts } from "@/test/seed-session";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import { projectAgentSnapshot } from "@/utils/agent-snapshots";
import { agentHistoryQueryKey, allAgentHistoryQueryKey } from "./agent-history-query-key";
import {
  applyArchivedAgentCloseResults,
  isArchiveReconciliationUncertain,
  isAgentArchiving,
  removeAgentFromListPayload,
  selectPendingArchiveAgentIds,
  setAgentArchiving,
  useArchiveAgent,
} from "./use-archive-agent";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

function queryClientWrapper(queryClient: QueryClient) {
  return function QueryClientWrapper({ children }: { children: ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function setTestSessionClient(client: DaemonClient): void {
  const store = useSessionStore.getState();
  // seedSessionHosts creates the session with a null client. initializeSession
  // deliberately preserves that entry, so tests must install the fake through
  // the normal client-update path.
  store.initializeSession("server-a", null);
  store.updateSessionClient("server-a", client);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function ignorePromiseRejection(): undefined {
  return undefined;
}

function observePromiseRejection(promise: Promise<unknown>): void {
  void promise.catch(ignorePromiseRejection);
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    serverId: "server-a",
    id: "agent-1",
    provider: "codex",
    status: "running",
    createdAt: new Date("2026-04-01T03:00:00.000Z"),
    updatedAt: new Date("2026-04-01T03:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-04-01T03:00:00.000Z"),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: "Agent 1",
    cwd: "/repo",
    model: null,
    parentAgentId: null,
    labels: {},
    archivedAt: null,
    ...overrides,
    turn: overrides.turn ?? { phase: "idle", cancellationRequestId: null },
  };
}

describe("useArchiveAgent", () => {
  afterEach(() => seedSessionHosts([]));
  beforeEach(() => {
    useSessionStore.setState((state) => ({ ...state, sessions: {} }));
    seedSessionHosts(["server-a"]);
  });

  it("tracks pending archive state in shared react-query cache", () => {
    const queryClient = new QueryClient();

    expect(
      isAgentArchiving({
        queryClient,
        serverId: "server-a",
        agentId: "agent-1",
      }),
    ).toBe(false);

    setAgentArchiving({
      queryClient,
      serverId: "server-a",
      agentId: "agent-1",
      isArchiving: true,
    });

    expect(
      isAgentArchiving({
        queryClient,
        serverId: "server-a",
        agentId: "agent-1",
      }),
    ).toBe(true);
    expect(
      isAgentArchiving({
        queryClient,
        serverId: "server-a",
        agentId: "agent-2",
      }),
    ).toBe(false);

    setAgentArchiving({
      queryClient,
      serverId: "server-a",
      agentId: "agent-1",
      isArchiving: false,
    });

    expect(
      isAgentArchiving({
        queryClient,
        serverId: "server-a",
        agentId: "agent-1",
      }),
    ).toBe(false);
  });

  it("selects pending archive ids for a single server", () => {
    const pendingIds = selectPendingArchiveAgentIds(
      {
        "server-a:agent-1": true,
        "server-a:agent-2": true,
        "server-b:agent-3": true,
      },
      "server-a",
    );

    expect(Array.from(pendingIds)).toEqual(["agent-1", "agent-2"]);
  });

  it("removes an archived agent from cached list payloads", () => {
    const payload = {
      entries: [{ agent: { id: "agent-1" } }, { agent: { id: "agent-2" } }],
      pageInfo: { hasMore: false },
    };

    const next = removeAgentFromListPayload(payload, "agent-1");

    expect(next.entries).toEqual([{ agent: { id: "agent-2" } }]);
    expect(next.pageInfo).toEqual({ hasMore: false });
  });

  it("applies archived agent close results to session state and cached lists", async () => {
    const queryClient = new QueryClient();
    useSessionStore.getState().initializeSession("server-a", {} as DaemonClient);
    useSessionStore.getState().setAgents("server-a", new Map([["agent-1", makeAgent()]]));
    queryClient.setQueryData(["sidebarAgentsList", "server-a"], {
      entries: [{ agent: { id: "agent-1" } }, { agent: { id: "agent-2" } }],
    });
    queryClient.setQueryData(["allAgents", "server-a"], {
      entries: [{ agent: { id: "agent-1" } }, { agent: { id: "agent-2" } }],
    });
    queryClient.setQueryData(agentHistoryQueryKey("server-a"), {
      pages: [
        {
          agents: [
            { id: "agent-1", archivedAt: null },
            { id: "agent-2", archivedAt: null },
          ],
        },
      ],
      pageParams: [null],
    });
    queryClient.setQueryData(allAgentHistoryQueryKey(["server-a", "server-b"]), {
      pages: [
        {
          agents: [
            { id: "agent-1", serverId: "server-a", archivedAt: null },
            { id: "agent-1", serverId: "server-b", archivedAt: null },
          ],
        },
      ],
      pageParams: [null],
    });

    applyArchivedAgentCloseResults({
      queryClient,
      serverId: "server-a",
      results: [{ agentId: "agent-1", archivedAt: "2026-04-01T04:00:00.000Z" }],
    });

    expect(
      useSessionStore
        .getState()
        .sessions["server-a"]?.agents.get("agent-1")
        ?.archivedAt?.toISOString(),
    ).toBe("2026-04-01T04:00:00.000Z");
    expect(queryClient.getQueryData(["sidebarAgentsList", "server-a"])).toEqual({
      entries: [{ agent: { id: "agent-2" } }],
    });
    expect(queryClient.getQueryData(["allAgents", "server-a"])).toEqual({
      entries: [{ agent: { id: "agent-2" } }],
    });
    expect(queryClient.getQueryData(agentHistoryQueryKey("server-a"))).toEqual({
      pages: [
        {
          agents: [
            { id: "agent-1", archivedAt: new Date("2026-04-01T04:00:00.000Z") },
            { id: "agent-2", archivedAt: null },
          ],
        },
      ],
      pageParams: [null],
    });
    expect(
      queryClient.getQueryState(allAgentHistoryQueryKey(["server-a", "server-b"]))?.isInvalidated,
    ).toBe(true);
    expect(queryClient.getQueryData(allAgentHistoryQueryKey(["server-a", "server-b"]))).toEqual({
      pages: [
        {
          agents: [
            {
              id: "agent-1",
              serverId: "server-a",
              archivedAt: new Date("2026-04-01T04:00:00.000Z"),
            },
            { id: "agent-1", serverId: "server-b", archivedAt: null },
          ],
        },
      ],
      pageParams: [null],
    });
  });

  it("can apply archived agent close results without invalidating cached lists", () => {
    const queryClient = new QueryClient();
    useSessionStore.getState().initializeSession("server-a", {} as DaemonClient);
    useSessionStore.getState().setAgents("server-a", new Map([["agent-1", makeAgent()]]));
    queryClient.setQueryData(["sidebarAgentsList", "server-a"], {
      entries: [{ agent: { id: "agent-1" } }, { agent: { id: "agent-2" } }],
    });
    queryClient.setQueryData(["allAgents", "server-a"], {
      entries: [{ agent: { id: "agent-1" } }, { agent: { id: "agent-2" } }],
    });
    queryClient.setQueryData(agentHistoryQueryKey("server-a"), {
      pages: [
        {
          agents: [{ id: "agent-1", archivedAt: null }],
        },
      ],
      pageParams: [null],
    });
    queryClient.setQueryData(allAgentHistoryQueryKey(["server-a"]), {
      pages: [{ agents: [{ id: "agent-1", serverId: "server-a", archivedAt: null }] }],
      pageParams: [null],
    });

    applyArchivedAgentCloseResults({
      queryClient,
      serverId: "server-a",
      results: [{ agentId: "agent-1", archivedAt: "2026-04-01T04:00:00.000Z" }],
      invalidateQueries: false,
    });

    expect(queryClient.getQueryState(["sidebarAgentsList", "server-a"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["allAgents", "server-a"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(agentHistoryQueryKey("server-a"))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(allAgentHistoryQueryKey(["server-a"]))?.isInvalidated).toBe(
      false,
    );
    expect(queryClient.getQueryData(agentHistoryQueryKey("server-a"))).toEqual({
      pages: [
        {
          agents: [{ id: "agent-1", archivedAt: new Date("2026-04-01T04:00:00.000Z") }],
        },
      ],
      pageParams: [null],
    });
    expect(queryClient.getQueryData(allAgentHistoryQueryKey(["server-a"]))).toEqual({
      pages: [
        {
          agents: [
            {
              id: "agent-1",
              serverId: "server-a",
              archivedAt: new Date("2026-04-01T04:00:00.000Z"),
            },
          ],
        },
      ],
      pageParams: [null],
    });
  });

  it("keeps a fresh recovery update and list order when archive rejects", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const request = deferred<{ archivedAt: string }>();
    const archiveAgent = vi.fn(() => request.promise);
    const reconciledAgent = makeAgent({
      updatedAt: new Date("2026-04-01T03:01:00.000Z"),
      lastActivityAt: new Date("2026-04-01T03:01:00.000Z"),
      archiveOperation: { state: "children_pending", canRetry: true },
    });
    const fetchAgent = vi.fn(async () => ({
      agent: projectAgentSnapshot(reconciledAgent),
      project: null,
    }));
    setTestSessionClient({ archiveAgent, fetchAgent } as unknown as DaemonClient);
    useSessionStore.getState().setAgents("server-a", new Map([["agent-1", makeAgent()]]));
    queryClient.setQueryData(["sidebarAgentsList", "server-a"], {
      entries: [{ agent: { id: "agent-1" } }, { agent: { id: "agent-2" } }],
    });

    const { result } = renderHook(() => useArchiveAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });
    let pendingArchive!: Promise<void>;
    await act(async () => {
      pendingArchive = result.current.archiveAgent({ serverId: "server-a", agentId: "agent-1" });
      observePromiseRejection(pendingArchive);
      await Promise.resolve();
    });

    expect(useSessionStore.getState().sessions["server-a"]?.agents.get("agent-1")?.archivedAt).toBe(
      null,
    );
    expect(queryClient.getQueryData(["sidebarAgentsList", "server-a"])).toEqual({
      entries: [{ agent: { id: "agent-1" } }, { agent: { id: "agent-2" } }],
    });

    // This is the authoritative update which races with the failed RPC. The
    // mutation must not restore its old snapshot over this recovery state.
    useSessionStore.getState().setAgents(
      "server-a",
      new Map([
        [
          "agent-1",
          makeAgent({
            archiveOperation: { state: "children_pending", canRetry: true },
          }),
        ],
      ]),
    );
    queryClient.setQueryData(["sidebarAgentsList", "server-a"], {
      entries: [{ agent: { id: "agent-2" } }, { agent: { id: "agent-1" } }],
    });

    await act(async () => {
      request.reject(new Error("Child archive did not settle"));
      await expect(pendingArchive).rejects.toThrow("Child archive did not settle");
    });

    expect(useSessionStore.getState().sessions["server-a"]?.agents.get("agent-1")).toMatchObject({
      archivedAt: null,
      archiveOperation: { state: "children_pending", canRetry: true },
    });
    expect(queryClient.getQueryData(["sidebarAgentsList", "server-a"])).toEqual({
      entries: [{ agent: { id: "agent-2" } }, { agent: { id: "agent-1" } }],
    });
    expect(fetchAgent).toHaveBeenCalledWith({ agentId: "agent-1", timeout: 5_000 });
    expect(result.current.isArchivingAgent({ serverId: "server-a", agentId: "agent-1" })).toBe(
      false,
    );
    expect(
      isArchiveReconciliationUncertain({
        queryClient,
        serverId: "server-a",
        agentId: "agent-1",
      }),
    ).toBe(false);
  });

  it("reconciles a confirmed archive into a details-only pane without a directory update", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const archivedAt = "2026-04-01T03:03:00.000Z";
    const archiveAgent = vi.fn(async () => ({ archivedAt }));
    const fetchAgent = vi.fn(async () => {
      throw new Error("Status refresh unavailable");
    });
    setTestSessionClient({ archiveAgent, fetchAgent } as unknown as DaemonClient);
    useSessionStore.getState().setAgents("server-a", new Map());
    useSessionStore
      .getState()
      .setAgentDetails(
        "server-a",
        new Map([
          [
            "agent-1",
            makeAgent({ archiveOperation: { state: "children_pending", canRetry: true } }),
          ],
        ]),
      );
    queryClient.setQueryData(["sidebarAgentsList", "server-a"], {
      entries: [{ agent: { id: "agent-1" } }, { agent: { id: "agent-2" } }],
    });
    queryClient.setQueryData(agentHistoryQueryKey("server-a"), {
      pages: [{ agents: [{ id: "agent-1", archivedAt: null }] }],
      pageParams: [null],
    });

    const { result } = renderHook(() => useArchiveAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });

    await act(async () => {
      await result.current.archiveAgent({ serverId: "server-a", agentId: "agent-1" });
    });

    expect(archiveAgent).toHaveBeenCalledWith("agent-1");
    expect(fetchAgent).toHaveBeenCalledWith({ agentId: "agent-1", timeout: 5_000 });
    expect(
      useSessionStore
        .getState()
        .sessions["server-a"]?.agentDetails.get("agent-1")
        ?.archivedAt?.toISOString(),
    ).toBe(archivedAt);
    expect(
      useSessionStore.getState().sessions["server-a"]?.agentDetails.get("agent-1")
        ?.archiveOperation,
    ).toBeNull();
    expect(queryClient.getQueryData(["sidebarAgentsList", "server-a"])).toEqual({
      entries: [{ agent: { id: "agent-2" } }],
    });
    expect(queryClient.getQueryData(agentHistoryQueryKey("server-a"))).toEqual({
      pages: [{ agents: [{ id: "agent-1", archivedAt: new Date(archivedAt) }] }],
      pageParams: [null],
    });
    expect(result.current.isArchivingAgent({ serverId: "server-a", agentId: "agent-1" })).toBe(
      false,
    );
  });

  it("does not replace a newer directory state with a delayed archive reply", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const request = deferred<{ archivedAt: string }>();
    const archiveAgent = vi.fn(() => request.promise);
    const fetchAgent = vi.fn(async () => {
      throw new Error("Status refresh unavailable");
    });
    setTestSessionClient({ archiveAgent, fetchAgent } as unknown as DaemonClient);
    const original = makeAgent();
    useSessionStore.getState().setAgents("server-a", new Map([["agent-1", original]]));
    queryClient.setQueryData(["sidebarAgentsList", "server-a"], {
      entries: [{ agent: { id: "agent-1" } }, { agent: { id: "agent-2" } }],
    });
    queryClient.setQueryData(agentHistoryQueryKey("server-a"), {
      pages: [{ agents: [{ id: "agent-1", archivedAt: null }] }],
      pageParams: [null],
    });

    const { result } = renderHook(() => useArchiveAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });
    let pendingArchive!: Promise<void>;
    await act(async () => {
      pendingArchive = result.current.archiveAgent({ serverId: "server-a", agentId: "agent-1" });
      observePromiseRejection(pendingArchive);
      await Promise.resolve();
    });

    const newer = makeAgent({
      updatedAt: new Date("2026-04-01T03:05:00.000Z"),
      lastActivityAt: new Date("2026-04-01T03:05:00.000Z"),
      archiveOperation: { state: "children_pending", canRetry: true },
    });
    useSessionStore.getState().setAgents("server-a", new Map([["agent-1", newer]]));

    await act(async () => {
      request.resolve({ archivedAt: "2026-04-01T03:03:00.000Z" });
      await pendingArchive;
    });

    expect(useSessionStore.getState().sessions["server-a"]?.agents.get("agent-1")).toBe(newer);
    expect(queryClient.getQueryData(["sidebarAgentsList", "server-a"])).toEqual({
      entries: [{ agent: { id: "agent-1" } }, { agent: { id: "agent-2" } }],
    });
    expect(queryClient.getQueryData(agentHistoryQueryKey("server-a"))).toEqual({
      pages: [{ agents: [{ id: "agent-1", archivedAt: null }] }],
      pageParams: [null],
    });
  });

  it("keeps the conversation uncertain until an explicit archive-status refresh succeeds", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const archiveAgent = vi.fn(async () => {
      throw new Error("Archive transport dropped");
    });
    const fetchAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error("Status transport dropped"))
      .mockResolvedValueOnce({
        agent: projectAgentSnapshot(
          makeAgent({
            updatedAt: new Date("2026-04-01T03:02:00.000Z"),
            lastActivityAt: new Date("2026-04-01T03:02:00.000Z"),
            archiveOperation: { state: "unresolved", canRetry: true },
          }),
        ),
        project: null,
      });
    setTestSessionClient({ archiveAgent, fetchAgent } as unknown as DaemonClient);
    useSessionStore.getState().setAgents("server-a", new Map([["agent-1", makeAgent()]]));

    const { result } = renderHook(() => useArchiveAgent(), {
      wrapper: queryClientWrapper(queryClient),
    });

    await act(async () => {
      await expect(
        result.current.archiveAgent({ serverId: "server-a", agentId: "agent-1" }),
      ).rejects.toThrow("Archive transport dropped");
    });

    expect(result.current.isArchivingAgent({ serverId: "server-a", agentId: "agent-1" })).toBe(
      false,
    );
    expect(
      result.current.isArchiveReconciliationUncertain({ serverId: "server-a", agentId: "agent-1" }),
    ).toBe(true);

    await act(async () => {
      await result.current.refreshArchiveStatus({ serverId: "server-a", agentId: "agent-1" });
    });

    expect(
      result.current.isArchiveReconciliationUncertain({ serverId: "server-a", agentId: "agent-1" }),
    ).toBe(false);
    expect(useSessionStore.getState().sessions["server-a"]?.agents.get("agent-1")).toMatchObject({
      archiveOperation: { state: "unresolved", canRetry: true },
    });
  });
});

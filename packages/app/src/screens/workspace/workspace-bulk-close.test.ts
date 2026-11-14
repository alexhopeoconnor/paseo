import { describe, expect, it, vi } from "vitest";
import {
  buildBulkCloseConfirmationMessage,
  classifyBulkClosableTabs,
  closeBulkWorkspaceTabs,
} from "@/screens/workspace/workspace-bulk-close";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

function makeAgentTab(id: string): WorkspaceTabDescriptor {
  return {
    key: `agent_${id}`,
    tabId: `agent_${id}`,
    kind: "agent",
    target: { kind: "agent", agentId: id },
  };
}

function makeTerminalTab(id: string): WorkspaceTabDescriptor {
  return {
    key: `terminal_${id}`,
    tabId: `terminal_${id}`,
    kind: "terminal",
    target: { kind: "terminal", terminalId: id },
  };
}

function makeFileTab(path: string): WorkspaceTabDescriptor {
  return {
    key: `file_${path}`,
    tabId: `file_${path}`,
    kind: "file",
    target: { kind: "file", path },
  };
}

describe("workspace bulk close helpers", () => {
  it("classifies agent, terminal, and passive tabs for shared bulk close handling", () => {
    const groups = classifyBulkClosableTabs([
      makeAgentTab("a1"),
      makeTerminalTab("t1"),
      makeFileTab("/repo/README.md"),
    ]);

    expect(groups).toEqual({
      archiveAgentTabs: [{ tabId: "agent_a1", agentId: "a1" }],
      layoutOnlyAgentTabs: [],
      terminalTabs: [{ tabId: "terminal_t1", terminalId: "t1" }],
      otherTabs: [
        {
          tabId: "file_/repo/README.md",
          target: { kind: "file", path: "/repo/README.md" },
        },
      ],
    });
  });

  it("separates subagent tabs from agents that archive on close", () => {
    const groups = classifyBulkClosableTabs(
      [makeAgentTab("root"), makeAgentTab("child")],
      (agentId) => (agentId === "child" ? "layout-only" : "archive"),
    );

    expect(groups).toMatchObject({
      archiveAgentTabs: [{ tabId: "agent_root", agentId: "root" }],
      layoutOnlyAgentTabs: [{ tabId: "agent_child", agentId: "child" }],
    });
    expect(buildBulkCloseConfirmationMessage(groups)).toBe(
      "This will archive 1 agent(s) and close 1 tab(s).",
    );
  });

  it("describes mixed destructive bulk close operations in the confirmation copy", () => {
    const message = buildBulkCloseConfirmationMessage(
      classifyBulkClosableTabs([
        makeAgentTab("a1"),
        makeAgentTab("a2"),
        makeTerminalTab("t1"),
        makeFileTab("/repo/README.md"),
      ]),
    );

    expect(message).toBe(
      "This will archive 2 agent(s), close 1 terminal(s), and close 1 tab(s). Any running process in a closed terminal will be stopped immediately.",
    );
  });

  it("keeps terminal-only confirmations explicit about stopping running processes", () => {
    const message = buildBulkCloseConfirmationMessage(
      classifyBulkClosableTabs([makeTerminalTab("t1")]),
    );

    expect(message).toBe(
      "This will close 1 terminal(s). Any running process in a closed terminal will be stopped immediately.",
    );
  });

  it("waits for closeItems confirmation before closing any tab", async () => {
    const groups = classifyBulkClosableTabs([
      makeAgentTab("a1"),
      makeTerminalTab("t1"),
      makeTerminalTab("t2"),
      makeFileTab("/repo/README.md"),
    ]);
    let resolveCloseItems!: (value: {
      agents: { agentId: string; archivedAt: string }[];
      terminals: { terminalId: string; success: boolean }[];
      requestId: string;
    }) => void;
    const closeItems = vi.fn(
      () =>
        new Promise<{
          agents: { agentId: string; archivedAt: string }[];
          terminals: { terminalId: string; success: boolean }[];
          requestId: string;
        }>((resolve) => {
          resolveCloseItems = resolve;
        }),
    );
    const closedTabIds: string[] = [];
    const cleanupCalls: Array<{ tabId: string; target?: WorkspaceTabDescriptor["target"] }> = [];

    const operation = closeBulkWorkspaceTabs({
      groups,
      client: { closeItems },
      closeTab: async (tabId, action) => {
        closedTabIds.push(tabId);
        await action();
      },
      closeWorkspaceTabWithCleanup: (input) => {
        cleanupCalls.push(input);
      },
      closeLayoutOnlyAgent: async () => {},
      logLabel: "all tabs",
    });

    await Promise.resolve();
    expect(closedTabIds).toEqual([]);
    expect(cleanupCalls).toEqual([]);

    resolveCloseItems({
      agents: [{ agentId: "a1", archivedAt: "2026-04-01T04:00:00.000Z" }],
      terminals: [
        { terminalId: "t1", success: true },
        { terminalId: "t2", success: true },
      ],
      requestId: "req-1",
    });
    const result = await operation;

    expect(result).toEqual({
      failedAgentIds: [],
      failedTerminalIds: [],
      failedLayoutOnlyAgentIds: [],
      error: null,
    });
    expect(closedTabIds).toEqual([
      "agent_a1",
      "terminal_t1",
      "terminal_t2",
      "file_/repo/README.md",
    ]);
  });

  it("keeps destructive tabs visible when closeItems rejects", async () => {
    const groups = classifyBulkClosableTabs([
      makeAgentTab("a1"),
      makeTerminalTab("t1"),
      makeFileTab("/repo/README.md"),
    ]);
    const closedTabIds: string[] = [];
    const cleanupCalls: Array<{ tabId: string; target?: WorkspaceTabDescriptor["target"] }> = [];
    const warn = vi.fn();

    const result = await closeBulkWorkspaceTabs({
      groups,
      client: {
        closeItems: async () => {
          throw new Error("rpc failed");
        },
      },
      closeTab: async (tabId, action) => {
        closedTabIds.push(tabId);
        await action();
      },
      closeWorkspaceTabWithCleanup: (input) => {
        cleanupCalls.push(input);
      },
      closeLayoutOnlyAgent: async () => {},
      warn,
      logLabel: "others",
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.failedAgentIds).toEqual(["a1"]);
    expect(result.failedTerminalIds).toEqual(["t1"]);
    expect(closedTabIds).toEqual(["file_/repo/README.md"]);
    expect(cleanupCalls).toEqual([
      { tabId: "file_/repo/README.md", target: { kind: "file", path: "/repo/README.md" } },
    ]);
  });

  it("closes only per-item confirmed successes and keeps failed ids retryable", async () => {
    const groups = classifyBulkClosableTabs([
      makeAgentTab("a1"),
      makeAgentTab("a2"),
      makeTerminalTab("t1"),
      makeTerminalTab("t2"),
      makeFileTab("/repo/README.md"),
    ]);
    const closedTabIds: string[] = [];
    const cleanupCalls: Array<{ tabId: string; target?: WorkspaceTabDescriptor["target"] }> = [];

    const result = await closeBulkWorkspaceTabs({
      groups,
      client: {
        closeItems: async () => ({
          agents: [{ agentId: "a1", archivedAt: "2026-04-01T04:00:00.000Z" }],
          terminals: [
            { terminalId: "t1", success: true },
            { terminalId: "t2", success: false },
          ],
          requestId: "req-1",
        }),
      },
      closeTab: async (tabId, action) => {
        closedTabIds.push(tabId);
        await action();
      },
      closeWorkspaceTabWithCleanup: (input) => {
        cleanupCalls.push(input);
      },
      closeLayoutOnlyAgent: async () => {},
      logLabel: "all tabs",
    });

    expect(result.failedAgentIds).toEqual(["a2"]);
    expect(result.failedTerminalIds).toEqual(["t2"]);
    expect(closedTabIds).toEqual(["agent_a1", "terminal_t1", "file_/repo/README.md"]);
    expect(cleanupCalls).toEqual([
      { tabId: "agent_a1", target: { kind: "agent", agentId: "a1" } },
      { tabId: "terminal_t1", target: { kind: "terminal", terminalId: "t1" } },
      { tabId: "file_/repo/README.md", target: { kind: "file", path: "/repo/README.md" } },
    ]);
  });

  it("closes subagent tabs without sending them to closeItems", async () => {
    const groups = classifyBulkClosableTabs(
      [makeAgentTab("root"), makeAgentTab("child")],
      (agentId) => (agentId === "child" ? "layout-only" : "archive"),
    );
    const closeItems = vi.fn(async () => ({
      agents: [{ agentId: "root", archivedAt: "2026-04-01T04:00:00.000Z" }],
      terminals: [],
      requestId: "req-1",
    }));
    const preparedSubagents: string[] = [];
    const cleanedTabs: string[] = [];

    await closeBulkWorkspaceTabs({
      groups,
      client: { closeItems },
      closeTab: async (_tabId, action) => action(),
      closeLayoutOnlyAgent: async (agentId) => {
        preparedSubagents.push(agentId);
      },
      closeWorkspaceTabWithCleanup: ({ tabId }) => {
        cleanedTabs.push(tabId);
      },
      logLabel: "others",
    });

    expect(closeItems).toHaveBeenCalledWith({ agentIds: ["root"], terminalIds: [] });
    expect(preparedSubagents).toEqual(["child"]);
    expect(cleanedTabs).toEqual(["agent_child", "agent_root"]);
  });

  it("keeps a layout-only subagent tab when its server update fails", async () => {
    const groups = classifyBulkClosableTabs([makeAgentTab("child")], () => "layout-only");
    const closedTabIds: string[] = [];
    const warn = vi.fn();

    const result = await closeBulkWorkspaceTabs({
      groups,
      client: null,
      closeTab: async (tabId, action) => {
        closedTabIds.push(tabId);
        await action();
      },
      closeLayoutOnlyAgent: async () => {
        throw new Error("update failed");
      },
      closeWorkspaceTabWithCleanup: () => {
        throw new Error("must not remove a failed layout-only tab");
      },
      warn,
      logLabel: "subagent",
    });

    expect(closedTabIds).toEqual(["agent_child"]);
    expect(result.failedLayoutOnlyAgentIds).toEqual(["child"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

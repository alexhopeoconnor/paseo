import { beforeEach, describe, expect, it } from "vitest";
import {
  openWorkspaceFileFromExplorer,
  resolveFileOpenSourceForParentTab,
  resolveFileOpenSourceForPreferredTarget,
} from "./workspace-file-open-command";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { usePanelStore } from "@/stores/panel-store";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import type { WorkspaceTab, WorkspaceTabTarget } from "@/workspace-tabs/model";

const workspaceKey = "server:workspace";
function openFile(filePath: string, persistenceKey: string | null = workspaceKey) {
  openWorkspaceFileFromExplorer({
    filePath,
    persistenceKey,
    openWorkspaceTabInFocusedPane: (key, target, placement) =>
      useWorkspaceLayoutStore
        .getState()
        .openTab({ workspaceKey: key, target, placement, intent: "reveal" }),
    revealWorkspaceTab,
  });
}
beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutMode: "compact",
    layoutByWorkspace: {},
    sheetsByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
  });
  usePanelStore.getState().showMobileFileExplorer();
});
describe("file search destination", () => {
  it("preserves Explorer under a new file sheet", () => {
    openFile("new.ts");
    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
    expect(useWorkspaceLayoutStore.getState().sheetsByWorkspace[workspaceKey]).toHaveLength(1);
  });
  it.each([null, workspaceKey])("preserves context when no file opens (%s)", (key) => {
    openFile("", key);
    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
  });
  it("reveals an existing main tab", () => {
    const store = useWorkspaceLayoutStore.getState();
    store.setLayoutMode("split-panes");
    store.openTab({
      workspaceKey,
      target: { kind: "file", path: "existing.ts" },
      intent: "reveal",
    });
    store.setLayoutMode("compact");
    openFile("existing.ts");
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
  });
  it("reveals the existing Explorer tab from the left sidebar", () => {
    const store = useWorkspaceLayoutStore.getState();
    const paneId = store.showExplorerSidebar(workspaceKey)!;
    store.openTab({
      workspaceKey,
      target: { kind: "file", path: "existing.ts" },
      intent: "reveal",
      placement: { mode: "pane", paneId },
    });
    usePanelStore.getState().showMobileAgentList();
    openFile("existing.ts");
    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
  });
});

describe("file-open source provenance", () => {
  function tab(tabId: string, target: WorkspaceTabTarget): WorkspaceTab {
    return { tabId, target, createdAt: 0 };
  }

  it.each([
    ["agent", { kind: "agent", agentId: "a" }, "chat"],
    ["draft", { kind: "draft", draftId: "d" }, "chat"],
    [
      "provider subagent",
      { kind: "provider_subagent", parentAgentId: "p", subagentId: "s" },
      "chat",
    ],
    ["files", { kind: "files" }, "explorer"],
    ["terminal", { kind: "terminal", terminalId: "t" }, "editor"],
    ["working diff", { kind: "working_diff" }, "editor"],
    ["commit diff", { kind: "commit_diff", sha: "abc" }, "editor"],
  ] as const)("maps a %s parent tab", (_label, target, expected) => {
    expect(
      resolveFileOpenSourceForParentTab({
        parentTabId: "parent",
        tabs: [tab("parent", target)],
      }),
    ).toBe(expected);
  });

  it("maps a missing parent to plugin and preferred sources to their pane semantics", () => {
    expect(resolveFileOpenSourceForParentTab({ parentTabId: null, tabs: [] })).toBe("plugin");
    expect(resolveFileOpenSourceForParentTab({ parentTabId: "missing", tabs: [] })).toBe("plugin");
    expect(resolveFileOpenSourceForPreferredTarget("explorerFiles")).toBe("explorer");
    expect(resolveFileOpenSourceForPreferredTarget("chatFiles")).toBe("chat");
    expect(resolveFileOpenSourceForPreferredTarget("diffs")).toBe("editor");
    expect(resolveFileOpenSourceForPreferredTarget("diffFiles")).toBe("editor");
    expect(resolveFileOpenSourceForPreferredTarget("subagents")).toBe("plugin");
  });
});

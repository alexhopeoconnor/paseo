import { beforeEach, describe, expect, it } from "vitest";
import type { ActiveFileOpenRequest } from "@/workspace/file-open/requests";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { resolveFileOpenPanelPlacement } from "./placement";

const workspaceKey = "server:workspace";
const target: WorkspaceTabTarget = {
  kind: "plugin",
  pluginId: "codium",
  panelId: "editor",
  context: "workspace",
};

function request(disposition: ActiveFileOpenRequest["disposition"]): ActiveFileOpenRequest {
  return {
    requestId: "request-1",
    hostId: "server",
    workspaceId: "workspace",
    path: "src/index.ts",
    disposition,
    source: "editor",
    signal: new AbortController().signal,
  };
}

beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutMode: "split-panes",
    layoutByWorkspace: {},
    sheetsByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    pendingOpenByWorkspace: {},
  });
});

describe("request-bound plugin panel placement", () => {
  it("reveals an existing editor panel in place instead of moving it to the side pane", () => {
    const store = useWorkspaceLayoutStore.getState();
    const tabId = store.openTab({
      workspaceKey,
      target,
      intent: "reveal",
    })!;
    const before = store.getTabDestination(workspaceKey, tabId);
    const placement = resolveFileOpenPanelPlacement({
      request: request("side"),
      target,
    });

    // The editor is already open; do not create an empty side pane just to reveal it again.
    expect(placement).toBeUndefined();
    expect(store.sidePaneIdByWorkspace[workspaceKey]).toBeUndefined();
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey,
      target,
      intent: "reveal",
      placement,
    });

    expect(useWorkspaceLayoutStore.getState().getTabDestination(workspaceKey, tabId)).toEqual(
      before,
    );
    expect(
      useWorkspaceLayoutStore
        .getState()
        .getWorkspaceTabs(workspaceKey)
        .filter((tab) => tab.target.kind === "plugin" && tab.target.panelId === "editor"),
    ).toHaveLength(1);
  });

  it("opens a new side-disposition panel in the side pane", () => {
    const placement = resolveFileOpenPanelPlacement({
      request: request("side"),
      target,
    });
    const store = useWorkspaceLayoutStore.getState();
    expect(placement).toEqual({
      mode: "prefer",
      paneId: store.sidePaneIdByWorkspace[workspaceKey],
    });
    const tabId = store.openTab({
      workspaceKey,
      target,
      intent: "reveal",
      placement,
    })!;
    expect(store.getTabDestination(workspaceKey, tabId)).toMatchObject({
      kind: "pane",
      paneId: store.sidePaneIdByWorkspace[workspaceKey],
    });
  });

  it.each(["main", "preferred"] as const)(
    "opens a new %s-disposition panel in the main pane while another pane is focused",
    (disposition) => {
      const store = useWorkspaceLayoutStore.getState();
      const sidePaneId = store.ensureSidePane(workspaceKey);
      expect(sidePaneId).toBeTruthy();
      store.focusPane(workspaceKey, sidePaneId!);
      const placement = resolveFileOpenPanelPlacement({
        request: request(disposition),
        target,
      });
      expect(placement).toEqual({ mode: "prefer", paneId: expect.any(String) });
      const tabId = useWorkspaceLayoutStore.getState().openTab({
        workspaceKey,
        target,
        intent: "reveal",
        placement,
      })!;
      const destination = useWorkspaceLayoutStore.getState().getTabDestination(workspaceKey, tabId);
      expect(destination).toMatchObject({ kind: "pane" });
      expect((destination as { paneId: string }).paneId).not.toBe(sidePaneId);
    },
  );
});

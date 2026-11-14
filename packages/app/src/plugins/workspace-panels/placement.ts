import type { ActiveFileOpenRequest } from "@/workspace/file-open/requests";
import {
  collectAllPanes,
  collectAllTabs,
  DEFAULT_PANE_ID,
  useWorkspaceLayoutStore,
  type WorkspaceTabPlacement,
} from "@/stores/workspace-layout-store";
import { workspaceTabTargetsEqual } from "@/workspace-tabs/identity";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

function mainPaneId(
  workspaceKey: string,
  explorerSidebarPaneId: string | null | undefined,
  sidePaneId: string | null | undefined,
): string | null {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  if (!layout) return null;
  const panes = collectAllPanes(layout.root).filter((pane) => pane.hidden !== true);
  return (
    panes.find((pane) => pane.id === DEFAULT_PANE_ID)?.id ??
    panes.find((pane) => pane.id !== explorerSidebarPaneId && pane.id !== sidePaneId)?.id ??
    null
  );
}

/**
 * The destination a confirmed file open gives a plugin panel. `prefer` is deliberate: an editor
 * panel that already exists elsewhere stays where the user placed it instead of being moved.
 * A main or preferred disposition opens a new panel in the workspace's main pane even when
 * another pane has focus. Plugin panels have no source-specific side preference, so `preferred`
 * resolves to main.
 */
export function resolveFileOpenPanelPlacement(input: {
  request: ActiveFileOpenRequest;
  target: WorkspaceTabTarget;
}): WorkspaceTabPlacement | undefined {
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: input.request.hostId,
    workspaceId: input.request.workspaceId,
  });
  if (!workspaceKey) return undefined;
  const store = useWorkspaceLayoutStore.getState();
  const layout = store.layoutByWorkspace[workspaceKey];
  const exists =
    layout !== undefined &&
    collectAllTabs(layout.root).some((tab) => workspaceTabTargetsEqual(tab.target, input.target));
  if (exists) return undefined;
  if (input.request.disposition === "side") {
    const paneId = store.ensureSidePane(workspaceKey);
    return paneId ? { mode: "prefer", paneId } : undefined;
  }
  const paneId = mainPaneId(
    workspaceKey,
    store.explorerSidebarPaneIdByWorkspace[workspaceKey],
    store.sidePaneIdByWorkspace[workspaceKey],
  );
  return paneId ? { mode: "prefer", paneId } : undefined;
}

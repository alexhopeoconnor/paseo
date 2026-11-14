import type { PluginFileOpenSource } from "@getpaseo/plugin/client";
import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
  type WorkspaceFileLocation,
  type WorkspaceFileOpenRequest,
} from "@/workspace/file-open";
import {
  FOCUSED_PANE_PLACEMENT,
  type WorkspaceTabPlacement,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTab, WorkspaceTabTarget } from "@/workspace-tabs/model";

export function resolveFileOpenSourceForParentTab(input: {
  parentTabId: string | null;
  tabs: readonly WorkspaceTab[];
}): PluginFileOpenSource {
  if (!input.parentTabId) return "plugin";
  const kind = input.tabs.find((tab) => tab.tabId === input.parentTabId)?.target.kind;
  switch (kind) {
    case "agent":
    case "draft":
    case "provider_subagent":
      return "chat";
    case "files":
      return "explorer";
    case "working_diff":
    case "commit_diff":
    case "terminal":
      return "editor";
    default:
      return "plugin";
  }
}

/** A semantic pane open keeps the source that chose its main/side destination. */
export function resolveFileOpenSourceForPreferredTarget(source: string): PluginFileOpenSource {
  switch (source) {
    case "explorerFiles":
      return "explorer";
    case "chatFiles":
      return "chat";
    case "diffs":
    case "diffFiles":
      return "editor";
    default:
      return "plugin";
  }
}

interface OpenWorkspaceFileFromExplorerInput {
  filePath: string;
  persistenceKey: string | null;
  /** Where the open came from. Omitted callers keep the host default (`plugin`). */
  source?: PluginFileOpenSource;
  openWorkspaceTabInFocusedPane: (
    workspaceKey: string,
    target: WorkspaceTabTarget,
    placement?: WorkspaceTabPlacement,
    source?: PluginFileOpenSource,
  ) => string | null;
  revealWorkspaceTab: (workspaceKey: string, tabId: string) => void;
}

/** A pending file open keeps its provenance into the confirmed dispatcher. */
export function createPendingFileOpenRequest(input: {
  location: WorkspaceFileLocation;
  disposition?: WorkspaceFileOpenRequest["disposition"];
  source?: WorkspaceFileOpenRequest["source"];
  panelId?: string;
}): WorkspaceFileOpenRequest {
  return {
    location: input.location,
    disposition: input.disposition ?? "main",
    source: input.source ?? "plugin",
    ...(input.panelId ? { viewer: { kind: "panel" as const, panelId: input.panelId } } : {}),
  };
}

export function openWorkspaceFileFromExplorer(input: OpenWorkspaceFileFromExplorerInput): void {
  if (!input.persistenceKey) {
    return;
  }
  const location = normalizeWorkspaceFileLocation({ path: input.filePath });
  if (!location) {
    return;
  }
  const tabId = input.openWorkspaceTabInFocusedPane(
    input.persistenceKey,
    createWorkspaceFileTabTarget(location),
    FOCUSED_PANE_PLACEMENT,
    input.source,
  );
  if (tabId) {
    input.revealWorkspaceTab(input.persistenceKey, tabId);
  }
}

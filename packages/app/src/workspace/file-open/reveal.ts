import type {
  PluginFileRevealOptions,
  PluginFileRevealOutcome,
  PluginFileRevealRequest,
} from "@getpaseo/plugin/client";
import { isHiddenExplorerPath } from "@/file-explorer/visibility";
import { requestExplorerReveal } from "@/file-explorer/reveal";
import { usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import {
  findPaneById,
  selectIsExplorerSidebarVisible,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openExplorerSidebarView } from "@/workspace-tabs/explorer-sidebar";
import { resolveWorkspaceFilePaths } from ".";
import { getFileOpenRequest, type ActiveFileOpenRequest } from "./requests";

export interface WorkspaceFileRevealInput {
  serverId: string;
  request: PluginFileRevealRequest;
  options?: PluginFileRevealOptions;
}

interface RevealTarget {
  workspaceKey: string;
  relativePath: string;
}

function workspaceKeyFor(serverId: string, workspaceId: string): string | null {
  return buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
}

function workspaceRootFor(serverId: string, workspaceId: string): string | null {
  const session = useSessionStore.getState().sessions[serverId];
  if (!session) return null;
  const key = resolveWorkspaceMapKeyByIdentity({
    workspaces: session.workspaces,
    workspaceId,
  });
  const workspace = key ? session.workspaces.get(key) : null;
  return workspace?.workspaceDirectory.trim() || null;
}

function explorerShowsFiles(workspaceKey: string): boolean {
  const store = useWorkspaceLayoutStore.getState();
  const layout = store.layoutByWorkspace[workspaceKey];
  const pane = layout
    ? findPaneById(layout.root, store.explorerSidebarPaneIdByWorkspace[workspaceKey])
    : null;
  if (!pane?.focusedTabId) return false;
  return store
    .getWorkspaceTabs(workspaceKey)
    .some((tab) => tab.tabId === pane.focusedTabId && tab.target.kind === "files");
}

function linkAbort(target: AbortController, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    target.abort();
    return () => {};
  }
  const abort = () => target.abort();
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function resolveRevealTarget(input: {
  serverId: string;
  request: PluginFileRevealRequest;
  workspaceId: string;
  bound: ActiveFileOpenRequest | null;
}): { ok: true; target: RevealTarget } | { ok: false; outcome: PluginFileRevealOutcome } {
  const { request, workspaceId, bound } = input;
  if (
    request.requestId &&
    (!bound || bound.hostId !== input.serverId || bound.workspaceId !== workspaceId)
  ) {
    return { ok: false, outcome: { status: "cancelled" } };
  }
  const workspaceKey = workspaceKeyFor(input.serverId, workspaceId);
  const workspaceRoot = workspaceRootFor(input.serverId, workspaceId);
  if (!workspaceKey || !workspaceRoot) {
    return { ok: false, outcome: { status: "unavailable", reason: "workspace" } };
  }
  const resolved = resolveWorkspaceFilePaths({
    path: request.path,
    workspaceRoot,
  });
  const relativePath = resolved?.relativePath;
  if (!relativePath) {
    return { ok: false, outcome: { status: "unavailable", reason: "missing" } };
  }
  if (isHiddenExplorerPath(relativePath) && !usePanelStore.getState().explorerShowHiddenFiles) {
    return { ok: false, outcome: { status: "unavailable", reason: "hidden" } };
  }
  return { ok: true, target: { workspaceKey, relativePath } };
}

function prepareRevealSurface(
  request: PluginFileRevealRequest,
  workspaceKey: string,
): PluginFileRevealOutcome | null {
  const store = useWorkspaceLayoutStore.getState();
  if (request.intent === "explicit") {
    openExplorerSidebarView({
      view: "files",
      workspaceKey,
      isCompact: store.layoutMode === "compact",
    });
    return null;
  }
  if (!selectIsExplorerSidebarVisible(store, workspaceKey) || !explorerShowsFiles(workspaceKey)) {
    return { status: "unavailable", reason: "not-visible" };
  }
  return null;
}

async function awaitRevealAcknowledgement(input: {
  workspaceKey: string;
  relativePath: string;
  request: PluginFileRevealRequest;
  bound: ActiveFileOpenRequest | null;
  options: PluginFileRevealOptions | undefined;
}): Promise<PluginFileRevealOutcome> {
  const lifetime = new AbortController();
  const unlink = [
    linkAbort(lifetime, input.bound?.signal),
    linkAbort(lifetime, input.options?.signal),
  ];
  try {
    if (lifetime.signal.aborted) return { status: "cancelled" };
    const pending = requestExplorerReveal({
      workspaceKey: input.workspaceKey,
      path: input.relativePath,
      intent: input.request.intent,
      requestId: input.request.requestId,
      signal: lifetime.signal,
      ttlMs: input.options?.ttlMs,
    });
    const result = await pending.result;
    if (result === "revealed") return { status: "revealed" };
    if (result === "missing") return { status: "unavailable", reason: "missing" };
    if (result === "hidden") return { status: "unavailable", reason: "hidden" };
    return { status: "cancelled" };
  } finally {
    for (const remove of unlink) remove();
  }
}

/**
 * Reveals a workspace path in the Files tree. It deliberately never opens or retargets a file
 * tab: the confirmed file-open dispatcher owns that. One ephemeral selection is kept per
 * workspace, so a stale reveal cannot outlive the request that asked for it. The result waits for
 * the tree to acknowledge the path, within the request's bounded TTL.
 */
export async function revealWorkspaceFile(
  input: WorkspaceFileRevealInput,
): Promise<PluginFileRevealOutcome> {
  const { request, options } = input;
  if (options?.signal?.aborted) return { status: "cancelled" };
  const workspaceId = request.workspaceId.trim();
  const bound = request.requestId ? getFileOpenRequest(request.requestId) : null;
  const resolved = resolveRevealTarget({
    serverId: input.serverId,
    request,
    workspaceId,
    bound,
  });
  if (!resolved.ok) return resolved.outcome;
  const surface = prepareRevealSurface(request, resolved.target.workspaceKey);
  if (surface) return surface;
  return awaitRevealAcknowledgement({
    workspaceKey: resolved.target.workspaceKey,
    relativePath: resolved.target.relativePath,
    request,
    bound,
    options,
  });
}

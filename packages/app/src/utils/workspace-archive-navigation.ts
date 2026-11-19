import type { Href } from "expo-router";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { buildHostRootRoute, buildNewWorkspaceRoute } from "@/utils/host-routes";
import { resolveWorkspaceRouteId } from "@/utils/workspace-identity";

export interface WorkspaceArchiveRedirectSnapshot {
  serverId: string;
  id: string;
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string;
  workspaceDirectory: string;
}

function workspaceSourceDirectory(
  workspace: WorkspaceDescriptor | WorkspaceArchiveRedirectSnapshot | null,
): string | null {
  for (const sourceDirectory of [workspace?.projectRootPath, workspace?.workspaceDirectory]) {
    if (sourceDirectory?.trim()) {
      return sourceDirectory;
    }
  }
  return null;
}

export function buildWorkspaceArchiveRedirectRoute(input: {
  serverId: string;
  archivedWorkspaceId: string;
  workspaces: Iterable<WorkspaceDescriptor>;
  archivedWorkspaceSnapshot?: WorkspaceArchiveRedirectSnapshot | null;
}): Href {
  const archivedWorkspaceId = resolveWorkspaceRouteId({
    routeWorkspaceId: input.archivedWorkspaceId,
  });
  if (!archivedWorkspaceId) {
    return buildHostRootRoute(input.serverId);
  }

  const listedArchivedWorkspace =
    Array.from(input.workspaces).find(
      (workspace) =>
        resolveWorkspaceRouteId({ routeWorkspaceId: workspace.id }) === archivedWorkspaceId,
    ) ?? null;
  const snapshot = input.archivedWorkspaceSnapshot;
  const matchingSnapshot =
    snapshot &&
    snapshot.serverId === input.serverId &&
    resolveWorkspaceRouteId({ routeWorkspaceId: snapshot.id }) === archivedWorkspaceId
      ? snapshot
      : null;
  const listedSourceDirectory = workspaceSourceDirectory(listedArchivedWorkspace);
  const snapshotSourceDirectory = workspaceSourceDirectory(matchingSnapshot);
  const archivedWorkspace =
    !listedSourceDirectory && snapshotSourceDirectory
      ? matchingSnapshot
      : (listedArchivedWorkspace ?? matchingSnapshot);
  const sourceDirectory = workspaceSourceDirectory(archivedWorkspace);
  if (!sourceDirectory || !archivedWorkspace) {
    return buildHostRootRoute(input.serverId);
  }

  return buildNewWorkspaceRoute({
    serverId: input.serverId,
    sourceDirectory,
    displayName: archivedWorkspace.projectDisplayName,
    projectId: archivedWorkspace.projectId,
  });
}

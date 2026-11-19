import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import {
  confirmRiskyWorktreeArchive,
  DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
  readWorktreeArchiveRisk,
  type WorktreeArchiveWarningLabels,
} from "@/git/worktree-archive-warning";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { selectWorkspace } from "@/stores/session-store-hooks/selectors";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceArchiveRedirectSnapshot } from "@/utils/workspace-archive-navigation";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { archiveWorkspaceWithUndo, supportsWorkspaceArchiveUndo } from "@/workspace/archive-undo";
import {
  archiveWorkspaceOptimistically,
  isWorkspaceListed,
  type WorkspaceArchiveTarget,
} from "@/workspace/workspace-archive";

function purgeArchivedWorkspaceState(input: { serverId: string; workspaceId: string }): void {
  const workspaceKey = buildWorkspaceTabPersistenceKey(input);
  if (workspaceKey) {
    useWorkspaceLayoutStore.getState().purgeWorkspace(workspaceKey);
  }
}

function captureWorkspaceArchiveRedirectSnapshot(
  workspace: WorkspaceArchiveTarget,
): WorkspaceArchiveRedirectSnapshot | null {
  const descriptor = selectWorkspace(
    useSessionStore.getState(),
    workspace.serverId,
    workspace.workspaceId,
  );
  if (!descriptor) {
    return null;
  }
  return {
    serverId: workspace.serverId,
    id: descriptor.id,
    projectId: descriptor.projectId,
    projectDisplayName: descriptor.projectDisplayName,
    projectRootPath: descriptor.projectRootPath,
    workspaceDirectory: descriptor.workspaceDirectory,
  };
}

export interface WorkspaceArchiveStarted extends WorkspaceArchiveTarget {
  archivedWorkspaceSnapshot: WorkspaceArchiveRedirectSnapshot | null;
}

export interface ArchiveWorkspaceInput {
  serverId: string;
  workspaceId: string;
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
  workspaceDirectory: string;
  name: string;
  /** Labels the warning's line counts. Whether to warn comes from the host's git state. */
  diffStat?: { additions: number; deletions: number } | null;
  warningLabels?: WorktreeArchiveWarningLabels;
  /** Runs once the host confirms the archive and the row is gone, with archived route data. */
  onArchiveStarted: (workspace: WorkspaceArchiveStarted) => void;
  onSetHiding?: (hiding: boolean) => void;
}

export interface WorkspaceArchiveController {
  archive: () => void;
}

export function useWorkspaceArchive(input: ArchiveWorkspaceInput): WorkspaceArchiveController {
  const {
    serverId,
    workspaceId,
    workspaceKind,
    workspaceDirectory,
    name,
    diffStat,
    warningLabels = DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
    onArchiveStarted,
    onSetHiding,
  } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const confirmingRef = useRef(false);
  // The archive starts after the host answers and you confirm. By then you may have opened another
  // workspace, so the redirect reads the selection from the latest render.
  const onArchiveStartedRef = useRef(onArchiveStarted);
  onArchiveStartedRef.current = onArchiveStarted;

  const archiveWorkspaceRecord = useCallback(async () => {
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      toast.error(t("sidebar.workspace.toasts.hostDisconnected"));
      return;
    }
    const workspace = { serverId, workspaceId };
    // Optimistic archive removes the row. Keep only immutable route fields from the
    // archive target before that hide; success is still established by the gate below.
    const archivedWorkspaceSnapshot = captureWorkspaceArchiveRedirectSnapshot(workspace);
    onSetHiding?.(true);
    try {
      if (supportsWorkspaceArchiveUndo(serverId)) {
        await archiveWorkspaceWithUndo({
          client,
          workspace,
          toast,
          onArchiveCommitted: () => purgeArchivedWorkspaceState(workspace),
        });
      } else {
        // COMPAT(workspaceArchiveUndo): hosts before v0.15.3 cannot undo; remove after 2027-05-06.
        await archiveWorkspaceOptimistically({ client, workspace });
        purgeArchivedWorkspaceState(workspace);
      }
      // A failed, canceled, or undone archive leaves the row listed. Redirect only
      // after the host confirms the archive and nothing restored the workspace,
      // so a partial failure keeps its current route visible for a retry.
      if (!isWorkspaceListed(workspace)) {
        onArchiveStartedRef.current({ ...workspace, archivedWorkspaceSnapshot });
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("sidebar.workspace.toasts.archiveFailed"),
      );
    } finally {
      onSetHiding?.(false);
    }
  }, [onSetHiding, serverId, t, toast, workspaceId]);

  // The host removes a worktree it archives, uncommitted work included. Ask it what that would
  // lose: the sidebar row's git status is empty until the row receives it.
  const confirmWorktreeArchive = useCallback(async (): Promise<boolean> => {
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      toast.error(t("sidebar.workspace.toasts.hostDisconnected"));
      return false;
    }
    const risk = await readWorktreeArchiveRisk(client, workspaceDirectory).catch(
      (error: unknown) => {
        toast.error(
          error instanceof Error ? error.message : t("sidebar.workspace.toasts.archiveFailed"),
        );
        return null;
      },
    );
    if (!risk) {
      return false;
    }
    return await confirmRiskyWorktreeArchive(
      { workspaceName: name, diffStat, ...risk },
      warningLabels,
    );
  }, [diffStat, name, serverId, t, toast, warningLabels, workspaceDirectory]);

  const archive = useCallback(() => {
    // A second press while the host answers or the warning is open would ask twice.
    if (confirmingRef.current) {
      return;
    }
    void (async () => {
      if (workspaceKind === "worktree") {
        confirmingRef.current = true;
        let confirmed: boolean;
        try {
          confirmed = await confirmWorktreeArchive();
        } finally {
          confirmingRef.current = false;
        }
        if (!confirmed) {
          return;
        }
      }
      await archiveWorkspaceRecord();
    })();
  }, [archiveWorkspaceRecord, confirmWorktreeArchive, workspaceKind]);

  return {
    archive,
  };
}

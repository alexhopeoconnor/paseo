import { useCallback, useSyncExternalStore } from "react";
import {
  isWorkspaceArchiveUndoPending,
  isWorkspaceArchiveUndoRestoringAgent,
  subscribeWorkspaceArchiveIntents,
} from "@/contexts/session-workspace-upserts";
import { isWorkspaceArchiveTabRetained, subscribeWorkspaceArchiveRetention } from "./undo-window";

/**
 * True while this workspace's archive can still take its tabs away or bring them back:
 * from the archive request, through host agent-archive deltas and the open undo window,
 * and through an uncertain or failed undo. It ends only when the archive commits or a
 * restore is accepted.
 */
export function useWorkspaceArchiveUndoRunning(input: {
  serverId: string;
  workspaceId: string | null;
}): boolean {
  const { serverId, workspaceId } = input;
  const readUndoIntent = useCallback(
    () => isWorkspaceArchiveUndoPending({ serverId, workspaceId }),
    [serverId, workspaceId],
  );
  const readRetention = useCallback(
    () => isWorkspaceArchiveTabRetained({ serverId, workspaceId }),
    [serverId, workspaceId],
  );
  const undoRunning = useSyncExternalStore(
    subscribeWorkspaceArchiveIntents,
    readUndoIntent,
    readUndoIntent,
  );
  const retained = useSyncExternalStore(
    subscribeWorkspaceArchiveRetention,
    readRetention,
    readRetention,
  );
  return undoRunning || retained;
}

/**
 * True while this client's undo of the workspace's archive is pending and `agentId` was active
 * in that workspace when archived (excluding agents that were already archived individually).
 */
export function useWorkspaceArchiveUndoRestoringAgent(input: {
  serverId: string;
  workspaceId: string | null;
  agentId: string | null;
}): boolean {
  const { serverId, workspaceId, agentId } = input;
  const read = useCallback(
    () => isWorkspaceArchiveUndoRestoringAgent({ serverId, workspaceId, agentId }),
    [agentId, serverId, workspaceId],
  );
  return useSyncExternalStore(subscribeWorkspaceArchiveIntents, read, read);
}

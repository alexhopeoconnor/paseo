import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { WorkspaceUndoRecoverySurface } from "./workspace-undo-recovery-surface";
import { hasUndoableWorkspaceArchive, undoLatestWorkspaceArchive } from "./undo-window";

const UNDO_ARCHIVE_ACTIONS: readonly KeyboardActionId[] = ["workspace.archive.undo"];

/**
 * Cmd/Ctrl+Z for the archive toast and the persistent failed-Undo recovery surface.
 * Mounted once at the app root because the row that started the archive unmounts as soon as
 * its workspace hides. It claims the key only while an archive can be undone or a failed
 * owner can be retried.
 */
export function WorkspaceArchiveUndoShortcutHost() {
  useKeyboardActionHandler({
    handlerId: "workspace-archive-undo-global",
    actions: UNDO_ARCHIVE_ACTIONS,
    enabled: true,
    priority: 0,
    isActive: hasUndoableWorkspaceArchive,
    handle: undoLatestWorkspaceArchive,
  });
  return <WorkspaceUndoRecoverySurface />;
}

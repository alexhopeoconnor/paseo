import type { DismissToast, ToastApi } from "@/components/toast-host";
import { i18n } from "@/i18n/i18next";
import { isWorkspaceArchiveUndoPending } from "@/contexts/session-workspace-upserts";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  beginOptimisticWorkspaceArchive,
  isWorkspaceListed,
  undoWorkspaceArchiveOptimistically,
  type WorkspaceArchiveTarget,
} from "@/workspace/workspace-archive";
import { WorkspaceArchivedToast } from "./workspace-archived-toast";

/** How long the archived toast, and with it the chance to undo, stays up. */
export const WORKSPACE_ARCHIVE_UNDO_WINDOW_MS = 6000;

const ARCHIVE_IN_PROGRESS = "Workspace archive is already in progress";

export interface UndoableWorkspaceArchiveClient {
  archiveWorkspace: (workspaceId: string) => Promise<{ error: string | null; canceled?: boolean }>;
  undoWorkspaceArchive: (workspaceId: string) => Promise<void>;
}

export interface WorkspaceArchiveRecoveryEntry {
  key: string;
  serverId: string;
  workspaceId: string;
  workspaceName: string;
  token: number;
  retrying: boolean;
  retryable: boolean;
}

export interface UndoableWorkspaceArchiveEntryInput {
  client: UndoableWorkspaceArchiveClient;
  workspace: WorkspaceArchiveTarget;
  onArchiveCommitted: () => void;
}

interface UndoWindowInput extends UndoableWorkspaceArchiveEntryInput {
  toast: ToastApi;
}

type UndoWindowPhase = "preparing" | "open" | "closed" | "undone";
type ArchiveOutcome = "pending" | "archived" | "canceled" | "failed";
type UndoOutcome = "none" | "running" | "accepted" | "failed";

interface ArchiveRetentionOwner {
  readonly workspace: WorkspaceArchiveTarget;
  readonly recoveryOrder: number;
  isRetained(): boolean;
  isOperationActive(): boolean;
  isUndoRunning(): boolean;
  hasPendingPurge(): boolean;
  isRecoveryRegistered(): boolean;
  isRetrying(): boolean;
  canRetry(): boolean;
  getWorkspaceName(): string;
  markRetained(): void;
  retry(): boolean;
  releaseRetention(): void;
}

const retainedWindowsByWorkspace = new Map<string, ArchiveRetentionOwner>();
const pendingStartByWorkspace = new Map<string, ArchiveRetentionOwner>();
const retentionListeners = new Set<() => void>();
let recoverySnapshot: readonly WorkspaceArchiveRecoveryEntry[] = [];
let nextRecoveryOrder = 0;

function retentionKey(input: { serverId: string; workspaceId?: string | null }): string | null {
  const serverId = input.serverId.trim();
  const workspaceId = input.workspaceId?.trim() ?? "";
  if (!serverId || !workspaceId) {
    return null;
  }
  return `${serverId}:${workspaceId}`;
}

function buildRecoverySnapshot(): readonly WorkspaceArchiveRecoveryEntry[] {
  return [...retainedWindowsByWorkspace.values()]
    .filter((owner) => owner.isRecoveryRegistered())
    .sort((left, right) => left.recoveryOrder - right.recoveryOrder)
    .flatMap((owner) => {
      const key = retentionKey(owner.workspace);
      if (!key) return [];
      return [
        {
          key,
          serverId: owner.workspace.serverId,
          workspaceId: owner.workspace.workspaceId,
          workspaceName: owner.getWorkspaceName(),
          token: owner.recoveryOrder,
          retrying: owner.isRetrying(),
          retryable: owner.canRetry(),
        },
      ];
    });
}

function notifyRetention(): void {
  recoverySnapshot = buildRecoverySnapshot();
  for (const listener of retentionListeners) {
    listener();
  }
}

function currentRetentionOwner(input: {
  serverId: string;
  workspaceId?: string | null;
}): ArchiveRetentionOwner | undefined {
  const key = retentionKey(input);
  return key ? retainedWindowsByWorkspace.get(key) : undefined;
}

function firstRetryableRecoveryOwner(): ArchiveRetentionOwner | null {
  for (const entry of recoverySnapshot) {
    if (!entry.retryable) continue;
    const owner = retainedWindowsByWorkspace.get(entry.key);
    if (owner && owner.recoveryOrder === entry.token && owner.canRetry()) {
      return owner;
    }
  }
  return null;
}

function hasActiveWorkspaceArchive(input: WorkspaceArchiveTarget): boolean {
  const key = retentionKey(input);
  if (!key) return false;
  if (pendingStartByWorkspace.has(key)) return true;
  const owner = retainedWindowsByWorkspace.get(key);
  if (!owner) return false;
  // The host serializes this successor behind the explicit local Undo. Keep the old
  // owner until the successor has actually hidden the restored row and opened.
  if (owner.isUndoRunning() && isWorkspaceArchiveUndoPending(input) && isWorkspaceListed(input)) {
    return false;
  }
  return owner.isOperationActive() || owner.hasPendingPurge();
}

function reservePendingStart(owner: ArchiveRetentionOwner): void {
  const key = retentionKey(owner.workspace);
  if (!key) {
    return;
  }
  pendingStartByWorkspace.set(key, owner);
}

function clearPendingStart(owner: ArchiveRetentionOwner): void {
  const key = retentionKey(owner.workspace);
  if (!key || pendingStartByWorkspace.get(key) !== owner) {
    return;
  }
  pendingStartByWorkspace.delete(key);
}

function retainWindow(owner: ArchiveRetentionOwner): void {
  const key = retentionKey(owner.workspace);
  if (!key) {
    return;
  }
  const previous = retainedWindowsByWorkspace.get(key);
  retainedWindowsByWorkspace.set(key, owner);
  owner.markRetained();
  if (previous && previous !== owner) {
    previous.releaseRetention();
  }
  notifyRetention();
}

function releaseWindow(owner: ArchiveRetentionOwner): void {
  const key = retentionKey(owner.workspace);
  if (!key || retainedWindowsByWorkspace.get(key) !== owner) {
    return;
  }
  retainedWindowsByWorkspace.delete(key);
  notifyRetention();
}

/** True while the workspace's latest archive still holds its tabs for a possible undo. */
export function isWorkspaceArchiveTabRetained(input: {
  serverId: string;
  workspaceId?: string | null;
}): boolean {
  return currentRetentionOwner(input)?.isRetained() === true;
}

/** Calls `listener` when a workspace's archive retention starts, moves, or ends. */
export function subscribeWorkspaceArchiveRetention(listener: () => void): () => void {
  retentionListeners.add(listener);
  return () => {
    retentionListeners.delete(listener);
  };
}

/** The current unresolved failed-Undo owners, oldest first. */
export function getWorkspaceArchiveRecoverySnapshot(): readonly WorkspaceArchiveRecoveryEntry[] {
  return recoverySnapshot;
}

/** Calls `listener` when the recovery entries or their retry state change. */
export function subscribeWorkspaceArchiveRecovery(listener: () => void): () => void {
  return subscribeWorkspaceArchiveRetention(listener);
}

/** Retries one exact unresolved owner; stale tokens are a no-op. */
export function retryWorkspaceArchiveRecovery(input: {
  serverId: string;
  workspaceId: string;
  token: number;
}): boolean {
  const key = retentionKey(input);
  if (!key) return false;
  const owner = retainedWindowsByWorkspace.get(key);
  if (!owner || owner.recoveryOrder !== input.token) return false;
  return owner.retry();
}

interface UndoWindowHandle {
  undo(): boolean;
}

let latest: UndoWindowHandle | null = null;

function setLatest(owner: UndoWindowHandle | null): void {
  latest = owner;
}

/**
 * One archive's chance to be undone. It owns the workspace's tab retention from the moment
 * the archive starts until it commits or a restore is accepted.
 *
 * - `preparing`: retained, archive request starting, no toast yet.
 * - `open`: undo is offered.
 * - `closed`: undo is no longer offered; the archive may still be running.
 * - `undone`: the user took the archive back; an undo request may still be settling.
 */
class UndoWindow implements ArchiveRetentionOwner {
  phase: UndoWindowPhase = "preparing";
  readonly workspace: WorkspaceArchiveTarget;
  readonly recoveryOrder: number;
  private readonly input: UndoWindowInput;
  private outcome: ArchiveOutcome = "pending";
  private undoOutcome: UndoOutcome = "none";
  private retained = false;
  private operationActive = true;
  private purgePending = false;
  private committed = false;
  private recoveryRegistered = false;
  private lateArchiveListed = false;
  private workspaceName: string;
  private hidden: WorkspaceDescriptor | null = null;
  private archivedAgentIds: ReadonlySet<string> = new Set();
  private readonly batch?: BatchUndoWindow;
  private dismissToast: DismissToast | null = null;

  constructor(
    input: UndoWindowInput,
    options: { retainImmediately: boolean; batch?: BatchUndoWindow },
  ) {
    this.batch = options.batch;
    this.input = input;
    this.workspace = input.workspace;
    this.workspaceName = input.workspace.workspaceId;
    this.recoveryOrder = nextRecoveryOrder;
    nextRecoveryOrder += 1;
    if (options.retainImmediately) {
      retainWindow(this);
    }
  }

  open(hidden: WorkspaceDescriptor | null, archivedAgentIds: ReadonlySet<string>): void {
    if (this.phase !== "preparing") {
      return;
    }
    this.hidden = hidden;
    this.archivedAgentIds = archivedAgentIds;
    this.workspaceName = hidden?.name ?? this.workspace.workspaceId;
    if (!this.retained) {
      retainWindow(this);
    }
    clearPendingStart(this);
    this.phase = "open";
    if (this.batch) {
      this.batch.add(this);
      return;
    }
    setLatest(this);
    this.dismissToast = this.input.toast.show(<WorkspaceArchivedToast onUndo={this.undo} />, {
      durationMs: WORKSPACE_ARCHIVE_UNDO_WINDOW_MS,
      testID: "workspace-archived-toast",
      onDismiss: this.close,
    });
  }

  /** The host finished the archive. It commits now if undo is no longer offered. */
  archiveFinished(): void {
    const listed = isWorkspaceListed(this.workspace);
    this.outcome = "archived";
    this.purgePending = !listed;
    this.lateArchiveListed = listed;
    if (this.recoveryRegistered) {
      notifyRetention();
    }
    if (this.phase === "closed") {
      this.commit();
      return;
    }
    if (this.phase === "undone" && this.undoOutcome === "failed") {
      this.commit();
    }
  }

  /** The host stopped the archive; the row is back and no archive will commit. */
  archiveCanceled(): void {
    this.outcome = "canceled";
    this.purgePending = false;
    if (this.undoOutcome === "running") {
      return;
    }
    this.operationActive = false;
    if (this.undoOutcome === "failed") {
      this.registerRecovery();
      this.clearLatest();
      return;
    }
    this.releaseRetention();
  }

  /** The archive rejected. The row is back; an in-flight undo still owns the settle point. */
  archiveFailed(): void {
    this.archiveDidFail();
    if (this.phase === "open") {
      this.close();
    }
    this.dismiss();
  }

  /** Records an archive failure without closing an already-ended undo window. */
  archiveDidFail(): void {
    this.outcome = "failed";
    this.purgePending = false;
    if (this.undoOutcome === "running") {
      return;
    }
    this.operationActive = false;
    if (this.undoOutcome === "failed") {
      this.registerRecovery();
      this.clearLatest();
      return;
    }
    this.releaseRetention();
  }

  /** The archive request never started; the row did not change for this attempt. */
  archiveFailedOrDisposed(): void {
    clearPendingStart(this);
    this.operationActive = false;
    this.purgePending = false;
    this.dismiss();
    if (this.retained) {
      this.releaseRetention();
    }
  }

  readonly close = (): void => {
    if (this.phase !== "open") {
      return;
    }
    this.phase = "closed";
    if (this.outcome === "archived") {
      this.commit();
      return;
    }
    if (this.outcome === "canceled" || this.outcome === "failed") {
      this.clearLatest();
    }
  };

  /** Commits unless the workspace is back by now, for example restored from another client. */
  private commit(): void {
    if (this.committed) {
      return;
    }
    if (!this.isRetentionOwner()) {
      this.releaseRetention();
      return;
    }
    if (isWorkspaceListed(this.workspace) || this.lateArchiveListed) {
      this.purgePending = false;
      this.operationActive = false;
      if (this.recoveryRegistered) {
        this.lateArchiveListed = true;
        notifyRetention();
        this.clearLatest();
      } else {
        this.releaseRetention();
      }
      return;
    }

    this.purgePending = true;
    this.operationActive = true;
    this.input.onArchiveCommitted();

    this.committed = true;
    this.purgePending = false;
    this.operationActive = false;
    this.releaseRetention();
  }

  private isRetentionOwner(): boolean {
    return currentRetentionOwner(this.workspace) === this;
  }

  readonly undo = (): boolean => {
    if (this.phase !== "open") {
      return false;
    }
    this.phase = "undone";
    this.undoOutcome = "running";
    this.operationActive = true;
    this.dismiss();
    this.runUndo();
    return true;
  };

  retry(): boolean {
    if (!this.canRetry()) {
      return false;
    }
    this.undoOutcome = "running";
    this.operationActive = true;
    notifyRetention();
    this.runUndo();
    return true;
  }

  private runUndo(): void {
    void undoWorkspaceArchiveOptimistically({
      client: this.input.client,
      workspace: this.input.workspace,
      hidden: this.hidden,
      archivedAgentIds: this.archivedAgentIds,
    })
      .then(
        () => this.undoAccepted(),
        (error: unknown) => this.undoFailed(error),
      )
      .catch((error: unknown) => {
        console.error("[workspace-archive-undo] undo settle failed", error);
      });
  }

  private undoAccepted(): void {
    this.undoOutcome = "accepted";
    this.purgePending = false;
    this.operationActive = false;
    this.releaseRetention();
  }

  private undoFailed(error: unknown): void {
    this.undoOutcome = "failed";
    console.warn("[workspace-archive-undo] undo failed", error);
    if (!this.isRetentionOwner()) {
      this.operationActive = false;
      this.purgePending = false;
      return;
    }
    this.input.toast.error(i18n.t("sidebar.workspace.toasts.undoArchiveFailed"));
    if (this.outcome === "archived") {
      if (this.lateArchiveListed || isWorkspaceListed(this.workspace)) {
        this.lateArchiveListed = true;
        this.registerRecovery();
        this.clearLatest();
        this.purgePending = false;
        this.operationActive = false;
        return;
      }
      this.commit();
      return;
    }
    this.registerRecovery();
    if (this.outcome === "pending") {
      this.operationActive = true;
      return;
    }
    this.clearLatest();
    this.purgePending = false;
    this.operationActive = false;
  }

  canUndo(): boolean {
    return this.phase === "open";
  }

  canRetry(): boolean {
    return (
      this.recoveryRegistered &&
      this.undoOutcome === "failed" &&
      (this.outcome === "canceled" ||
        this.outcome === "failed" ||
        (this.outcome === "archived" && this.lateArchiveListed))
    );
  }

  isRetrying(): boolean {
    return this.recoveryRegistered && this.undoOutcome === "running";
  }

  isRecoveryRegistered(): boolean {
    return this.recoveryRegistered;
  }

  getWorkspaceName(): string {
    return this.workspaceName;
  }

  isRetained(): boolean {
    return this.retained;
  }

  isOperationActive(): boolean {
    return this.operationActive;
  }

  isUndoRunning(): boolean {
    return this.phase === "undone" && this.undoOutcome === "running";
  }

  hasPendingPurge(): boolean {
    return this.purgePending;
  }

  markRetained(): void {
    this.retained = true;
  }

  releaseRetention(): void {
    const wasRegistered = this.recoveryRegistered;
    this.recoveryRegistered = false;
    this.clearLatest();
    if (this.retained) {
      this.retained = false;
      releaseWindow(this);
      this.batch?.remove(this);
      return;
    }
    if (wasRegistered) {
      notifyRetention();
    }
    this.batch?.remove(this);
  }

  private registerRecovery(): void {
    this.workspaceName = this.hidden?.name ?? this.workspaceName;
    this.recoveryRegistered = true;
    notifyRetention();
  }

  private clearLatest(): void {
    if (latest === this) {
      setLatest(null);
    }
  }

  private dismiss(): void {
    if (this.batch) {
      this.batch.remove(this);
      return;
    }
    const dismiss = this.dismissToast;
    this.dismissToast = null;
    dismiss?.();
  }
}

/** One toast groups independent operation owners; ownership and recovery stay per workspace. */
class BatchUndoWindow implements UndoWindowHandle {
  private phase: "open" | "closed" | "undone" = "open";
  private readonly windows = new Set<UndoWindow>();
  private dismissToast: DismissToast | null = null;
  private toastToken: object | null = null;

  constructor(private readonly toast: ToastApi) {}

  add(window: UndoWindow): void {
    this.windows.add(window);
    setLatest(this);
    this.showToast();
  }

  remove(window: UndoWindow): void {
    if (!this.windows.delete(window)) return;
    if (this.phase !== "open") return;
    if (this.windows.size === 0) {
      this.close();
      this.dismiss();
    } else {
      this.showToast();
    }
  }

  private showToast(message?: string): void {
    const token = {};
    this.toastToken = token;
    this.dismissToast = this.toast.show(
      <WorkspaceArchivedToast count={this.windows.size} message={message} onUndo={this.undo} />,
      {
        variant: message ? "error" : "default",
        layout: "action",
        durationMs: WORKSPACE_ARCHIVE_UNDO_WINDOW_MS,
        testID: "workspace-archived-toast",
        onDismiss: () => {
          if (this.toastToken === token) this.close();
        },
      },
    );
  }

  showPartialFailure(message: string): boolean {
    if (this.phase !== "open" || latest !== this) return false;
    this.showToast(message);
    return true;
  }

  private clearLatest(): void {
    if (latest === this) setLatest(null);
  }

  private readonly close = (): void => {
    if (this.phase !== "open") return;
    this.phase = "closed";
    this.clearLatest();
    for (const window of this.windows) window.close();
  };

  readonly undo = (): boolean => {
    if (this.phase !== "open") return false;
    this.phase = "undone";
    this.clearLatest();
    this.dismiss();
    for (const window of this.windows) window.undo();
    return true;
  };

  private dismiss(): void {
    this.toastToken = null;
    const dismiss = this.dismissToast;
    this.dismissToast = null;
    dismiss?.();
  }
}

export interface WorkspaceArchiveBatchFailure {
  workspace: WorkspaceArchiveTarget;
  error: unknown;
}

export interface WorkspaceArchiveBatchResult {
  failures: WorkspaceArchiveBatchFailure[];
  showPartialFailure: (message: string) => boolean;
}

export async function archiveWorkspacesWithUndo(input: {
  entries: readonly UndoableWorkspaceArchiveEntryInput[];
  toast: ToastApi;
}): Promise<WorkspaceArchiveBatchResult> {
  const batch = new BatchUndoWindow(input.toast);
  const failures: WorkspaceArchiveBatchFailure[] = [];
  await Promise.all(
    input.entries.map(async (entry) => {
      try {
        await archiveWorkspaceEntry({ ...entry, toast: input.toast }, batch);
      } catch (error) {
        failures.push({ workspace: entry.workspace, error });
      }
    }),
  );
  return { failures, showPartialFailure: (message) => batch.showPartialFailure(message) };
}

export function archiveWorkspaceWithUndo(input: UndoWindowInput): Promise<"archived" | "canceled"> {
  return archiveWorkspaceEntry(input);
}

/**
 * Archives a workspace and offers to undo it until the toast goes away.
 *
 * `onArchiveCommitted` runs once the archive both finished on the host and can no longer be
 * undone, and only if the workspace is still gone then. Local state the undo would want back
 * (tabs, layout) survives the window, and survives a restore from another client.
 * Rejects when the archive fails and was not undone; the row is back by then.
 */
async function archiveWorkspaceEntry(
  input: UndoWindowInput,
  batch?: BatchUndoWindow,
): Promise<"archived" | "canceled"> {
  if (hasActiveWorkspaceArchive(input.workspace)) {
    throw new Error(ARCHIVE_IN_PROGRESS);
  }

  const current = currentRetentionOwner(input.workspace);
  const window = new UndoWindow(input, { retainImmediately: current === undefined, batch });
  reservePendingStart(window);

  let archive: ReturnType<typeof beginOptimisticWorkspaceArchive>;
  try {
    archive = beginOptimisticWorkspaceArchive(input);
  } catch (error) {
    window.archiveFailedOrDisposed();
    throw error;
  }
  window.open(archive.hidden, archive.archivedAgentIds);

  let outcome: Awaited<typeof archive.done>;
  try {
    outcome = await archive.done;
  } catch (error) {
    if (window.phase === "undone") {
      window.archiveDidFail();
      return "canceled";
    }
    window.archiveFailed();
    throw error;
  }
  if (outcome === "archived") {
    window.archiveFinished();
  } else {
    window.archiveCanceled();
  }
  return window.phase === "undone" ? "canceled" : outcome;
}

/** Undoes the latest open archive, or retries the oldest unresolved failed Undo. */
export function undoLatestWorkspaceArchive(): boolean {
  if (latest) {
    return latest.undo();
  }
  const recovery = firstRetryableRecoveryOwner();
  return recovery ? recovery.retry() : false;
}

export function hasUndoableWorkspaceArchive(): boolean {
  return latest !== null || firstRetryableRecoveryOwner() !== null;
}

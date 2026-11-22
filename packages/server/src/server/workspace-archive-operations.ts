import { resolve } from "node:path";
import { normalizePathForIdentity } from "../utils/path.js";
import {
  type ArchiveResult,
  WorkspaceArchiveCanceledError,
  WorkspaceArchiveTeardownError,
} from "./workspace-archive-service.js";

export type WorkspaceArchiveOutcome =
  | { kind: "archived"; archivedAt?: string; result: ArchiveResult }
  | { kind: "canceled"; archivedAt: string };

export interface WorkspaceArchiveUndoInput {
  archivedAt?: string;
}

export interface WorkspaceArchiveRunInput {
  /** Reuses an unfinished operation's stamp when its archive is retried. */
  archivedAt?: string;
}

interface PendingArchive {
  controller: AbortController;
  done: Promise<WorkspaceArchiveOutcome>;
}

type LaneEntry =
  | { kind: "archiving"; controller: AbortController; done: Promise<WorkspaceArchiveOutcome> }
  | {
      kind: "restoring";
      pendingArchive: PendingArchive | null;
      supersededBy: Promise<void> | null;
      done: Promise<void>;
    }
  | { kind: "undoing"; done: Promise<void> };

/**
 * Daemon-wide coordinator for workspace archive, undo, and restore operations.
 *
 * Per-workspace lanes:
 * - An archive while one runs joins it.
 * - An undo while an archive runs (including when a restore queued behind it) aborts the archive,
 *   waits for it to stop, then restores.
 * - A restore while an archive runs waits for the archive without aborting it, then restores.
 * - An archive while an undo or restore runs waits for it, then archives.
 * - A duplicate undo or restore while recovery runs joins it.
 *
 * Per-checkout gates:
 * - Any archive or recovery mutating the same backing checkout directory (including CLI worktree
 *   archives covering multiple workspace records, background auto-archives, and sibling workspaces
 *   sharing one checkout) serializes through `withCheckout` so a restore cannot inspect or unarchive
 *   a checkout while an archive is still deleting it.
 * - Lock order is strictly workspace lane -> checkout gate, preventing deadlocks.
 */
export class WorkspaceArchiveOperations {
  private readonly lanes = new Map<string, LaneEntry>();
  // A successful archive stamps its workspace record durably. Only a failed
  // partial archive remains active without such a record, so retain its stamp
  // in memory for an exact Undo or retry. A fresh daemon intentionally has no
  // such volatile recovery state.
  private readonly partialArchiveStamps = new Map<string, string>();
  private readonly checkoutGates = new Map<string, Promise<void>>();

  // Project removal can overlap a checkout-scoped archive of the same workspace.
  private readonly archiving = new Map<string, { startedAt: string; count: number }>();

  getArchivingAt(workspaceId: string): string | null {
    return this.archiving.get(workspaceId)?.startedAt ?? null;
  }

  markArchiving(workspaceIds: Iterable<string>, startedAt: string): void {
    for (const id of workspaceIds) {
      const current = this.archiving.get(id);
      if (current) current.count += 1;
      else this.archiving.set(id, { startedAt, count: 1 });
    }
  }

  clearArchiving(workspaceIds: Iterable<string>): void {
    for (const id of workspaceIds) {
      const current = this.archiving.get(id);
      if (!current) continue;
      current.count -= 1;
      if (current.count === 0) this.archiving.delete(id);
    }
  }

  archive(
    workspaceId: string,
    run: (signal: AbortSignal, input: WorkspaceArchiveRunInput) => Promise<ArchiveResult>,
  ): Promise<WorkspaceArchiveOutcome> {
    const current = this.lanes.get(workspaceId);
    if (current?.kind === "archiving") {
      return current.done;
    }
    const controller = new AbortController();
    const done = (async (): Promise<WorkspaceArchiveOutcome> => {
      await settled(current?.done);
      try {
        const result = await run(controller.signal, {
          archivedAt: this.partialArchiveStamps.get(workspaceId),
        });
        this.partialArchiveStamps.delete(workspaceId);
        return {
          kind: "archived",
          ...(result.archivedAt ? { archivedAt: result.archivedAt } : {}),
          result,
        };
      } catch (error) {
        if (error instanceof WorkspaceArchiveCanceledError) {
          // A cancellation may be observed after this lane has already
          // released. Preserve its shared stamp just like a failed partial
          // teardown so a later Undo restores only records this operation
          // actually confirmed.
          this.partialArchiveStamps.set(workspaceId, error.archivedAt);
          return { kind: "canceled", archivedAt: error.archivedAt };
        }
        if (error instanceof WorkspaceArchiveTeardownError && error.archivedAt) {
          this.partialArchiveStamps.set(workspaceId, error.archivedAt);
        }
        throw error;
      }
    })();
    this.claim(workspaceId, { kind: "archiving", controller, done });
    return done;
  }

  undo(
    workspaceId: string,
    restore: (input: WorkspaceArchiveUndoInput) => Promise<void>,
  ): Promise<void> {
    const current = this.lanes.get(workspaceId);
    if (current?.kind === "undoing") {
      return current.done;
    }
    if (current?.kind === "restoring" && current.pendingArchive === null) {
      return current.done;
    }
    let pendingArchive: PendingArchive | null = null;
    if (current?.kind === "archiving") {
      pendingArchive = { controller: current.controller, done: current.done };
    } else if (current?.kind === "restoring") {
      pendingArchive = current.pendingArchive;
    }
    pendingArchive?.controller.abort();
    const done = (async () => {
      const outcome = pendingArchive ? await pendingArchive.done.catch(() => undefined) : undefined;
      // A completed archive and a canceled partial archive both carry the same
      // operation stamp. Restoration must never fall back to every archived
      // record merely because the workspace record itself was committed.
      const archivedAt = outcome?.archivedAt ?? this.partialArchiveStamps.get(workspaceId);
      await restore({ archivedAt });
      // Do not erase a later operation's stamp. A failed restore deliberately
      // leaves this entry behind so its retry remains equally precise.
      if (archivedAt && this.partialArchiveStamps.get(workspaceId) === archivedAt) {
        this.partialArchiveStamps.delete(workspaceId);
      }
    })();
    if (current?.kind === "restoring") {
      current.supersededBy = done;
    }
    this.claim(workspaceId, { kind: "undoing", done });
    return done;
  }

  /**
   * Run a workspace recovery restore on the per-workspace lane so concurrent restores
   * across daemon sessions share one outcome and wait for checkout + validation to settle.
   * When queued behind an in-flight archive, the archive stays cancelable by a subsequent undo.
   */
  restore(workspaceId: string, run: () => Promise<void>): Promise<void> {
    const current = this.lanes.get(workspaceId);
    if (current?.kind === "undoing" || current?.kind === "restoring") {
      return current.done;
    }
    const pendingArchive: PendingArchive | null =
      current?.kind === "archiving" ? { controller: current.controller, done: current.done } : null;
    const entry: Extract<LaneEntry, { kind: "restoring" }> = {
      kind: "restoring",
      pendingArchive,
      supersededBy: null,
      done: Promise.resolve(),
    };
    entry.done = (async () => {
      if (pendingArchive) {
        await settled(pendingArchive.done);
        entry.pendingArchive = null;
        if (entry.supersededBy) {
          await entry.supersededBy;
          return;
        }
      } else {
        await settled(current?.done);
      }
      await run();
    })();
    this.claim(workspaceId, entry);
    return entry.done;
  }

  /**
   * Serialize mutations touching the same backing checkout directory across all daemon callers
   * (UI archive, CLI worktree archive, background auto-archive, undo, and recovery restore).
   */
  withCheckout<T>(checkoutPath: string, run: () => Promise<T>): Promise<T> {
    const key = normalizePathForIdentity(resolve(checkoutPath));
    const previous = this.checkoutGates.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const gate = previous ? previous.then(() => current) : current;
    this.checkoutGates.set(key, gate);
    const cleanup = () => {
      if (this.checkoutGates.get(key) === gate) {
        this.checkoutGates.delete(key);
      }
    };
    void gate.then(cleanup, cleanup);

    return (async () => {
      await settled(previous);
      try {
        return await run();
      } finally {
        release();
      }
    })();
  }

  private claim(workspaceId: string, entry: LaneEntry): void {
    this.lanes.set(workspaceId, entry);
    const release = () => {
      if (this.lanes.get(workspaceId) === entry) this.lanes.delete(workspaceId);
    };
    void (entry.done as Promise<unknown>).then(release, release);
  }
}

async function settled(promise: Promise<unknown> | undefined): Promise<void> {
  if (!promise) return;
  try {
    await promise;
  } catch {
    // The earlier request reports its own failure; this one only waits for the lane.
  }
}

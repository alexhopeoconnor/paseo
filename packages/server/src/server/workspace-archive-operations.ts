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

type LaneEntry =
  | { kind: "archiving"; controller: AbortController; done: Promise<WorkspaceArchiveOutcome> }
  | { kind: "undoing"; done: Promise<void> };

/**
 * One lane per workspace for archive and its undo, shared by every session on the daemon.
 *
 * - An archive while one runs joins it.
 * - An undo while an archive runs aborts it, waits for it to stop, then restores.
 * - An archive while an undo runs waits for the undo, then archives.
 * - An undo while an undo runs joins it.
 *
 * Each call claims the lane synchronously, so whichever request arrives last decides the
 * workspace's final state no matter how the earlier work interleaves.
 */
export class WorkspaceArchiveOperations {
  private readonly lanes = new Map<string, LaneEntry>();
  // A successful archive stamps its workspace record durably. Only a failed
  // partial archive remains active without such a record, so retain its stamp
  // in memory for an exact Undo or retry. A fresh daemon intentionally has no
  // such volatile recovery state.
  private readonly partialArchiveStamps = new Map<string, string>();

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
    current?.controller.abort();
    const done = (async () => {
      const outcome =
        current?.kind === "archiving" ? await current.done.catch(() => undefined) : undefined;
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
    this.claim(workspaceId, { kind: "undoing", done });
    return done;
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

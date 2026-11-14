import type { PersistStorage } from "zustand/middleware";

export const DRAFT_PERSIST_INTERVAL_MS = 200;
export interface PersistenceScheduler {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
}

export interface DraftPersistStorage<T> extends PersistStorage<T> {
  flush: () => Promise<void>;
  /** Flush the latest checkpoint and surface storage failure to a submission owner. */
  flushOrThrow: () => Promise<void>;
}

let nextSystemTimerId = 0;
const systemTimers = new Map<number, ReturnType<typeof setTimeout>>();
const systemScheduler: PersistenceScheduler = {
  now: Date.now,
  schedule: (callback, delayMs) => {
    const id = nextSystemTimerId++;
    systemTimers.set(
      id,
      setTimeout(() => {
        systemTimers.delete(id);
        callback();
      }, delayMs),
    );
    return id;
  },
  cancel: (handle) => {
    if (typeof handle !== "number") return;
    const timer = systemTimers.get(handle);
    if (timer === undefined) return;
    clearTimeout(timer);
    systemTimers.delete(handle);
  },
};

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false;
  }
  return "then" in value && typeof value.then === "function";
}

function getStorageOperationCompletion(result: unknown): Promise<void> | undefined {
  return isThenable(result) ? Promise.resolve(result).then(() => undefined) : undefined;
}

export function createDraftPersistStorage<T>(
  storage: PersistStorage<T>,
  scheduler?: PersistenceScheduler,
): DraftPersistStorage<T>;
export function createDraftPersistStorage<T>(
  storage: PersistStorage<T> | undefined,
  scheduler?: PersistenceScheduler,
): DraftPersistStorage<T> | undefined;
export function createDraftPersistStorage<T>(
  storage: PersistStorage<T> | undefined,
  scheduler: PersistenceScheduler = systemScheduler,
): DraftPersistStorage<T> | undefined {
  if (!storage) {
    return undefined;
  }

  interface PendingWrite {
    name: string;
    value: Parameters<typeof storage.setItem>[1];
    generation: number;
  }
  let pending: PendingWrite | null = null;
  let timer: unknown = null;
  let lastWriteAt = -Infinity;
  let latestMutationGeneration = 0;
  let writeTail: Promise<void> | null = null;
  // Concurrent durability callers join an async flush owner. The owner
  // restores a failed snapshot before its promise rejects, so a second caller
  // cannot observe the swallowed storage tail and incorrectly report success.
  let activeFlush: Promise<void> | null = null;

  const cancelTimer = () => {
    if (timer !== null) {
      scheduler.cancel(timer);
      timer = null;
    }
  };
  // Keep the first synchronous storage operation synchronous. Zustand callers
  // commonly do not await ordinary interval checkpoints or clears, and
  // turning every write into an async microtask made a completed timer leave
  // the previous draft visible. Async stores still serialize behind one tail.
  const enqueueStorageOperation = (operation: () => unknown): Promise<void> => {
    const trackAsyncOperation = (result: Promise<void>): Promise<void> => {
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      writeTail = settled;
      void settled.finally(() => {
        if (writeTail === settled) writeTail = null;
      });
      return result;
    };
    const previous = writeTail;
    if (previous) {
      return trackAsyncOperation(previous.then(() => getStorageOperationCompletion(operation())));
    }
    try {
      const completion = getStorageOperationCompletion(operation());
      if (completion) {
        return trackAsyncOperation(completion);
      }
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  };
  // A write can be started by another caller while this async function is
  // suspended. Reading through a function prevents control-flow narrowing
  // from incorrectly treating that concurrently updated slot as always null.
  const currentPending = (): PendingWrite | null => pending;
  const executeFlushOrThrow = async (): Promise<void> => {
    while (true) {
      const write = pending;
      pending = null;
      if (!write) {
        // A caller that needs a durability barrier must also wait for a
        // previously extracted/in-flight write, not return ahead of it.
        await writeTail;
        if (!currentPending()) return;
        continue;
      }
      lastWriteAt = scheduler.now();
      try {
        await enqueueStorageOperation(() => storage.setItem(write.name, write.value));
      } catch (error) {
        // Do not let an older completion overwrite a newer mutation. If a
        // newer checkpoint appeared while this write was in flight, commit it
        // before resolving the barrier; otherwise retain this failed write.
        const newerPending = currentPending();
        if (newerPending && newerPending.generation > write.generation) {
          continue;
        }
        if (latestMutationGeneration === write.generation && currentPending() === null) {
          pending = write;
        }
        throw error;
      }
    }
  };
  const flushOrThrow = (): Promise<void> => {
    cancelTimer();
    const inFlight = activeFlush;
    if (inFlight && writeTail) {
      // Preserve the first storage failure for every overlapping barrier.
      // Once it succeeds, re-check pending writes that arrived after its last
      // loop iteration before declaring this caller durable.
      return inFlight.then(() => flushOrThrow());
    }
    const flushPromise = executeFlushOrThrow();
    activeFlush = flushPromise;
    void flushPromise.then(
      () => {
        if (activeFlush === flushPromise) activeFlush = null;
        return undefined;
      },
      () => {
        if (activeFlush === flushPromise) activeFlush = null;
        return undefined;
      },
    );
    return flushPromise;
  };
  const flush = async (): Promise<void> => {
    try {
      await flushOrThrow();
    } catch (error) {
      console.warn("[DraftStore] Failed to persist draft checkpoint", error);
    }
  };

  return {
    getItem: (name) => storage.getItem(name),
    setItem: (name, value) => {
      pending = { name, value, generation: ++latestMutationGeneration };
      const delay = DRAFT_PERSIST_INTERVAL_MS - (scheduler.now() - lastWriteAt);
      if (delay <= 0) {
        return flush();
      }
      timer ??= scheduler.schedule(() => {
        void flush();
      }, delay);
    },
    removeItem: (name) => {
      cancelTimer();
      pending = null;
      latestMutationGeneration += 1;
      lastWriteAt = scheduler.now();
      return enqueueStorageOperation(() => storage.removeItem(name));
    },
    flush,
    flushOrThrow,
  };
}

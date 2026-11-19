import { z } from "zod";
import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";

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
  /**
   * Undefined only after the persisted draft state has hydrated successfully.
   * Attachment deletion must fail closed while it returns an error: raw draft
   * bytes may still reference a blob that is absent from memory.
   */
  getReferenceSafetyError: (name: string) => Error | undefined;
  /**
   * Captures the exact hydration generation that produced the current
   * reference view. Destructive attachment operations must assert this again
   * immediately before deletion: a later, even successfully completed,
   * rehydrate makes an earlier reference snapshot stale.
   */
  getReferenceSafetyAuthority: (name: string) => DraftReferenceSafetyAuthority;
  markReferenceHydrationComplete: (name: string) => Promise<void>;
  markReferenceHydrationFailed: (name: string, error: unknown) => void;
}

export interface DraftReferenceSafetyAuthority {
  assertCurrent: () => void;
}

interface DraftStorageWriteGate {
  getWriteBlockError: () => Error | undefined;
}

interface DraftStorageReferenceGate {
  getReferenceSafetyError: (name: string) => Error | undefined;
  getReferenceSafetyAuthority: (name: string) => DraftReferenceSafetyAuthority;
  markReferenceHydrationComplete: (name: string) => Promise<void>;
  markReferenceHydrationFailed: (name: string, error: unknown) => void;
}

function getWriteBlockError<T>(storage: PersistStorage<T>): Error | undefined {
  const candidate = storage as PersistStorage<T> & Partial<DraftStorageWriteGate>;
  return candidate.getWriteBlockError?.();
}

function getReferenceSafetyError<T>(storage: PersistStorage<T>, name: string): Error | undefined {
  const candidate = storage as PersistStorage<T> & Partial<DraftStorageReferenceGate>;
  return candidate.getReferenceSafetyError?.(name);
}

function readReferenceSafetyAuthority<T>(
  storage: PersistStorage<T>,
  name: string,
): DraftReferenceSafetyAuthority {
  const candidate = storage as PersistStorage<T> & Partial<DraftStorageReferenceGate>;
  if (candidate.getReferenceSafetyAuthority) {
    return candidate.getReferenceSafetyAuthority(name);
  }
  const error = candidate.getReferenceSafetyError?.(name);
  if (error) throw error;
  throw new Error(
    "Draft storage cannot prove that attachment references are current; preserving attachment bytes.",
  );
}

function completeReferenceHydration<T>(storage: PersistStorage<T>, name: string): Promise<void> {
  const candidate = storage as PersistStorage<T> & Partial<DraftStorageReferenceGate>;
  return candidate.markReferenceHydrationComplete?.(name) ?? Promise.resolve();
}

function markReferenceHydrationFailed<T>(
  storage: PersistStorage<T>,
  name: string,
  error: unknown,
): void {
  const candidate = storage as PersistStorage<T> & Partial<DraftStorageReferenceGate>;
  candidate.markReferenceHydrationFailed?.(name, error);
}

/**
 * Drafts are user-authored data, so invalid or newer on-disk bytes must never
 * take the generic settings-storage recovery path of deleting the whole key.
 * Instead, an unreadable/future envelope returns no hydrated state and latches
 * writes (including removes) for the session. An explicit durability barrier
 * then reports the block instead of falsely claiming that replacement bytes
 * were saved.
 */
export function createPreservingDraftPersistStorage<T>(input: {
  backingStorage: StateStorage;
  stateSchema: z.ZodType<T>;
  maxVersion: number;
  /**
   * Web-only synchronous view of the same raw backing bytes. It is optional
   * because native AsyncStorage has no cross-process atomicity claim.
   */
  readRawSync?: (name: string) => string | null;
  /**
   * Runs only after a current hydration/write generation has become safe for
   * reference collection. This is an availability signal, never an authority:
   * callers must still capture and assert a fresh authority before deletion.
   */
  onReferenceSafetyAvailable?: (name: string) => void;
}): PersistStorage<T> & DraftStorageWriteGate & DraftStorageReferenceGate {
  const envelopeSchema = z.strictObject({
    state: input.stateSchema,
    version: z.number().int().nonnegative().optional(),
  });
  const activeReadCounts = new Map<string, number>();
  const latestReadGeneration = new Map<string, number>();
  // A newer read can finish before an older overlapping read. Keep its
  // completion separate from the shared active-read count so the final older
  // completion can still recognize that the latest generation is valid and
  // ready to finalize. This never publishes a stale generation: the
  // finalizer still requires the latest completed generation below.
  const completedGenerations = new Map<string, Set<number>>();
  const completedReadGeneration = new Map<string, number>();
  const completedReads = new Set<string>();
  const hydratedReferenceNames = new Set<string>();
  const writeBlocks = new Map<string, Error>();
  const writeTails = new Map<string, Promise<void>>();
  const drainingDeferredMutations = new Set<string>();
  const drainingPromises = new Map<string, Promise<void>>();
  const finalizingReferenceHydration = new Set<string>();
  const referenceHydrationCompletions = new Map<
    string,
    { generation: number; promise: Promise<void> }
  >();
  const hydratedRawByGeneration = new Map<string, Map<number, string | null>>();
  const referenceAuthorities = new Map<
    string,
    { generation: number; epoch: number; raw: string | null | undefined }
  >();
  // Availability is an edge-triggered handoff, not a level-triggered event.
  // A drain can complete repeatedly without changing the durable reference
  // view; rescheduling attachment GC for each completion turns a single
  // fail-closed collector refusal into an unbounded retry loop. Keep the last
  // emitted authority epoch per key so only a freshly published safe view can
  // wake the collector again.
  const notifiedReferenceAuthorityEpoch = new Map<string, number>();
  let nextReferenceAuthorityEpoch = 0;

  interface DeferredMutation {
    write: (generation: number) => Promise<"written" | "superseded">;
    resolve: () => void;
    reject: (error: unknown) => void;
  }
  const deferredMutations = new Map<string, DeferredMutation[]>();

  const isReading = (name: string): boolean => (activeReadCounts.get(name) ?? 0) > 0;
  const isCurrentCompletedGeneration = (name: string, generation: number): boolean =>
    !isReading(name) &&
    latestReadGeneration.get(name) === generation &&
    completedReadGeneration.get(name) === generation;

  const beginRead = (name: string): number => {
    hydratedReferenceNames.delete(name);
    // A new read invalidates every previously collected reference snapshot
    // synchronously, before its backing-storage await starts.
    referenceAuthorities.delete(name);
    completedReads.delete(name);
    const generation = (latestReadGeneration.get(name) ?? 0) + 1;
    latestReadGeneration.set(name, generation);
    // Only the current latest generation matters after all overlapping reads
    // settle. A fresh set also bounds bookkeeping across manual rehydrates.
    completedGenerations.set(name, new Set());
    activeReadCounts.set(name, (activeReadCounts.get(name) ?? 0) + 1);
    return generation;
  };

  const finishRead = (name: string, generation: number): void => {
    const completed = completedGenerations.get(name) ?? new Set<number>();
    completed.add(generation);
    completedGenerations.set(name, completed);
    const remaining = (activeReadCounts.get(name) ?? 1) - 1;
    if (remaining > 0) {
      activeReadCounts.set(name, remaining);
      return;
    }
    activeReadCounts.delete(name);
    completedReads.add(name);
    const latest = latestReadGeneration.get(name);
    if (latest !== undefined && completed.has(latest)) {
      completedReadGeneration.set(name, latest);
    }
  };

  const rejectDeferredMutations = (name: string, error: unknown): void => {
    const queued = deferredMutations.get(name);
    if (!queued) return;
    deferredMutations.delete(name);
    for (const mutation of queued) {
      mutation.reject(error);
    }
  };

  const block = (name: string, message: string): Error => {
    const previous = writeBlocks.get(name);
    if (previous) return previous;
    const error = new Error(message);
    writeBlocks.set(name, error);
    referenceAuthorities.delete(name);
    rejectDeferredMutations(name, error);
    return error;
  };

  const requireWritable = (name: string): void => {
    const error = writeBlocks.get(name);
    if (error) throw error;
  };

  const referenceSafetyError = (name: string): Error | undefined => {
    const writeBlock = writeBlocks.get(name);
    if (writeBlock) return writeBlock;
    if (
      isReading(name) ||
      finalizingReferenceHydration.has(name) ||
      drainingDeferredMutations.has(name) ||
      deferredMutations.has(name) ||
      !hydratedReferenceNames.has(name)
    ) {
      let blocker = "no successful hydration generation published reference safety";
      if (isReading(name)) {
        blocker = "a draft read is still active";
      } else if (finalizingReferenceHydration.has(name)) {
        blocker = "hydration finalization is still active";
      } else if (drainingDeferredMutations.has(name)) {
        blocker = "a deferred draft mutation is still draining";
      } else if (deferredMutations.has(name)) {
        blocker = "a deferred draft mutation is waiting";
      }
      return new Error(
        `Draft storage has not hydrated safely (${blocker}); preserving attachment bytes until draft references are known.`,
      );
    }
    return undefined;
  };

  const notifyReferenceSafetyAvailable = (name: string): void => {
    if (referenceSafetyError(name)) return;
    const authority = referenceAuthorities.get(name);
    if (!authority || notifiedReferenceAuthorityEpoch.get(name) === authority.epoch) {
      return;
    }
    // Mark before the callback. The callback schedules asynchronous work and
    // may itself cause an ordinary draft persistence drain; that follow-up
    // must not redispatch this unchanged authority while the first collector
    // is still in flight.
    notifiedReferenceAuthorityEpoch.set(name, authority.epoch);
    // The callback schedules best-effort collection. It must never turn a
    // durable draft checkpoint into a failed hydration merely because a UI
    // notification implementation throws.
    try {
      input.onReferenceSafetyAvailable?.(name);
    } catch {
      // Reference authority remains available; a later normal draft mutation
      // or explicit collection request can still trigger a fresh pass.
      return;
    }
  };

  const recordHydratedRaw = (name: string, generation: number, raw: string | null): void => {
    if (!input.readRawSync) return;
    const values = hydratedRawByGeneration.get(name) ?? new Map<number, string | null>();
    values.set(generation, raw);
    hydratedRawByGeneration.set(name, values);
  };

  const readCurrentRaw = (name: string): string | null | undefined => {
    if (!input.readRawSync) return undefined;
    try {
      return input.readRawSync(name);
    } catch (error) {
      throw block(
        name,
        `Draft storage bytes could not be inspected for attachment retention (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  };

  const publishReferenceAuthority = (
    name: string,
    generation: number,
    raw: string | null | undefined,
  ): void => {
    referenceAuthorities.set(name, {
      generation,
      epoch: ++nextReferenceAuthorityEpoch,
      raw,
    });
  };

  const confirmHydratedRaw = (name: string, generation: number): string | null | undefined => {
    if (!input.readRawSync) return undefined;
    const expected = hydratedRawByGeneration.get(name)?.get(generation);
    if (expected === undefined && !hydratedRawByGeneration.get(name)?.has(generation)) {
      throw block(
        name,
        "Draft storage has no known-safe raw envelope for this hydration; preserving attachment bytes.",
      );
    }
    const actual = readCurrentRaw(name);
    if (actual !== expected) {
      throw block(
        name,
        "Draft storage bytes changed outside the hydrated reference generation; preserving attachment bytes.",
      );
    }
    return expected;
  };

  const confirmOwnWrite = (name: string, raw: string | null, expectedGeneration?: number): void => {
    if (input.readRawSync) {
      const actual = readCurrentRaw(name);
      if (actual !== raw) {
        throw block(
          name,
          "Draft storage bytes changed while writing; preserving attachment bytes without replacement.",
        );
      }
    }
    const currentGeneration = latestReadGeneration.get(name);
    if (expectedGeneration !== undefined && currentGeneration === expectedGeneration) {
      recordHydratedRaw(name, expectedGeneration, raw);
    }
    const authority = referenceAuthorities.get(name);
    if (authority && authority.generation === currentGeneration && !isReading(name)) {
      // A completed own write changes the durable reference view too. A
      // collector that captured before it must recollect rather than reuse a
      // same-generation authority (even if serialization happened to match).
      publishReferenceAuthority(name, authority.generation, input.readRawSync ? raw : undefined);
    }
  };

  const getReferenceSafetyAuthority = (name: string): DraftReferenceSafetyAuthority => {
    const error = referenceSafetyError(name);
    if (error) throw error;
    const authority = referenceAuthorities.get(name);
    if (!authority) {
      throw new Error(
        "Draft storage has no completed hydration authority; preserving attachment bytes.",
      );
    }
    const { generation, epoch, raw } = authority;
    return {
      assertCurrent: () => {
        const currentError = referenceSafetyError(name);
        if (currentError) throw currentError;
        if (latestReadGeneration.get(name) !== generation) {
          throw new Error(
            "Draft reference hydration generation changed; preserving attachment bytes until a fresh reference view is collected.",
          );
        }
        const currentAuthority = referenceAuthorities.get(name);
        if (currentAuthority?.epoch !== epoch) {
          throw new Error(
            "Draft reference authority changed; preserving attachment bytes until a fresh reference view is collected.",
          );
        }
        if (input.readRawSync && readCurrentRaw(name) !== raw) {
          throw new Error(
            "Draft storage raw bytes changed; preserving attachment bytes until a fresh reference view is collected.",
          );
        }
      },
    };
  };

  const enqueueSerializedWrite = <Result>(
    name: string,
    write: () => Promise<Result>,
  ): Promise<Result> => {
    const previous = writeTails.get(name) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(write);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    writeTails.set(name, settled);
    void settled.then(() => {
      if (writeTails.get(name) === settled) {
        writeTails.delete(name);
      }
      return undefined;
    });
    return result;
  };

  const persistSet = (
    name: string,
    serialized: string,
    expectedGeneration?: number,
  ): Promise<"written" | "superseded"> =>
    enqueueSerializedWrite(name, async () => {
      if (
        expectedGeneration !== undefined &&
        !isCurrentCompletedGeneration(name, expectedGeneration)
      ) {
        return "superseded";
      }
      requireWritable(name);
      try {
        await input.backingStorage.setItem(name, serialized);
        confirmOwnWrite(name, serialized, expectedGeneration);
        return "written";
      } catch (error) {
        throw block(
          name,
          `Draft storage could not be written; preserving attachment bytes without replacement (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    });

  const persistRemove = (
    name: string,
    expectedGeneration?: number,
  ): Promise<"written" | "superseded"> =>
    enqueueSerializedWrite(name, async () => {
      if (
        expectedGeneration !== undefined &&
        !isCurrentCompletedGeneration(name, expectedGeneration)
      ) {
        return "superseded";
      }
      requireWritable(name);
      try {
        await input.backingStorage.removeItem(name);
        confirmOwnWrite(name, null, expectedGeneration);
        return "written";
      } catch (error) {
        throw block(
          name,
          `Draft storage could not be cleared; preserving attachment bytes (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    });

  const deferMutation = (
    name: string,
    write: (generation: number) => Promise<"written" | "superseded">,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const writeBlock = writeBlocks.get(name);
      if (writeBlock) {
        reject(writeBlock);
        return;
      }
      const queued = deferredMutations.get(name) ?? [];
      queued.push({ write, resolve, reject });
      deferredMutations.set(name, queued);
    });

  const drainDeferredMutations = (name: string, generation: number): Promise<void> => {
    const inFlight = drainingPromises.get(name);
    if (inFlight) return inFlight;
    drainingDeferredMutations.add(name);
    let drainPromise!: Promise<void>;
    drainPromise = (async () => {
      try {
        while (true) {
          let queued = deferredMutations.get(name);
          let mutation = queued?.[0];
          if (!mutation) {
            deferredMutations.delete(name);
            // The caller starts its matching durability flush immediately
            // after opening the hydration gate. Include those microtask
            // enqueues before deciding the exact mutation queue is empty.
            await Promise.resolve();
            queued = deferredMutations.get(name);
            mutation = queued?.[0];
            if (!mutation) {
              deferredMutations.delete(name);
              return;
            }
          }
          const writeBlock = writeBlocks.get(name);
          if (writeBlock) {
            mutation.reject(writeBlock);
            rejectDeferredMutations(name, writeBlock);
            return;
          }

          try {
            if (!isCurrentCompletedGeneration(name, generation)) {
              return;
            }
            const result = await mutation.write(generation);
            if (result === "superseded") {
              // A newer getItem began after this finalizer opened. Keep the
              // exact mutation queued for that generation; resolving it here
              // would falsely satisfy a durability barrier.
              return;
            }
            queued?.shift();
            if (queued?.length === 0) {
              deferredMutations.delete(name);
            }
            mutation.resolve();
          } catch (error) {
            mutation.reject(error);
            rejectDeferredMutations(name, writeBlocks.get(name) ?? error);
            throw error;
          }
        }
      } finally {
        drainingDeferredMutations.delete(name);
        if (drainingPromises.get(name) === drainPromise) {
          drainingPromises.delete(name);
        }
        // A mutation can arrive after this drain's final empty-queue check
        // while its hydration finalizer is still active. Re-enter through the
        // finalizer rather than leaving a real user write stranded or marking
        // references safe around it.
        if (deferredMutations.has(name)) {
          queueMicrotask(() => {
            void markReferenceHydrationComplete(name).catch(() => undefined);
          });
        } else if (!finalizingReferenceHydration.has(name)) {
          // A persistence operation can arrive just after an earlier GC pass
          // observed this key draining. Re-signal only after this exact FIFO
          // drain has released its gate, so that source-driven cleanup is not
          // permanently lost between the old pass and a now-safe checkpoint.
          notifyReferenceSafetyAvailable(name);
        }
      }
    })();
    drainingPromises.set(name, drainPromise);
    return drainPromise;
  };

  const drainQueuedMutationsIfReferencesSafe = (name: string): void => {
    const generation = latestReadGeneration.get(name);
    if (
      generation === undefined ||
      !hydratedReferenceNames.has(name) ||
      finalizingReferenceHydration.has(name) ||
      !isCurrentCompletedGeneration(name, generation)
    ) {
      return;
    }
    void drainDeferredMutations(name, generation).catch(() => undefined);
  };

  const markReferenceHydrationComplete = (name: string): Promise<void> => {
    const generation = latestReadGeneration.get(name);
    const existingCompletion = referenceHydrationCompletions.get(name);
    if (existingCompletion) {
      if (existingCompletion.generation === generation) {
        return existingCompletion.promise;
      }
      // A stale callback may finish after a newer read. Once its completion
      // releases, re-check the newest generation rather than making old bytes
      // authoritative.
      return existingCompletion.promise.then(() => markReferenceHydrationComplete(name));
    }
    const writeBlock = writeBlocks.get(name);
    if (writeBlock) return Promise.reject(writeBlock);
    if (
      generation === undefined ||
      isReading(name) ||
      !completedReads.has(name) ||
      completedReadGeneration.get(name) !== generation
    ) {
      return Promise.resolve();
    }

    finalizingReferenceHydration.add(name);
    let completion!: Promise<void>;
    completion = (async () => {
      // Let the caller synchronously start the outer persistence barrier.
      // Any operation it passes through while this gate is open becomes a
      // deferred mutation and is drained below in exact call order.
      await Promise.resolve();
      if (isReading(name) || latestReadGeneration.get(name) !== generation) return;

      await writeTails.get(name);
      requireWritable(name);
      if (!isCurrentCompletedGeneration(name, generation)) return;
      while (true) {
        await drainDeferredMutations(name, generation);
        requireWritable(name);
        // The drain deliberately yields once after observing an empty queue
        // so the outer persistence barrier can enqueue its captured mutation.
        // A mutation can still land after that drain resolves but before this
        // finalizer continuation runs; loop and drain it rather than ending
        // the completion with a permanently deferred write/ref-safety gate.
        if (!isCurrentCompletedGeneration(name, generation)) return;
        if (deferredMutations.has(name) || drainingDeferredMutations.has(name)) {
          await Promise.resolve();
          continue;
        }
        // A current-version envelope is only safe for attachment deletion if
        // its exact raw bytes still match what this hydration (or its own
        // confirmed migration write) observed. Do not adopt a different,
        // possibly future/malformed envelope written by another web tab.
        const raw = confirmHydratedRaw(name, generation);
        if (!isCurrentCompletedGeneration(name, generation)) return;
        hydratedReferenceNames.add(name);
        const authority = referenceAuthorities.get(name);
        // Zustand may call the post-hydration callback more than once for one
        // completed read. That is not a new reference view. Keep the existing
        // authority so its one availability handoff remains one handoff; a
        // new read (generation) or a confirmed own write still deliberately
        // publishes a fresh epoch.
        if (authority?.generation !== generation || authority.raw !== raw) {
          publishReferenceAuthority(name, generation, raw);
        }
        return;
      }
    })()
      .catch((error) => {
        const latched =
          writeBlocks.get(name) ??
          block(
            name,
            `Draft storage hydration could not be finalized; preserving attachment bytes (${error instanceof Error ? error.message : String(error)}).`,
          );
        throw latched;
      })
      .finally(() => {
        finalizingReferenceHydration.delete(name);
        if (referenceHydrationCompletions.get(name)?.promise === completion) {
          referenceHydrationCompletions.delete(name);
        }
        // An outer flush can enqueue its exact mutation after this completion
        // has published hydrated references but before this finally block
        // clears `finalizingReferenceHydration`. Its normal fast-path then
        // correctly refuses to drain during finalization; restart the current
        // generation after the flag is gone so that mutation cannot strand
        // reference safety forever.
        if (deferredMutations.has(name)) {
          queueMicrotask(() => {
            void markReferenceHydrationComplete(name).catch(() => undefined);
          });
        } else {
          // Publish the availability signal after removing the finalization
          // gate. A collector scheduled while that gate is still set correctly
          // refuses deletion, but used to have no later source event to retry
          // once a final outer Zustand write had drained.
          notifyReferenceSafetyAvailable(name);
        }
      });
    referenceHydrationCompletions.set(name, { generation, promise: completion });
    return completion;
  };

  return {
    async getItem(name) {
      const generation = beginRead(name);
      try {
        let raw: string | null;
        try {
          raw = await input.backingStorage.getItem(name);
        } catch (error) {
          block(
            name,
            `Draft storage could not be read; preserving existing bytes without replacement (${error instanceof Error ? error.message : String(error)}).`,
          );
          return null;
        }
        if (raw === null) {
          recordHydratedRaw(name, generation, null);
          return null;
        }

        let decoded: unknown;
        try {
          decoded = JSON.parse(raw);
        } catch {
          block(
            name,
            "Draft storage contains malformed bytes; preserving them without replacement.",
          );
          return null;
        }
        const parsed = envelopeSchema.safeParse(decoded);
        if (!parsed.success) {
          block(name, "Draft storage has an unsupported shape; preserving it without replacement.");
          return null;
        }
        if ((parsed.data.version ?? 0) > input.maxVersion) {
          block(
            name,
            `Draft storage was written by a newer version (${parsed.data.version}); preserving it without replacement.`,
          );
          return null;
        }
        recordHydratedRaw(name, generation, raw);
        return parsed.data as StorageValue<T>;
      } finally {
        finishRead(name, generation);
      }
    },
    async setItem(name, value) {
      requireWritable(name);
      const parsed = envelopeSchema.safeParse(value);
      if (!parsed.success) {
        throw block(name, "Refusing to replace draft storage with an invalid envelope.");
      }
      if ((parsed.data.version ?? 0) > input.maxVersion) {
        throw block(
          name,
          `Refusing to replace draft storage with a future envelope (${parsed.data.version}).`,
        );
      }
      // Preserve the exact mutation requested by the caller. All mutations
      // pass through the per-key FIFO so a write that began just before a
      // newer getItem cannot overtake that read and replace unknown bytes.
      // This is deliberately operation-level, not a replay of a stale whole
      // Zustand snapshot.
      const serialized = JSON.stringify(parsed.data);
      const mutation = deferMutation(name, (generation) =>
        persistSet(name, serialized, generation),
      );
      drainQueuedMutationsIfReferencesSafe(name);
      return mutation;
    },
    async removeItem(name) {
      requireWritable(name);
      const mutation = deferMutation(name, (generation) => persistRemove(name, generation));
      drainQueuedMutationsIfReferencesSafe(name);
      return mutation;
    },
    getWriteBlockError: () => writeBlocks.values().next().value,
    getReferenceSafetyError: referenceSafetyError,
    getReferenceSafetyAuthority,
    markReferenceHydrationComplete,
    markReferenceHydrationFailed: (name, error) => {
      hydratedReferenceNames.delete(name);
      block(
        name,
        `Draft storage hydration failed; preserving attachment bytes (${error instanceof Error ? error.message : String(error)}).`,
      );
    },
  };
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
    const initiallyBlocked = getWriteBlockError(storage);
    if (initiallyBlocked) throw initiallyBlocked;
    while (true) {
      const write = pending;
      pending = null;
      if (!write) {
        // A caller that needs a durability barrier must also wait for a
        // previously extracted/in-flight write, not return ahead of it.
        await writeTail;
        if (!currentPending()) {
          const blocked = getWriteBlockError(storage);
          if (blocked) throw blocked;
          return;
        }
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
        // Zustand awaits its migration write before calling the hydration
        // finalizer that releases our write gate. Scheduled checkpoints must
        // not join that wait; durability callers explicitly use flushOrThrow.
        void flush();
        return;
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
    getReferenceSafetyError: (name) => getReferenceSafetyError(storage, name),
    getReferenceSafetyAuthority: (name) => readReferenceSafetyAuthority(storage, name),
    markReferenceHydrationComplete: (name) => completeReferenceHydration(storage, name),
    markReferenceHydrationFailed: (name, error) =>
      markReferenceHydrationFailed(storage, name, error),
  };
}

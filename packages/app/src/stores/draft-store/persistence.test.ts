import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";
import {
  createDraftPersistStorage,
  createPreservingDraftPersistStorage,
  DRAFT_PERSIST_INTERVAL_MS,
  type PersistenceScheduler,
} from "./persistence";

interface DraftState {
  text: string;
}

const DraftStateSchema: z.ZodType<DraftState> = z.strictObject({ text: z.string() });

function createMemoryBackingStorage(initial?: Record<string, string>) {
  const values = new Map(Object.entries(initial ?? {}));
  let writes = 0;
  let removals = 0;
  const storage: StateStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      writes += 1;
      values.set(name, value);
    },
    removeItem: (name) => {
      removals += 1;
      values.delete(name);
    },
  };
  return {
    storage,
    values,
    get writes() {
      return writes;
    },
    get removals() {
      return removals;
    },
  };
}

function createDraftPersistence() {
  let nowMs = 0;
  let saved: StorageValue<DraftState> | null = null;
  let scheduled: { callback: () => void; dueAt: number } | null = null;
  const storage: PersistStorage<DraftState> = {
    getItem: () => saved,
    setItem: (_name, value) => {
      saved = value;
    },
    removeItem: () => {
      saved = null;
    },
  };
  const scheduler: PersistenceScheduler = {
    now: () => nowMs,
    schedule: (callback, delayMs) => (scheduled = { callback, dueAt: nowMs + delayMs }),
    cancel: () => {
      scheduled = null;
    },
  };
  const drafts = createDraftPersistStorage(storage, scheduler);

  return {
    save(text: string) {
      drafts.setItem("drafts", { state: { text } });
    },
    remove() {
      drafts.removeItem("drafts");
    },
    flush() {
      return drafts.flush();
    },
    advance(ms: number) {
      nowMs += ms;
      if (scheduled && scheduled.dueAt <= nowMs) {
        const { callback } = scheduled;
        scheduled = null;
        callback();
      }
    },
    text() {
      return saved?.state.text ?? null;
    },
  };
}

describe("draft persistence", () => {
  it("checkpoints the first change and the latest change in each interval", () => {
    const drafts = createDraftPersistence();

    drafts.save("a");
    drafts.save("ab");
    drafts.save("abc");
    expect(drafts.text()).toBe("a");

    drafts.advance(DRAFT_PERSIST_INTERVAL_MS - 1);
    expect(drafts.text()).toBe("a");

    drafts.advance(1);
    expect(drafts.text()).toBe("abc");
  });

  it("does not restore a pending draft after storage is cleared", () => {
    const drafts = createDraftPersistence();

    drafts.save("first checkpoint");
    drafts.save("pending checkpoint");
    drafts.remove();
    drafts.advance(DRAFT_PERSIST_INTERVAL_MS);

    expect(drafts.text()).toBeNull();
  });

  it("continues checkpointing the latest change across consecutive intervals", () => {
    const drafts = createDraftPersistence();

    drafts.save("first");
    drafts.save("first interval");
    drafts.advance(DRAFT_PERSIST_INTERVAL_MS);
    expect(drafts.text()).toBe("first interval");

    drafts.save("second");
    drafts.save("second interval");
    drafts.advance(DRAFT_PERSIST_INTERVAL_MS);
    expect(drafts.text()).toBe("second interval");
  });

  it("flushes the latest pending change before the interval ends", async () => {
    const drafts = createDraftPersistence();

    drafts.save("first checkpoint");
    drafts.save("pending checkpoint");
    await drafts.flush();

    expect(drafts.text()).toBe("pending checkpoint");
  });

  it("serializes an in-flight checkpoint before committing and resolving a newer flush", async () => {
    let resolveFirstWrite!: () => void;
    let saved: StorageValue<DraftState> | null = null;
    const writes: string[] = [];
    const firstWrite = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve;
    });
    const readSaved = (): StorageValue<DraftState> | null => saved;
    const storage: PersistStorage<DraftState> = {
      getItem: () => saved,
      setItem: async (_name, value) => {
        writes.push(value.state.text);
        if (value.state.text === "older") {
          await firstWrite;
        }
        saved = value;
      },
      removeItem: () => {
        saved = null;
      },
    };
    const scheduler: PersistenceScheduler = {
      now: () => 0,
      schedule: () => 0,
      cancel: () => undefined,
    };
    const drafts = createDraftPersistStorage(storage, scheduler);
    if (!drafts) throw new Error("Expected draft persistence");

    void drafts.setItem("drafts", { state: { text: "older" } });
    drafts.setItem("drafts", { state: { text: "newer" } });
    const durabilityBarrier = drafts.flushOrThrow();
    expect(writes).toEqual(["older"]);

    resolveFirstWrite();
    await durabilityBarrier;

    expect(writes).toEqual(["older", "newer"]);
    expect(readSaved()?.state.text).toBe("newer");
  });

  it("serializes a clear after an in-flight checkpoint so delayed bytes cannot restore a draft", async () => {
    let resolveFirstWrite!: () => void;
    let saved: StorageValue<DraftState> | null = null;
    const readSaved = (): StorageValue<DraftState> | null => saved;
    const firstWrite = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve;
    });
    const storage: PersistStorage<DraftState> = {
      getItem: () => saved,
      setItem: async (_name, value) => {
        await firstWrite;
        saved = value;
      },
      removeItem: () => {
        saved = null;
      },
    };
    const scheduler: PersistenceScheduler = {
      now: () => 0,
      schedule: () => 0,
      cancel: () => undefined,
    };
    const drafts = createDraftPersistStorage(storage, scheduler);
    if (!drafts) throw new Error("Expected draft persistence");

    void drafts.setItem("drafts", { state: { text: "older" } });
    const clear = drafts.removeItem("drafts");
    resolveFirstWrite();
    await clear;

    expect(readSaved()).toBeNull();
  });

  it("keeps malformed persisted bytes untouched and latches every replacement path", async () => {
    const raw = "{not-json";
    const backing = createMemoryBackingStorage({ "paseo-drafts": raw });
    const storage = createPreservingDraftPersistStorage({
      backingStorage: backing.storage,
      stateSchema: DraftStateSchema,
      maxVersion: 7,
    });

    await expect(storage.getItem("paseo-drafts")).resolves.toBeNull();
    await expect(
      storage.setItem("paseo-drafts", { state: { text: "replacement" }, version: 7 }),
    ).rejects.toThrow(/malformed bytes/);
    await expect(storage.removeItem("paseo-drafts")).rejects.toThrow(/malformed bytes/);

    expect(backing.values.get("paseo-drafts")).toBe(raw);
    expect(backing.writes).toBe(0);
    expect(backing.removals).toBe(0);
  });

  it("keeps a future envelope untouched and makes a durability barrier fail", async () => {
    const raw = JSON.stringify({ state: { text: "future draft" }, version: 9 });
    const backing = createMemoryBackingStorage({ "paseo-drafts": raw });
    const storage = createPreservingDraftPersistStorage({
      backingStorage: backing.storage,
      stateSchema: DraftStateSchema,
      maxVersion: 8,
    });
    const drafts = createDraftPersistStorage(storage, {
      now: () => 0,
      schedule: () => 0,
      cancel: () => undefined,
    });

    await expect(drafts.getItem("paseo-drafts")).resolves.toBeNull();
    await expect(drafts.flushOrThrow()).rejects.toThrow(/newer version/);
    await expect(drafts.removeItem("paseo-drafts")).rejects.toThrow(/newer version/);

    expect(backing.values.get("paseo-drafts")).toBe(raw);
    expect(backing.writes).toBe(0);
    expect(backing.removals).toBe(0);
  });

  it.each([6, 7])("accepts a supported v%s envelope", async (version) => {
    const backing = createMemoryBackingStorage({
      "paseo-drafts": JSON.stringify({ state: { text: `v${version}` }, version }),
    });
    const storage = createPreservingDraftPersistStorage({
      backingStorage: backing.storage,
      stateSchema: DraftStateSchema,
      maxVersion: 8,
    });

    await expect(storage.getItem("paseo-drafts")).resolves.toEqual({
      state: { text: `v${version}` },
      version,
    });
    expect(storage.getWriteBlockError()).toBeUndefined();
  });

  it("serializes a real edit made during a delayed valid read after hydration", async () => {
    let releaseRead!: (value: string | null) => void;
    const writes: string[] = [];
    const read = new Promise<string | null>((resolve) => {
      releaseRead = resolve;
    });
    const storage = createPreservingDraftPersistStorage({
      backingStorage: {
        getItem: () => read,
        setItem: async (_name, value) => {
          writes.push(value);
        },
        removeItem: async () => undefined,
      },
      stateSchema: DraftStateSchema,
      maxVersion: 8,
    });

    const hydration = storage.getItem("paseo-drafts");
    const edit = storage.setItem("paseo-drafts", {
      state: { text: "edited while reading" },
      version: 8,
    });
    releaseRead(JSON.stringify({ state: { text: "old draft" }, version: 7 }));
    await expect(hydration).resolves.toEqual({ state: { text: "old draft" }, version: 7 });
    await storage.markReferenceHydrationComplete("paseo-drafts");
    await expect(edit).resolves.toBeUndefined();
    expect(writes).toEqual([
      JSON.stringify({ state: { text: "edited while reading" }, version: 8 }),
    ]);
  });

  it("serializes a clear made during a delayed read so old bytes are not revived", async () => {
    let releaseRead!: (value: string | null) => void;
    let removals = 0;
    const read = new Promise<string | null>((resolve) => {
      releaseRead = resolve;
    });
    const storage = createPreservingDraftPersistStorage({
      backingStorage: {
        getItem: () => read,
        setItem: async () => undefined,
        removeItem: async () => {
          removals += 1;
        },
      },
      stateSchema: DraftStateSchema,
      maxVersion: 8,
    });

    const hydration = storage.getItem("paseo-drafts");
    const clear = storage.removeItem("paseo-drafts");
    releaseRead(JSON.stringify({ state: { text: "old draft" }, version: 7 }));
    await hydration;
    await storage.markReferenceHydrationComplete("paseo-drafts");
    await expect(clear).resolves.toBeUndefined();
    expect(removals).toBe(1);
  });

  it("keeps the latest edit after mixed pre-hydration edit, clear, and edit", async () => {
    let releaseRead!: (value: string | null) => void;
    const operations: string[] = [];
    const read = new Promise<string | null>((resolve) => {
      releaseRead = resolve;
    });
    const storage = createPreservingDraftPersistStorage({
      backingStorage: {
        getItem: () => read,
        setItem: async (_name, value) => {
          operations.push(`set:${value}`);
        },
        removeItem: async () => {
          operations.push("remove");
        },
      },
      stateSchema: DraftStateSchema,
      maxVersion: 8,
    });

    const hydration = storage.getItem("paseo-drafts");
    const first = storage.setItem("paseo-drafts", { state: { text: "A" }, version: 8 });
    const clear = storage.removeItem("paseo-drafts");
    const latest = storage.setItem("paseo-drafts", { state: { text: "B" }, version: 8 });
    releaseRead(null);
    await hydration;
    await storage.markReferenceHydrationComplete("paseo-drafts");
    await Promise.all([first, clear, latest]);
    expect(operations).toEqual([
      `set:${JSON.stringify({ state: { text: "A" }, version: 8 })}`,
      "remove",
      `set:${JSON.stringify({ state: { text: "B" }, version: 8 })}`,
    ]);
  });

  it("rejects a queued mutation and preserves future raw bytes", async () => {
    let releaseRead!: (value: string | null) => void;
    const raw = JSON.stringify({ state: { text: "future" }, version: 9 });
    let writes = 0;
    const read = new Promise<string | null>((resolve) => {
      releaseRead = resolve;
    });
    const storage = createPreservingDraftPersistStorage({
      backingStorage: {
        getItem: () => read,
        setItem: async () => {
          writes += 1;
        },
        removeItem: async () => {
          writes += 1;
        },
      },
      stateSchema: DraftStateSchema,
      maxVersion: 8,
    });

    const hydration = storage.getItem("paseo-drafts");
    const edit = storage.setItem("paseo-drafts", { state: { text: "new" }, version: 8 });
    releaseRead(raw);
    await hydration;
    await expect(edit).rejects.toThrow(/newer version/);
    await expect(storage.markReferenceHydrationComplete("paseo-drafts")).rejects.toThrow(
      /newer version/,
    );
    expect(writes).toBe(0);
  });

  it("keeps a durability barrier pending through hydration and rejects it for future bytes", async () => {
    let releaseRead!: (value: string | null) => void;
    const read = new Promise<string | null>((resolve) => {
      releaseRead = resolve;
    });
    const preserving = createPreservingDraftPersistStorage({
      backingStorage: {
        getItem: () => read,
        setItem: async () => undefined,
        removeItem: async () => undefined,
      },
      stateSchema: DraftStateSchema,
      maxVersion: 8,
    });
    const drafts = createDraftPersistStorage(preserving, {
      now: () => 0,
      schedule: () => 0,
      cancel: () => undefined,
    });
    if (!drafts) throw new Error("Expected draft persistence");

    const hydration = drafts.getItem("paseo-drafts");
    void drafts.setItem("paseo-drafts", { state: { text: "must be durable" }, version: 8 });
    const barrier = drafts.flushOrThrow();
    releaseRead(JSON.stringify({ state: { text: "future" }, version: 9 }));
    await hydration;
    await expect(barrier).rejects.toThrow(/newer version/);
  });

  it("leaves a deferred mutation for a newer overlapping hydration instead of overwriting it", async () => {
    let releaseFirstRead!: (value: string | null) => void;
    let releaseSecondRead!: (value: string | null) => void;
    let writes = 0;
    let removals = 0;
    const firstRaw = JSON.stringify({ state: { text: "first" }, version: 8 });
    const futureRaw = JSON.stringify({ state: { text: "future" }, version: 9 });
    let durableRaw: string | null = firstRaw;
    const firstRead = new Promise<string | null>((resolve) => {
      releaseFirstRead = resolve;
    });
    const secondRead = new Promise<string | null>((resolve) => {
      releaseSecondRead = resolve;
    });
    let reads = 0;
    const storage = createPreservingDraftPersistStorage({
      backingStorage: {
        getItem: () => (reads++ === 0 ? firstRead : secondRead),
        setItem: async (_name, value) => {
          writes += 1;
          durableRaw = value;
        },
        removeItem: async () => {
          removals += 1;
          durableRaw = null;
        },
      },
      stateSchema: DraftStateSchema,
      maxVersion: 8,
    });
    const drafts = createDraftPersistStorage(storage, {
      now: () => 0,
      schedule: () => 0,
      cancel: () => undefined,
    });
    if (!drafts) throw new Error("Expected draft persistence");

    const firstHydration = storage.getItem("paseo-drafts");
    void drafts.setItem("paseo-drafts", { state: { text: "queued" }, version: 8 });
    const durabilityBarrier = drafts.flushOrThrow();
    releaseFirstRead(firstRaw);
    await firstHydration;
    const migration = storage.setItem("paseo-drafts", { state: { text: "migration" }, version: 8 });
    const firstFinalize = storage.markReferenceHydrationComplete("paseo-drafts");
    const secondHydration = storage.getItem("paseo-drafts");
    durableRaw = futureRaw;
    releaseSecondRead(futureRaw);
    await Promise.allSettled([migration, firstFinalize, secondHydration]);
    await expect(durabilityBarrier).rejects.toThrow(/newer version/);
    await expect(storage.markReferenceHydrationComplete("paseo-drafts")).rejects.toThrow(
      /newer version/,
    );
    // The canonical migration write was queued behind G1's finalizer. G2's
    // future envelope began before that backing write could start, so neither
    // the migration nor the user's deferred edit may replace the raw bytes.
    expect(writes).toBe(0);
    expect(removals).toBe(0);
    expect(durableRaw).toBe(futureRaw);
    expect(storage.getReferenceSafetyError("paseo-drafts")).toBeInstanceOf(Error);
  });

  it("finishes a queued edit after an older read releases a newer valid hydration", async () => {
    let releaseFirstRead!: (value: string | null) => void;
    let releaseSecondRead!: (value: string | null) => void;
    const writes: string[] = [];
    const firstRead = new Promise<string | null>((resolve) => {
      releaseFirstRead = resolve;
    });
    const secondRead = new Promise<string | null>((resolve) => {
      releaseSecondRead = resolve;
    });
    let reads = 0;
    const safetyAvailable: string[] = [];
    const preserving = createPreservingDraftPersistStorage({
      backingStorage: {
        getItem: () => (reads++ === 0 ? firstRead : secondRead),
        setItem: async (_name, value) => {
          writes.push(value);
        },
        removeItem: async () => undefined,
      },
      stateSchema: DraftStateSchema,
      maxVersion: 8,
      onReferenceSafetyAvailable: (name) => safetyAvailable.push(name),
    });
    const drafts = createDraftPersistStorage(preserving, {
      now: () => 0,
      schedule: () => 0,
      cancel: () => undefined,
    });
    if (!drafts) throw new Error("Expected draft persistence");

    const firstHydration = drafts.getItem("paseo-drafts");
    const secondHydration = drafts.getItem("paseo-drafts");
    const queuedEdit = drafts.setItem("paseo-drafts", {
      state: { text: "queued after overlap" },
      version: 8,
    });
    const durabilityBarrier = drafts.flushOrThrow();
    let barrierSettled = false;
    void durabilityBarrier.then(() => {
      barrierSettled = true;
      return undefined;
    });

    // The newest read returns first, but G1 remains in flight. Its callback
    // cannot publish references or drain the edit yet.
    releaseSecondRead(JSON.stringify({ state: { text: "newest" }, version: 8 }));
    await expect(secondHydration).resolves.toEqual({ state: { text: "newest" }, version: 8 });
    await preserving.markReferenceHydrationComplete("paseo-drafts");
    await Promise.resolve();
    expect(barrierSettled).toBe(false);
    expect(preserving.getReferenceSafetyError("paseo-drafts")).toBeInstanceOf(Error);
    expect(safetyAvailable).toEqual([]);

    // Once the older read completes, the tracker must recognize that the
    // current generation already completed successfully, publish only that
    // generation, and drain the exact queued edit.
    releaseFirstRead(JSON.stringify({ state: { text: "older" }, version: 8 }));
    await expect(firstHydration).resolves.toEqual({ state: { text: "older" }, version: 8 });
    await preserving.markReferenceHydrationComplete("paseo-drafts");
    await Promise.all([queuedEdit, durabilityBarrier]);

    expect(writes).toEqual([
      JSON.stringify({ state: { text: "queued after overlap" }, version: 8 }),
    ]);
    expect(preserving.getReferenceSafetyError("paseo-drafts")).toBeUndefined();
    expect(safetyAvailable).toEqual(["paseo-drafts"]);
  });

  it("signals safe reference availability once per authority, then again after an own write", async () => {
    const safetyAvailable: string[] = [];
    const backing = createMemoryBackingStorage({
      "paseo-drafts": JSON.stringify({ state: { text: "hydrated" }, version: 8 }),
    });
    const storage = createPreservingDraftPersistStorage({
      backingStorage: backing.storage,
      stateSchema: DraftStateSchema,
      maxVersion: 8,
      onReferenceSafetyAvailable: (name) => safetyAvailable.push(name),
    });

    await storage.getItem("paseo-drafts");
    await storage.markReferenceHydrationComplete("paseo-drafts");
    // Zustand can invoke a hydration callback more than once. With no new
    // read or write, a second completion must not turn one safe handoff into
    // another GC schedule.
    await storage.markReferenceHydrationComplete("paseo-drafts");
    expect(safetyAvailable).toEqual(["paseo-drafts"]);

    await storage.setItem("paseo-drafts", {
      state: { text: "own durable update" },
      version: 8,
    });
    // A confirmed own write changes the durable reference view, so it creates
    // exactly one fresh authority handoff for a later source-driven collector.
    expect(safetyAvailable).toEqual(["paseo-drafts", "paseo-drafts"]);
  });
});

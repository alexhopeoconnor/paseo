import { describe, expect, it } from "vitest";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import {
  createDraftPersistStorage,
  DRAFT_PERSIST_INTERVAL_MS,
  type PersistenceScheduler,
} from "./persistence";

interface DraftState {
  text: string;
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
});

import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MemoryHistory {
  readonly index: number;
  push(input: { path: string; state: unknown }): void;
  replace(input: { path: string; state: unknown }): void;
  go(distance: number): Promise<void> | undefined;
  listen(listener: () => void): () => void;
}

type PopStateListener = () => void;

interface FakeBrowser {
  readonly go: ReturnType<typeof vi.fn>;
  readonly path: string;
  popStateListenerCount(): number;
  setGoDelay(delayMs: number | null): void;
  traverseExternally(distance: number): void;
}

const require = createRequire(import.meta.url);
const { createMemoryHistory } = require("expo-router/build/fork/createMemoryHistory") as {
  createMemoryHistory(): MemoryHistory;
};

const STATE = {
  key: "memory-history-test-stack",
  type: "stack",
  index: 0,
  routeNames: ["screen"],
  routes: [{ key: "memory-history-test-screen", name: "screen" }],
  stale: false,
};

function installFakeBrowser(initialGoDelayMs: number | null): FakeBrowser {
  let index = 0;
  let goDelayMs = initialGoDelayMs;
  let entries: { path: string; state: unknown }[] = [{ path: "/", state: null }];
  const popStateListeners = new Set<PopStateListener>();

  const emitPopState = () => {
    for (const listener of Array.from(popStateListeners)) {
      listener();
    }
  };
  const traverse = (distance: number) => {
    const nextIndex = index + distance;
    if (nextIndex < 0 || nextIndex >= entries.length) {
      return;
    }
    index = nextIndex;
    emitPopState();
  };
  const history = {
    get state() {
      return entries[index]?.state ?? null;
    },
    pushState(state: unknown, _title: string, path: string) {
      entries = [...entries.slice(0, index + 1), { path, state }];
      index = entries.length - 1;
    },
    replaceState(state: unknown, _title: string, path: string) {
      entries[index] = { path, state };
    },
    go: vi.fn((distance: number) => {
      if (goDelayMs === null) {
        return;
      }
      setTimeout(() => traverse(distance), goDelayMs);
    }),
  };

  vi.stubGlobal("window", {
    history,
    document: { title: "Paseo" },
    addEventListener(type: string, listener: PopStateListener) {
      if (type === "popstate") {
        popStateListeners.add(listener);
      }
    },
    removeEventListener(type: string, listener: PopStateListener) {
      if (type === "popstate") {
        popStateListeners.delete(listener);
      }
    },
  });
  vi.stubGlobal("location", { hash: "" });

  return {
    go: history.go,
    get path() {
      return entries[index]?.path ?? "";
    },
    popStateListenerCount: () => popStateListeners.size,
    setGoDelay: (nextDelayMs) => {
      goDelayMs = nextDelayMs;
    },
    traverseExternally: traverse,
  };
}

function seededHistory(): MemoryHistory {
  const history = createMemoryHistory();
  history.replace({ path: "/one", state: STATE });
  history.push({ path: "/two", state: STATE });
  return history;
}

function requireNavigation(navigation: Promise<void> | undefined): Promise<void> {
  if (!navigation) {
    throw new Error("Expected history.go to begin a traversal");
  }
  return navigation;
}

describe("Expo Router delayed browser history patch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("settles an actual browser pop that arrives after 100 ms without notifying the external listener", async () => {
    const browser = installFakeBrowser(150);
    const history = seededHistory();
    const listener = vi.fn();
    const unlisten = history.listen(listener);
    const navigation = requireNavigation(history.go(-1));

    await vi.advanceTimersByTimeAsync(150);

    await expect(navigation).resolves.toBeUndefined();
    expect(browser.go).toHaveBeenCalledExactlyOnceWith(-1);
    expect(browser.path).toBe("/one");
    expect(history.index).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    unlisten();
  });

  it("rejects a non-arrival, removes its one-shot listener, and permits later browser history", async () => {
    const browser = installFakeBrowser(null);
    const history = seededHistory();
    const listener = vi.fn();
    const unlisten = history.listen(listener);
    const timedOutNavigation = requireNavigation(history.go(-1));
    const timeoutAssertion = expect(timedOutNavigation).rejects.toThrow(
      "History was changed during navigation.",
    );

    await vi.advanceTimersByTimeAsync(1000);

    await timeoutAssertion;
    expect(browser.popStateListenerCount()).toBe(1);
    expect(history.index).toBe(1);

    browser.setGoDelay(0);
    const laterNavigation = requireNavigation(history.go(-1));
    await vi.runAllTimersAsync();
    await expect(laterNavigation).resolves.toBeUndefined();
    expect(listener).not.toHaveBeenCalled();

    history.push({ path: "/three", state: STATE });
    browser.traverseExternally(-1);
    expect(listener).toHaveBeenCalledTimes(1);
    unlisten();
  });

  it("keeps interruption, zero-distance, and bounded traversal behavior intact", async () => {
    installFakeBrowser(150);
    const history = seededHistory();
    const interruptedNavigation = requireNavigation(history.go(-1));
    const interruptionAssertion = expect(interruptedNavigation).rejects.toThrow(
      "History was changed during navigation.",
    );
    history.push({ path: "/three", state: STATE });

    await vi.advanceTimersByTimeAsync(150);
    await interruptionAssertion;

    const boundedBrowser = installFakeBrowser(0);
    const boundedHistory = seededHistory();
    const callsBeforeZeroDistance = boundedBrowser.go.mock.calls.length;
    expect(boundedHistory.go(0)).toBeUndefined();
    expect(boundedBrowser.go).toHaveBeenCalledTimes(callsBeforeZeroDistance);

    const boundedNavigation = requireNavigation(boundedHistory.go(-99));
    await vi.runAllTimersAsync();
    await expect(boundedNavigation).resolves.toBeUndefined();
    expect(boundedBrowser.go).toHaveBeenLastCalledWith(-1);
    expect(boundedHistory.index).toBe(0);
  });
});

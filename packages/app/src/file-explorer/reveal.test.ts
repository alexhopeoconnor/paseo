import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeExplorerReveal,
  cancelExplorerReveal,
  claimExplorerReveal,
  peekExplorerReveal,
  requestExplorerReveal,
  subscribeExplorerReveals,
} from "./reveal";

afterEach(() => {
  vi.useRealTimers();
});

describe("scoped Explorer reveal", () => {
  it("keeps one pending selection per workspace until the tree acknowledges it", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const pending = requestExplorerReveal({
      workspaceKey: "server:workspace-a",
      path: "src/index.ts",
      intent: "explicit",
    });
    expect(peekExplorerReveal("server:workspace-a")).toMatchObject({
      path: "src/index.ts",
      intent: "explicit",
      expiresAt: 16_000,
    });
    const request = peekExplorerReveal("server:workspace-a")!;
    expect(claimExplorerReveal("server:workspace-a", request.id)).toBe(request);
    // The owning tree still sees its claimed request across rerenders; another claimant cannot.
    expect(peekExplorerReveal("server:workspace-a")).toBe(request);
    expect(claimExplorerReveal("server:workspace-a", request.id)).toBeNull();
    acknowledgeExplorerReveal("server:workspace-a", request.id, "revealed");
    expect(peekExplorerReveal("server:workspace-a")).toBeNull();
    await expect(pending.result).resolves.toBe("revealed");
  });

  it("supersedes a pending reveal instead of stacking selections", async () => {
    vi.useFakeTimers({ now: 0 });
    const first = requestExplorerReveal({
      workspaceKey: "server:workspace-b",
      path: "first.ts",
      intent: "auto",
    });
    const second = requestExplorerReveal({
      workspaceKey: "server:workspace-b",
      path: "second.ts",
      intent: "auto",
    });
    await expect(first.result).resolves.toBe("cancelled");
    expect(peekExplorerReveal("server:workspace-b")?.path).toBe("second.ts");
    second.cancel();
    await expect(second.result).resolves.toBe("cancelled");
  });

  it("drops an unconsumed reveal at the bounded TTL", async () => {
    vi.useFakeTimers({ now: 0 });
    const listener = vi.fn();
    const unsubscribe = subscribeExplorerReveals(listener);
    const pending = requestExplorerReveal({
      workspaceKey: "server:workspace-c",
      path: "stale.ts",
      intent: "auto",
      ttlMs: 2_000,
    });
    vi.advanceTimersByTime(1_999);
    expect(peekExplorerReveal("server:workspace-c")?.path).toBe("stale.ts");
    vi.advanceTimersByTime(1);
    expect(peekExplorerReveal("server:workspace-c")).toBeNull();
    await expect(pending.result).resolves.toBe("cancelled");
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("clamps an out-of-range TTL", () => {
    vi.useFakeTimers({ now: 0 });
    const short = requestExplorerReveal({
      workspaceKey: "server:workspace-d",
      path: "short.ts",
      intent: "auto",
      ttlMs: 10,
    });
    expect(peekExplorerReveal("server:workspace-d")?.expiresAt).toBe(1_000);
    const long = requestExplorerReveal({
      workspaceKey: "server:workspace-e",
      path: "long.ts",
      intent: "auto",
      ttlMs: 120_000,
    });
    expect(peekExplorerReveal("server:workspace-e")?.expiresAt).toBe(30_000);
    short.cancel();
    long.cancel();
  });

  it("cancels on an abort signal or an explicit cancel", async () => {
    vi.useFakeTimers({ now: 0 });
    const controller = new AbortController();
    const aborted = requestExplorerReveal({
      workspaceKey: "server:workspace-f",
      path: "aborted.ts",
      intent: "explicit",
      signal: controller.signal,
    });
    controller.abort();
    expect(peekExplorerReveal("server:workspace-f")).toBeNull();
    await expect(aborted.result).resolves.toBe("cancelled");

    const cancelled = requestExplorerReveal({
      workspaceKey: "server:workspace-g",
      path: "cancelled.ts",
      intent: "explicit",
    });
    cancelExplorerReveal("server:workspace-g");
    expect(peekExplorerReveal("server:workspace-g")).toBeNull();
    await expect(cancelled.result).resolves.toBe("cancelled");
  });
});

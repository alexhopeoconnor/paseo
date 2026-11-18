import { afterEach, describe, expect, it, vi } from "vitest";
import { requestPanelClose } from "./close-protection";
import { setPanelInstanceAttributes } from "./panel-instance-attributes";

const first = { serverId: "host", workspaceId: "close-check", tabId: "one" };
const second = { ...first, tabId: "two" };
afterEach(() => {
  setPanelInstanceAttributes(first, { modified: false });
  setPanelInstanceAttributes(second, { modified: false });
  vi.useRealTimers();
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function closeRequest(identities = [first]) {
  const confirm = vi.fn(async () => true);
  const apply = vi.fn(() => true);
  const pending = vi.fn();
  const input = {
    identities,
    cancelled: false,
    confirm,
    apply,
    didClose: (closed: boolean) => closed,
    onPendingChange: pending,
  };
  return { input, confirm, apply, pending, run: () => requestPanelClose(input) };
}

describe("panel close protection", () => {
  it("waits for fresh clean evidence before closing and ignores a duplicate click", async () => {
    const state = deferred<boolean>();
    const resolver = vi.fn(() => state.promise);
    setPanelInstanceAttributes(first, {
      modified: true,
      retained: true,
      resolveCloseProtection: resolver,
    });
    const close = closeRequest();
    const result = close.run();
    expect(close.pending).toHaveBeenCalledWith(true);
    expect(close.apply).not.toHaveBeenCalled();
    await expect(close.run()).resolves.toBe(false);
    expect(close.confirm).not.toHaveBeenCalled();
    state.resolve(false);
    await expect(result).resolves.toBe(true);
    expect(resolver).toHaveBeenCalledOnce();
    expect(close.confirm).toHaveBeenCalledExactlyOnceWith(0);
    expect(close.apply).toHaveBeenCalledOnce();
    expect(close.pending.mock.calls).toEqual([[true], [false]]);
  });

  it.each(["dirty", "rejected", "throws", "timeout"])(
    "keeps %s evidence protected even when the displayed state is clean",
    async (mode) => {
      vi.useFakeTimers();
      const resolver = () => {
        if (mode === "throws") throw new Error("Disconnected");
        if (mode === "rejected") return Promise.reject(new Error("Disconnected"));
        if (mode === "timeout") return new Promise<boolean>(() => {});
        return true;
      };
      setPanelInstanceAttributes(first, { modified: false, resolveCloseProtection: resolver });
      const close = closeRequest();
      close.confirm.mockResolvedValue(false);
      const result = close.run();
      await vi.advanceTimersByTimeAsync(6_000);
      await expect(result).resolves.toBe(false);
      expect(close.confirm).toHaveBeenCalledExactlyOnceWith(1);
      expect(close.apply).not.toHaveBeenCalled();
    },
  );

  it("counts fresh bulk protection and resumes built-in writes when discard is declined", async () => {
    const resume = vi.fn();
    setPanelInstanceAttributes(first, { modified: true, suspendPendingSave: () => resume });
    setPanelInstanceAttributes(second, { modified: false, resolveCloseProtection: () => true });
    const close = closeRequest([first, second]);
    close.confirm.mockResolvedValue(false);
    await expect(close.run()).resolves.toBe(false);
    expect(close.confirm).toHaveBeenCalledExactlyOnceWith(2);
    expect(resume).toHaveBeenCalledOnce();
    expect(close.apply).not.toHaveBeenCalled();
  });

  it("keeps discarded writes suspended for already closed panels when a bulk close is partial", async () => {
    const firstResume = vi.fn();
    const secondResume = vi.fn();
    setPanelInstanceAttributes(first, { modified: true, suspendPendingSave: () => firstResume });
    setPanelInstanceAttributes(second, { modified: true, suspendPendingSave: () => secondResume });
    await expect(
      requestPanelClose({
        identities: [first, second],
        cancelled: false,
        confirm: async () => true,
        apply: (_isCurrent, markClosed) => {
          markClosed(first);
          return false;
        },
        didClose: (closed) => closed,
      }),
    ).resolves.toBe(false);
    expect(firstResume).not.toHaveBeenCalled();
    expect(secondResume).toHaveBeenCalledOnce();
  });

  it("does not close a replacement whose resolver changed during a pending snapshot", async () => {
    const state = deferred<boolean>();
    setPanelInstanceAttributes(first, {
      modified: false,
      resolveCloseProtection: () => state.promise,
    });
    const close = closeRequest();
    const result = close.run();
    setPanelInstanceAttributes(first, { modified: false, resolveCloseProtection: () => false });
    state.resolve(false);
    await expect(result).resolves.toBe(false);
    expect(close.confirm).not.toHaveBeenCalled();
    expect(close.apply).not.toHaveBeenCalled();
  });

  it("does not let a clean resolver result hide a new dirty publication during its own check", async () => {
    const state = deferred<boolean>();
    const resolver = () => state.promise;
    setPanelInstanceAttributes(first, { modified: false, resolveCloseProtection: resolver });
    const close = closeRequest();
    const result = close.run();
    setPanelInstanceAttributes(first, { modified: true, resolveCloseProtection: resolver });
    state.resolve(false);
    await expect(result).resolves.toBe(false);
    expect(close.confirm).not.toHaveBeenCalled();
    expect(close.apply).not.toHaveBeenCalled();
  });

  it("does not apply an old confirmation after the panel was replaced", async () => {
    vi.useFakeTimers();
    const answer = deferred<boolean>();
    setPanelInstanceAttributes(first, { modified: true, resolveCloseProtection: () => true });
    const close = closeRequest();
    close.confirm.mockImplementation(() => answer.promise);
    const result = close.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(close.confirm).toHaveBeenCalledOnce();
    setPanelInstanceAttributes(first, { modified: false, resolveCloseProtection: () => false });
    answer.resolve(true);
    await expect(result).resolves.toBe(false);
    expect(close.apply).not.toHaveBeenCalled();
  });

  it("rejects an earlier clean result when that panel becomes dirty while another bulk check waits", async () => {
    vi.useFakeTimers();
    const slow = deferred<boolean>();
    const resolver = () => false;
    setPanelInstanceAttributes(first, { modified: false, resolveCloseProtection: resolver });
    setPanelInstanceAttributes(second, {
      modified: false,
      resolveCloseProtection: () => slow.promise,
    });
    const close = closeRequest([first, second]);
    const result = close.run();
    await vi.advanceTimersByTimeAsync(0);
    setPanelInstanceAttributes(first, { modified: true, resolveCloseProtection: resolver });
    slow.resolve(false);
    await expect(result).resolves.toBe(false);
    expect(close.confirm).not.toHaveBeenCalled();
    expect(close.apply).not.toHaveBeenCalled();
  });

  it("rechecks clean evidence after the bulk confirmation dialog", async () => {
    vi.useFakeTimers();
    const answer = deferred<boolean>();
    const resolver = () => false;
    setPanelInstanceAttributes(first, { modified: false, resolveCloseProtection: resolver });
    const close = closeRequest();
    close.confirm.mockImplementation(() => answer.promise);
    const result = close.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(close.confirm).toHaveBeenCalledOnce();
    setPanelInstanceAttributes(first, { modified: true, resolveCloseProtection: resolver });
    answer.resolve(true);
    await expect(result).resolves.toBe(false);
    expect(close.apply).not.toHaveBeenCalled();
  });

  it.each(["handled", "cancelled", "render"] as const)(
    "resumes old file writes unless an accepted opener replaces the viewer (%s)",
    async (outcome) => {
      const resume = vi.fn();
      setPanelInstanceAttributes(first, { modified: true, suspendPendingSave: () => resume });
      await expect(
        requestPanelClose<"handled" | "cancelled" | "render">({
          identities: [first],
          cancelled: "cancelled",
          confirm: async () => true,
          apply: async () => outcome,
          didClose: (result) => result === "render",
        }),
      ).resolves.toBe(outcome);
      expect(resume).toHaveBeenCalledTimes(outcome === "render" ? 0 : 1);
    },
  );
});

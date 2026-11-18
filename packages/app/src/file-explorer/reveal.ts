import { useSyncExternalStore } from "react";

export type ExplorerRevealStatus = "revealed" | "missing" | "hidden" | "cancelled";

/** One pending Explorer selection. Ephemeral: never persisted and dropped on expiry. */
export interface ExplorerRevealRequest {
  readonly id: string;
  readonly workspaceKey: string;
  readonly path: string;
  readonly intent: "auto" | "explicit";
  readonly requestId?: string;
  readonly signal?: AbortSignal;
  readonly expiresAt: number;
}

interface TrackedReveal {
  request: ExplorerRevealRequest;
  timer: ReturnType<typeof setTimeout>;
  controller: AbortController;
  unlinkSignal?(): void;
  claimed: boolean;
  settle(status: ExplorerRevealStatus): void;
}

const DEFAULT_TTL_MS = 15_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 30_000;

const requests = new Map<string, TrackedReveal>();
const listeners = new Set<() => void>();
let sequence = 0;

function notify(): void {
  for (const listener of listeners) listener();
}

function clampTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined || !Number.isFinite(ttlMs)) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(ttlMs)));
}

function clearTracked(
  workspaceKey: string,
  id: string | undefined,
  status: ExplorerRevealStatus,
): void {
  const tracked = requests.get(workspaceKey);
  if (!tracked || (id !== undefined && tracked.request.id !== id)) return;
  clearTimeout(tracked.timer);
  tracked.unlinkSignal?.();
  tracked.controller.abort();
  requests.delete(workspaceKey);
  tracked.settle(status);
  notify();
}

export interface RequestExplorerRevealInput {
  workspaceKey: string;
  path: string;
  intent: "auto" | "explicit";
  requestId?: string;
  signal?: AbortSignal;
  ttlMs?: number;
}

export interface PendingExplorerReveal {
  /** Resolves once the tree acknowledges the request, or the request is cancelled/expired. */
  readonly result: Promise<ExplorerRevealStatus>;
  cancel(): void;
}

/**
 * Replaces any pending reveal for the workspace. A later request always wins, so a stale ancestor
 * expansion cannot select a path after the user asked for another one.
 */
export function requestExplorerReveal(input: RequestExplorerRevealInput): PendingExplorerReveal {
  if (input.signal?.aborted) {
    return { result: Promise.resolve("cancelled"), cancel() {} };
  }
  clearTracked(input.workspaceKey, undefined, "cancelled");
  sequence += 1;
  const ttlMs = clampTtl(input.ttlMs);
  const controller = new AbortController();
  const request: ExplorerRevealRequest = {
    id: `reveal_${sequence}`,
    workspaceKey: input.workspaceKey,
    path: input.path,
    intent: input.intent,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    signal: controller.signal,
    expiresAt: Date.now() + ttlMs,
  };
  let resolve!: (status: ExplorerRevealStatus) => void;
  const result = new Promise<ExplorerRevealStatus>((next) => {
    resolve = next;
  });
  let settled = false;
  const settle = (status: ExplorerRevealStatus) => {
    if (settled) return;
    settled = true;
    resolve(status);
  };
  const timer = setTimeout(() => {
    clearTracked(input.workspaceKey, request.id, "cancelled");
  }, ttlMs);
  let unlinkSignal: (() => void) | undefined;
  if (input.signal) {
    const abort = () => {
      clearTracked(input.workspaceKey, request.id, "cancelled");
    };
    input.signal.addEventListener("abort", abort, { once: true });
    unlinkSignal = () => input.signal?.removeEventListener("abort", abort);
  }
  requests.set(input.workspaceKey, {
    request,
    timer,
    controller,
    unlinkSignal,
    claimed: false,
    settle,
  });
  notify();
  return {
    result,
    cancel: () => clearTracked(input.workspaceKey, request.id, "cancelled"),
  };
}

/** The pending reveal the tree should claim, including one already claimed by its owner tree. */
export function peekExplorerReveal(workspaceKey: string): ExplorerRevealRequest | null {
  const tracked = requests.get(workspaceKey);
  if (!tracked) return null;
  if (tracked.request.expiresAt <= Date.now()) return null;
  return tracked.request;
}

/** Marks the request as owned by one tree. It remains pending until acknowledged or expired. */
export function claimExplorerReveal(
  workspaceKey: string,
  id: string,
): ExplorerRevealRequest | null {
  const tracked = requests.get(workspaceKey);
  if (!tracked || tracked.request.id !== id || tracked.claimed) return null;
  tracked.claimed = true;
  return tracked.request;
}

export function acknowledgeExplorerReveal(
  workspaceKey: string,
  id: string,
  status: ExplorerRevealStatus,
): void {
  clearTracked(workspaceKey, id, status);
}

export function cancelExplorerReveal(workspaceKey: string, id?: string): void {
  clearTracked(workspaceKey, id, "cancelled");
}

export function subscribeExplorerReveals(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useExplorerReveal(workspaceKey: string | null): ExplorerRevealRequest | null {
  return useSyncExternalStore(
    subscribeExplorerReveals,
    () => (workspaceKey ? peekExplorerReveal(workspaceKey) : null),
    () => null,
  );
}

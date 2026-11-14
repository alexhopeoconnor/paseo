import type { PluginFileOpenSource } from "@getpaseo/plugin/client";
import type { OpenFileDisposition } from ".";

/** A confirmed user file open while its dispatcher operation is still running. */
export interface ActiveFileOpenRequest {
  readonly requestId: string;
  readonly hostId: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly disposition: OpenFileDisposition;
  readonly source: PluginFileOpenSource;
  /** Aborts when the dispatcher lifetime ends or this request settles. */
  readonly signal: AbortSignal;
}

interface TrackedRequest {
  record: ActiveFileOpenRequest;
  dispose(): void;
}

const requests = new Map<string, TrackedRequest>();

export function registerFileOpenRequest(input: {
  requestId: string;
  hostId: string;
  workspaceId: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
  disposition: OpenFileDisposition;
  source: PluginFileOpenSource;
  signal: AbortSignal;
}): { record: ActiveFileOpenRequest; unregister(): void } {
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  if (input.signal.aborted) lifetime.abort();
  else input.signal.addEventListener("abort", abort, { once: true });
  const record: ActiveFileOpenRequest = {
    requestId: input.requestId,
    hostId: input.hostId,
    workspaceId: input.workspaceId,
    path: input.path,
    ...(input.lineStart ? { lineStart: input.lineStart } : {}),
    ...(input.lineEnd ? { lineEnd: input.lineEnd } : {}),
    disposition: input.disposition,
    source: input.source,
    signal: lifetime.signal,
  };
  let active = true;
  const unregister = () => {
    if (!active) return;
    active = false;
    input.signal.removeEventListener("abort", abort);
    lifetime.abort();
    const tracked = requests.get(input.requestId);
    if (tracked?.record === record) requests.delete(input.requestId);
  };
  requests.set(input.requestId, { record, dispose: unregister });
  return { record, unregister };
}

/**
 * The request a plugin-side open or reveal can bind to. Settled and aborted requests are never
 * returned, so a queued callback cannot place layout after its file open ended.
 */
export function getFileOpenRequest(requestId: string): ActiveFileOpenRequest | null {
  const tracked = requests.get(requestId);
  if (!tracked || tracked.record.signal.aborted) return null;
  return tracked.record;
}

import { setTimeout as delay } from "node:timers/promises";

import type { OpenCodeEvent, SessionInfo } from "@opencode/client";

import type {
  NativeSessionStopOptions,
  NativeSessionStopResult,
} from "../../../agent-sdk-types.js";
import { OpenCodeHttpError } from "../http-error.js";

import type { V2Api } from "./api.js";

const FAMILY_RECONCILIATION_DELAY_MS = 25;
const FAMILY_QUIESCENCE_MS = 200;
const NATIVE_STOP_SETTLEMENT_TIMEOUT_MS = 30_000;

export interface OpenCodeV2NativeStopOptions extends NativeSessionStopOptions {
  /** Test and caller deadline; production callers rely on the 30 second cap. */
  signal?: AbortSignal;
}

type ExecutionEvent = Extract<
  OpenCodeEvent,
  {
    type:
      | "session.execution.started"
      | "session.execution.succeeded"
      | "session.execution.failed"
      | "session.execution.interrupted";
  }
>;

function isExecutionEvent(event: { type: string }): event is ExecutionEvent {
  return (
    event.type === "session.execution.started" ||
    event.type === "session.execution.succeeded" ||
    event.type === "session.execution.failed" ||
    event.type === "session.execution.interrupted"
  );
}

function isTerminalExecution(event: ExecutionEvent): boolean {
  // OpenCode shutdown preserves a durable execution claim for automatic
  // restart recovery. That is unfinished work, not just resumable history.
  return (
    event.type === "session.execution.succeeded" ||
    event.type === "session.execution.failed" ||
    (event.type === "session.execution.interrupted" && event.data.reason !== "shutdown")
  );
}

function isTerminalOutcome(outcome: SessionInfo["outcome"] | undefined): boolean {
  return outcome === "succeeded" || outcome === "failed" || outcome === "interrupted";
}

// v2.2.5 persists `time.busy`, although the bundled client declaration used
// by the server predates that field. Keep the compatibility read narrow and
// treat an absent or malformed value as no execution watermark.
function busyAt(info: SessionInfo): number | undefined {
  const busy = (info.time as SessionInfo["time"] & { busy?: unknown }).busy;
  return typeof busy === "number" && Number.isFinite(busy) ? busy : undefined;
}

function idleAt(info: SessionInfo): number | undefined {
  const idle = info.time.idle;
  return typeof idle === "number" && Number.isFinite(idle) ? idle : undefined;
}

function isNeverStarted(info: SessionInfo): boolean {
  return busyAt(info) === undefined && idleAt(info) === undefined && info.outcome === undefined;
}

/**
 * `outcome` is durable state, but start writes a new busy watermark without
 * clearing a prior outcome/idle. A terminal outcome is therefore current only
 * when its idle watermark covers the latest busy watermark. For an execution
 * that this stop actually interrupted, its idle must also advance past the
 * pre-interrupt watermark.
 */
function hasCurrentTerminalOutcome(info: SessionInfo, minimumIdleExclusive?: number): boolean {
  if (!isTerminalOutcome(info.outcome)) return false;
  const idle = idleAt(info);
  if (idle === undefined) return false;
  const busy = busyAt(info);
  if (busy !== undefined && idle < busy) return false;
  if (minimumIdleExclusive !== undefined) return idle > minimumIdleExclusive;
  // `busy === idle` can be an old terminal idle followed by a new start at
  // the same timestamp and shutdown before projection. Without a locally
  // captured pre-interrupt idle watermark, it is not terminal proof.
  return busy === undefined || idle > busy;
}

function preInterruptIdleWatermark(info: SessionInfo): number {
  return idleAt(info) ?? Number.NEGATIVE_INFINITY;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingSession(error: unknown): boolean {
  if (error instanceof OpenCodeHttpError) return error.status === 404;
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("OpenCode native stop timed out");
}

/**
 * SDK endpoints normally honor the request signal. The race also bounds older
 * or test implementations that do not. Winning that race does not prove the
 * underlying request stopped, so callers receive `uncertain`, never settlement.
 */
async function awaitWithinDeadline<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const pending = Promise.resolve(operation);
  // The client may finish after this deadline. Observe that outcome so a late
  // rejection does not become unhandled; it remains no proof of native state.
  void pending.catch(() => undefined);
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    removeAbortListener?.();
  }
}

function request(signal: AbortSignal) {
  return { signal };
}

async function latestExecution(
  client: V2Api,
  sessionId: string,
  signal: AbortSignal,
): Promise<ExecutionEvent | null> {
  let latest: ExecutionEvent | null = null;
  const log = client.session.log({ sessionID: sessionId, follow: false }, request(signal));
  const iterator = log[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await awaitWithinDeadline(iterator.next(), signal);
      if (next.done) return latest;
      const event = next.value;
      if (!isExecutionEvent(event)) continue;
      if (!latest || event.durable.seq > latest.durable.seq) latest = event;
    }
  } finally {
    // Do not await an older SDK iterator that ignores its request signal. The
    // deadline outcome remains uncertain while its late cleanup is observed.
    const returned = iterator.return?.();
    if (returned) void returned.catch(() => undefined);
  }
}

async function getExactSessionInfo(
  client: V2Api,
  sessionId: string,
  signal: AbortSignal,
): Promise<SessionInfo> {
  const info = await awaitWithinDeadline(
    client.session.get({ sessionID: sessionId }, request(signal)),
    signal,
  );
  if (info.id !== sessionId)
    throw new Error(`OpenCode native handle ${sessionId} resolved to a different session`);
  return info;
}

async function assertEmptyInbox(
  client: V2Api,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  const inbox = await awaitWithinDeadline(
    client.session.inbox.list({ sessionID: sessionId }, request(signal)),
    signal,
  );
  if (inbox.length > 0)
    throw new Error(`OpenCode session ${sessionId} has queued inbox work that must not resume`);
}

/**
 * Archive is terminal rather than a delivery boundary. A known member's
 * pending input must be explicitly discarded so it cannot run after native
 * interruption. `inbox.cancel` records the native item's cancellation; it
 * does not prompt, resume, or inspect work outside the verified family.
 */
async function cancelPendingInbox(
  client: V2Api,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  const inbox = await awaitWithinDeadline(
    client.session.inbox.list({ sessionID: sessionId }, request(signal)),
    signal,
  );
  for (const item of inbox) {
    await awaitWithinDeadline(
      client.session.inbox.cancel({ sessionID: sessionId, inboxID: item.id }, request(signal)),
      signal,
    );
  }
  // A successful DELETE acknowledgement alone is not enough: re-read the
  // native queue before treating its work as discarded.
  await assertEmptyInbox(client, sessionId, signal);
}

/**
 * Traverses only `parentID`-scoped descendants and verifies every returned
 * relationship. It deliberately never reads the server-wide active inventory:
 * the persisted native handle is the sole cancellation authority. The caller
 * must have ruled out protected detached descendants before traversal; this
 * helper still declines to add one exposed by a concurrent listing update.
 */
async function collectOwnedFamily(
  client: V2Api,
  nativeHandle: string,
  excludedNativeHandles: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<SessionInfo[]> {
  if (excludedNativeHandles.has(nativeHandle))
    throw new Error(`OpenCode archive target ${nativeHandle} cannot exclude its own native handle`);
  const root = await getExactSessionInfo(client, nativeHandle, signal);

  const family = new Map<string, SessionInfo>([[root.id, root]]);
  for (const parent of family.values()) {
    let cursor: string | undefined;
    do {
      const page = await awaitWithinDeadline(
        client.session.list(
          { ...(cursor ? { cursor } : { parentID: parent.id }), limit: 100 },
          request(signal),
        ),
        signal,
      );
      for (const child of page.data) {
        if (child.parentID !== parent.id)
          throw new Error(`OpenCode returned an unverified child while stopping ${parent.id}`);
        if (excludedNativeHandles.has(child.id)) continue;
        family.set(child.id, child);
      }
      cursor = page.cursor.next ?? undefined;
    } while (cursor);
  }
  return [...family.values()];
}

/**
 * Read-only membership check used before interrupting a root or releasing a
 * dedicated helper. A v2 foreground child can inherit its parent's native
 * interrupt, so a protected descendant must be proved absent before either
 * action. It never selects a stop target from the result and never consults
 * the server-wide active inventory.
 */
export async function hasOpenCodeV2ExcludedFamilyMember(
  client: V2Api,
  nativeHandle: string,
  excludedNativeHandles: readonly string[],
  outerSignal?: AbortSignal,
): Promise<"present" | "absent" | "uncertain"> {
  const excluded = new Set(excludedNativeHandles);
  if (excluded.size === 0) return "absent";
  const signal = AbortSignal.timeout(NATIVE_STOP_SETTLEMENT_TIMEOUT_MS);
  const deadline = outerSignal ? AbortSignal.any([signal, outerSignal]) : signal;
  try {
    const root = await awaitWithinDeadline(
      client.session.get({ sessionID: nativeHandle }, request(deadline)),
      deadline,
    );
    if (root.id !== nativeHandle) return "uncertain";
    const family = new Map<string, SessionInfo>([[root.id, root]]);
    for (const parent of family.values()) {
      const children = await readVerifiedChildrenForExclusion(
        client,
        parent.id,
        excluded,
        deadline,
      );
      if (children.status !== "absent") return children.status;
      for (const child of children.data) family.set(child.id, child);
    }
    return "absent";
  } catch {
    return "uncertain";
  }
}

function excludedChildMembership(
  parentId: string,
  child: SessionInfo,
  excluded: ReadonlySet<string>,
): "present" | "absent" | "uncertain" {
  if (child.parentID !== parentId) return "uncertain";
  return excluded.has(child.id) ? "present" : "absent";
}

async function readVerifiedChildrenForExclusion(
  client: V2Api,
  parentId: string,
  excluded: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<{
  status: "present" | "absent" | "uncertain";
  data: SessionInfo[];
}> {
  const data: SessionInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await awaitWithinDeadline(
      client.session.list(
        { ...(cursor ? { cursor } : { parentID: parentId }), limit: 100 },
        request(signal),
      ),
      signal,
    );
    for (const child of page.data) {
      const membership = excludedChildMembership(parentId, child, excluded);
      if (membership !== "absent") return { status: membership, data };
      data.push(child);
    }
    cursor = page.cursor.next ?? undefined;
  } while (cursor);
  return { status: "absent", data };
}

function familySignature(family: readonly SessionInfo[]): string {
  return family
    .map((info) => `${info.parentID ?? ""}:${info.id}`)
    .sort()
    .join("|");
}

class ProtectedNativeFamilyError extends Error {}

async function assertNoExcludedFamilyMember(
  client: V2Api,
  sessionId: string,
  excludedNativeHandles: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  if (
    (await hasOpenCodeV2ExcludedFamilyMember(client, sessionId, excludedNativeHandles, signal)) !==
    "absent"
  ) {
    throw new ProtectedNativeFamilyError(
      `OpenCode native session ${sessionId} has a protected or unproven descendant`,
    );
  }
}

async function isSettled(
  client: V2Api,
  info: SessionInfo,
  signal: AbortSignal,
  minimumIdleExclusive?: number,
): Promise<boolean> {
  // `session.log` is durable history, not a current-state lock. A backgrounded
  // or resumed execution can be active after the latest terminal entry. Read
  // the status only for this already verified family member; the inventory
  // never contributes a target or cancellation authority.
  const active = await awaitWithinDeadline(client.session.active(request(signal)), signal);
  if (active[info.id]) return false;
  await assertEmptyInbox(client, info.id, signal);
  const latest = await latestExecution(client, info.id, signal);
  // A retained `started`/shutdown record is evidence against settlement even
  // if an old SessionInfo outcome still looks terminal.
  if (latest && !isTerminalExecution(latest)) return false;
  if (hasCurrentTerminalOutcome(info, minimumIdleExclusive)) return true;
  // Only a truly untouched session may settle without a terminal outcome.
  // A first-run shutdown has busy without idle/outcome and must remain
  // recoverably uncertain rather than being mistaken for an idle session.
  return minimumIdleExclusive === undefined && latest === null && isNeverStarted(info);
}

async function waitForSettlement(
  client: V2Api,
  sessionId: string,
  excludedNativeHandles: readonly string[],
  minimumIdleExclusive: number,
  signal: AbortSignal,
): Promise<void> {
  while (true) {
    signal.throwIfAborted();
    // A child continuation can arrive after the interrupt ACK. Re-prove
    // protection before discarding any newly queued input and let the outer
    // reconciliation loop discover/stop owned continuations.
    await assertNoExcludedFamilyMember(client, sessionId, excludedNativeHandles, signal);
    await cancelPendingInbox(client, sessionId, signal);
    const info = await getExactSessionInfo(client, sessionId, signal);
    if (await isSettled(client, info, signal, minimumIdleExclusive)) return;
    await delay(FAMILY_RECONCILIATION_DELAY_MS, undefined, { signal });
  }
}

async function stopExactSession(
  client: V2Api,
  info: SessionInfo,
  excludedNativeHandles: readonly string[],
  signal: AbortSignal,
  minimumIdleExclusive?: number,
): Promise<number | undefined> {
  // Both queue cancellation and interrupt can affect a foreground native
  // branch, so require the same protected-descendant proof before each.
  await assertNoExcludedFamilyMember(client, info.id, excludedNativeHandles, signal);
  await cancelPendingInbox(client, info.id, signal);
  // Family discovery is only an ownership snapshot. Read current timestamps
  // immediately before the decision to interrupt so a stale terminal outcome
  // cannot settle a newer busy execution.
  const current = await getExactSessionInfo(client, info.id, signal);
  if (minimumIdleExclusive !== undefined) {
    if (await isSettled(client, current, signal, minimumIdleExclusive)) return minimumIdleExclusive;
  } else if (await isSettled(client, current, signal)) {
    return undefined;
  }
  const watermark = preInterruptIdleWatermark(current);
  await assertNoExcludedFamilyMember(client, info.id, excludedNativeHandles, signal);
  await awaitWithinDeadline(
    client.session.interrupt({ sessionID: info.id }, request(signal)),
    signal,
  );
  // The native API ACK precedes process and child cleanup. A terminal execution
  // record (or current terminal outcome when no execution exists) is the proof.
  await waitForSettlement(client, info.id, excludedNativeHandles, watermark, signal);
  return watermark;
}

/**
 * Stops exactly the persisted OpenCode-v2 session and only descendants whose
 * `parentID` chain is verified from it. It never creates/resumes/prompts a
 * session and never stops a shared server. A queued inbox is intentionally an
 * uncertain result, rather than an opportunity to resume or drain it.
 */
export async function stopOpenCodeV2NativeSession(
  client: V2Api,
  nativeHandle: string | null | undefined,
  options: OpenCodeV2NativeStopOptions = {},
): Promise<NativeSessionStopResult> {
  if (!nativeHandle) return { status: "unavailable" };

  const deadline = AbortSignal.timeout(NATIVE_STOP_SETTLEMENT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const excludedNativeHandles = new Set(options.excludedNativeHandles ?? []);
  try {
    // Pruning an excluded descendant from our explicit leaf-first traversal is
    // insufficient: OpenCode foreground-child cleanup may be invoked by a
    // root-session interrupt. The public native session shape does not expose
    // whether a descendant is foreground or background, so only a verified
    // absence is positive proof that interrupting this root leaves it alone.
    if (
      (await hasOpenCodeV2ExcludedFamilyMember(
        client,
        nativeHandle,
        [...excludedNativeHandles],
        signal,
      )) !== "absent"
    ) {
      return { status: "unavailable" };
    }
    let priorSignature: string | null = null;
    let quietSince: number | null = null;
    // A post-interrupt idle watermark remains required through later family
    // reconciliation. Without carrying this proof forward, equal busy/idle
    // would look ambiguous again and cause a duplicate interrupt.
    const interruptedIdleWatermarks = new Map<string, number>();
    while (true) {
      signal.throwIfAborted();
      const family = await collectOwnedFamily(client, nativeHandle, excludedNativeHandles, signal);
      // Stop leaves first, then the root. Before every interrupt, re-prove no
      // protected descendant is now parent-linked to that target: v2.2.5's
      // foreground callback can relay an interrupt through that relationship.
      for (let index = family.length - 1; index >= 0; index -= 1) {
        const info = family[index];
        if (
          (await hasOpenCodeV2ExcludedFamilyMember(
            client,
            info.id,
            [...excludedNativeHandles],
            signal,
          )) !== "absent"
        ) {
          return { status: "unavailable" };
        }
        const watermark = await stopExactSession(
          client,
          info,
          [...excludedNativeHandles],
          signal,
          interruptedIdleWatermarks.get(info.id),
        );
        if (watermark === undefined) interruptedIdleWatermarks.delete(info.id);
        else interruptedIdleWatermarks.set(info.id, watermark);
      }

      const reconciled = await collectOwnedFamily(
        client,
        nativeHandle,
        excludedNativeHandles,
        signal,
      );
      const settled = await Promise.all(
        reconciled.map(async (info) =>
          isSettled(
            client,
            await getExactSessionInfo(client, info.id, signal),
            signal,
            interruptedIdleWatermarks.get(info.id),
          ),
        ),
      );
      const signature = familySignature(reconciled);
      // A repeated quiescent snapshot catches children/continuations that arrive
      // after the first interrupt acknowledgement without relying on globals.
      if (priorSignature === signature && settled.every(Boolean)) {
        quietSince ??= Date.now();
        if (Date.now() - quietSince >= FAMILY_QUIESCENCE_MS) return { status: "settled" };
      } else {
        quietSince = null;
      }
      priorSignature = signature;
      await delay(FAMILY_RECONCILIATION_DELAY_MS, undefined, { signal });
    }
  } catch (error) {
    if (error instanceof ProtectedNativeFamilyError) return { status: "unavailable" };
    if (isMissingSession(error)) return { status: "unavailable" };
    return { status: "uncertain", error: message(error) };
  }
}

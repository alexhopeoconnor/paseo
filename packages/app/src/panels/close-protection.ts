import {
  buildPanelInstanceKey,
  capturePanelInstanceAttributes,
  subscribePanelInstanceAttributes,
  type PanelInstanceIdentity,
  type PanelInstanceSnapshot,
} from "./panel-instance-attributes";

const CLOSE_PROTECTION_TIMEOUT_MS = 6_000;
const pendingPanels = new Set<string>();

interface PanelCloseRequest<Result> {
  identities: readonly PanelInstanceIdentity[];
  cancelled: Result;
  confirm(protectedCount: number): Promise<boolean>;
  apply(
    isCurrent: (identity: PanelInstanceIdentity) => boolean,
    markClosed: (identity: PanelInstanceIdentity) => void,
  ): Result | Promise<Result>;
  /** A handled file open keeps the old viewer, so its suspended writes must resume. */
  didClose(result: Result): boolean;
  onPendingChange?(pending: boolean): void;
}

async function resolveProtection(snapshot: PanelInstanceSnapshot): Promise<boolean> {
  const resolver = snapshot.attributes.resolveCloseProtection;
  if (!resolver) return snapshot.attributes.modified;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(resolver)
        .then((protectedState) => protectedState !== false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), CLOSE_PROTECTION_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Plugin errors and unavailable remote editors must not silently permit discarding work.
    return true;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One close/replacement decision owns each panel through its check, dialog and teardown. */
export async function requestPanelClose<Result>(input: PanelCloseRequest<Result>): Promise<Result> {
  const snapshots = new Map(
    input.identities.map((identity) => [
      buildPanelInstanceKey(identity),
      capturePanelInstanceAttributes(identity),
    ]),
  );
  const keys = [...snapshots.keys()];
  if (keys.some((key) => pendingPanels.has(key))) return input.cancelled;
  for (const key of keys) pendingPanels.add(key);
  const modifiedWhilePending = new Set<string>();
  const unsubscribe = input.identities.map((identity) =>
    subscribePanelInstanceAttributes(identity, () => {
      const key = buildPanelInstanceKey(identity);
      if (snapshots.get(key)?.currentAttributes().modified) modifiedWhilePending.add(key);
    }),
  );
  const protectionByPanel = new Map<string, boolean>();
  const isKeyCurrent = (key: string) => {
    const snapshot = snapshots.get(key);
    if (!snapshot?.isCurrent()) return false;
    // A new modification during this RPC, another panel's RPC, or the dialog
    // invalidates clean evidence. A cached dirty flag predating the request does not.
    const becameModified = protectionByPanel.get(key) === false && modifiedWhilePending.has(key);
    return !becameModified;
  };
  const isCurrent = (identity: PanelInstanceIdentity) =>
    isKeyCurrent(buildPanelInstanceKey(identity));
  const allCurrent = () => keys.every(isKeyCurrent);
  const resumeWrites = new Map<string, () => void>();
  const closedPanels = new Set<string>();
  let closed = false;
  try {
    input.onPendingChange?.(true);
    const states = await Promise.all(
      [...snapshots.entries()].map(async ([key, snapshot]) => {
        const protectedState = await resolveProtection(snapshot);
        protectionByPanel.set(key, protectedState);
        return protectedState;
      }),
    );
    if (!allCurrent()) return input.cancelled;
    let protectedCount = 0;
    for (const [index, [key, snapshot]] of [...snapshots.entries()].entries()) {
      if (!states[index]) continue;
      protectedCount++;
      const resume = snapshot.attributes.suspendPendingSave?.();
      if (resume) resumeWrites.set(key, resume);
    }
    if (!(await input.confirm(protectedCount)) || !allCurrent()) return input.cancelled;
    const result = await input.apply(isCurrent, (identity) =>
      closedPanels.add(buildPanelInstanceKey(identity)),
    );
    closed = input.didClose(result);
    return result;
  } finally {
    if (!closed)
      for (const [key, resume] of resumeWrites) {
        if (!closedPanels.has(key)) resume();
      }
    for (const stop of unsubscribe) stop();
    for (const key of keys) pendingPanels.delete(key);
    input.onPendingChange?.(false);
  }
}

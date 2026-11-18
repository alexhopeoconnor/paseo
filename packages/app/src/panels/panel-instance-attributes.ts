import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { usePaneContext } from "@/panels/pane-context";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

export interface PanelInstanceIdentity {
  serverId: string;
  workspaceId: string;
  tabId: string;
}

export interface PanelInstanceAttributes {
  modified: boolean;
  retained?: boolean;
  suspendPendingSave?: () => () => void;
  resolveCloseProtection?: (() => boolean | Promise<boolean>) | null;
}

export interface PanelInstanceSnapshot {
  attributes: PanelInstanceAttributes;
  currentAttributes(): PanelInstanceAttributes;
  isCurrent(): boolean;
}

const DEFAULT_ATTRIBUTES: PanelInstanceAttributes = { modified: false };
const attributesByPanel = new Map<string, PanelInstanceAttributes>();
const listenersByPanel = new Map<string, Set<() => void>>();
const workspaceByPanel = new Map<string, string>();
const publisherByPanel = new Map<string, symbol>();
const allListeners = new Set<() => void>();
let attributesRevision = 0;

function buildWorkspacePanelKey(workspaceKey: string, tabId: string): string {
  return `${workspaceKey}:${tabId}`;
}

export function buildPanelInstanceKey(identity: PanelInstanceIdentity): string {
  return buildWorkspacePanelKey(buildWorkspaceTabPersistenceKey(identity) ?? "", identity.tabId);
}

/** Looks a panel up by the workspace key the layout store uses. */
export function getWorkspacePanelAttributes(
  workspaceKey: string,
  tabId: string,
): PanelInstanceAttributes {
  return attributesByPanel.get(buildWorkspacePanelKey(workspaceKey, tabId)) ?? DEFAULT_ATTRIBUTES;
}

export function getPanelInstanceAttributes(
  identity: PanelInstanceIdentity,
): PanelInstanceAttributes {
  return attributesByPanel.get(buildPanelInstanceKey(identity)) ?? DEFAULT_ATTRIBUTES;
}

/** A completed async close check must never discard a replacement plugin or viewer. */
export function capturePanelInstanceAttributes(
  identity: PanelInstanceIdentity,
): PanelInstanceSnapshot {
  const key = buildPanelInstanceKey(identity);
  const owner = publisherByPanel.get(key);
  const attributes = getPanelInstanceAttributes(identity);
  return {
    attributes,
    currentAttributes: () => getPanelInstanceAttributes(identity),
    isCurrent: () =>
      publisherByPanel.get(key) === owner &&
      getPanelInstanceAttributes(identity).resolveCloseProtection ===
        attributes.resolveCloseProtection,
  };
}

export function setPanelInstanceAttributes(
  identity: PanelInstanceIdentity,
  attributes: PanelInstanceAttributes,
): void {
  const key = buildPanelInstanceKey(identity);
  const previous = attributesByPanel.get(key) ?? DEFAULT_ATTRIBUTES;
  if (
    previous.modified === attributes.modified &&
    Boolean(previous.retained) === Boolean(attributes.retained) &&
    previous.suspendPendingSave === attributes.suspendPendingSave &&
    previous.resolveCloseProtection === attributes.resolveCloseProtection
  ) {
    return;
  }
  if (attributes.modified || attributes.retained || attributes.resolveCloseProtection) {
    attributesByPanel.set(key, attributes);
  } else {
    attributesByPanel.delete(key);
  }
  if (attributes.modified || attributes.retained) {
    workspaceByPanel.set(key, buildWorkspaceTabPersistenceKey(identity) ?? "");
  } else {
    workspaceByPanel.delete(key);
  }
  attributesRevision += 1;
  for (const listener of listenersByPanel.get(key) ?? []) listener();
  for (const listener of allListeners) listener();
}

export function useModifiedPanelTabIds(input: {
  serverId: string;
  workspaceId: string;
  tabIds: string[];
}): Set<string> {
  return usePanelTabIds(input, false);
}

export function useRetainedPanelTabIds(input: {
  serverId: string;
  workspaceId: string;
  tabIds: string[];
}): Set<string> {
  return usePanelTabIds(input, true);
}

function usePanelTabIds(
  input: {
    serverId: string;
    workspaceId: string;
    tabIds: string[];
  },
  includeRetained: boolean,
): Set<string> {
  const revision = useSyncExternalStore(
    useCallback((listener: () => void) => {
      allListeners.add(listener);
      return () => allListeners.delete(listener);
    }, []),
    () => attributesRevision,
    () => attributesRevision,
  );
  return useMemo(() => {
    void revision;
    return new Set(
      input.tabIds.filter((tabId) => {
        const attributes = getPanelInstanceAttributes({
          serverId: input.serverId,
          workspaceId: input.workspaceId,
          tabId,
        });
        return attributes.modified || (includeRetained && attributes.retained);
      }),
    );
  }, [input.serverId, input.tabIds, input.workspaceId, includeRetained, revision]);
}

export function subscribePanelInstanceAttributes(
  identity: PanelInstanceIdentity,
  listener: () => void,
): () => void {
  const key = buildPanelInstanceKey(identity);
  const listeners = listenersByPanel.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  listenersByPanel.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByPanel.delete(key);
  };
}

export function usePanelInstanceAttributes({
  serverId,
  workspaceId,
  tabId,
}: PanelInstanceIdentity): PanelInstanceAttributes {
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribePanelInstanceAttributes({ serverId, workspaceId, tabId }, listener),
    [serverId, tabId, workspaceId],
  );
  const getSnapshot = useCallback(
    () => getPanelInstanceAttributes({ serverId, workspaceId, tabId }),
    [serverId, tabId, workspaceId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Workspace keys protected by mounted panels; dirty state also must survive workspace eviction. */
export function useRetainedPanelWorkspaceKeys(): ReadonlySet<string> {
  const revision = useSyncExternalStore(
    useCallback((listener: () => void) => {
      allListeners.add(listener);
      return () => allListeners.delete(listener);
    }, []),
    () => attributesRevision,
    () => attributesRevision,
  );
  return useMemo(() => {
    void revision;
    return new Set(workspaceByPanel.values());
  }, [revision]);
}

export function usePublishPanelInstanceAttributes(
  attributes: PanelInstanceAttributes,
): (update: Partial<PanelInstanceAttributes>) => void {
  const { serverId, workspaceId, tabId } = usePaneContext();
  const owner = useRef(Symbol("panel attributes")).current;
  const modified = attributes.modified;
  const retained = attributes.retained;
  const suspendPendingSave = attributes.suspendPendingSave;
  const resolveCloseProtection = attributes.resolveCloseProtection;
  useLayoutEffect(() => {
    const identity = { serverId, workspaceId, tabId };
    const key = buildPanelInstanceKey(identity);
    publisherByPanel.set(key, owner);
    return () => {
      if (publisherByPanel.get(key) !== owner) return;
      publisherByPanel.delete(key);
      setPanelInstanceAttributes(identity, DEFAULT_ATTRIBUTES);
    };
  }, [owner, serverId, tabId, workspaceId]);
  useLayoutEffect(() => {
    const identity = { serverId, workspaceId, tabId };
    if (publisherByPanel.get(buildPanelInstanceKey(identity)) === owner) {
      setPanelInstanceAttributes(identity, {
        modified,
        retained,
        suspendPendingSave,
        resolveCloseProtection,
      });
    }
  }, [
    modified,
    retained,
    owner,
    resolveCloseProtection,
    serverId,
    suspendPendingSave,
    tabId,
    workspaceId,
  ]);
  // Plugin events invalidate pending close checks immediately, before React's
  // next render. A replaced mount's callbacks cannot publish into its successor.
  return useCallback(
    (update: Partial<PanelInstanceAttributes>) => {
      const identity = { serverId, workspaceId, tabId };
      if (publisherByPanel.get(buildPanelInstanceKey(identity)) !== owner) return;
      setPanelInstanceAttributes(identity, { ...getPanelInstanceAttributes(identity), ...update });
    },
    [owner, serverId, tabId, workspaceId],
  );
}

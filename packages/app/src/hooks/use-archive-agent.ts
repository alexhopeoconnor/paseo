import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { acceptAgentDirectoryUpdate } from "@/utils/agent-directory-update-policy";
import { agentHistoryQueryKey, allAgentHistoryQueryRootKey } from "./agent-history-query-key";

export const ARCHIVE_AGENT_PENDING_QUERY_KEY = ["archive-agent-pending"] as const;
export const ARCHIVE_AGENT_RECONCILIATION_QUERY_KEY = ["archive-agent-reconciliation"] as const;
const EMPTY_PENDING_ARCHIVE_AGENT_IDS = new Set<string>();

export interface ArchiveAgentInput {
  serverId: string;
  agentId: string;
}

export type ArchiveAgentPendingState = Record<string, true>;
export type ArchiveAgentReconciliationState = Record<string, true>;

interface SetAgentArchivingInput extends ArchiveAgentInput {
  queryClient: QueryClient;
  isArchiving: boolean;
}

interface IsAgentArchivingInput extends ArchiveAgentInput {
  queryClient: QueryClient;
}

export interface AgentsListQueryData {
  entries?: Array<{ agent?: { id?: string | null } | null } | null>;
}

export interface AgentHistoryQueryAgent {
  id?: string | null;
  serverId?: string | null;
  archivedAt?: Date | null;
}

export interface AgentHistoryQueryPage {
  agents?: AgentHistoryQueryAgent[];
}

export interface AgentHistoryQueryData {
  pages?: AgentHistoryQueryPage[];
}

export function toArchiveKey(input: ArchiveAgentInput): string {
  const serverId = input.serverId.trim();
  const agentId = input.agentId.trim();
  if (!serverId || !agentId) {
    return "";
  }
  return `${serverId}:${agentId}`;
}

export function readPendingState(queryClient: QueryClient): ArchiveAgentPendingState {
  return queryClient.getQueryData<ArchiveAgentPendingState>(ARCHIVE_AGENT_PENDING_QUERY_KEY) ?? {};
}

export function selectPendingArchiveAgentIds(
  pendingState: ArchiveAgentPendingState,
  serverId: string,
): ReadonlySet<string> {
  const normalizedServerId = serverId.trim();
  if (!normalizedServerId) {
    return EMPTY_PENDING_ARCHIVE_AGENT_IDS;
  }

  const prefix = `${normalizedServerId}:`;
  let agentIds: string[] | null = null;
  for (const key of Object.keys(pendingState)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const agentId = key.slice(prefix.length);
    if (!agentId) {
      continue;
    }
    agentIds ??= [];
    agentIds.push(agentId);
  }

  if (!agentIds || agentIds.length === 0) {
    return EMPTY_PENDING_ARCHIVE_AGENT_IDS;
  }
  return new Set(agentIds);
}

export function setAgentArchiving(input: SetAgentArchivingInput): void {
  const key = toArchiveKey(input);
  if (!key) {
    return;
  }

  input.queryClient.setQueryData<ArchiveAgentPendingState>(
    ARCHIVE_AGENT_PENDING_QUERY_KEY,
    (current) => {
      const state = current ?? {};
      if (input.isArchiving) {
        if (state[key]) {
          return state;
        }
        return { ...state, [key]: true };
      }

      if (!state[key]) {
        return state;
      }

      const next = { ...state };
      delete next[key];
      return next;
    },
  );
}

export function isAgentArchiving(input: IsAgentArchivingInput): boolean {
  const key = toArchiveKey(input);
  if (!key) {
    return false;
  }
  return readPendingState(input.queryClient)[key] ?? false;
}

function setArchiveReconciliationState(input: SetAgentArchivingInput): void {
  const key = toArchiveKey(input);
  if (!key) {
    return;
  }

  input.queryClient.setQueryData<ArchiveAgentReconciliationState>(
    ARCHIVE_AGENT_RECONCILIATION_QUERY_KEY,
    (current) => {
      const state = current ?? {};
      if (input.isArchiving) {
        return state[key] ? state : { ...state, [key]: true };
      }
      if (!state[key]) {
        return state;
      }
      const next = { ...state };
      delete next[key];
      return next;
    },
  );
}

export function isArchiveReconciliationUncertain(input: IsAgentArchivingInput): boolean {
  const key = toArchiveKey(input);
  if (!key) {
    return false;
  }
  return (
    input.queryClient.getQueryData<ArchiveAgentReconciliationState>(
      ARCHIVE_AGENT_RECONCILIATION_QUERY_KEY,
    )?.[key] ?? false
  );
}

type FetchAgentResult = Awaited<ReturnType<DaemonClient["fetchAgent"]>>;

function applyFetchedArchiveStatus(input: {
  serverId: string;
  result: NonNullable<FetchAgentResult>;
}): Agent {
  const normalized = normalizeAgentSnapshot(input.result.agent, input.serverId);
  const store = useSessionStore.getState();
  let found = false;
  const merge = (current: Agent | undefined): Agent => {
    found ||= Boolean(current);
    const incoming: Agent = {
      ...normalized,
      projectPlacement: input.result.project,
    };
    return acceptAgentDirectoryUpdate(current, incoming);
  };

  store.setAgents(input.serverId, (current) => {
    const existing = current.get(normalized.id);
    if (!existing) return current;
    const next = new Map(current);
    next.set(normalized.id, merge(existing));
    return next;
  });
  store.setAgentDetails(input.serverId, (current) => {
    const existing = current.get(normalized.id);
    if (!existing) return current;
    const next = new Map(current);
    next.set(normalized.id, merge(existing));
    return next;
  });
  if (found) return normalized;
  store.setAgentDetails(input.serverId, (current) => {
    const next = new Map(current);
    next.set(normalized.id, {
      ...normalized,
      projectPlacement: input.result.project,
    });
    return next;
  });
  return normalized;
}

async function reconcileArchiveStatus(
  input: ArchiveAgentInput,
  daemonClientUnavailableMessage: string,
): Promise<Agent> {
  const client = useSessionStore.getState().sessions[input.serverId]?.client ?? null;
  if (!client) {
    throw new Error(daemonClientUnavailableMessage);
  }
  const result = await client.fetchAgent({ agentId: input.agentId, timeout: 5_000 });
  if (!result) {
    throw new Error(`Agent not found: ${input.agentId}`);
  }
  return applyFetchedArchiveStatus({ serverId: input.serverId, result });
}

export function removeAgentFromListPayload<T extends AgentsListQueryData | undefined>(
  payload: T,
  agentId: string,
): T {
  if (!payload || !Array.isArray(payload.entries) || !agentId) {
    return payload;
  }
  const filtered = payload.entries.filter((entry) => entry?.agent?.id !== agentId);
  if (filtered.length === payload.entries.length) {
    return payload;
  }
  return {
    ...payload,
    entries: filtered,
  } as T;
}

export function removeAgentFromCachedLists(
  queryClient: QueryClient,
  input: ArchiveAgentInput,
): void {
  const agentId = input.agentId.trim();
  if (!agentId) {
    return;
  }

  queryClient.setQueryData<AgentsListQueryData | undefined>(
    ["sidebarAgentsList", input.serverId],
    (current) => removeAgentFromListPayload(current, agentId),
  );
  queryClient.setQueryData<AgentsListQueryData | undefined>(
    ["allAgents", input.serverId],
    (current) => removeAgentFromListPayload(current, agentId),
  );
}

export function markAgentArchivedInHistoryPayload<T extends AgentHistoryQueryData | undefined>(
  payload: T,
  input: ArchiveAgentInput & { archivedAt: string },
): T {
  if (!payload || !Array.isArray(payload.pages) || !input.agentId) {
    return payload;
  }

  const archivedAt = new Date(input.archivedAt);
  if (Number.isNaN(archivedAt.getTime())) {
    return payload;
  }

  let changed = false;
  const pages = payload.pages.map((page) => {
    if (!Array.isArray(page.agents)) {
      return page;
    }

    let pageChanged = false;
    const agents = page.agents.map((agent) => {
      if (
        agent.id !== input.agentId ||
        (agent.serverId != null && agent.serverId !== input.serverId)
      ) {
        return agent;
      }
      pageChanged = true;
      changed = true;
      return {
        ...agent,
        archivedAt,
      };
    });

    return pageChanged ? { ...page, agents } : page;
  });

  return changed ? ({ ...payload, pages } as T) : payload;
}

export function markAgentArchivedInHistoryCache(
  queryClient: QueryClient,
  input: ArchiveAgentInput & { archivedAt: string },
): void {
  queryClient.setQueryData<AgentHistoryQueryData | undefined>(
    agentHistoryQueryKey(input.serverId),
    (current) => markAgentArchivedInHistoryPayload(current, input),
  );
  queryClient.setQueriesData<AgentHistoryQueryData | undefined>(
    { queryKey: allAgentHistoryQueryRootKey() },
    (current) => markAgentArchivedInHistoryPayload(current, input),
  );
}

export function clearArchiveAgentPending(input: IsAgentArchivingInput): void {
  setAgentArchiving({
    ...input,
    isArchiving: false,
  });
}

export interface ArchivedAgentCloseResult {
  agentId: string;
  archivedAt: string;
}

interface ArchiveAgentMutationContext {
  agent: Agent | undefined;
  detail: Agent | undefined;
}

function captureArchiveAttempt(input: ArchiveAgentInput): ArchiveAgentMutationContext {
  const session = useSessionStore.getState().sessions[input.serverId];
  return {
    agent: session?.agents.get(input.agentId),
    detail: session?.agentDetails.get(input.agentId),
  };
}

function currentArchiveAgent(input: ArchiveAgentInput): Agent | null {
  const session = useSessionStore.getState().sessions[input.serverId];
  return session?.agents.get(input.agentId) ?? session?.agentDetails.get(input.agentId) ?? null;
}

/**
 * An archive reply has no revision or complete snapshot. It is a fallback only
 * when a passive fetch cannot supply one, so it may update exactly the objects
 * that began this mutation and never replace a newer directory projection.
 */
function applyConfirmedArchiveReceipt(input: {
  attempt: ArchiveAgentMutationContext | undefined;
  archivedAt: string;
  serverId: string;
  agentId: string;
}): boolean {
  if (!input.attempt) return false;
  return getHostRuntimeStore().archiveAgentReceiptIfCurrent(
    input.serverId,
    input.agentId,
    input.attempt,
    input.archivedAt,
  );
}

function applyArchivedAgentCaches(queryClient: QueryClient, input: ArchiveAgentInput): void {
  const current = currentArchiveAgent(input);
  if (!current?.archivedAt || Number.isNaN(current.archivedAt.getTime())) return;
  const archivedAt = current.archivedAt.toISOString();
  removeAgentFromCachedLists(queryClient, input);
  markAgentArchivedInHistoryCache(queryClient, { ...input, archivedAt });
}

function markAgentArchivedInStore(input: ArchiveAgentInput & { archivedAt: string }): void {
  const archivedAt = new Date(input.archivedAt);
  if (Number.isNaN(archivedAt.getTime())) {
    return;
  }

  getHostRuntimeStore().archiveAgentSnapshot(
    input.serverId,
    input.agentId,
    archivedAt.toISOString(),
  );
}

interface ApplyArchivedAgentCloseResultsInput {
  queryClient: QueryClient;
  serverId: string;
  results: ArchivedAgentCloseResult[];
  invalidateQueries?: boolean;
}

export function applyArchivedAgentCloseResults(input: ApplyArchivedAgentCloseResultsInput): void {
  if (input.results.length === 0) {
    return;
  }

  for (const result of input.results) {
    markAgentArchivedInStore({
      serverId: input.serverId,
      agentId: result.agentId,
      archivedAt: result.archivedAt,
    });
    applyArchivedAgentCaches(input.queryClient, {
      serverId: input.serverId,
      agentId: result.agentId,
    });
  }

  if (input.invalidateQueries ?? true) {
    void input.queryClient.invalidateQueries({
      queryKey: ["sidebarAgentsList", input.serverId],
    });
    void input.queryClient.invalidateQueries({
      queryKey: ["allAgents", input.serverId],
    });
    void input.queryClient.invalidateQueries({
      queryKey: agentHistoryQueryKey(input.serverId),
    });
    void input.queryClient.invalidateQueries({
      queryKey: allAgentHistoryQueryRootKey(),
    });
  }
}

function useArchiveAgentPendingQuery() {
  return useQuery({
    queryKey: ARCHIVE_AGENT_PENDING_QUERY_KEY,
    queryFn: async (): Promise<ArchiveAgentPendingState> => ({}),
    initialData: {} as ArchiveAgentPendingState,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

function useArchiveAgentReconciliationQuery() {
  return useQuery({
    queryKey: ARCHIVE_AGENT_RECONCILIATION_QUERY_KEY,
    queryFn: async (): Promise<ArchiveAgentReconciliationState> => ({}),
    initialData: {} as ArchiveAgentReconciliationState,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export function usePendingArchiveAgentKeys(): ReadonlySet<string> {
  const pendingQuery = useArchiveAgentPendingQuery();
  return useMemo(() => new Set(Object.keys(pendingQuery.data ?? {})), [pendingQuery.data]);
}

export function usePendingArchiveAgentIds(serverId: string): ReadonlySet<string> {
  const pendingQuery = useArchiveAgentPendingQuery();
  return useMemo(
    () => selectPendingArchiveAgentIds(pendingQuery.data ?? {}, serverId),
    [pendingQuery.data, serverId],
  );
}

export function useArchiveAgent() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const pendingQuery = useArchiveAgentPendingQuery();
  const reconciliationQuery = useArchiveAgentReconciliationQuery();

  const archiveMutation = useMutation({
    mutationFn: async (input: ArchiveAgentInput): Promise<{ archivedAt: string }> => {
      const client = useSessionStore.getState().sessions[input.serverId]?.client ?? null;
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return await client.archiveAgent(input.agentId);
    },
    onMutate: (input): ArchiveAgentMutationContext => {
      const attempt = captureArchiveAttempt(input);
      setAgentArchiving({
        queryClient,
        serverId: input.serverId,
        agentId: input.agentId,
        isArchiving: true,
      });
      return attempt;
    },
    onSuccess: async (result, input, attempt) => {
      try {
        await reconcileArchiveStatus(input, t("common.errors.daemonClientUnavailable"));
      } catch {
        applyConfirmedArchiveReceipt({
          attempt,
          archivedAt: result.archivedAt,
          serverId: input.serverId,
          agentId: input.agentId,
        });
      }
      applyArchivedAgentCaches(queryClient, input);
    },
    onSettled: async (result, error, input) => {
      if (error) {
        try {
          await reconcileArchiveStatus(input, t("common.errors.daemonClientUnavailable"));
          setArchiveReconciliationState({
            queryClient,
            serverId: input.serverId,
            agentId: input.agentId,
            isArchiving: false,
          });
        } catch {
          // A failed status fetch proves nothing about the archive outcome. Keep
          // this local uncertainty separate from the daemon-owned summary and
          // leave the conversation read-only until an explicit refresh succeeds.
          setArchiveReconciliationState({
            queryClient,
            serverId: input.serverId,
            agentId: input.agentId,
            isArchiving: true,
          });
        }
      } else if (result) {
        setArchiveReconciliationState({
          queryClient,
          serverId: input.serverId,
          agentId: input.agentId,
          isArchiving: false,
        });
      }
      clearArchiveAgentPending({
        queryClient,
        serverId: input.serverId,
        agentId: input.agentId,
      });
      void queryClient.invalidateQueries({
        queryKey: ["sidebarAgentsList", input.serverId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["allAgents", input.serverId],
      });
      void queryClient.invalidateQueries({
        queryKey: agentHistoryQueryKey(input.serverId),
      });
      void queryClient.invalidateQueries({
        queryKey: allAgentHistoryQueryRootKey(),
      });
    },
  });

  const archiveMutateAsync = archiveMutation.mutateAsync;

  const archiveAgent = useCallback(
    async (input: ArchiveAgentInput): Promise<void> => {
      await archiveMutateAsync(input);
    },
    [archiveMutateAsync],
  );

  const refreshArchiveStatus = useCallback(
    async (input: ArchiveAgentInput): Promise<void> => {
      try {
        await reconcileArchiveStatus(input, t("common.errors.daemonClientUnavailable"));
        setArchiveReconciliationState({
          queryClient,
          serverId: input.serverId,
          agentId: input.agentId,
          isArchiving: false,
        });
      } catch (error) {
        setArchiveReconciliationState({
          queryClient,
          serverId: input.serverId,
          agentId: input.agentId,
          isArchiving: true,
        });
        throw error;
      }
    },
    [queryClient, t],
  );

  const isArchivingAgent = useCallback(
    (input: ArchiveAgentInput): boolean => {
      const key = toArchiveKey(input);
      if (!key) {
        return false;
      }
      return (pendingQuery.data ?? {})[key] ?? false;
    },
    [pendingQuery.data],
  );

  const isArchiveReconciliationUncertainForAgent = useCallback(
    (input: ArchiveAgentInput): boolean => {
      const key = toArchiveKey(input);
      if (!key) {
        return false;
      }
      return (reconciliationQuery.data ?? {})[key] ?? false;
    },
    [reconciliationQuery.data],
  );

  return {
    archiveAgent,
    isArchivingAgent,
    refreshArchiveStatus,
    isArchiveReconciliationUncertain: isArchiveReconciliationUncertainForAgent,
  };
}

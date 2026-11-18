import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { i18n } from "@/i18n/i18next";

export interface BulkClosableTabGroups {
  archiveAgentTabs: Array<{ tabId: string; agentId: string }>;
  layoutOnlyAgentTabs: Array<{ tabId: string; agentId: string }>;
  terminalTabs: Array<{ tabId: string; terminalId: string }>;
  otherTabs: Array<{ tabId: string; target: WorkspaceTabDescriptor["target"] }>;
}

export interface BulkCloseConfirmationLabels {
  all: (input: { agents: number; terminals: number; tabs: number }) => string;
  agentsAndTerminals: (input: { agents: number; terminals: number }) => string;
  terminalsAndTabs: (input: { terminals: number; tabs: number }) => string;
  agentsAndTabs: (input: { agents: number; tabs: number }) => string;
  terminals: (input: { terminals: number }) => string;
  tabs: (input: { tabs: number }) => string;
  agents: (input: { agents: number }) => string;
}

export const DEFAULT_BULK_CLOSE_CONFIRMATION_LABELS: BulkCloseConfirmationLabels = {
  all: ({ agents, terminals, tabs }) =>
    `This will archive ${agents} agent(s), close ${terminals} terminal(s), and close ${tabs} tab(s). Any running process in a closed terminal will be stopped immediately.`,
  agentsAndTerminals: ({ agents, terminals }) =>
    `This will archive ${agents} agent(s) and close ${terminals} terminal(s). Any running process in a closed terminal will be stopped immediately.`,
  terminalsAndTabs: ({ terminals, tabs }) =>
    `This will close ${terminals} terminal(s) and close ${tabs} tab(s). Any running process in a closed terminal will be stopped immediately.`,
  agentsAndTabs: ({ agents, tabs }) =>
    `This will archive ${agents} agent(s) and close ${tabs} tab(s).`,
  terminals: ({ terminals }) =>
    `This will close ${terminals} terminal(s). Any running process in a closed terminal will be stopped immediately.`,
  tabs: ({ tabs }) => `This will close ${tabs} tab(s).`,
  agents: ({ agents }) => `This will archive ${agents} agent(s).`,
};

interface CloseWorkspaceTabWithCleanupInput {
  tabId: string;
  target?: WorkspaceTabDescriptor["target"];
}

interface CloseBulkWorkspaceTabsInput {
  client: Pick<DaemonClient, "closeItems"> | null;
  groups: BulkClosableTabGroups;
  closeTab: (tabId: string, action: () => Promise<void>) => Promise<void>;
  closeWorkspaceTabWithCleanup: (input: CloseWorkspaceTabWithCleanupInput) => void;
  closeLayoutOnlyAgent: (agentId: string) => Promise<void>;
  logLabel: string;
  warn?: (message: string, payload: object) => void;
}

export function classifyBulkClosableTabs(
  tabs: WorkspaceTabDescriptor[],
  resolveAgentCloseKind: (agentId: string) => "archive" | "layout-only" = () => "archive",
): BulkClosableTabGroups {
  const groups: BulkClosableTabGroups = {
    archiveAgentTabs: [],
    layoutOnlyAgentTabs: [],
    terminalTabs: [],
    otherTabs: [],
  };

  for (const tab of tabs) {
    if (tab.target.kind === "agent") {
      const agentTab = { tabId: tab.tabId, agentId: tab.target.agentId };
      if (resolveAgentCloseKind(tab.target.agentId) === "layout-only") {
        groups.layoutOnlyAgentTabs.push(agentTab);
      } else {
        groups.archiveAgentTabs.push(agentTab);
      }
      continue;
    }
    if (tab.target.kind === "terminal") {
      groups.terminalTabs.push({ tabId: tab.tabId, terminalId: tab.target.terminalId });
      continue;
    }
    groups.otherTabs.push({ tabId: tab.tabId, target: tab.target });
  }

  return groups;
}

export function buildBulkCloseConfirmationMessage(
  input: BulkClosableTabGroups,
  labels: BulkCloseConfirmationLabels = DEFAULT_BULK_CLOSE_CONFIRMATION_LABELS,
): string {
  const { archiveAgentTabs, layoutOnlyAgentTabs, terminalTabs, otherTabs } = input;
  const tabCount = layoutOnlyAgentTabs.length + otherTabs.length;
  if (archiveAgentTabs.length > 0 && terminalTabs.length > 0 && tabCount > 0) {
    return labels.all({
      agents: archiveAgentTabs.length,
      terminals: terminalTabs.length,
      tabs: tabCount,
    });
  }
  if (archiveAgentTabs.length > 0 && terminalTabs.length > 0) {
    return labels.agentsAndTerminals({
      agents: archiveAgentTabs.length,
      terminals: terminalTabs.length,
    });
  }
  if (terminalTabs.length > 0 && tabCount > 0) {
    return labels.terminalsAndTabs({
      terminals: terminalTabs.length,
      tabs: tabCount,
    });
  }
  if (archiveAgentTabs.length > 0 && tabCount > 0) {
    return labels.agentsAndTabs({
      agents: archiveAgentTabs.length,
      tabs: tabCount,
    });
  }
  if (terminalTabs.length > 0) {
    return labels.terminals({ terminals: terminalTabs.length });
  }
  if (tabCount > 0) {
    return labels.tabs({ tabs: tabCount });
  }
  return labels.agents({ agents: archiveAgentTabs.length });
}

export interface BulkCloseResult {
  /** Destructive tabs the daemon did not confirm. They stay visible and retryable. */
  failedAgentIds: string[];
  failedTerminalIds: string[];
  failedLayoutOnlyAgentIds: string[];
  /** A transport/daemon failure covering every requested destructive tab. */
  error: unknown | null;
}

function confirmedCloseItemIds(result: {
  agents: readonly { agentId: string }[];
  terminals: readonly { terminalId: string; success: boolean }[];
}): { agents: Set<string>; terminals: Set<string> } {
  return {
    agents: new Set(result.agents.map((agent) => agent.agentId).filter(Boolean)),
    terminals: new Set(
      result.terminals
        .filter((terminal) => terminal.success)
        .map((terminal) => terminal.terminalId)
        .filter(Boolean),
    ),
  };
}

export async function closeBulkWorkspaceTabs(
  input: CloseBulkWorkspaceTabsInput,
): Promise<BulkCloseResult> {
  const {
    client,
    groups,
    closeTab,
    closeWorkspaceTabWithCleanup,
    closeLayoutOnlyAgent,
    logLabel,
    warn,
  } = input;
  const hasDestructiveTabs = groups.archiveAgentTabs.length > 0 || groups.terminalTabs.length > 0;
  const failedLayoutOnlyAgentIds: string[] = [];

  for (const { tabId, agentId } of groups.layoutOnlyAgentTabs) {
    await closeTab(tabId, async () => {
      try {
        await closeLayoutOnlyAgent(agentId);
      } catch (error) {
        failedLayoutOnlyAgentIds.push(agentId);
        warn?.(`[WorkspaceScreen] Failed to close subagent tab ${logLabel}`, { error, agentId });
        return;
      }
      closeWorkspaceTabWithCleanup({
        tabId,
        target: { kind: "agent", agentId },
      });
    });
  }

  let error: unknown = null;
  const confirmedAgentIds = new Set<string>();
  const confirmedTerminalIds = new Set<string>();

  if (hasDestructiveTabs) {
    if (!client) {
      error = new Error(i18n.t("common.errors.daemonClientUnavailable"));
      warn?.(`[WorkspaceScreen] Failed to bulk close tabs ${logLabel}`, { error });
    } else {
      try {
        const result = await client.closeItems({
          agentIds: groups.archiveAgentTabs.map((tab) => tab.agentId),
          terminalIds: groups.terminalTabs.map((tab) => tab.terminalId),
        });
        const confirmed = confirmedCloseItemIds(result);
        for (const agentId of confirmed.agents) confirmedAgentIds.add(agentId);
        for (const terminalId of confirmed.terminals) confirmedTerminalIds.add(terminalId);
      } catch (caught) {
        error = caught;
        warn?.(`[WorkspaceScreen] Failed to bulk close tabs ${logLabel}`, { error: caught });
      }
    }
  }

  const failedAgentIds = groups.archiveAgentTabs
    .filter((tab) => !confirmedAgentIds.has(tab.agentId))
    .map((tab) => tab.agentId);
  const failedTerminalIds = groups.terminalTabs
    .filter((tab) => !confirmedTerminalIds.has(tab.terminalId))
    .map((tab) => tab.terminalId);

  await Promise.all([
    ...groups.archiveAgentTabs
      .filter((tab) => confirmedAgentIds.has(tab.agentId))
      .map(({ tabId, agentId }) =>
        closeTab(tabId, async () => {
          closeWorkspaceTabWithCleanup({
            tabId,
            target: { kind: "agent", agentId },
          });
        }),
      ),
    ...groups.terminalTabs
      .filter((tab) => confirmedTerminalIds.has(tab.terminalId))
      .map(({ tabId, terminalId }) =>
        closeTab(tabId, async () => {
          closeWorkspaceTabWithCleanup({
            tabId,
            target: { kind: "terminal", terminalId },
          });
        }),
      ),
    ...groups.otherTabs.map(({ tabId, target }) =>
      closeTab(tabId, async () => {
        closeWorkspaceTabWithCleanup({ tabId, target });
      }),
    ),
  ]);

  return {
    failedAgentIds,
    failedTerminalIds,
    failedLayoutOnlyAgentIds,
    error,
  };
}

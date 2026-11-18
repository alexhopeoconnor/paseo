import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import {
  closeActiveAgentWithShortcut,
  archiveAgentFromDaemon,
  archiveAgentFromSessions,
  clickSessionRow,
  createIdleAgent,
  expectArchivedAgentFocused,
  expectSessionRowArchived,
  expectSessionRowVisible,
  expectWorkspaceArchiveOutcome,
  expectWorkspaceTabHidden,
  expectWorkspaceTabVisible,
  fetchAgentArchivedAt,
  openSessions,
  openWorkspaceWithAgents,
  primeAdditionalPage,
  resetSeededPageState,
  unarchiveAgentFromConversation,
  reloadWorkspace,
} from "../support/helpers/archive-tab";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  expectComposerDraft,
  expectComposerVisible,
  fillComposerDraft,
  submitMessage,
} from "../support/helpers/composer";
import { awaitAssistantMessage, expectAgentIdle } from "../support/helpers/agent-stream";
import { expectAgentTabActive } from "../support/helpers/launcher";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";

type WebSocketMessage = string | Buffer;
type SessionMessage = Record<string, unknown>;

function parseSessionMessage(message: WebSocketMessage): {
  envelope: Record<string, unknown>;
  session: SessionMessage;
} | null {
  try {
    const raw = typeof message === "string" ? message : message.toString("utf8");
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    if (envelope.type !== "session" || !envelope.message || typeof envelope.message !== "object") {
      return null;
    }
    return { envelope, session: envelope.message as SessionMessage };
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function targetSnapshots(message: SessionMessage, agentId: string): Record<string, unknown>[] {
  const payload = asObject(message.payload);
  if (!payload) return [];
  const candidate = (value: unknown): Record<string, unknown>[] => {
    const snapshot = asObject(value);
    return snapshot?.id === agentId ? [snapshot] : [];
  };
  switch (message.type) {
    case "agent_update":
    case "fetch_agent_response":
    case "fetch_agent_timeline_response":
      return candidate(payload.agent);
    case "fetch_agents_response":
    case "fetch_agent_history_response": {
      const entries = Array.isArray(payload.entries) ? payload.entries : [];
      return entries.flatMap((entry) => candidate(asObject(entry)?.agent));
    }
    case "agent_list":
      return Array.isArray(payload.agents) ? payload.agents.flatMap(candidate) : [];
    default:
      return [];
  }
}

/**
 * Reproduces the daemon's partial-child archive reply while keeping the real
 * browser client, query invalidation, reload, and eventual retry in play. The
 * server daemon/client E2E covers the native cascade itself; this transport
 * fixture isolates the UI's recovery contract without mutating the shared mock
 * provider.
 */
async function installArchiveRecoveryTransport(page: Page, agentId: string) {
  let failureTriggered = false;
  let retryAllowed = false;
  let archiveRequestCount = 0;
  let archiveReplyCount = 0;
  let messageRequestCount = 0;
  let latestSnapshot: Record<string, unknown> | null = null;

  const recoverySnapshot = () => {
    if (!latestSnapshot) {
      throw new Error("Archive recovery fixture did not receive an agent snapshot before close");
    }
    return {
      ...latestSnapshot,
      archivedAt: null,
      archiveOperation: { state: "children_pending", canRetry: true },
    };
  };

  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      const parsed = parseSessionMessage(message);
      if (
        parsed?.session.type === "send_agent_message_request" &&
        parsed.session.agentId === agentId
      ) {
        messageRequestCount += 1;
      }
      if (parsed?.session.type === "archive_agent_request" && parsed.session.agentId === agentId) {
        archiveRequestCount += 1;
        if (!failureTriggered) {
          failureTriggered = true;
          const requestId = parsed.session.requestId;
          if (typeof requestId !== "string") {
            throw new Error(
              "Archive recovery fixture received an archive request without requestId",
            );
          }
          browser.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "agent_update",
                payload: { kind: "upsert", agent: recoverySnapshot() },
              },
            }),
          );
          browser.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "rpc_error",
                payload: {
                  requestId,
                  requestType: "archive_agent_request",
                  error: "Some child agents still need to close.",
                  code: "archive_children_pending",
                },
              },
            }),
          );
          return;
        }
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const parsed = parseSessionMessage(message);
      const archiveReply =
        parsed && parsed.session.type === "agent_archived"
          ? asObject(parsed.session.payload)
          : null;
      if (archiveReply?.agentId === agentId) {
        archiveReplyCount += 1;
      }
      let rewritten = false;
      for (const snapshot of parsed ? targetSnapshots(parsed.session, agentId) : []) {
        latestSnapshot = { ...snapshot };
        if (failureTriggered && !retryAllowed) {
          snapshot.archivedAt = null;
          snapshot.archiveOperation = { state: "children_pending", canRetry: true };
          rewritten = true;
        }
      }
      // Leave the handshake and unrelated daemon packets byte-for-byte intact.
      // We only serialize parsed session traffic after changing its target snapshot.
      browser.send(rewritten && parsed ? JSON.stringify(parsed.envelope) : message);
    });
  });

  return {
    allowExplicitRetry(): void {
      retryAllowed = true;
    },
    archiveRequestCount: () => archiveRequestCount,
    archiveReplyCount: () => archiveReplyCount,
    messageRequestCount: () => messageRequestCount,
  };
}

test.describe("Archive tab reconciliation", () => {
  let client: Awaited<ReturnType<typeof connectSeedClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  let projectId: string;
  let workspaceId: string;

  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    tempRepo = await createTempGitRepo("archive-tab-");
    client = await connectSeedClient();
    const created = await client.createWorkspace({
      source: { kind: "directory", path: tempRepo.path },
    });
    if (!created.workspace) {
      throw new Error(created.error ?? `Failed to create workspace ${tempRepo.path}`);
    }
    projectId = created.workspace.projectId;
    workspaceId = created.workspace.id;
  });

  test.afterAll(async () => {
    await client?.removeProject(projectId).catch(() => undefined);
    await client?.close().catch(() => undefined);
    await tempRepo?.cleanup();
  });

  test("restoring a closed agent retains its unsent composer draft after reload", async ({
    page,
  }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "archived-composer-",
      title: "Restore unsent draft",
    });
    try {
      await openAgentRoute(page, agent);
      await submitMessage(page, "A completed conversation before closing");
      await awaitAssistantMessage(page);
      await expectAgentIdle(page);
      await fillComposerDraft(page, "Keep this unsent message after closing");
      await expectComposerDraft(page, "Keep this unsent message after closing");
      await closeActiveAgentWithShortcut(page, agent.agentId);
      await expect.poll(() => fetchAgentArchivedAt(agent.client, agent.agentId)).not.toBeNull();
      await page.reload();
      await openSessions(page);
      await expectSessionRowArchived(page, "Restore unsent draft");
      await clickSessionRow(page, "Restore unsent draft");
      await expectArchivedAgentFocused(page, agent.agentId);
      await unarchiveAgentFromConversation(page);
      await expectComposerDraft(page, "Keep this unsent message after closing");
    } finally {
      await agent.cleanup();
    }
  });

  test("retains a partial archive tab read-only through reload until an explicit retry", async ({
    page,
  }) => {
    const historyText = "Keep this completed message while archive recovery is pending";
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "archive-recovery-tab-",
      title: "Archive recovery tab",
    });
    const transport = await installArchiveRecoveryTransport(page, agent.agentId);

    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await submitMessage(page, historyText);
      await awaitAssistantMessage(page);
      await expectAgentIdle(page);
      await expect.poll(transport.messageRequestCount).toBe(1);

      await page.keyboard.press("Alt+Shift+w");

      await expect.poll(transport.archiveRequestCount).toBe(1);
      await expectWorkspaceTabVisible(page, agent.agentId);
      await expect(
        page.getByTestId("agent-archive-recovery").filter({ visible: true }).first(),
      ).toContainText("Some child agents still need to close.");
      await expect(
        page.getByTestId("agent-archive-recovery-retry").filter({ visible: true }).first(),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Message agent..." }).filter({ visible: true }),
      ).toHaveCount(0);
      await expect(
        page.getByTestId("user-message").filter({ hasText: historyText, visible: true }),
      ).toBeVisible();
      expect(await fetchAgentArchivedAt(agent.client, agent.agentId)).toBeNull();
      expect(transport.archiveReplyCount()).toBe(0);
      expect(transport.messageRequestCount()).toBe(1);

      await page.reload({ waitUntil: "domcontentloaded" });

      await expectWorkspaceTabVisible(page, agent.agentId);
      await expect(
        page.getByTestId("agent-archive-recovery").filter({ visible: true }).first(),
      ).toContainText("Some child agents still need to close.");
      await expect(
        page.getByRole("textbox", { name: "Message agent..." }).filter({ visible: true }),
      ).toHaveCount(0);
      await expect(
        page.getByTestId("user-message").filter({ hasText: historyText, visible: true }),
      ).toBeVisible();
      expect(transport.archiveRequestCount()).toBe(1);
      expect(transport.archiveReplyCount()).toBe(0);
      expect(transport.messageRequestCount()).toBe(1);

      transport.allowExplicitRetry();
      await page
        .getByTestId("agent-archive-recovery-retry")
        .filter({ visible: true })
        .first()
        .click();

      await expect.poll(transport.archiveRequestCount).toBe(2);
      await expect.poll(transport.archiveReplyCount).toBe(1);
      await expect.poll(() => fetchAgentArchivedAt(agent.client, agent.agentId)).not.toBeNull();
      await expectWorkspaceTabHidden(page, agent.agentId);
      expect(transport.messageRequestCount()).toBe(1);
    } finally {
      await agent.cleanup();
    }
  });

  test("non-UI archive prunes the archived tab across open pages and reload", async ({ page }) => {
    const archived = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `cli-archive-${randomUUID().slice(0, 8)}`,
    });
    const surviving = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `cli-control-${randomUUID().slice(0, 8)}`,
    });
    const passivePage = await page.context().newPage();

    try {
      await primeAdditionalPage(passivePage);
      await resetSeededPageState(page);
      await resetSeededPageState(passivePage);
      await openSessions(page);
      await expectSessionRowVisible(page, archived.title);
      await expectSessionRowVisible(page, surviving.title);
      await openSessions(passivePage);
      await expectSessionRowVisible(passivePage, archived.title);
      await expectSessionRowVisible(passivePage, surviving.title);
      await openWorkspaceWithAgents(page, [archived, surviving]);
      await openWorkspaceWithAgents(passivePage, [archived, surviving]);
      await archiveAgentFromDaemon(client, archived.id);
      await expectWorkspaceArchiveOutcome(page, {
        archivedAgentId: archived.id,
        survivingAgentId: surviving.id,
      });
      await expectWorkspaceArchiveOutcome(passivePage, {
        archivedAgentId: archived.id,
        survivingAgentId: surviving.id,
      });
      await reloadWorkspace(passivePage, surviving.workspaceId);
      await expectWorkspaceTabHidden(passivePage, archived.id);
    } finally {
      await passivePage.close();
    }
  });

  test("Sessions archive prunes the archived tab across open pages", async ({ page }) => {
    const archived = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `ui-archive-${randomUUID().slice(0, 8)}`,
    });
    const surviving = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `ui-control-${randomUUID().slice(0, 8)}`,
    });
    const passivePage = await page.context().newPage();

    try {
      await primeAdditionalPage(passivePage);
      await resetSeededPageState(page);
      await resetSeededPageState(passivePage);
      await openWorkspaceWithAgents(page, [archived, surviving]);
      await openWorkspaceWithAgents(passivePage, [archived, surviving]);
      await openSessions(page);
      await archiveAgentFromSessions(page, { agentId: archived.id, title: archived.title });
      await reloadWorkspace(page, surviving.workspaceId);
      await expectWorkspaceTabHidden(page, archived.id);
      await expectWorkspaceArchiveOutcome(passivePage, {
        archivedAgentId: archived.id,
        survivingAgentId: surviving.id,
      });
    } finally {
      await passivePage.close();
    }
  });

  test("clicking an archived session navigates without unarchiving it", async ({ page }) => {
    const archived = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `unarchive-archived-${randomUUID().slice(0, 8)}`,
    });
    const surviving = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `unarchive-control-${randomUUID().slice(0, 8)}`,
    });

    await resetSeededPageState(page);
    await openWorkspaceWithAgents(page, [archived, surviving]);
    await archiveAgentFromDaemon(client, archived.id);
    const archivedAt = await fetchAgentArchivedAt(client, archived.id);
    expect(archivedAt).not.toBeNull();
    await openSessions(page);
    await expectSessionRowArchived(page, archived.title);

    await clickSessionRow(page, archived.title);

    await expectArchivedAgentFocused(page, archived.id);
    await expectAgentTabActive(page, archived.id);
    expect(await fetchAgentArchivedAt(client, archived.id)).toBe(archivedAt);

    await expect(page).toHaveURL(buildHostWorkspaceRoute(getServerId(), archived.workspaceId), {
      timeout: 30_000,
    });
  });
});

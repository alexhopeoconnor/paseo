import { expect, test, type Page } from "../support/fixtures";
import { getUtf8ByteLength } from "../../src/components/assistant-message-render-limit";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { expectComposerVisible } from "../support/helpers/composer";
import { getServerId } from "../support/helpers/server-id";
import {
  scrollTimelineToNewestLoadedEdge,
  scrollTimelineToOldestLoadedEdge,
  waitForTimelineGeometryToSettle,
} from "../support/helpers/timeline-pagination";
import { switchWorkspaceViaSidebar } from "../support/helpers/workspace-ui";

const MESSAGE_START = "Beginning of the expandable response.";
const HIDDEN_TAIL = "HIDDEN_OVERSIZED_MESSAGE_TAIL";
const LONG_RESPONSE = `${MESSAGE_START}\n\n${"word ".repeat(6_500)}${HIDDEN_TAIL}`;

function visibleAssistantMessage(page: Page) {
  return page.getByTestId("assistant-message").filter({ visible: true }).last();
}

async function expectCopiedFullResponse(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /^(Copy turn|Copied)$/ })
    .last()
    .click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(LONG_RESPONSE);
}

test("caps a newline-heavy assistant message on web before rendering markdown", async ({
  page,
}) => {
  const hiddenTail = "HIDDEN_OVERSIZED_MESSAGE_TAIL";
  const response = `${"x\n".repeat(16_000)}${hiddenTail}`;
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "assistant-message-render-limit-",
    title: "Assistant message render limit",
    initialPrompt: "Render the configured oversized response.",
    featureValues: { mockAssistantResponse: response },
  });

  try {
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await openAgentRoute(page, agent);

    const assistantMessage = page.getByTestId("assistant-message").last();
    await expect(assistantMessage).toBeVisible({ timeout: 30_000 });
    await expect(assistantMessage).not.toContainText(hiddenTail);

    const notice = assistantMessage.getByTestId("assistant-message-capped-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText(
      `Showing a preview. Full message: ${getUtf8ByteLength(response)} bytes.`,
    );
    await expect(notice).toHaveCSS("font-style", "italic");
    await expect(assistantMessage.getByRole("button", { name: "Show more" })).toBeVisible();
  } finally {
    await agent.cleanup();
  }
});

test.describe("assistant message expansion", () => {
  test("reveals the full response with the keyboard, copies all text and collapses to its start", async ({
    context,
    page,
  }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "assistant-message-expand-",
      title: "Expandable assistant response",
      initialPrompt: "Render the long response.",
      featureValues: { mockAssistantResponse: LONG_RESPONSE },
    });
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await openAgentRoute(page, agent);
      const message = visibleAssistantMessage(page);
      const toggle = message.getByTestId("assistant-message-expand-toggle");
      await expect(message).not.toContainText(HIDDEN_TAIL);
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expectCopiedFullResponse(page);

      await toggle.focus();
      await page.keyboard.press("Enter");
      await expect(message).toContainText(HIDDEN_TAIL);
      await expect(toggle).toHaveAccessibleName("Show less");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(toggle).toBeFocused();
      await expect(message.getByTestId("assistant-message-capped-notice")).toHaveCount(0);
      await expectCopiedFullResponse(page);

      await toggle.scrollIntoViewIfNeeded();
      await expect(message.getByText(MESSAGE_START, { exact: true })).not.toBeInViewport();
      await toggle.focus();
      await page.keyboard.press("Space");
      await expect(message).not.toContainText(HIDDEN_TAIL);
      await expect(toggle).toHaveAccessibleName("Show more");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(message.getByText(MESSAGE_START, { exact: true })).toBeInViewport();
      await expectCopiedFullResponse(page);
    } finally {
      await agent.cleanup();
    }
  });

  test("keeps manual expansion in a retained workspace without expanding another agent", async ({
    page,
  }) => {
    const expandedAgent = await seedMockAgentWorkspace({
      repoPrefix: "assistant-message-retained-",
      title: "Retained expanded response",
      initialPrompt: "Render the long response.",
      featureValues: { mockAssistantResponse: LONG_RESPONSE },
    });
    const otherAgent = await seedMockAgentWorkspace({
      repoPrefix: "assistant-message-other-",
      title: "Other expandable response",
      initialPrompt: "Render the other long response.",
      featureValues: {
        mockAssistantResponses: [LONG_RESPONSE, "A short response needs no expansion control."],
      },
    });
    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      await Promise.all([
        expandedAgent.client.waitForFinish(expandedAgent.agentId, 30_000),
        otherAgent.client.waitForFinish(otherAgent.agentId, 30_000),
      ]);
      await openAgentRoute(page, expandedAgent);
      await visibleAssistantMessage(page).getByRole("button", { name: "Show more" }).click();
      await expect(visibleAssistantMessage(page)).toContainText(HIDDEN_TAIL);

      await switchWorkspaceViaSidebar({
        page,
        serverId: getServerId(),
        workspaceId: otherAgent.workspaceId,
      });
      await expect(
        visibleAssistantMessage(page).getByRole("button", { name: "Show more" }),
      ).toBeVisible();
      await expect(visibleAssistantMessage(page)).not.toContainText(HIDDEN_TAIL);
      await otherAgent.client.sendAgentMessage(otherAgent.agentId, "Give a short response.");
      await otherAgent.client.waitForFinish(otherAgent.agentId, 15_000);
      await expect(visibleAssistantMessage(page)).toHaveText(
        "A short response needs no expansion control.",
      );
      await expect(
        visibleAssistantMessage(page).getByTestId("assistant-message-expand-toggle"),
      ).toHaveCount(0);

      await switchWorkspaceViaSidebar({
        page,
        serverId: getServerId(),
        workspaceId: expandedAgent.workspaceId,
      });
      await expect(visibleAssistantMessage(page)).toContainText(HIDDEN_TAIL);
      await expect(
        visibleAssistantMessage(page).getByRole("button", { name: "Show less" }),
      ).toBeVisible();

      await page.reload();
      await expect(
        visibleAssistantMessage(page).getByRole("button", { name: "Show more" }),
      ).toBeVisible();
      await expect(visibleAssistantMessage(page)).not.toContainText(HIDDEN_TAIL);
    } finally {
      await Promise.allSettled([expandedAgent.cleanup(), otherAgent.cleanup()]);
    }
  });

  test("keeps an expanded message after its virtualized row is remounted", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    const laterTurnCount = 60;
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "assistant-message-remount-",
      title: "Expanded response after remount",
      initialPrompt: "Render the original long response.",
      featureValues: {
        mockAssistantResponses: [LONG_RESPONSE],
        mockAssistantResponse: "A later short reply.",
      },
    });
    try {
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await openAgentRoute(page, agent);
      const original = page.getByTestId("assistant-message").filter({ hasText: MESSAGE_START });
      await original.getByRole("button", { name: "Show more" }).click();
      await expect(original).toContainText(HIDDEN_TAIL);

      for (let index = 0; index < laterTurnCount; index++) {
        await agent.client.sendAgentMessage(agent.agentId, `Later prompt ${index}`);
        await agent.client.waitForFinish(agent.agentId, 15_000);
      }
      await scrollTimelineToNewestLoadedEdge(page);
      await expect(
        page.getByText(`Later prompt ${laterTurnCount - 1}`, { exact: true }),
      ).toBeInViewport();
      await expect(original).toHaveCount(0);

      await scrollTimelineToOldestLoadedEdge(page);
      await waitForTimelineGeometryToSettle(page);
      await expect(original).toContainText(HIDDEN_TAIL);
      await expect(original.getByRole("button", { name: "Show less" })).toBeVisible();
    } finally {
      await agent.cleanup();
    }
  });

  test("can expand while streaming and displays the complete ending", async ({ page }) => {
    test.setTimeout(90_000);
    const tail = "STREAMING_RESPONSE_END";
    const response = `${"word ".repeat(14_000)}${tail}`;
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "assistant-message-streaming-",
      title: "Streaming expandable response",
      featureValues: {
        mockStreamingAssistantResponse: response,
        mockStreamingAssistantIntervalMs: 2,
      },
    });
    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await agent.client.sendAgentMessage(agent.agentId, "Stream the long response.");
      const message = visibleAssistantMessage(page);
      await message.getByRole("button", { name: "Show more" }).click({ timeout: 30_000 });
      await expect(message.getByRole("button", { name: "Show less" })).toBeVisible();
      await expect(message).not.toContainText(tail);
      await expect(message.getByTestId("assistant-message-capped-notice")).toHaveCount(0);

      await agent.client.waitForFinish(agent.agentId, 45_000);
      await expect(message).toContainText(tail);
      await expect(message.getByRole("button", { name: "Show less" })).toBeVisible();
      await message.getByRole("button", { name: "Show less" }).click();
      await expect(message).not.toContainText(tail);
      await expect(message.getByTestId("assistant-message-capped-notice")).toHaveText(
        `Showing a preview. Full message: ${getUtf8ByteLength(response)} bytes.`,
      );
    } finally {
      await agent.cleanup();
    }
  });
});

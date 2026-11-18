import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { expectComposerVisible } from "../support/helpers/composer";
import { getServerId } from "../support/helpers/server-id";
import {
  scrollTimelineToNewestLoadedEdge,
  scrollTimelineToOldestLoadedEdge,
  waitForTimelineGeometryToSettle,
} from "../support/helpers/timeline-pagination";
import { switchWorkspaceViaSidebar } from "../support/helpers/workspace-ui";
import { openSettings } from "../support/helpers/app";
import { clickSettingsBackToWorkspace, openSettingsSection } from "../support/helpers/settings";
import { buildSettingsSectionRoute } from "@/utils/host-routes";

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
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    const key = "@paseo:app-settings";
    const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (!settings.theme) {
      localStorage.setItem(key, JSON.stringify({ ...settings, theme: "light" }));
    }
  });
  const hiddenTail = "HIDDEN_OVERSIZED_MESSAGE_TAIL";
  const response = `${"x\n".repeat(16_000)}${"y".repeat(8_000)}${hiddenTail}`;
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

    await expect(assistantMessage.getByTestId("assistant-message-count")).toHaveCount(0);
    await expect(assistantMessage.getByTestId("assistant-message-streaming-status")).toHaveCount(0);
    const expand = assistantMessage.getByRole("button", { name: "Show full response" });
    await expect(expand).toBeVisible();
    const footer = assistantMessage.getByTestId("assistant-message-footer");
    await footer.screenshot({
      path: testInfo.outputPath("message-preview-desktop-light.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(expand).toBeVisible();
    await footer.screenshot({
      path: testInfo.outputPath("message-preview-narrow-light.png"),
    });

    await page.evaluate(() => {
      const key = "@paseo:app-settings";
      const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(key, JSON.stringify({ ...settings, theme: "dark" }));
    });
    await page.reload();
    await expect(expand).toBeVisible();
    await footer.screenshot({
      path: testInfo.outputPath("message-preview-narrow-dark.png"),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await footer.screenshot({
      path: testInfo.outputPath("message-preview-desktop-dark.png"),
    });
  } finally {
    await agent.cleanup();
  }
});

test.describe("assistant message expansion", () => {
  test("can change or disable the limit and restore it from a direct settings visit", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "assistant-message-preview-settings-",
      title: "Configurable assistant preview",
      initialPrompt: "Render the long response.",
      featureValues: { mockAssistantResponse: LONG_RESPONSE },
    });
    try {
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await openAgentRoute(page, agent);
      const message = visibleAssistantMessage(page);
      await expect(message).not.toContainText(HIDDEN_TAIL);
      await expect(message.getByRole("button", { name: "Show full response" })).toBeVisible();

      await openSettings(page);
      await openSettingsSection(page, "chat");
      const toggle = page.getByRole("switch", { name: "Limit long responses", exact: true });
      const limit = page.getByTestId("assistant-message-preview-limit");
      const apply = page.getByTestId("assistant-message-preview-apply");
      await expect(toggle).toBeChecked();
      await expect(limit).toHaveValue("32000");
      await page.screenshot({ path: testInfo.outputPath("long-response-settings-desktop.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(limit).toBeVisible();
      await expect(apply).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("long-response-settings-narrow.png") });
      await page.setViewportSize({ width: 1280, height: 900 });

      const invalidLimit = page.getByRole("alert").filter({
        hasText: "Enter a whole number greater than zero",
      });
      await limit.fill("0");
      await apply.click();
      await expect(invalidLimit).toBeVisible();
      await limit.fill("32000.5");
      await apply.click();
      await expect(invalidLimit).toBeVisible();
      await limit.fill("64000");
      await expect(invalidLimit).toHaveCount(0);
      await page.evaluate(() => {
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
          if (key === "@paseo:app-settings") {
            Storage.prototype.setItem = setItem;
            throw new DOMException("Test settings storage failure", "QuotaExceededError");
          }
          setItem.call(this, key, value);
        };
      });
      await apply.click();
      const saveError = page.getByRole("alert").filter({
        hasText: "Unable to save the response limit",
      });
      await expect(saveError).toBeVisible();
      await expect(apply).toBeEnabled();
      await apply.click();
      await expect(saveError).toHaveCount(0);
      await clickSettingsBackToWorkspace(page);
      await expect(message).toContainText(HIDDEN_TAIL);
      await expect(message.getByTestId("assistant-message-footer")).toHaveCount(0);

      await openSettings(page);
      await openSettingsSection(page, "chat");
      await limit.fill("16000");
      await apply.click();
      await clickSettingsBackToWorkspace(page);
      await expect(message).not.toContainText(HIDDEN_TAIL);
      await expect(message.getByRole("button", { name: "Show full response" })).toBeVisible();
      await expect
        .poll(async () => (await message.locator("p").last().textContent())!.length)
        .toBeLessThan(16_000);
      await message.getByRole("button", { name: "Show full response" }).click();
      await expect(message).toContainText(HIDDEN_TAIL);

      await openSettings(page);
      await openSettingsSection(page, "chat");
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await clickSettingsBackToWorkspace(page);
      await expect(message).toContainText(HIDDEN_TAIL);
      await expect(message.getByTestId("assistant-message-footer")).toHaveCount(0);

      await openSettings(page);
      await openSettingsSection(page, "chat");
      await toggle.click();
      await clickSettingsBackToWorkspace(page);
      await expect(message).not.toContainText(HIDDEN_TAIL);
      await expect(message.getByRole("button", { name: "Show full response" })).toBeVisible();
      await openSettings(page);
      await openSettingsSection(page, "chat");
      await toggle.click();
      await clickSettingsBackToWorkspace(page);
      await expect(message).toContainText(HIDDEN_TAIL);

      // Direct settings navigation must avoid restoring a potentially oversized response.
      await page.goto(buildSettingsSectionRoute("chat"));
      await expect(toggle).not.toBeChecked();
      await expect(page.getByTestId("assistant-message")).toHaveCount(0);
      await page.reload();
      await expect(toggle).not.toBeChecked();
      await expect(page.getByTestId("assistant-message")).toHaveCount(0);
      await toggle.click();
      await expect(toggle).toBeChecked();
      await expect(limit).toHaveValue("16000");
      await openAgentRoute(page, agent);
      await expect(message).not.toContainText(HIDDEN_TAIL);
      await expect(message.getByRole("button", { name: "Show full response" })).toBeVisible();
      await expect
        .poll(async () => (await message.locator("p").last().textContent())!.length)
        .toBeLessThan(16_000);
    } finally {
      await agent.cleanup();
    }
  });

  test("reveals the full response once with the keyboard and copies all text", async ({
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
      await expect(toggle).toHaveCount(0);
      await expect(page.getByTestId("agent-chat-scroll")).toBeFocused();
      await expect(message.getByRole("button", { name: "Show less" })).toHaveCount(0);
      await expect(message.getByTestId("assistant-message-footer")).toHaveCount(0);
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
      await visibleAssistantMessage(page)
        .getByRole("button", { name: "Show full response" })
        .click();
      await expect(visibleAssistantMessage(page)).toContainText(HIDDEN_TAIL);

      await switchWorkspaceViaSidebar({
        page,
        serverId: getServerId(),
        workspaceId: otherAgent.workspaceId,
      });
      await expect(
        visibleAssistantMessage(page).getByRole("button", { name: "Show full response" }),
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
        visibleAssistantMessage(page).getByTestId("assistant-message-footer"),
      ).toHaveCount(0);

      await page.reload();
      await expect(
        visibleAssistantMessage(page).getByRole("button", { name: "Show full response" }),
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
      await original.getByRole("button", { name: "Show full response" }).click();
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
      await expect(original.getByTestId("assistant-message-footer")).toHaveCount(0);
    } finally {
      await agent.cleanup();
    }
  });

  test("can expand while streaming and displays the complete ending", async ({
    page,
  }, testInfo) => {
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
      const progress = message.getByTestId("assistant-message-streaming-status");
      const spinner = message.getByTestId("assistant-message-footer").getByRole("progressbar");
      const body = message.locator("p").first();
      await expect(progress).toHaveText("Still generating…", { timeout: 30_000 });
      await expect(spinner).toBeVisible();
      await expect
        .poll(async () => (await body.textContent())!.trim().split(/\s+/).length)
        .toBe(6_400);
      const previewTextLength = (await body.textContent())!.length;
      await message.getByTestId("assistant-message-footer").screenshot({
        path: testInfo.outputPath("message-streaming-preview-footer.png"),
      });
      await message.getByRole("button", { name: "Show full response" }).click({ timeout: 30_000 });
      await expect(message.getByTestId("assistant-message-expand-toggle")).toHaveCount(0);
      await expect(progress).toHaveText("Still generating…");
      await expect(spinner).toBeVisible();
      await expect(message.getByTestId("assistant-message-count")).toHaveCount(0);
      await expect(message).not.toContainText(tail);
      await expect
        .poll(async () => (await body.textContent())!.length)
        .toBeGreaterThan(previewTextLength);
      const expandedTextLength = (await body.textContent())!.length;
      await expect
        .poll(async () => (await body.textContent())!.length)
        .toBeGreaterThan(expandedTextLength);

      await agent.client.waitForFinish(agent.agentId, 45_000);
      await expect(message).toContainText(tail);
      await expect(progress).toHaveCount(0);
      await expect(spinner).toHaveCount(0);
      await expect(message.getByTestId("assistant-message-footer")).toHaveCount(0);
    } finally {
      await agent.cleanup();
    }
  });
});

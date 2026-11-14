import type { BrowserContext, Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const PARAGRAPHS = Array.from(
  { length: 40 },
  (_, index) =>
    `Paragraph ${index + 1}: ${"The quick brown fox jumps over the lazy dog. ".repeat(3).trim()}`,
).join("\n\n");

const STREAM_PARAGRAPHS = Array.from(
  { length: 40 },
  (_, index) =>
    `Stream paragraph ${index + 1}: ${"The quick brown fox jumps over the lazy dog. ".repeat(3).trim()}`,
).join("\n\n");

const STRUCTURED_MARKDOWN = [
  "Cross paragraph intro.",
  "",
  "- first list item",
  "- second list item",
  "",
  "```typescript",
  'const answer = "forty two";',
  "```",
  "",
  "After code.",
].join("\n");

function assistantBlocks(page: Page): Locator {
  return page.locator("[data-message-id]").filter({ has: page.getByTestId("assistant-message") });
}

function chatScroller(page: Page): Locator {
  return page.locator('[data-testid="agent-chat-scroll"]');
}

async function scrollTop(page: Page): Promise<number> {
  return chatScroller(page).evaluate((element) => element.scrollTop);
}

async function selectedText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

async function openTallAgent(page: Page, repoPrefix: string, markdown = PARAGRAPHS) {
  const agent = await seedMockAgentWorkspace({
    repoPrefix,
    title: repoPrefix,
    initialPrompt: "Render the paragraphs.",
    featureValues: { mockAssistantResponse: markdown },
  });
  await agent.client.waitForAgentUpsert(
    agent.agentId,
    (snapshot) => snapshot.status === "idle",
    30_000,
  );
  await openAgentRoute(page, agent);
  return agent;
}

async function dragPastEdge(
  page: Page,
  options: { fromText: string; direction: "up" | "down" },
): Promise<{ before: number; after: number; selected: string }> {
  const start = assistantBlocks(page).getByText(options.fromText, { exact: false }).first();
  const startBox = await start.boundingBox();
  const scrollBox = await chatScroller(page).boundingBox();
  if (!startBox || !scrollBox) {
    throw new Error("Expected selection start and chat scroll box");
  }
  const before = await scrollTop(page);
  const edgeY =
    options.direction === "down" ? scrollBox.y + scrollBox.height + 40 : scrollBox.y - 40;

  await page.mouse.move(startBox.x + 3, startBox.y + startBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(scrollBox.x + scrollBox.width / 2, edgeY, { steps: 10 });
  await expect.poll(() => scrollTop(page), { message: "edge auto-scroll" }).not.toBe(before);
  await page.waitForTimeout(1_200);
  await page.mouse.move(
    scrollBox.x + scrollBox.width / 2,
    options.direction === "down" ? edgeY + 20 : edgeY - 20,
    { steps: 5 },
  );
  await page.waitForTimeout(800);
  await page.mouse.up();
  // Native edge scrolling stops at release; the browser selection is still there.
  await page.waitForTimeout(300);
  const after = await scrollTop(page);
  const selected = await selectedText(page);
  return { before, after, selected };
}

async function loadAllOlderHistory(page: Page): Promise<void> {
  const scroller = chatScroller(page);
  const box = await scroller.boundingBox();
  if (!box) throw new Error("Expected chat scroll box");
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await page.getByText("Turn 0", { exact: true }).count()) > 0) return;
    await page.mouse.wheel(0, -2_000);
    await page.waitForTimeout(700);
  }
  throw new Error("Older history did not load Turn 0");
}

async function seedManyTurns(page: Page, repoPrefix: string) {
  const turns = 20;
  await page.addInitScript(() => {
    Reflect.set(globalThis, "__PASEO_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD", 6);
    Reflect.set(globalThis, "__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS", 6);
  });
  const agent = await seedMockAgentWorkspace({
    repoPrefix,
    title: repoPrefix,
    initialPrompt: "Turn 0",
    featureValues: {
      mockAssistantResponses: Array.from(
        { length: turns },
        (_, index) => `Response ${index}:\n\n${"Bounded history line. ".repeat(5)}`,
      ),
    },
  });
  await agent.client.waitForAgentUpsert(
    agent.agentId,
    (snapshot) => snapshot.status === "idle",
    30_000,
  );
  for (let turn = 1; turn < turns; turn += 1) {
    await agent.client.sendAgentMessage(agent.agentId, `Turn ${turn}`);
    await agent.client.waitForFinish(agent.agentId, 20_000);
  }
  await openAgentRoute(page, agent);
  await expect(page.getByText(`Response ${turns - 1}:`, { exact: false })).toBeVisible({
    timeout: 30_000,
  });
  await loadAllOlderHistory(page);
  return { agent, turns };
}

async function readClipboard(context: BrowserContext, page: Page): Promise<string> {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe("ordinary desktop mouse selection", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("dragging below the bottom edge scrolls and selects offscreen text", async ({ page }) => {
    const agent = await openTallAgent(page, "selection-edge-desktop-down-");
    try {
      await expect(assistantBlocks(page).getByText("Paragraph 1:", { exact: false })).toBeVisible();
      await chatScroller(page).evaluate((element) => {
        element.scrollTop = 0;
      });
      const { before, after, selected } = await dragPastEdge(page, {
        fromText: "Paragraph 1:",
        direction: "down",
      });

      expect(after).toBeGreaterThan(before);
      expect(selected).toContain("Paragraph 10:");
      await page.waitForTimeout(500);
      expect(await scrollTop(page)).toBe(after);
    } finally {
      await agent.cleanup();
    }
  });

  test("dragging above the top edge scrolls up and selects earlier text", async ({ page }) => {
    const agent = await openTallAgent(page, "selection-edge-desktop-up-");
    try {
      await expect(
        assistantBlocks(page).getByText("Paragraph 40:", { exact: false }),
      ).toBeVisible();
      const { before, after, selected } = await dragPastEdge(page, {
        fromText: "Paragraph 40:",
        direction: "up",
      });

      expect(after).toBeLessThan(before);
      expect(selected).toContain("Paragraph 20:");
      expect(selected).toContain("Paragraph 40:");
    } finally {
      await agent.cleanup();
    }
  });

  test("a real mouse drag copies across a paragraph, list and code block", async ({
    context,
    page,
  }) => {
    const agent = await openTallAgent(page, "selection-edge-structure-", STRUCTURED_MARKDOWN);
    try {
      await expect(assistantBlocks(page).getByText("Cross paragraph intro.")).toBeVisible();
      const start = assistantBlocks(page).getByText("Cross paragraph intro.");
      const end = assistantBlocks(page).getByText("After code.");
      const startBox = await start.boundingBox();
      const endBox = await end.boundingBox();
      if (!startBox || !endBox) throw new Error("Expected cross-structure text");

      await page.mouse.move(startBox.x + 1, startBox.y + startBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(endBox.x + endBox.width - 1, endBox.y + endBox.height / 2, {
        steps: 20,
      });
      await page.mouse.up();

      expect(await selectedText(page)).toContain("After code.");
      await page.keyboard.press("ControlOrMeta+c");
      const clipboard = await readClipboard(context, page);
      expect(clipboard).toContain("Cross paragraph intro.");
      expect(clipboard).toContain("first list item");
      expect(clipboard).toContain('const answer = "forty two";');
      expect(clipboard).toContain("After code.");
    } finally {
      await agent.cleanup();
    }
  });
});

test.describe("touch-capable compact desktop mouse selection", () => {
  test.use({ hasTouch: true, viewport: { width: 540, height: 900 } });

  test("still works after opening and closing navigation", async ({ page }) => {
    const agent = await openTallAgent(page, "selection-edge-nav-");
    try {
      await expect(assistantBlocks(page).getByText("Paragraph 1:", { exact: false })).toBeVisible();
      const navigation = page.getByTestId("menu-button").filter({ visible: true });
      await navigation.click();
      await expect(page.getByTestId("sidebar-global-new-workspace")).toBeVisible();
      await page.getByTestId("sidebar-close").click();
      await expect(page.getByTestId("sidebar-global-new-workspace")).not.toBeVisible();

      await chatScroller(page).evaluate((element) => {
        element.scrollTop = 0;
      });
      const { after, selected } = await dragPastEdge(page, {
        fromText: "Paragraph 1:",
        direction: "down",
      });
      expect(after).toBeGreaterThan(0);
      expect(selected).toContain("Paragraph 10:");
    } finally {
      await agent.cleanup();
    }
  });

  test("still works after opening and closing the Explorer", async ({ page }) => {
    const agent = await openTallAgent(page, "selection-edge-explorer-");
    try {
      await expect(
        assistantBlocks(page).getByText("Paragraph 40:", { exact: false }),
      ).toBeVisible();
      await page.getByTestId("workspace-explorer-toggle").filter({ visible: true }).first().click();
      await expect(
        page.getByTestId("workspace-explorer-sidebar").filter({ visible: true }),
      ).toBeVisible();
      await page.getByTestId("workspace-explorer-toggle").filter({ visible: true }).last().click();
      await expect(
        page.getByTestId("workspace-explorer-sidebar").filter({ visible: true }),
      ).toHaveCount(0);

      const { after, selected } = await dragPastEdge(page, {
        fromText: "Paragraph 40:",
        direction: "up",
      });
      expect(after).toBeLessThan(400);
      expect(selected).toContain("Paragraph 20:");
    } finally {
      await agent.cleanup();
    }
  });

  test("wheel scrolling while a selection is held extends it", async ({ page }) => {
    const agent = await openTallAgent(page, "selection-edge-wheel-");
    try {
      await expect(assistantBlocks(page).getByText("Paragraph 1:", { exact: false })).toBeVisible();
      await chatScroller(page).evaluate((element) => {
        element.scrollTop = 0;
      });
      const start = assistantBlocks(page).getByText("Paragraph 1:", { exact: false });
      const startBox = await start.boundingBox();
      if (!startBox) throw new Error("Expected selection start");

      await page.mouse.move(startBox.x + 3, startBox.y + startBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(startBox.x + 160, startBox.y + startBox.height / 2, { steps: 5 });
      const selectedBefore = await selectedText(page);
      await page.mouse.wheel(0, 1_200);
      await expect.poll(() => scrollTop(page), { message: "wheel while held" }).toBeGreaterThan(0);
      // The browser updates the selection endpoint on the next pointer move after the wheel.
      await page.mouse.move(startBox.x + 161, startBox.y + startBox.height / 2 + 2);
      await page.waitForTimeout(200);
      const selected = await selectedText(page);
      await page.mouse.up();

      expect(selected.length).toBeGreaterThan(selectedBefore.length);
      expect(selected).toContain("Paragraph 10:");
    } finally {
      await agent.cleanup();
    }
  });

  test("streaming output does not move a held selection", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "selection-edge-streaming-",
      title: "selection-edge-streaming-",
      initialPrompt: "Stream the paragraphs.",
      featureValues: {
        mockStreamingAssistantResponse: STREAM_PARAGRAPHS,
        mockStreamingAssistantIntervalMs: 20,
      },
    });
    try {
      await openAgentRoute(page, agent);
      const paragraphs = assistantBlocks(page).getByText(/Stream paragraph \d+:/);
      await expect(paragraphs.first()).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(1_500);
      const count = await paragraphs.count();
      const anchor = paragraphs.nth(Math.max(0, count - 4));
      const box = await anchor.boundingBox();
      if (!box) throw new Error("Expected a settled stream paragraph");

      await page.mouse.move(box.x + 3, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 200, box.y + box.height / 2, { steps: 4 });
      const before = await scrollTop(page);
      const selectedBefore = await selectedText(page);
      await page.waitForTimeout(1_500);
      const after = await scrollTop(page);
      const selectedAfter = await selectedText(page);
      await page.mouse.up();

      expect(selectedBefore.length).toBeGreaterThan(0);
      expect(selectedAfter).toContain(selectedBefore);
      expect(after).toBe(before);
    } finally {
      await agent.cleanup();
    }
  });
});

test.describe("virtualized history", () => {
  test.use({ viewport: { width: 900, height: 700 } });

  test("a real drag from a virtualized turn retains it across the boundary", async ({ page }) => {
    const { agent, turns } = await seedManyTurns(page, "selection-edge-virtualized-drag-");
    try {
      const scroller = chatScroller(page);
      await scroller.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.waitForTimeout(300);
      // A `data-index` row is rendered by the virtualizer, not the mounted recent window.
      expect(await page.locator("[data-history-row-id][data-index]").count()).toBeGreaterThan(0);
      expect(await page.locator("[data-history-row-id]").count()).toBeLessThan(turns * 2);

      const anchor = page.locator('[data-history-row-id] [data-testid="user-message"]').first();
      const anchorRowId = await anchor.evaluate((element) =>
        element.closest("[data-history-row-id]")?.getAttribute("data-history-row-id"),
      );
      const anchorText = (await anchor.innerText()).split("\n")[0]?.trim() ?? "";
      expect(anchorText).toBe("Turn 0");
      const anchorBox = await page.getByText(anchorText, { exact: true }).first().boundingBox();
      const scrollBox = await scroller.boundingBox();
      if (!anchorBox || !scrollBox) throw new Error("Expected virtualized anchor and scroller");

      await page.mouse.move(anchorBox.x + 3, anchorBox.y + anchorBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        scrollBox.x + scrollBox.width / 2,
        scrollBox.y + scrollBox.height + 40,
        {
          steps: 10,
        },
      );
      await page.waitForTimeout(1_200);
      await page.mouse.move(
        scrollBox.x + scrollBox.width / 2,
        scrollBox.y + scrollBox.height + 60,
        {
          steps: 5,
        },
      );
      await page.waitForTimeout(800);
      await page.mouse.up();
      await page.waitForTimeout(300);

      const after = await scrollTop(page);
      const selected = await selectedText(page);
      expect(after).toBeGreaterThan(0);
      expect(selected).toContain("Turn 0");
      expect(selected).toContain("Turn 10");
      expect(await page.locator(`[data-history-row-id="${anchorRowId}"]`).count()).toBe(1);
    } finally {
      await agent.cleanup();
    }
  });

  test("retains only the selected interval and releases it when cleared", async ({ page }) => {
    const { agent, turns } = await seedManyTurns(page, "selection-edge-virtualized-");
    try {
      const scroller = chatScroller(page);
      await scroller.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.waitForTimeout(300);
      const rows = page.locator("[data-history-row-id]");
      const mountedAtTop = await rows.count();
      expect(mountedAtTop).toBeLessThan(turns * 2);

      const response = page.getByText("Response 0:", { exact: false }).first();
      const box = await response.boundingBox();
      if (!box) throw new Error("Expected a virtualized response");
      await page.mouse.move(box.x + 3, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 220, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      expect(await selectedText(page)).toContain("Response 0:");

      await scroller.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.waitForTimeout(800);
      const mountedAfter = await rows.count();
      const selectedAfter = await selectedText(page);
      expect(selectedAfter).toContain("Response 0:");
      expect(mountedAfter).toBeLessThan(turns * 2);
      expect(await page.getByText("Turn 2", { exact: true }).count()).toBe(0);

      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await page.waitForTimeout(400);
      expect(await page.getByText("Response 0:", { exact: false }).count()).toBe(0);
      expect(await rows.count()).toBeLessThan(mountedAfter);
    } finally {
      await agent.cleanup();
    }
  });
});

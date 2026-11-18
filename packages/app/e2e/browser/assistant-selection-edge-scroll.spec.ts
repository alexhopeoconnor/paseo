import type { BrowserContext, Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { firefoxClipboardLaunchOptions, grantClipboardAccess } from "../support/helpers/clipboard";

test.use(firefoxClipboardLaunchOptions);

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

const ANCHOR_LIFECYCLE_PROBE_KEY = "__paseoVirtualizedAnchorLifecycleProbe";
const ANCHOR_LIFECYCLE_MAX_EVENTS = 128;

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

interface NativeSelectionEndpoint {
  rowId: string | null;
  offset: number;
  nodeName: string | null;
}

interface NativeSelectionCheckpoint {
  phase: "pre-edge" | "post-edge";
  text: string;
  isCollapsed: boolean;
  anchor: NativeSelectionEndpoint;
  focus: NativeSelectionEndpoint;
}

async function captureNativeSelectionCheckpoint(
  page: Page,
  phase: NativeSelectionCheckpoint["phase"],
): Promise<NativeSelectionCheckpoint> {
  return page.evaluate((checkpointPhase) => {
    const selection = window.getSelection();
    const endpoint = (node: Node | null, offset: number): NativeSelectionEndpoint => {
      const element = node instanceof Element ? node : node?.parentElement;
      return {
        rowId:
          element?.closest("[data-history-row-id]")?.getAttribute("data-history-row-id") ?? null,
        offset,
        nodeName:
          node === null
            ? null
            : node.nodeType === Node.TEXT_NODE
              ? "#text"
              : node.nodeName.toLowerCase(),
      };
    };
    return {
      phase: checkpointPhase,
      text: selection?.toString() ?? "",
      isCollapsed: selection?.isCollapsed ?? true,
      anchor: endpoint(selection?.anchorNode ?? null, selection?.anchorOffset ?? -1),
      focus: endpoint(selection?.focusNode ?? null, selection?.focusOffset ?? -1),
    };
  }, phase);
}

async function installAnchorLifecycleProbe(page: Page, anchorRowId: string): Promise<void> {
  await page.evaluate(
    ({ anchorRowId: expectedAnchorRowId, probeKey, maxEvents }) => {
      const rowsWithAnchorId = () =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-history-row-id]")).filter(
          (element) => element.dataset.historyRowId === expectedAnchorRowId,
        );
      const originalAnchor = rowsWithAnchorId()[0];
      if (!originalAnchor) {
        throw new Error(`Expected anchor row for lifecycle probe: ${expectedAnchorRowId}`);
      }
      const events: unknown[] = [];
      let truncatedEventCount = 0;
      const describeNode = (node: Node | null) => {
        const element = node instanceof Element ? node : node?.parentElement;
        const row = element?.closest<HTMLElement>("[data-history-row-id]") ?? null;
        return {
          nodeName:
            node === null
              ? null
              : node.nodeType === Node.TEXT_NODE
                ? "#text"
                : node.nodeName.toLowerCase(),
          rowId: row?.dataset.historyRowId ?? null,
          dataIndex: row?.dataset.index ?? null,
        };
      };
      const anchorState = () => {
        const matchingRows = rowsWithAnchorId();
        const currentRow = matchingRows[0] ?? null;
        return {
          originalAnchorIsConnected: originalAnchor.isConnected,
          matchingRowCount: matchingRows.length,
          hasCurrentSameIdNode: currentRow !== null,
          currentSameIdIsOriginal: currentRow === originalAnchor,
          currentSameIdNodeIsConnected: currentRow?.isConnected ?? false,
          originalDataIndex: originalAnchor.dataset.index ?? null,
          currentDataIndex: currentRow?.dataset.index ?? null,
        };
      };
      const selectionState = () => {
        const selection = window.getSelection();
        const scrollContainer = document.querySelector<HTMLElement>(
          '[data-testid="agent-chat-scroll"]',
        );
        const endpoint = (node: Node | null, offset: number) => ({
          ...describeNode(node),
          offset,
          isInsideScrollContainer: Boolean(node && scrollContainer?.contains(node)),
        });
        const text = selection?.toString() ?? "";
        return {
          isCollapsed: selection?.isCollapsed ?? true,
          rangeCount: selection?.rangeCount ?? 0,
          textLength: text.length,
          textPrefix: text.slice(0, 120),
          anchor: endpoint(selection?.anchorNode ?? null, selection?.anchorOffset ?? -1),
          focus: endpoint(selection?.focusNode ?? null, selection?.focusOffset ?? -1),
        };
      };
      const record = (kind: string, details: Record<string, unknown> = {}) => {
        if (events.length >= maxEvents) {
          truncatedEventCount += 1;
          return;
        }
        events.push({
          kind,
          at: performance.now(),
          selection: selectionState(),
          anchor: anchorState(),
          ...details,
        });
      };
      const containsAnchorId = (node: Node) => {
        if (node instanceof Element) {
          if (node.getAttribute("data-history-row-id") === expectedAnchorRowId) return true;
          return Array.from(node.querySelectorAll<HTMLElement>("[data-history-row-id]")).some(
            (element) => element.dataset.historyRowId === expectedAnchorRowId,
          );
        }
        if (node instanceof DocumentFragment) {
          return Array.from(node.querySelectorAll<HTMLElement>("[data-history-row-id]")).some(
            (element) => element.dataset.historyRowId === expectedAnchorRowId,
          );
        }
        return false;
      };
      const describeMutation = (mutation: MutationRecord) => ({
        target: describeNode(mutation.target),
        added: Array.from(mutation.addedNodes, describeNode),
        removed: Array.from(mutation.removedNodes, describeNode),
      });
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          const removedOriginal = Array.from(mutation.removedNodes).some(
            (node) => node === originalAnchor || node.contains(originalAnchor),
          );
          const addedSameId = Array.from(mutation.addedNodes).some(containsAnchorId);
          if (removedOriginal) {
            record("anchor-original-removed", { mutation: describeMutation(mutation) });
          }
          if (addedSameId) {
            record("anchor-same-id-added", { mutation: describeMutation(mutation) });
          }
        }
      });
      const pointerDetails = (event: PointerEvent) => ({
        pointerType: event.pointerType,
        isPrimary: event.isPrimary,
        buttons: event.buttons,
        button: event.button,
        pointerId: event.pointerId,
        target: describeNode(event.target instanceof Node ? event.target : null),
      });
      const onPointerMoveCapture = (event: PointerEvent) => {
        record("pointermove-capture", pointerDetails(event));
      };
      const onPointerMoveBubble = (event: PointerEvent) => {
        record("pointermove-bubble", pointerDetails(event));
      };
      const onSelectionChange = () => {
        record("selectionchange");
      };

      observer.observe(document.documentElement, { childList: true, subtree: true });
      // These listeners are registered after the mounted viewport listeners, so the bubble
      // record observes state after the product's window-level pointermove handler.
      window.addEventListener("pointermove", onPointerMoveCapture, true);
      window.addEventListener("pointermove", onPointerMoveBubble);
      document.addEventListener("selectionchange", onSelectionChange);
      record("probe-installed");

      Reflect.set(window, probeKey, {
        dispose: () => {
          observer.disconnect();
          window.removeEventListener("pointermove", onPointerMoveCapture, true);
          window.removeEventListener("pointermove", onPointerMoveBubble);
          document.removeEventListener("selectionchange", onSelectionChange);
          return {
            anchorRowId: expectedAnchorRowId,
            originalAnchor: describeNode(originalAnchor),
            finalAnchor: anchorState(),
            finalSelection: selectionState(),
            truncatedEventCount,
            events,
          };
        },
      });
    },
    {
      anchorRowId,
      probeKey: ANCHOR_LIFECYCLE_PROBE_KEY,
      maxEvents: ANCHOR_LIFECYCLE_MAX_EVENTS,
    },
  );
}

async function disposeAnchorLifecycleProbe(page: Page): Promise<unknown | null> {
  return page.evaluate((probeKey) => {
    const probe = Reflect.get(window, probeKey) as { dispose?: () => unknown } | undefined;
    try {
      return probe?.dispose?.() ?? null;
    } finally {
      Reflect.deleteProperty(window, probeKey);
    }
  }, ANCHOR_LIFECYCLE_PROBE_KEY);
}

interface TextSelectionSweepGeometry {
  text: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  rects: Array<{ left: number; right: number; top: number; bottom: number }>;
}

async function textSelectionSweepGeometry(
  locator: Locator,
  expectedText: string,
): Promise<TextSelectionSweepGeometry> {
  return locator.evaluate((element, expected) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let textNode: Text | null = null;
    while (walker.nextNode()) {
      const candidate = walker.currentNode;
      if (candidate instanceof Text && candidate.data.trim() === expected) {
        textNode = candidate;
        break;
      }
    }
    if (!textNode) {
      throw new Error(`Expected text node for native selection: ${expected}`);
    }

    const range = document.createRange();
    range.selectNodeContents(textNode);
    const rects = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      }));
    const first = rects[0];
    const last = rects[rects.length - 1];
    if (!first || !last) {
      throw new Error(`Expected visible text geometry for native selection: ${expected}`);
    }

    const inset = (rect: (typeof rects)[number]) =>
      Math.min(1, Math.max(0.5, (rect.right - rect.left) / 4));
    return {
      text: textNode.data,
      start: {
        x: first.left + inset(first),
        y: first.top + (first.bottom - first.top) / 2,
      },
      end: {
        x: last.right - inset(last),
        y: last.top + (last.bottom - last.top) / 2,
      },
      rects,
    };
  }, expectedText);
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

async function scrollChatToTop(page: Page): Promise<void> {
  const box = await chatScroller(page).boundingBox();
  if (!box) throw new Error("Expected chat scroll box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const before = await scrollTop(page);
    if (before === 0) return;
    await page.mouse.wheel(0, -2_000);
    await expect.poll(() => scrollTop(page)).toBeLessThan(before);
  }
  throw new Error("Chat did not reach the start");
}

async function dragPastEdge(
  page: Page,
  options: { fromText: string; direction: "up" | "down"; viewportEdge?: boolean },
): Promise<{ before: number; after: number; selected: string }> {
  const start = assistantBlocks(page).getByText(options.fromText, { exact: false }).first();
  const startBox = await start.boundingBox();
  const scrollBox = await chatScroller(page).boundingBox();
  if (!startBox || !scrollBox) {
    throw new Error("Expected selection start and chat scroll box");
  }
  const before = await scrollTop(page);
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  const viewportEdgeY = options.direction === "down" ? viewportHeight - 2 : 2;
  const chatEdgeY =
    options.direction === "down" ? scrollBox.y + scrollBox.height + 40 : scrollBox.y - 40;
  const edgeY = options.viewportEdge ? viewportEdgeY : chatEdgeY;

  await page.mouse.move(startBox.x + 3, startBox.y + startBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(scrollBox.x + scrollBox.width / 2, edgeY, { steps: 10 });
  await expect.poll(() => scrollTop(page), { message: "edge auto-scroll" }).not.toBe(before);
  await page.waitForTimeout(1_200);
  await page.mouse.move(
    scrollBox.x + scrollBox.width / 2,
    options.direction === "down"
      ? Math.min(viewportHeight - 1, edgeY + 20)
      : Math.max(0, edgeY - 20),
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
  await grantClipboardAccess(context);
  return page.evaluate(() => navigator.clipboard.readText());
}

function nextPointerId(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        window.addEventListener("pointerdown", (event) => resolve(event.pointerId), { once: true });
      }),
  );
}

test.describe("ordinary desktop mouse selection", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("dragging below the bottom edge scrolls and selects offscreen text", async ({ page }) => {
    const agent = await openTallAgent(page, "selection-edge-desktop-down-");
    try {
      await expect(assistantBlocks(page).getByText("Paragraph 1:", { exact: false })).toBeVisible();
      await scrollChatToTop(page);
      const { before, after, selected } = await dragPastEdge(page, {
        fromText: "Paragraph 1:",
        direction: "down",
      });

      expect(after).toBeGreaterThan(before);
      expect(selected).toContain("Paragraph 10:");
      await page.waitForTimeout(500);
      expect(await scrollTop(page)).toBe(after);
      const composer = page.getByRole("textbox", { name: "Message agent...", exact: true });
      await composer.fill("Selection released");
      await composer.selectText();
      await expect(composer).toHaveValue("Selection released");
      expect(
        await composer.evaluate((element) => {
          if (!(element instanceof HTMLTextAreaElement))
            throw new Error("Expected composer textarea");
          return element.value.slice(element.selectionStart, element.selectionEnd);
        }),
      ).toBe("Selection released");
    } finally {
      await agent.cleanup();
    }
  });

  test("dragging to the viewport bottom keeps scrolling past the composer", async ({ page }) => {
    const agent = await openTallAgent(page, "selection-viewport-bottom-");
    try {
      await expect(assistantBlocks(page).getByText("Paragraph 1:", { exact: false })).toBeVisible();
      await scrollChatToTop(page);
      const { before, after, selected } = await dragPastEdge(page, {
        fromText: "Paragraph 1:",
        direction: "down",
        viewportEdge: true,
      });
      expect(after).toBeGreaterThan(before);
      expect(selected).toContain("Paragraph 10:");
      expect(selected).not.toContain("Ctrl+L to focus");
      const composer = page.getByRole("textbox", { name: "Message agent...", exact: true });
      const controlText = await page.getByTestId("composer-root").innerText();
      for (const label of controlText
        .split("\n")
        .map((text) => text.trim())
        .filter(Boolean)) {
        expect(selected).not.toContain(label);
      }
      await page.waitForTimeout(500);
      expect(await scrollTop(page)).toBe(after);
      await composer.fill("Composer still selects text");
      await composer.selectText();
      expect(
        await composer.evaluate((element: HTMLTextAreaElement) =>
          element.value.slice(element.selectionStart, element.selectionEnd),
        ),
      ).toBe("Composer still selects text");
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

  for (const interruption of ["pointercancel", "blur"] as const) {
    test(`restores composing after a selection drag receives ${interruption}`, async ({ page }) => {
      const agent = await openTallAgent(page, `selection-cancel-${interruption}-`);
      try {
        await expect(
          assistantBlocks(page).getByText("Paragraph 1:", { exact: false }),
        ).toBeVisible();
        await scrollChatToTop(page);
        const start = await assistantBlocks(page)
          .getByText("Paragraph 1:", { exact: false })
          .first()
          .boundingBox();
        if (!start) throw new Error("Expected selection start");
        const pointerId = nextPointerId(page);
        await page.mouse.move(start.x + 3, start.y + 8);
        await page.mouse.down();
        await page.mouse.move(start.x + 120, start.y + 8, { steps: 8 });
        const composer = page.getByRole("textbox", { name: "Message agent...", exact: true });
        await expect(composer).toHaveCSS("pointer-events", "none");
        await page.evaluate(
          (details) => {
            // Exercise cleanup handlers, not an OS-level blur or cancellation assertion.
            const event =
              details.interruption === "blur"
                ? new Event("blur")
                : new PointerEvent("pointercancel", { pointerId: details.pointerId });
            window.dispatchEvent(event);
          },
          { interruption, pointerId: await pointerId },
        );
        await expect(composer).not.toHaveCSS("pointer-events", "none");
        await page.mouse.up();
        await composer.fill("Composing restored");
        await expect(composer).toHaveValue("Composing restored");
      } finally {
        await page.mouse.up();
        await agent.cleanup();
      }
    });
  }

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

      await scrollChatToTop(page);
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
      await scrollChatToTop(page);
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

  test("a real drag from a virtualized turn retains it across the boundary", async ({
    page,
  }, testInfo) => {
    const { agent, turns } = await seedManyTurns(page, "selection-edge-virtualized-drag-");
    const checkpoints: NativeSelectionCheckpoint[] = [];
    let anchorRowId: string | null = null;
    let geometry: TextSelectionSweepGeometry | null = null;
    let selectionPointerHeld = false;
    let anchorLifecycleProbeInstalled = false;
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
      anchorRowId = await anchor.evaluate(
        (element) =>
          element.closest("[data-history-row-id]")?.getAttribute("data-history-row-id") ?? null,
      );
      const anchorText = (await anchor.innerText()).split("\n")[0]?.trim() ?? "";
      expect(anchorText).toBe("Turn 0");
      if (!anchorRowId) throw new Error("Expected virtualized anchor row id");
      await installAnchorLifecycleProbe(page, anchorRowId);
      anchorLifecycleProbeInstalled = true;
      geometry = await textSelectionSweepGeometry(anchor, anchorText);
      const scrollBox = await scroller.boundingBox();
      if (!scrollBox) throw new Error("Expected virtualized scroller");

      await page.mouse.move(geometry.start.x, geometry.start.y);
      await page.mouse.down();
      selectionPointerHeld = true;
      // This remains one native drag. The initial sweep proves the pointer selected Turn 0
      // before it leaves the virtualized row and starts browser edge scrolling.
      await page.mouse.move(geometry.end.x, geometry.end.y, { steps: 3 });
      const preEdge = await captureNativeSelectionCheckpoint(page, "pre-edge");
      checkpoints.push(preEdge);
      expect(preEdge.text).toContain("Turn 0");
      await page.mouse.move(
        scrollBox.x + scrollBox.width / 2,
        scrollBox.y + scrollBox.height + 40,
        {
          steps: 10,
        },
      );
      await page.waitForTimeout(1_200);
      expect(await page.locator(`[data-history-row-id="${anchorRowId}"]`).count()).toBe(1);
      await page.mouse.move(
        scrollBox.x + scrollBox.width / 2,
        scrollBox.y + scrollBox.height + 60,
        {
          steps: 5,
        },
      );
      await page.waitForTimeout(800);
      const postEdge = await captureNativeSelectionCheckpoint(page, "post-edge");
      checkpoints.push(postEdge);
      await page.mouse.up();
      selectionPointerHeld = false;
      await page.waitForTimeout(300);

      const after = await scrollTop(page);
      const selected = await selectedText(page);
      expect(after).toBeGreaterThan(0);
      expect(selected).toContain("Turn 0");
      expect(selected).toContain("Turn 10");
      expect(await page.locator(`[data-history-row-id="${anchorRowId}"]`).count()).toBe(1);
    } finally {
      try {
        if (selectionPointerHeld) {
          await page.mouse.up().catch(() => undefined);
        }
        if (anchorLifecycleProbeInstalled) {
          const lifecycle = await disposeAnchorLifecycleProbe(page).catch((error: unknown) => ({
            disposeError: error instanceof Error ? error.message : String(error),
          }));
          await testInfo.attach("virtualized-selection-anchor-lifecycle", {
            body: JSON.stringify(lifecycle, null, 2),
            contentType: "application/json",
          });
        }
        await testInfo.attach("virtualized-selection-native-range", {
          body: JSON.stringify({ anchorRowId, geometry, checkpoints }, null, 2),
          contentType: "application/json",
        });
      } finally {
        await agent.cleanup();
      }
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

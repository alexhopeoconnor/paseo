import { expect, type Locator, type Page } from "@playwright/test";
import { WEB_SCROLLBAR_SIZE_PX } from "@/styles/web-scrollbar";
import { test } from "../support/fixtures";
import {
  readScrollMetrics,
  scrollChatAwayFromBottom,
} from "../support/helpers/agent-bottom-anchor";
import { getServerId } from "../support/helpers/server-id";
import { seedMockAgentWorkspace, type MockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  continueToNextQuestion,
  fillQuestionAnswer,
  submitQuestionAnswers,
  waitForQuestionPrompt,
} from "../support/helpers/questions";
import { openMobileAgentSidebar } from "../support/helpers/sidebar";
import {
  expectTimelinePromptVisible,
  openAgentTimeline,
  seedLongMockAgentTimeline,
} from "../support/helpers/timeline-pagination";
import { switchWorkspaceViaSidebar } from "../support/helpers/workspace-ui";

async function expectChatAtBottom(page: Page): Promise<void> {
  await expect
    .poll(async () => (await readScrollMetrics(page)).distanceFromBottom, {
      timeout: 10_000,
    })
    .toBeLessThanOrEqual(72);
}

async function expectNoNoncollapsedSelection(page: Page, stage: string): Promise<void> {
  const selection = await page.evaluate(() => {
    const current = window.getSelection();
    return {
      isCollapsed: current?.isCollapsed ?? true,
      rangeCount: current?.rangeCount ?? 0,
      textLength: current?.toString().length ?? 0,
    };
  });
  expect(selection.rangeCount, `${stage}: expected no multi-range selection`).toBeLessThanOrEqual(
    1,
  );
  expect(selection.isCollapsed, `${stage}: ${JSON.stringify(selection)}`).toBe(true);
}

type PointerJitterTraversalClassification = "ordinary-content" | "scrollbar-gutter";

interface PointerJitterTraversalSegment {
  classification: PointerJitterTraversalClassification;
  fromX: number;
  throughX: number;
  hitCount: number;
}

interface PointerJitterContentPaddingGeometry {
  contentLeft: number;
  contentTop: number;
  contentRight: number;
  contentBottom: number;
  paddingLeft: number;
  paddingRight: number;
  paddingBottom: number;
  contentBoxLeft: number;
  contentBoxRight: number;
  visibleBottomPaddingTop: number;
  visibleBottomPaddingBottom: number;
}

interface PointerJitterRightCorridor {
  x: number;
  y: number;
  traversalY: number;
  rootLeft: number;
  rootTop: number;
  rootRight: number;
  rootBottom: number;
  direction: string;
  actualScrollbarWidth: number;
  scrollbarGutterWidth: number;
  gutterLeft: number;
  contentPadding: PointerJitterContentPaddingGeometry;
  hitTag: string;
  hitTestId: string | null;
  traversalHitCount: number;
  startClassification: PointerJitterTraversalClassification;
  endpointClassification: PointerJitterTraversalClassification;
  traversalSegments: PointerJitterTraversalSegment[];
}

async function resolvePointerJitterRightCorridor(
  scroll: Locator,
): Promise<PointerJitterRightCorridor> {
  const result = await scroll.evaluate((root, minimumScrollbarWidth: number) => {
    function readContentPadding(
      contentContainer: HTMLElement | null,
      rect: DOMRect,
    ): PointerJitterContentPaddingGeometry | null {
      if (contentContainer === null) return null;
      const contentRect = contentContainer.getBoundingClientRect();
      const contentStyle = window.getComputedStyle(contentContainer);
      const paddingLeft = Number.parseFloat(contentStyle.paddingLeft);
      const paddingRight = Number.parseFloat(contentStyle.paddingRight);
      const paddingBottom = Number.parseFloat(contentStyle.paddingBottom);
      return {
        contentLeft: contentRect.left,
        contentTop: contentRect.top,
        contentRight: contentRect.right,
        contentBottom: contentRect.bottom,
        paddingLeft,
        paddingRight,
        paddingBottom,
        contentBoxLeft: contentRect.left + paddingLeft,
        contentBoxRight: contentRect.right - paddingRight,
        visibleBottomPaddingTop: Math.max(contentRect.bottom - paddingBottom, rect.top),
        visibleBottomPaddingBottom: Math.min(contentRect.bottom, rect.bottom),
      };
    }

    function hasUsableContentPadding(
      contentPadding: PointerJitterContentPaddingGeometry | null,
    ): contentPadding is PointerJitterContentPaddingGeometry {
      return (
        contentPadding !== null &&
        Number.isFinite(contentPadding.paddingLeft) &&
        Number.isFinite(contentPadding.paddingRight) &&
        Number.isFinite(contentPadding.paddingBottom) &&
        contentPadding.paddingBottom > 3 &&
        contentPadding.contentBoxLeft < contentPadding.contentBoxRight &&
        contentPadding.visibleBottomPaddingBottom - contentPadding.visibleBottomPaddingTop > 3
      );
    }

    function hasInvalidContentPaddingCoordinate(
      x: number,
      y: number,
      rect: DOMRect,
      gutterLeft: number,
      contentPadding: PointerJitterContentPaddingGeometry,
    ): boolean {
      const traversalY = y - 3;
      return (
        x < rect.left ||
        x >= gutterLeft ||
        x <= contentPadding.contentBoxLeft ||
        x >= contentPadding.contentBoxRight ||
        y <= contentPadding.visibleBottomPaddingTop ||
        y >= contentPadding.visibleBottomPaddingBottom ||
        traversalY <= contentPadding.visibleBottomPaddingTop ||
        traversalY >= contentPadding.visibleBottomPaddingBottom
      );
    }

    const container = root as HTMLElement;
    const contentContainer = container.querySelector<HTMLElement>(
      '[data-testid="agent-chat-content"]',
    );
    const contentContainerIsDirectChild = contentContainer?.parentElement === container;
    const contentUserSelect =
      contentContainer === null ? null : window.getComputedStyle(contentContainer).userSelect;
    const rect = container.getBoundingClientRect();
    const contentPadding = readContentPadding(contentContainer, rect);
    const actualScrollbarWidth = Math.max(container.offsetWidth - container.clientWidth, 0);
    const scrollbarGutterWidth = Math.max(actualScrollbarWidth, minimumScrollbarWidth);
    const direction = window.getComputedStyle(container).direction;
    const gutterLeft = rect.right - scrollbarGutterWidth;
    const rightOffsets = [2, 4, 6, 8, 10, 12];
    const rejected: Array<Record<string, unknown>> = [];
    if (
      direction !== "ltr" ||
      contentContainer === null ||
      !contentContainerIsDirectChild ||
      contentUserSelect !== "none" ||
      !hasUsableContentPadding(contentPadding) ||
      !Number.isFinite(gutterLeft) ||
      gutterLeft <= rect.left ||
      gutterLeft >= rect.right
    ) {
      return {
        corridor: null,
        diagnostics: {
          reason: direction !== "ltr" ? "unsupported-scroll-direction" : "invalid-scrollbar-gutter",
          direction,
          contentContainerFound: contentContainer !== null,
          contentContainerIsDirectChild,
          contentUserSelect,
          contentPadding,
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
          actualScrollbarWidth,
          scrollbarGutterWidth,
          gutterLeft,
        },
      };
    }

    const inspect = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      const isInside = hit !== null && container.contains(hit);
      const isText =
        hit !== null &&
        Array.from(hit.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0,
        );
      const isLink = hit !== null && hit.closest("a") !== null;
      const isEditor =
        hit !== null &&
        hit.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') !== null;
      const isMessageText =
        hit !== null &&
        hit.closest(
          '[data-message-text], [data-history-row-id], [data-testid="user-message"], [data-testid="assistant-message"]',
        ) !== null;
      const isInteractive =
        hit !== null &&
        hit.closest(
          'button, summary, [role="button"], [role="link"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [data-testid="workspace-overlay-scrollbar"], [data-testid="workspace-overlay-scrollbar-grab"]',
        ) !== null;
      const classification: PointerJitterTraversalClassification =
        x >= gutterLeft ? "scrollbar-gutter" : "ordinary-content";
      const safeNonInteractive =
        isInside && !isText && !isLink && !isEditor && !isMessageText && !isInteractive;
      const isContentPaddingHit = hit === contentContainer;
      return {
        x,
        y,
        hitTag: hit?.tagName ?? null,
        hitTestId: hit?.getAttribute("data-testid") ?? null,
        isInside,
        isText,
        isLink,
        isEditor,
        isMessageText,
        isInteractive,
        isContentPaddingHit,
        contentUserSelect,
        classification,
        safeNonInteractive,
        safeStartOrEndpoint:
          safeNonInteractive &&
          classification === "ordinary-content" &&
          isContentPaddingHit &&
          contentUserSelect === "none",
      };
    };

    const inspectTraversal = (x: number, y: number) => {
      const traversalStart = Math.ceil(x);
      const traversalEnd = Math.floor(rect.right - 1);
      if (traversalStart > traversalEnd) {
        return {
          traversalHitCount: 0,
          traversalSegments: [] as PointerJitterTraversalSegment[],
          rejection: { stage: "empty-interior-traversal", x, y: y - 3 },
        };
      }

      let traversalHitCount = 0;
      const traversalSegments: PointerJitterTraversalSegment[] = [];
      for (let traversalX = traversalStart; traversalX <= traversalEnd; traversalX += 1) {
        const traversalHit = inspect(traversalX, y - 3);
        traversalHitCount += 1;
        if (!traversalHit.safeNonInteractive) {
          return {
            traversalHitCount,
            traversalSegments,
            rejection: { stage: "interior-traversal", hit: traversalHit },
          };
        }
        const previousSegment = traversalSegments[traversalSegments.length - 1];
        if (
          previousSegment === undefined ||
          previousSegment.classification !== traversalHit.classification
        ) {
          traversalSegments.push({
            classification: traversalHit.classification,
            fromX: traversalX,
            throughX: traversalX,
            hitCount: 1,
          });
        } else {
          previousSegment.throughX = traversalX;
          previousSegment.hitCount += 1;
        }
      }

      const ordinaryHitCount = traversalSegments
        .filter((segment) => segment.classification === "ordinary-content")
        .reduce((count, segment) => count + segment.hitCount, 0);
      const gutterHitCount = traversalSegments
        .filter((segment) => segment.classification === "scrollbar-gutter")
        .reduce((count, segment) => count + segment.hitCount, 0);
      if (
        ordinaryHitCount === 0 ||
        gutterHitCount === 0 ||
        traversalSegments[0]?.classification !== "ordinary-content" ||
        traversalSegments[traversalSegments.length - 1]?.classification !== "scrollbar-gutter"
      ) {
        return {
          traversalHitCount,
          traversalSegments,
          rejection: {
            stage: "ordinary-and-gutter-traversal-classification",
            ordinaryHitCount,
            gutterHitCount,
            traversalSegments,
          },
        };
      }
      return { traversalHitCount, traversalSegments, rejection: null };
    };

    const inspectCandidate = (x: number, y: number) => {
      if (hasInvalidContentPaddingCoordinate(x, y, rect, gutterLeft, contentPadding)) {
        return { corridor: null, rejection: { stage: "candidate-coordinate", x, y } };
      }

      const start = inspect(x, y);
      if (!start.safeStartOrEndpoint) {
        return { corridor: null, rejection: { stage: "start", hit: start } };
      }
      const endpoint = inspect(x, y - 3);
      if (!endpoint.safeStartOrEndpoint) {
        return { corridor: null, rejection: { stage: "three-pixel-endpoint", hit: endpoint } };
      }

      const traversal = inspectTraversal(x, y);
      if (traversal.rejection !== null) {
        return { corridor: null, rejection: traversal.rejection };
      }
      return {
        corridor: {
          x,
          y,
          traversalY: y - 3,
          rootLeft: rect.left,
          rootTop: rect.top,
          rootRight: rect.right,
          rootBottom: rect.bottom,
          direction: "ltr",
          actualScrollbarWidth,
          scrollbarGutterWidth,
          gutterLeft,
          contentPadding,
          hitTag: start.hitTag ?? "unknown",
          hitTestId: start.hitTestId,
          traversalHitCount: traversal.traversalHitCount,
          startClassification: start.classification,
          endpointClassification: endpoint.classification,
          traversalSegments: traversal.traversalSegments,
        },
        rejection: null,
      };
    };

    const visibleBottomPaddingHeight =
      contentPadding.visibleBottomPaddingBottom - contentPadding.visibleBottomPaddingTop;
    const y = contentPadding.visibleBottomPaddingTop + (visibleBottomPaddingHeight + 3) / 2;
    for (const offset of rightOffsets) {
      const x = gutterLeft - offset;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const candidate = inspectCandidate(x, y);
      if (candidate.corridor !== null) {
        return { corridor: candidate.corridor, diagnostics: null };
      }
      rejected.push(candidate.rejection);
    }

    return {
      corridor: null,
      diagnostics: {
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        direction,
        actualScrollbarWidth,
        scrollbarGutterWidth,
        gutterLeft,
        rejected,
      },
    };
  }, WEB_SCROLLBAR_SIZE_PX);

  expect(
    result.corridor,
    `Expected a hit-tested right-side interior corridor inside agent-chat-scroll: ${JSON.stringify(result.diagnostics)}`,
  ).not.toBeNull();
  return result.corridor!;
}

async function expectPointerJitterRightCorridorAfterResize(
  scroll: Locator,
  corridor: PointerJitterRightCorridor,
): Promise<void> {
  const result = await scroll.evaluate(
    (
      root,
      input: {
        expected: PointerJitterRightCorridor;
        minimumScrollbarWidth: number;
      },
    ) => {
      function readContentPadding(
        contentContainer: HTMLElement | null,
        rect: DOMRect,
      ): PointerJitterContentPaddingGeometry | null {
        if (contentContainer === null) return null;
        const contentRect = contentContainer.getBoundingClientRect();
        const contentStyle = window.getComputedStyle(contentContainer);
        const paddingLeft = Number.parseFloat(contentStyle.paddingLeft);
        const paddingRight = Number.parseFloat(contentStyle.paddingRight);
        const paddingBottom = Number.parseFloat(contentStyle.paddingBottom);
        return {
          contentLeft: contentRect.left,
          contentTop: contentRect.top,
          contentRight: contentRect.right,
          contentBottom: contentRect.bottom,
          paddingLeft,
          paddingRight,
          paddingBottom,
          contentBoxLeft: contentRect.left + paddingLeft,
          contentBoxRight: contentRect.right - paddingRight,
          visibleBottomPaddingTop: Math.max(contentRect.bottom - paddingBottom, rect.top),
          visibleBottomPaddingBottom: Math.min(contentRect.bottom, rect.bottom),
        };
      }

      function hasUsableContentPadding(
        contentPadding: PointerJitterContentPaddingGeometry | null,
      ): contentPadding is PointerJitterContentPaddingGeometry {
        return (
          contentPadding !== null &&
          Number.isFinite(contentPadding.paddingLeft) &&
          Number.isFinite(contentPadding.paddingRight) &&
          Number.isFinite(contentPadding.paddingBottom) &&
          contentPadding.paddingBottom > 3 &&
          contentPadding.contentBoxLeft < contentPadding.contentBoxRight &&
          contentPadding.visibleBottomPaddingBottom - contentPadding.visibleBottomPaddingTop > 3
        );
      }

      function contentPaddingMatchesExpected(
        contentPadding: PointerJitterContentPaddingGeometry | null,
        expectedPadding: PointerJitterContentPaddingGeometry,
      ): boolean {
        return (
          contentPadding !== null &&
          contentPadding.contentLeft === expectedPadding.contentLeft &&
          contentPadding.contentTop === expectedPadding.contentTop &&
          contentPadding.contentRight === expectedPadding.contentRight &&
          contentPadding.contentBottom === expectedPadding.contentBottom &&
          contentPadding.paddingLeft === expectedPadding.paddingLeft &&
          contentPadding.paddingRight === expectedPadding.paddingRight &&
          contentPadding.paddingBottom === expectedPadding.paddingBottom &&
          contentPadding.contentBoxLeft === expectedPadding.contentBoxLeft &&
          contentPadding.contentBoxRight === expectedPadding.contentBoxRight &&
          contentPadding.visibleBottomPaddingTop === expectedPadding.visibleBottomPaddingTop &&
          contentPadding.visibleBottomPaddingBottom === expectedPadding.visibleBottomPaddingBottom
        );
      }

      function geometryMatchesExpected(
        observed: {
          rootLeft: number;
          rootTop: number;
          rootRight: number;
          rootBottom: number;
          direction: string;
          actualScrollbarWidth: number;
          scrollbarGutterWidth: number;
          gutterLeft: number;
        },
        expected: PointerJitterRightCorridor,
        paddingMatchesExpected: boolean,
      ): boolean {
        return (
          observed.rootLeft === expected.rootLeft &&
          observed.rootTop === expected.rootTop &&
          observed.rootRight === expected.rootRight &&
          observed.rootBottom === expected.rootBottom &&
          observed.direction === expected.direction &&
          observed.actualScrollbarWidth === expected.actualScrollbarWidth &&
          observed.scrollbarGutterWidth === expected.scrollbarGutterWidth &&
          observed.gutterLeft === expected.gutterLeft &&
          paddingMatchesExpected
        );
      }

      function isInsideVisibleBottomPadding(
        x: number,
        y: number,
        traversalY: number,
        contentPadding: PointerJitterContentPaddingGeometry | null,
      ): boolean {
        return (
          contentPadding !== null &&
          x > contentPadding.contentBoxLeft &&
          x < contentPadding.contentBoxRight &&
          y > contentPadding.visibleBottomPaddingTop &&
          y < contentPadding.visibleBottomPaddingBottom &&
          traversalY > contentPadding.visibleBottomPaddingTop &&
          traversalY < contentPadding.visibleBottomPaddingBottom
        );
      }

      const { expected, minimumScrollbarWidth } = input;
      const container = root as HTMLElement;
      const contentContainer = container.querySelector<HTMLElement>(
        '[data-testid="agent-chat-content"]',
      );
      const contentContainerIsDirectChild = contentContainer?.parentElement === container;
      const contentUserSelect =
        contentContainer === null ? null : window.getComputedStyle(contentContainer).userSelect;
      const rect = container.getBoundingClientRect();
      const contentPadding = readContentPadding(contentContainer, rect);
      const actualScrollbarWidth = Math.max(container.offsetWidth - container.clientWidth, 0);
      const scrollbarGutterWidth = Math.max(actualScrollbarWidth, minimumScrollbarWidth);
      const direction = window.getComputedStyle(container).direction;
      const gutterLeft = rect.right - scrollbarGutterWidth;
      const observed = {
        rootLeft: rect.left,
        rootTop: rect.top,
        rootRight: rect.right,
        rootBottom: rect.bottom,
        direction,
        actualScrollbarWidth,
        scrollbarGutterWidth,
        gutterLeft,
        contentPadding,
      };
      const paddingMatchesExpected = contentPaddingMatchesExpected(
        contentPadding,
        expected.contentPadding,
      );
      const expectedIsInsideVisibleBottomPadding = isInsideVisibleBottomPadding(
        expected.x,
        expected.y,
        expected.traversalY,
        contentPadding,
      );
      if (
        direction !== "ltr" ||
        contentContainer === null ||
        !contentContainerIsDirectChild ||
        contentUserSelect !== "none" ||
        !hasUsableContentPadding(contentPadding) ||
        !expectedIsInsideVisibleBottomPadding ||
        !Number.isFinite(gutterLeft) ||
        !geometryMatchesExpected(observed, expected, paddingMatchesExpected)
      ) {
        return {
          safe: false,
          reason: "corridor geometry changed after resize",
          expected,
          observed: {
            ...observed,
            contentContainerFound: contentContainer !== null,
            contentContainerIsDirectChild,
            contentUserSelect,
          },
        };
      }

      const inspect = (x: number, y: number) => {
        const hit = document.elementFromPoint(x, y);
        const isInside = hit !== null && container.contains(hit);
        const isText =
          hit !== null &&
          Array.from(hit.childNodes).some(
            (node) =>
              node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0,
          );
        const isLink = hit !== null && hit.closest("a") !== null;
        const isEditor =
          hit !== null &&
          hit.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') !==
            null;
        const isMessageText =
          hit !== null &&
          hit.closest(
            '[data-message-text], [data-history-row-id], [data-testid="user-message"], [data-testid="assistant-message"]',
          ) !== null;
        const isInteractive =
          hit !== null &&
          hit.closest(
            'button, summary, [role="button"], [role="link"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [data-testid="workspace-overlay-scrollbar"], [data-testid="workspace-overlay-scrollbar-grab"]',
          ) !== null;
        const classification: PointerJitterTraversalClassification =
          x >= gutterLeft ? "scrollbar-gutter" : "ordinary-content";
        const safeNonInteractive =
          isInside && !isText && !isLink && !isEditor && !isMessageText && !isInteractive;
        const isContentPaddingHit = hit === contentContainer;
        return {
          x,
          y,
          hitTag: hit?.tagName ?? null,
          hitTestId: hit?.getAttribute("data-testid") ?? null,
          isInside,
          isText,
          isLink,
          isEditor,
          isMessageText,
          isInteractive,
          isContentPaddingHit,
          contentUserSelect,
          classification,
          safeNonInteractive,
          safeStartOrEndpoint:
            safeNonInteractive &&
            classification === "ordinary-content" &&
            isContentPaddingHit &&
            contentUserSelect === "none",
        };
      };

      const inspectTraversalAfterResize = (
        start: ReturnType<typeof inspect>,
        endpoint: ReturnType<typeof inspect>,
      ) => {
        const traversalStart = Math.ceil(expected.x);
        const traversalEnd = Math.floor(rect.right - 1);
        if (traversalStart > traversalEnd) {
          return { safe: false, reason: "interior traversal disappeared after resize" };
        }

        let traversalHitCount = 0;
        const traversalSegments: PointerJitterTraversalSegment[] = [];
        for (let traversalX = traversalStart; traversalX <= traversalEnd; traversalX += 1) {
          const traversalHit = inspect(traversalX, expected.traversalY);
          traversalHitCount += 1;
          if (!traversalHit.safeNonInteractive) {
            return {
              safe: false,
              reason: "interior traversal changed after resize",
              hit: traversalHit,
            };
          }
          const previousSegment = traversalSegments[traversalSegments.length - 1];
          if (
            previousSegment === undefined ||
            previousSegment.classification !== traversalHit.classification
          ) {
            traversalSegments.push({
              classification: traversalHit.classification,
              fromX: traversalX,
              throughX: traversalX,
              hitCount: 1,
            });
          } else {
            previousSegment.throughX = traversalX;
            previousSegment.hitCount += 1;
          }
        }

        const ordinaryHitCount = traversalSegments
          .filter((segment) => segment.classification === "ordinary-content")
          .reduce((count, segment) => count + segment.hitCount, 0);
        const gutterHitCount = traversalSegments
          .filter((segment) => segment.classification === "scrollbar-gutter")
          .reduce((count, segment) => count + segment.hitCount, 0);
        const classificationsMatch =
          start.classification === expected.startClassification &&
          endpoint.classification === expected.endpointClassification &&
          JSON.stringify(traversalSegments) === JSON.stringify(expected.traversalSegments);
        if (
          ordinaryHitCount === 0 ||
          gutterHitCount === 0 ||
          traversalSegments[0]?.classification !== "ordinary-content" ||
          traversalSegments[traversalSegments.length - 1]?.classification !== "scrollbar-gutter" ||
          traversalHitCount !== expected.traversalHitCount ||
          !classificationsMatch
        ) {
          return {
            safe: false,
            reason: "interior traversal classification changed after resize",
            expectedTraversalHitCount: expected.traversalHitCount,
            traversalHitCount,
            expectedTraversalSegments: expected.traversalSegments,
            traversalSegments,
            ordinaryHitCount,
            gutterHitCount,
          };
        }
        return { safe: true, traversalHitCount };
      };

      const start = inspect(expected.x, expected.y);
      if (!start.safeStartOrEndpoint) {
        return { safe: false, reason: "start changed after resize", hit: start };
      }
      const endpoint = inspect(expected.x, expected.traversalY);
      if (!endpoint.safeStartOrEndpoint) {
        return { safe: false, reason: "three-pixel endpoint changed after resize", hit: endpoint };
      }
      return inspectTraversalAfterResize(start, endpoint);
    },
    { expected: corridor, minimumScrollbarWidth: WEB_SCROLLBAR_SIZE_PX },
  );

  expect(
    result.safe,
    `Expected the recorded right-side pointer corridor to remain safe after resize: ${JSON.stringify(result)}`,
  ).toBe(true);
}

async function openCompactWorkspace(
  page: Page,
  workspace: Pick<MockAgentWorkspace, "workspaceId">,
): Promise<void> {
  await openMobileAgentSidebar(page);
  await switchWorkspaceViaSidebar({
    page,
    serverId: getServerId(),
    workspaceId: workspace.workspaceId,
  });
}

function armDelayedScrollForHiddenChat(page: Page): Promise<void> {
  return page
    .locator('[data-testid="agent-chat-scroll"]:visible')
    .first()
    .evaluate((root) => {
      const scroll = root as HTMLElement;
      return new Promise<void>((resolve) => {
        const observer = new ResizeObserver(() => {
          if (scroll.getClientRects().length > 0) return;
          observer.disconnect();
          scroll.dispatchEvent(new Event("scroll"));
          resolve();
        });
        observer.observe(scroll);
      });
    });
}

test("pointer jitter cannot turn geometry changes into scroll intent", async ({ page }) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const backgroundPrompt = "Continue after a pointer is released outside the chat";

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    await expectChatAtBottom(page);

    const scroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
    // Start in a read-only hit-tested right-side ordinary-content corridor.
    // The start and three-pixel endpoint stay outside the product scrollbar
    // gutter; each ordinary and gutter traversal hit remains non-text and
    // non-interactive, or the test fails closed.
    const jitterCorridor = await resolvePointerJitterRightCorridor(scroll);
    await expectNoNoncollapsedSelection(page, "before pointer jitter");
    await page.mouse.move(jitterCorridor.x, jitterCorridor.y);
    await page.mouse.down();
    await page.mouse.move(jitterCorridor.x, jitterCorridor.y - 3);
    await expectNoNoncollapsedSelection(page, "after 3px pointer jitter");
    await page.setViewportSize({ width: 390, height: 1124 });
    await page.setViewportSize({ width: 390, height: 844 });
    await expectPointerJitterRightCorridorAfterResize(scroll, jitterCorridor);
    await page.mouse.move(410, jitterCorridor.y - 3);
    await page.mouse.up();
    await expectNoNoncollapsedSelection(page, "after outside release");

    await longChat.client.sendAgentMessage(longChat.agentId, backgroundPrompt);
    await longChat.client.waitForFinish(longChat.agentId, 20_000);
    await expectTimelinePromptVisible(page, backgroundPrompt);
    await expectChatAtBottom(page);
  } finally {
    await longChat.cleanup();
  }
});

test("a retained chat ignores delayed scroll delivery while hidden", async ({ page }) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const otherWorkspace = await seedMockAgentWorkspace({
    repoPrefix: "scroll-return-hidden-other-",
    title: "Other workspace",
    initialPrompt: "Open the other workspace",
  });
  const backgroundPrompt = "emit 500 coalesced agent stream updates";

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    await expectChatAtBottom(page);

    const delayedScrollDelivered = armDelayedScrollForHiddenChat(page);
    await openCompactWorkspace(page, otherWorkspace);
    await delayedScrollDelivered;
    await longChat.client.sendAgentMessage(longChat.agentId, backgroundPrompt);
    await longChat.client.waitForFinish(longChat.agentId, 20_000);

    await openCompactWorkspace(page, longChat);
    await expectTimelinePromptVisible(page, backgroundPrompt);
    await expectChatAtBottom(page);
  } finally {
    await Promise.allSettled([longChat.cleanup(), otherWorkspace.cleanup()]);
  }
});

test("a retained streaming chat returns to the bottom and continues following", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const otherWorkspace = await seedMockAgentWorkspace({
    repoPrefix: "scroll-return-streaming-other-",
    title: "Other workspace",
    initialPrompt: "Open the other workspace",
  });
  const streamingPrompt = "Continue streaming while this workspace is hidden";

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    await expectChatAtBottom(page);

    await longChat.client.sendAgentMessage(longChat.agentId, streamingPrompt);
    await longChat.client.waitForAgentUpsert(
      longChat.agentId,
      (snapshot) => snapshot.status === "running",
      15_000,
    );
    await openCompactWorkspace(page, otherWorkspace);
    await openCompactWorkspace(page, longChat);

    await expectTimelinePromptVisible(page, streamingPrompt);
    await expectChatAtBottom(page);
    await longChat.client.waitForFinish(longChat.agentId, 20_000);
    await expectChatAtBottom(page);
  } finally {
    await Promise.allSettled([longChat.cleanup(), otherWorkspace.cleanup()]);
  }
});

test("a retained chat preserves an intentional reading position", async ({ page }) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const otherWorkspace = await seedMockAgentWorkspace({
    repoPrefix: "scroll-return-reading-position-other-",
    title: "Other workspace",
    initialPrompt: "Open the other workspace",
  });

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    const readingPosition = await scrollChatAwayFromBottom(page, {
      deltaY: -900,
      minDistanceFromBottom: 300,
    });

    await openCompactWorkspace(page, otherWorkspace);
    await openCompactWorkspace(page, longChat);

    await expect
      .poll(async () => Math.abs((await readScrollMetrics(page)).offsetY - readingPosition.offsetY))
      .toBeLessThanOrEqual(24);
  } finally {
    await Promise.allSettled([longChat.cleanup(), otherWorkspace.cleanup()]);
  }
});

test("editing keys in an embedded question keep output following", async ({ page }) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const questionPrompt = "Emit synthetic questions: two free-write questions.";
  const firstQuestion = "What is the GitHub private repo URL to push to?";
  const secondQuestion = "What should the first commit message be?";

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    await expectChatAtBottom(page);

    await longChat.client.sendAgentMessage(longChat.agentId, questionPrompt);
    await waitForQuestionPrompt(page, 30_000);
    await fillQuestionAnswer(page, {
      question: firstQuestion,
      answer: "git@github.com:user/private-repo.git",
    });
    const firstInput = page
      .getByTestId("question-form-card")
      .first()
      .getByRole("textbox", { name: firstQuestion });
    const inputBounds = await firstInput.boundingBox();
    expect(inputBounds, "Expected embedded question input bounds").not.toBeNull();
    await page.mouse.move(
      inputBounds!.x + inputBounds!.width / 2,
      inputBounds!.y + inputBounds!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      inputBounds!.x + inputBounds!.width / 2 + 20,
      inputBounds!.y + inputBounds!.height / 2 - 3,
    );
    await page.mouse.up();
    await firstInput.press("Home");
    await firstInput.press("ArrowUp");
    await continueToNextQuestion(page);
    await fillQuestionAnswer(page, {
      question: secondQuestion,
      answer: "Initialize private repo",
    });
    await submitQuestionAnswers(page);
    await longChat.client.waitForFinish(longChat.agentId, 20_000);

    await expectChatAtBottom(page);
  } finally {
    await longChat.cleanup();
  }
});

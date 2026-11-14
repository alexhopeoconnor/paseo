import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONTENT_MAX_WIDTH } from "@/styles/theme";
import type { StreamItem } from "@/types/stream";
import type { StreamRenderInput, StreamViewportHandle } from "./strategy";
import { createWebStreamStrategy } from "./strategy-web";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// The timeline imports chat find for its selected-row range. Mounting the real find surface
// pulls the shared Lucide test stub, which does not need to be complete for a scroll test.
vi.mock("@/pane-find", () => ({
  PaneFind: () => null,
  findShortcutPlatform: () => ({ isMac: false }),
  isFindShortcut: () => false,
}));

const VIEWPORT_HEIGHT = 100;
const ROW_HEIGHT = 40;
const ROW_STYLE = { height: ROW_HEIGHT };

function row(index: number): Extract<StreamItem, { kind: "user_message" }> {
  return {
    kind: "user_message",
    id: `message-${index}`,
    text: `Message ${index}`,
    timestamp: new Date(`2026-04-20T00:00:${String(index % 60).padStart(2, "0")}.000Z`),
  };
}

function renderRow(item: StreamItem) {
  return <div style={ROW_STYLE}>{item.id}</div>;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = `display:flex;flex-direction:column;width:500px;height:${VIEWPORT_HEIGHT}px`;
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

interface MountTimelineOptions {
  input?: Partial<StreamRenderInput>;
  isMobileBreakpoint?: boolean;
}

function mountTimeline(
  historyMounted: StreamItem[],
  { input = {}, isMobileBreakpoint = true }: MountTimelineOptions = {},
) {
  const strategy = createWebStreamStrategy({ isMobileBreakpoint });
  const viewportRef = React.createRef<StreamViewportHandle>();
  const renderInput: StreamRenderInput = {
    agentId: "agent",
    segments: { historyVirtualized: [], historyMounted, liveHead: [] },
    boundary: { hasVirtualizedHistory: false, hasMountedHistory: true, hasLiveHead: false },
    renderers: {
      renderHistoryVirtualizedRow: renderRow,
      renderHistoryMountedRow: renderRow,
      renderLiveHeadRow: renderRow,
      renderLiveAuxiliary: () => null,
    },
    listEmptyComponent: null,
    viewportRef,
    routeBottomAnchorRequest: null,
    isAuthoritativeHistoryReady: true,
    onNearBottomChange: () => {},
    onNearHistoryStart: async () => true,
    isLoadingOlderHistory: false,
    hasOlderHistory: false,
    olderHistoryProgressKey: null,
    scrollEnabled: true,
    listStyle: null,
    baseListContentContainerStyle: null,
    forwardListContentContainerStyle: null,
    contentMaxWidth: DEFAULT_CONTENT_MAX_WIDTH,
    ...input,
  };
  const render = (segments: Partial<StreamRenderInput["segments"]>) =>
    root.render(
      strategy.render({ ...renderInput, segments: { ...renderInput.segments, ...segments } }),
    );
  act(() => render({}));

  const scrollContainer = host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]');
  if (!scrollContainer) throw new Error("Expected agent chat scroll container");
  const rowElement = (id: string) => {
    const element = host.querySelector<HTMLElement>(`[data-history-row-id="${id}"]`);
    if (!element) throw new Error(`Expected row ${id}`);
    return element;
  };

  return {
    render: (segments: Partial<StreamRenderInput["segments"]>) => act(() => render(segments)),
    holdReadingPosition: () => act(() => viewportRef.current!.holdReadingPosition()),
    rowTop: (id: string) =>
      rowElement(id).getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top,
    scrollTo: (top: number) => {
      scrollContainer.scrollTop = top;
    },
    scrollTop: () => scrollContainer.scrollTop,
    scrollUp: (distance: number) =>
      act(() => {
        scrollContainer.dispatchEvent(new WheelEvent("wheel", { deltaY: -distance }));
        scrollContainer.scrollTop -= distance;
        scrollContainer.dispatchEvent(new Event("scroll"));
      }),
    // A wheel listener runs before the browser applies the scroll the wheel causes.
    wheelUpTo: (top: number) => {
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1000 }));
      scrollContainer.scrollTop = top;
    },
    distanceFromEnd: () =>
      scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop,
    // Resize observers and the history-start settle run on animation frames.
    settle: () =>
      act(async () => {
        for (let frame = 0; frame < 4; frame += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }),
  };
}

describe("web history start", () => {
  it("loads older history when an upward wheel lands at the start after the reader stopped following", async () => {
    let olderHistoryLoads = 0;
    const history = [1, 2, 3, 4, 5, 6].map((index) => row(index));
    const timeline = mountTimeline(history, {
      input: {
        hasOlderHistory: true,
        olderHistoryProgressKey: "epoch:1",
        onNearHistoryStart: async () => {
          olderHistoryLoads += 1;
          return true;
        },
      },
    });
    await timeline.settle();
    // Stopping at the bottom without scrolling, as opening a disclosure row does, leaves
    // history-start pagination dormant until the reader shows upward intent.
    timeline.holdReadingPosition();
    await timeline.settle();
    expect(olderHistoryLoads).toBe(0);

    timeline.wheelUpTo(0);
    await timeline.settle();

    expect(olderHistoryLoads).toBe(1);
  });
});

describe("web history virtualization", () => {
  it.each([{ isMobileBreakpoint: true }, { isMobileBreakpoint: false }])(
    "keeps the reading position when mounted history becomes virtualized (compact: $isMobileBreakpoint)",
    async (options) => {
      const history = Array.from({ length: 80 }, (_, index) => row(index));
      const timeline = mountTimeline(history, options);
      await timeline.settle();
      timeline.scrollUp(600);
      await timeline.settle();
      const offset = timeline.scrollTop();
      const readingTop = timeline.rowTop("message-64");
      expect(offset).toBeGreaterThan(0);

      timeline.render({
        historyVirtualized: history.slice(0, 60),
        historyMounted: history.slice(60),
      });
      await timeline.settle();

      expect(timeline.scrollTop()).toBe(offset);
      expect(timeline.rowTop("message-64")).toBe(readingTop);
    },
  );

  it.each([{ isMobileBreakpoint: true }, { isMobileBreakpoint: false }])(
    "keeps following output when mounted history becomes virtualized at the end (compact: $isMobileBreakpoint)",
    async (options) => {
      const history = Array.from({ length: 80 }, (_, index) => row(index));
      const timeline = mountTimeline(history, options);
      await timeline.settle();

      timeline.render({
        historyVirtualized: history.slice(0, 60),
        historyMounted: history.slice(60),
      });
      await timeline.settle();
      expect(timeline.distanceFromEnd()).toBeLessThanOrEqual(1);

      timeline.render({
        historyVirtualized: history.slice(0, 60),
        historyMounted: history.slice(60),
        liveHead: [row(80)],
      });
      await timeline.settle();
      expect(timeline.distanceFromEnd()).toBeLessThanOrEqual(1);
    },
  );
});

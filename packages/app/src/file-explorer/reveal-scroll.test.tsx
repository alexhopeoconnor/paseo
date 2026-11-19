/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useExplorerRevealScroll } from "./reveal-scroll";

test("retries an unmeasured deep row and acknowledges only its visible token", () => {
  const scrollToIndex = vi.fn();
  const scrollToOffset = vi.fn();
  const onVisible = vi.fn();
  const target = { id: "request", path: "file-199.txt", index: 199 };
  const { result } = renderHook(() =>
    useExplorerRevealScroll({
      target,
      list: { current: { scrollToIndex, scrollToOffset } },
      pathOf: (path: string) => path,
      onVisible,
    }),
  );
  expect(scrollToIndex).toHaveBeenCalledWith({ index: 199, viewPosition: 0.5, animated: false });
  expect(onVisible).not.toHaveBeenCalled();
  act(() => result.current.onScrollToIndexFailed({ index: 199, averageItemLength: 28 }));
  expect(scrollToOffset).toHaveBeenCalledWith({ offset: 5572, animated: false });
  act(() => result.current.onContentSizeChange());
  expect(scrollToIndex).toHaveBeenCalledTimes(2);
  act(() =>
    result.current.onViewableItemsChanged({
      viewableItems: [{ item: "file-180.txt", isViewable: true }],
    }),
  );
  expect(onVisible).not.toHaveBeenCalled();
  act(() =>
    result.current.onViewableItemsChanged({
      viewableItems: [{ item: target.path, isViewable: true }],
    }),
  );
  expect(onVisible).toHaveBeenCalledExactlyOnceWith(target.id);
  act(() => result.current.onContentSizeChange());
  expect(onVisible).toHaveBeenCalledTimes(1);
});

test("late measurement after request cancellation cannot acknowledge or retry it", () => {
  const scrollToIndex = vi.fn();
  const onVisible = vi.fn();
  const target = { id: "canceled", path: "target.txt", index: 199 };
  const { result, rerender } = renderHook(
    ({ active }) =>
      useExplorerRevealScroll({
        target: active ? target : null,
        list: { current: { scrollToIndex, scrollToOffset: vi.fn() } },
        pathOf: (path: string) => path,
        onVisible,
      }),
    { initialProps: { active: true } },
  );
  const callback = result.current.onViewableItemsChanged;
  rerender({ active: false });
  expect(result.current.onViewableItemsChanged).toBe(callback);
  act(() => callback({ viewableItems: [{ item: target.path, isViewable: true }] }));
  act(() => result.current.onContentSizeChange());
  expect(onVisible).not.toHaveBeenCalled();
  expect(scrollToIndex).toHaveBeenCalledTimes(1);
});

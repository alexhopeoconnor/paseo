import { useCallback, useEffect, useRef, type RefObject } from "react";

interface RevealTarget {
  id: string;
  path: string;
  index: number;
}

interface ScrollList {
  scrollToIndex(input: { index: number; viewPosition: number; animated: boolean }): void;
  scrollToOffset(input: { offset: number; animated: boolean }): void;
}

/** A scroll request is not proof that an unmeasured virtualized row was revealed. */
export function useExplorerRevealScroll<T>(input: {
  target: RevealTarget | null;
  scope?: string | null;
  list: RefObject<ScrollList | null>;
  pathOf(item: T): string | null;
  onVisible(id: string): void;
}) {
  const latest = useRef(input);
  latest.current = input;
  const visiblePaths = useRef({ scope: input.scope, paths: new Set<string>() });
  const completed = useRef<string | null>(null);
  const retry = useCallback(() => {
    const { target, list, onVisible } = latest.current;
    if (!target || completed.current === target.id) return;
    if (
      visiblePaths.current.scope === latest.current.scope &&
      visiblePaths.current.paths.has(target.path)
    ) {
      completed.current = target.id;
      onVisible(target.id);
      return;
    }
    list.current?.scrollToIndex({ index: target.index, viewPosition: 0.5, animated: false });
  }, []);
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: { item: T; isViewable: boolean }[] }) => {
      visiblePaths.current = {
        scope: latest.current.scope,
        paths: new Set(
          viewableItems.flatMap(({ item, isViewable }) => {
            const path = isViewable ? latest.current.pathOf(item) : null;
            return path === null ? [] : [path];
          }),
        ),
      };
      retry();
    },
    [retry],
  );
  const onScrollToIndexFailed = useCallback(
    ({ index, averageItemLength }: { index: number; averageItemLength: number }) => {
      latest.current.list.current?.scrollToOffset({
        offset: Math.max(0, averageItemLength * index),
        animated: false,
      });
      // Measurement/viewability updates retry. Cancellation and expiry belong
      // to the existing reveal request; no second timeout or success estimate.
    },
    [],
  );
  useEffect(retry, [input.scope, input.target?.id, input.target?.index, retry]);
  return { onViewableItemsChanged, onScrollToIndexFailed, onContentSizeChange: retry };
}

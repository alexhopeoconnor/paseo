/** @vitest-environment jsdom */
import { type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { PaneProvider, type PaneContextValue } from "./pane-context";
import {
  capturePanelInstanceAttributes,
  getPanelInstanceAttributes,
  setPanelInstanceAttributes,
  subscribePanelInstanceAttributes,
  usePublishPanelInstanceAttributes,
} from "./panel-instance-attributes";

const publisherIdentity = { serverId: "server", workspaceId: "replacement", tabId: "editor" };
const noop = () => {};
const publisherContext: PaneContextValue = {
  ...publisherIdentity,
  host: "main",
  target: { kind: "file", path: "notes.md" },
  openTab: noop,
  openPreferredTarget: noop,
  closeCurrentTab: noop,
  retargetCurrentTab: noop,
  setCurrentTabState: noop,
  openFileInWorkspace: noop,
  openImportSheet: noop,
};

function PublisherProvider({ children }: { children: ReactNode }) {
  return <PaneProvider value={publisherContext}>{children}</PaneProvider>;
}

describe("panel instance attributes", () => {
  test("keeps runtime attributes isolated by workspace and tab", () => {
    const first = { serverId: "server", workspaceId: "one", tabId: "tab" };
    const second = { serverId: "server", workspaceId: "two", tabId: "tab" };

    setPanelInstanceAttributes(first, { modified: true });

    expect(getPanelInstanceAttributes(first)).toEqual({ modified: true });
    expect(getPanelInstanceAttributes(second)).toEqual({ modified: false });

    setPanelInstanceAttributes(first, { modified: false });
  });

  test("notifies subscribers only when attributes change", () => {
    const identity = { serverId: "server", workspaceId: "workspace", tabId: "observed" };
    let notifications = 0;
    const unsubscribe = subscribePanelInstanceAttributes(identity, () => {
      notifications += 1;
    });

    setPanelInstanceAttributes(identity, { modified: true });
    setPanelInstanceAttributes(identity, { modified: true });
    setPanelInstanceAttributes(identity, { modified: false });

    expect(notifications).toBe(2);
    unsubscribe();
  });
  test("retains a clean panel without marking it modified, then releases it", () => {
    const identity = { serverId: "server", workspaceId: "clean", tabId: "editor" };
    setPanelInstanceAttributes(identity, { modified: false, retained: true });
    expect(getPanelInstanceAttributes(identity)).toEqual({ modified: false, retained: true });
    setPanelInstanceAttributes(identity, { modified: true, retained: false });
    expect(getPanelInstanceAttributes(identity).modified).toBe(true);
    setPanelInstanceAttributes(identity, { modified: false, retained: false });
    expect(getPanelInstanceAttributes(identity)).toEqual({ modified: false });
  });

  test("publishes close invalidation synchronously and ignores a replaced owner's setters and cleanup", () => {
    const identity = publisherIdentity;
    const resolver = () => false;
    const first = renderHook(
      () =>
        usePublishPanelInstanceAttributes({ modified: false, resolveCloseProtection: resolver }),
      { wrapper: PublisherProvider },
    );
    const captured = capturePanelInstanceAttributes(identity);
    act(() => {
      first.result.current({ modified: true });
      expect(getPanelInstanceAttributes(identity).modified).toBe(true);
      first.result.current({ resolveCloseProtection: () => false });
      expect(captured.isCurrent()).toBe(false);
    });
    const replaced = capturePanelInstanceAttributes(identity);
    const second = renderHook(
      () =>
        usePublishPanelInstanceAttributes({ modified: false, resolveCloseProtection: resolver }),
      { wrapper: PublisherProvider },
    );
    expect(replaced.isCurrent()).toBe(false);
    act(() => first.result.current({ modified: true, resolveCloseProtection: null }));
    first.unmount();
    expect(getPanelInstanceAttributes(identity)).toMatchObject({
      modified: false,
      resolveCloseProtection: resolver,
    });
    second.unmount();
    expect(getPanelInstanceAttributes(identity)).toEqual({ modified: false });
  });
});

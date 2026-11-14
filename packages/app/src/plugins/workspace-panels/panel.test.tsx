/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RetainedPanel } from "@/components/retained-panel";
import {
  PaneFocusProvider,
  PaneProvider,
  type PaneContextValue,
  type PaneFocusContextValue,
} from "@/panels/pane-context";
import { PluginPanelMount } from "./panel";

const pane: PaneContextValue = {
  serverId: "server",
  workspaceId: "workspace",
  host: "main",
  tabId: "plugin_tab",
  target: {
    kind: "plugin",
    pluginId: "codium",
    panelId: "editor",
    context: "workspace",
  },
  openTab: () => {},
  openPreferredTarget: () => {},
  closeCurrentTab: () => {},
  retargetCurrentTab: () => {},
  setCurrentTabState: () => {},
  openFileInWorkspace: () => {},
  openImportSheet: () => {},
};

const unfocused: PaneFocusContextValue = {
  isWorkspaceFocused: true,
  isPaneFocused: false,
  isInteractive: false,
  focusPane: () => {},
};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PluginPanelMount tab visibility", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
  });

  it("reports actual retained visibility even while the pane is unfocused", () => {
    const visibleValues: (boolean | undefined)[] = [];
    const onVisible = vi.fn((visible: boolean | undefined) => visibleValues.push(visible));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const render = (active: boolean) => {
      root?.render(
        <PaneProvider value={pane}>
          <PaneFocusProvider value={unfocused}>
            <RetainedPanel active={active}>
              <PluginPanelMount>
                {(tab) => {
                  onVisible(tab.visible);
                  return null;
                }}
              </PluginPanelMount>
            </RetainedPanel>
          </PaneFocusProvider>
        </PaneProvider>,
      );
    };

    act(() => render(true));
    act(() => render(false));
    act(() => render(true));

    expect(visibleValues).toEqual([true, false, true]);
    expect(unfocused.isInteractive).toBe(false);
  });
});

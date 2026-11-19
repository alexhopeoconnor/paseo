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
import { SheetPaneHostProvider } from "@/screens/workspace/sheet-pane/host";
import { useWorkspaceLayoutStore, type SheetTab } from "@/stores/workspace-layout-store";
import { PluginPanelMount } from "./panel";

// The sheet bridge also imports native navigation/gesture portals. This test
// supplies only its context boundary; visibility uses the real layout store.
vi.mock("@/screens/workspace/sheet-pane/host", async () => {
  const { createContext, useContext } = await import("react");
  const Context = createContext<unknown>(null);
  return {
    SheetPaneHostProvider: Context.Provider,
    useSheetPaneHostIfAny: () => useContext(Context),
  };
});

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

const sheetHost = {
  workspaceKey: "server:workspace",
  serverId: "server",
  workspaceId: "workspace",
  isWorkspaceFocused: true,
  buildContent: () => {
    throw new Error("unused");
  },
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
  it("hides a covered plugin sheet and restores visibility when the top sheet closes", () => {
    const workspaceKey = "server:workspace";
    const sheet = (tabId: string): SheetTab => ({
      tab: { tabId, target: pane.target, createdAt: 1 },
      policy: { openAsTab: true },
      parentTabId: null,
    });
    const lower = sheet(pane.tabId!);
    const upper = sheet("top_plugin");
    const observed: boolean[] = [];
    act(() => {
      useWorkspaceLayoutStore.setState({ sheetsByWorkspace: { [workspaceKey]: [lower, upper] } });
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() =>
      root?.render(
        <SheetPaneHostProvider value={sheetHost}>
          <PaneProvider value={pane}>
            <PaneFocusProvider value={unfocused}>
              <PluginPanelMount>
                {(tab) => {
                  observed.push(tab.visible!);
                  return null;
                }}
              </PluginPanelMount>
            </PaneFocusProvider>
          </PaneProvider>
        </SheetPaneHostProvider>,
      ),
    );
    expect(observed.at(-1)).toBe(false);
    act(() => {
      useWorkspaceLayoutStore.setState({ sheetsByWorkspace: { [workspaceKey]: [lower] } });
    });
    expect(observed.at(-1)).toBe(true);
    act(() => {
      useWorkspaceLayoutStore.setState({ sheetsByWorkspace: {} });
    });
  });
});

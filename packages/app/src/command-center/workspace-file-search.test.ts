/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useSessionStore } from "@/stores/session-store";
import { describeWorkspaceFilePath } from "./workspace-file-search-model";
import { useWorkspaceFileSearch } from "./workspace-file-search";

const mockClient = vi.hoisted(() => ({
  getDirectorySuggestions: vi.fn(async () => ({ entries: [] })),
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => ({ serverId: "server", workspaceId: "workspace" }),
}));
vi.mock("@/stores/session-store-hooks", () => ({
  useWorkspaceDirectory: () => "/repo",
}));

describe("describeWorkspaceFilePath", () => {
  it("separates a workspace-relative file into its row labels", () => {
    expect(describeWorkspaceFilePath("src/components/message.tsx")).toEqual({
      path: "src/components/message.tsx",
      name: "message.tsx",
      directory: "src/components",
    });
  });

  it("normalizes Windows separators before opening or presenting a file", () => {
    expect(describeWorkspaceFilePath("src\\components\\message.tsx")).toEqual({
      path: "src/components/message.tsx",
      name: "message.tsx",
      directory: "src/components",
    });
  });

  it("keeps root files free of a redundant directory label", () => {
    expect(describeWorkspaceFilePath("package.json")).toEqual({
      path: "package.json",
      name: "package.json",
      directory: "",
    });
  });
});

describe("useWorkspaceFileSearch", () => {
  beforeEach(() => {
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        server: {
          ...state.sessions.server,
          client: mockClient,
        } as never,
      },
    }));
    useWorkspaceLayoutStore.setState({
      layoutMode: "compact",
      layoutByWorkspace: {},
      sheetsByWorkspace: {},
      explorerSidebarPaneIdByWorkspace: {},
      sidePaneIdByWorkspace: {},
      pendingOpenByWorkspace: {},
    });
  });

  it("defers a search open with search provenance and no immediate tab creation", () => {
    const { result } = renderHook(() => useWorkspaceFileSearch({ enabled: true, query: "" }));

    act(() => result.current.openFile("src/index.ts"));

    expect(useWorkspaceLayoutStore.getState().takePendingOpen("server:workspace")).toEqual({
      workspaceKey: "server:workspace",
      target: { kind: "file", path: "src/index.ts" },
      intent: "reveal",
      placement: { mode: "focused" },
      fileSource: "search",
    });
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace).toEqual({});
  });
});

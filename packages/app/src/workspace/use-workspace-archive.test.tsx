/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import type { ToastApi } from "@/components/toast-host";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { useWorkspaceArchive } from "./use-workspace-archive";
import { useGlobalWorkspaceArchiveAction } from "@/hooks/use-global-workspace-archive-action";
import { redirectIfArchivingActiveWorkspace as redirectPure } from "@/utils/workspace-archive-redirect";

const archiveWorkspaceOptimistically = vi.hoisted(() => vi.fn());
const isWorkspaceListed = vi.hoisted(() => vi.fn(() => false));
const archiveWorkspaceWithUndo = vi.hoisted(() => vi.fn());
const supportsWorkspaceArchiveUndo = vi.hoisted(() => vi.fn(() => false));
const getClient = vi.hoisted(() =>
  vi.fn(() => ({ archiveWorkspace: vi.fn(async () => ({ error: null })) })),
);
const selectWorkspace = vi.hoisted(() => vi.fn());
const shortcut = vi.hoisted(() => ({
  workspace: null as import("@/stores/session-store").WorkspaceDescriptor | null,
  route: null as { serverId: string; workspaceId: string } | null,
  focused: null as { serverId: string; workspaceId: string } | null,
  handle: null as (() => boolean) | null,
  redirect: vi.fn(),
}));

vi.mock("@/workspace/workspace-archive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workspace/workspace-archive")>()),
  archiveWorkspaceOptimistically,
  isWorkspaceListed,
}));
vi.mock("@/workspace/archive-undo", () => ({
  archiveWorkspaceWithUndo,
  supportsWorkspaceArchiveUndo,
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient }),
}));
vi.mock("@/stores/session-store-hooks/selectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/session-store-hooks/selectors")>()),
  selectWorkspace,
}));
vi.mock("@/stores/session-store-hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/session-store-hooks")>()),
  useWorkspaceFields: (
    _serverId: string | null,
    _workspaceId: string | null,
    project: (workspace: import("@/stores/session-store").WorkspaceDescriptor) => unknown,
  ) => (shortcut.workspace ? project(shortcut.workspace) : null),
}));
vi.mock("@/stores/navigation-active-workspace-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/navigation-active-workspace-store")>()),
  useActiveWorkspaceSelection: () => shortcut.route,
}));
vi.mock("@/navigation/workspace-route-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/navigation/workspace-route-navigation")>()),
  getFocusedWorkspaceSelection: () => shortcut.focused,
}));
vi.mock("@/hooks/use-keyboard-action-handler", () => ({
  useKeyboardActionHandler: (input: { handle: () => boolean }) => {
    shortcut.handle = input.handle;
  },
}));
vi.mock("@/utils/sidebar-workspace-archive-redirect", () => ({
  redirectIfArchivingActiveWorkspace: shortcut.redirect,
}));

const toastError = vi.hoisted(() => vi.fn());
const defaultToast: ToastApi = {
  show: vi.fn(),
  copied: vi.fn(),
  error: vi.fn(),
};
const rejectingToast: ToastApi = {
  show: vi.fn(),
  copied: vi.fn(),
  error: toastError,
};

function wrapper({ children }: { children: ReactNode }) {
  return <ToastApiProvider api={defaultToast}>{children}</ToastApiProvider>;
}

describe("useWorkspaceArchive", () => {
  beforeEach(() => {
    const store = useSessionStore.getState();
    store.initializeSession("server", {} as DaemonClient);
    const workspace = normalizeWorkspaceDescriptor({
      id: "workspace",
      projectId: "project-1",
      projectDisplayName: "Project",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo/workspace",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "Workspace",
      status: "done",
      statusEnteredAt: null,
      activityAt: null,
      archivingAt: null,
      diffStat: null,
      scripts: [],
    });
    store.setWorkspaces("server", new Map([[workspace.id, workspace]]));
    archiveWorkspaceOptimistically.mockReset();
    archiveWorkspaceWithUndo.mockReset();
    supportsWorkspaceArchiveUndo.mockReset().mockReturnValue(false);
    isWorkspaceListed.mockReset().mockReturnValue(false);
    selectWorkspace.mockReset().mockReturnValue(null);
    shortcut.workspace = null;
    shortcut.route = null;
    shortcut.focused = null;
    shortcut.handle = null;
    shortcut.redirect.mockReset();
    toastError.mockReset();
  });
  afterEach(() => useSessionStore.getState().clearSession("server"));

  it.each([
    {
      name: "the same workspace",
      focused: { serverId: "server", workspaceId: "workspace" },
      shouldRedirect: true,
    },
    {
      name: "a different workspace",
      focused: { serverId: "server", workspaceId: "other" },
      shouldRedirect: false,
    },
    {
      name: "a different host",
      focused: { serverId: "other-server", workspaceId: "workspace" },
      shouldRedirect: false,
    },
    { name: "Settings", focused: null, shouldRedirect: false },
  ])(
    "uses the current focused route after confirmed shortcut archive: $name",
    async ({ focused, shouldRedirect }) => {
      let resolveArchive!: (outcome: "archived") => void;
      supportsWorkspaceArchiveUndo.mockReturnValue(true);
      archiveWorkspaceWithUndo.mockImplementation(
        () =>
          new Promise<"archived">((resolve) => {
            resolveArchive = resolve;
          }),
      );
      const workspace = useSessionStore.getState().sessions.server!.workspaces.get("workspace")!;
      // The descriptor ID is the route ID even if the storage key differs.
      act(() =>
        useSessionStore.getState().setWorkspaces("server", new Map([["storage-key", workspace]])),
      );
      shortcut.workspace = workspace;
      shortcut.route = { serverId: "server", workspaceId: "workspace" };
      shortcut.focused = shortcut.route;
      selectWorkspace.mockReturnValue(workspace);
      isWorkspaceListed.mockReturnValue(true);
      const routes: unknown[] = [];
      shortcut.redirect.mockImplementation((input) =>
        redirectPure(input, {
          readWorkspaces: () => [],
          navigateToRoute: (route) => routes.push(route),
        }),
      );
      const { rerender } = renderHook(() => useGlobalWorkspaceArchiveAction(), { wrapper });

      act(() => expect(shortcut.handle?.()).toBe(true));
      expect(archiveWorkspaceWithUndo).toHaveBeenCalledTimes(1);
      // Simulate the optimistic removal and its hook rerender, before RPC completion.
      shortcut.workspace = null;
      isWorkspaceListed.mockReturnValue(false);
      act(() => useSessionStore.getState().setWorkspaces("server", new Map()));
      rerender();
      expect(routes).toEqual([]);
      expect(shortcut.redirect).not.toHaveBeenCalled();

      // The current focused leaf may change without a further hook render.
      shortcut.focused = focused;
      await act(async () => resolveArchive("archived"));
      expect(shortcut.redirect).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: "server",
          workspaceId: "workspace",
          activeWorkspaceSelection: focused,
          archivedWorkspaceSnapshot: expect.objectContaining({
            serverId: "server",
            id: "workspace",
            projectId: "project-1",
            projectRootPath: "/repo",
          }),
        }),
      );
      expect(routes).toEqual(
        shouldRedirect ? ["/new?serverId=server&dir=%2Frepo&name=Project&projectId=project-1"] : [],
      );
    },
  );

  it("hides while pending but redirects and purges only after archive confirmation", async () => {
    let resolveArchive!: (outcome: "archived") => void;
    archiveWorkspaceOptimistically.mockImplementation(
      () => new Promise<"archived">((resolve) => (resolveArchive = resolve)),
    );
    const onArchiveStarted = vi.fn();
    const onSetHiding = vi.fn();
    const purgeWorkspace = vi.spyOn(useWorkspaceLayoutStore.getState(), "purgeWorkspace");

    const { result } = renderHook(
      () =>
        useWorkspaceArchive({
          serverId: "server",
          workspaceId: "workspace",
          workspaceKind: "directory",
          workspaceDirectory: "/repo/workspace",
          name: "Workspace",
          onArchiveStarted,
          onSetHiding,
        }),
      { wrapper },
    );

    act(() => result.current.archive());
    expect(onSetHiding).toHaveBeenCalledWith(true);
    expect(onArchiveStarted).not.toHaveBeenCalled();
    expect(purgeWorkspace).not.toHaveBeenCalled();

    await act(async () => {
      resolveArchive("archived");
      await Promise.resolve();
    });
    expect(onArchiveStarted).toHaveBeenCalledTimes(1);
    expect(purgeWorkspace).toHaveBeenCalledWith("server:workspace");
    expect(onSetHiding).toHaveBeenLastCalledWith(false);
  });

  it("restores hiding and skips redirect/purge when the archive rejects", async () => {
    let rejectArchive!: (error: Error) => void;
    archiveWorkspaceOptimistically.mockImplementation(
      () => new Promise<void>((_resolve, reject) => (rejectArchive = reject)),
    );
    const onArchiveStarted = vi.fn();
    const onSetHiding = vi.fn();

    const { result } = renderHook(
      () =>
        useWorkspaceArchive({
          serverId: "server",
          workspaceId: "workspace",
          workspaceKind: "directory",
          workspaceDirectory: "/repo/workspace",
          name: "Workspace",
          onArchiveStarted,
          onSetHiding,
        }),
      {
        wrapper: ({ children }) => (
          <ToastApiProvider api={rejectingToast}>{children}</ToastApiProvider>
        ),
      },
    );

    act(() => result.current.archive());
    await act(async () => {
      rejectArchive(new Error("archive failed"));
      await Promise.resolve();
    });

    expect(onArchiveStarted).not.toHaveBeenCalled();
    expect(onSetHiding).toHaveBeenLastCalledWith(false);
    expect(toastError).toHaveBeenCalledWith("archive failed");
  });

  it("keeps the current route when a canceled archive restores the row", async () => {
    archiveWorkspaceOptimistically.mockResolvedValue("canceled");
    isWorkspaceListed.mockReturnValue(true);
    selectWorkspace.mockReturnValue({
      serverId: "server",
      id: "workspace",
      projectId: "project-1",
      projectDisplayName: "Project",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo/workspace",
    });
    const onArchiveStarted = vi.fn();

    const { result } = renderHook(
      () =>
        useWorkspaceArchive({
          serverId: "server",
          workspaceId: "workspace",
          workspaceKind: "directory",
          workspaceDirectory: "/repo/workspace",
          name: "Workspace",
          onArchiveStarted,
        }),
      { wrapper },
    );

    await act(async () => {
      result.current.archive();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onArchiveStarted).not.toHaveBeenCalled();
  });

  it("defers the undo-capable redirect until the host confirms the archive", async () => {
    let resolveArchive!: (outcome: "archived") => void;
    supportsWorkspaceArchiveUndo.mockReturnValue(true);
    archiveWorkspaceWithUndo.mockImplementation(
      () => new Promise<"archived">((resolve) => (resolveArchive = resolve)),
    );
    const onArchiveStarted = vi.fn();

    const { result } = renderHook(
      () =>
        useWorkspaceArchive({
          serverId: "server",
          workspaceId: "workspace",
          workspaceKind: "directory",
          workspaceDirectory: "/repo/workspace",
          name: "Workspace",
          onArchiveStarted,
        }),
      { wrapper },
    );

    act(() => result.current.archive());
    expect(archiveWorkspaceWithUndo).toHaveBeenCalledTimes(1);
    expect(onArchiveStarted).not.toHaveBeenCalled();

    await act(async () => {
      resolveArchive("archived");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onArchiveStarted).toHaveBeenCalledTimes(1);
  });

  it("passes the pre-hide route snapshot only after the archive settles with no listed row", async () => {
    let resolveArchive!: (outcome: "archived") => void;
    archiveWorkspaceOptimistically.mockImplementation(
      () => new Promise<"archived">((resolve) => (resolveArchive = resolve)),
    );
    const archivedWorkspaceSnapshot = {
      serverId: "server",
      id: "workspace",
      projectId: "project-1",
      projectDisplayName: "Project",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo/workspace",
    };
    selectWorkspace.mockReturnValue(archivedWorkspaceSnapshot);
    const initialOnArchiveStarted = vi.fn();
    const latestOnArchiveStarted = vi.fn();

    const { result, rerender } = renderHook(
      ({ onArchiveStarted }) =>
        useWorkspaceArchive({
          serverId: "server",
          workspaceId: "workspace",
          workspaceKind: "directory",
          workspaceDirectory: "/repo/workspace",
          name: "Workspace",
          onArchiveStarted,
        }),
      { initialProps: { onArchiveStarted: initialOnArchiveStarted }, wrapper },
    );

    act(() => result.current.archive());
    expect(initialOnArchiveStarted).not.toHaveBeenCalled();
    selectWorkspace.mockReturnValue({
      ...archivedWorkspaceSnapshot,
      projectRootPath: "/other",
    });
    rerender({ onArchiveStarted: latestOnArchiveStarted });

    await act(async () => {
      resolveArchive("archived");
      await Promise.resolve();
    });

    expect(initialOnArchiveStarted).not.toHaveBeenCalled();
    expect(latestOnArchiveStarted).toHaveBeenCalledWith({
      serverId: "server",
      workspaceId: "workspace",
      archivedWorkspaceSnapshot,
    });
  });

  it("keeps the route when undo restores the row after an undo-capable archive", async () => {
    supportsWorkspaceArchiveUndo.mockReturnValue(true);
    archiveWorkspaceWithUndo.mockResolvedValue("canceled");
    isWorkspaceListed.mockReturnValue(true);
    selectWorkspace.mockReturnValue({
      serverId: "server",
      id: "workspace",
      projectId: "project-1",
      projectDisplayName: "Project",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo/workspace",
    });
    const onArchiveStarted = vi.fn();

    const { result } = renderHook(
      () =>
        useWorkspaceArchive({
          serverId: "server",
          workspaceId: "workspace",
          workspaceKind: "directory",
          workspaceDirectory: "/repo/workspace",
          name: "Workspace",
          onArchiveStarted,
        }),
      { wrapper },
    );

    await act(async () => {
      result.current.archive();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onArchiveStarted).not.toHaveBeenCalled();
  });

  it("does not redirect for an undone attempt after a successor hides the row", async () => {
    const resolve: Array<(outcome: "archived" | "canceled") => void> = [];
    supportsWorkspaceArchiveUndo.mockReturnValue(true);
    archiveWorkspaceWithUndo.mockImplementation(
      () => new Promise<"archived" | "canceled">((done) => resolve.push(done)),
    );
    const onArchiveStarted = vi.fn();
    const { result } = renderHook(
      () =>
        useWorkspaceArchive({
          serverId: "server",
          workspaceId: "workspace",
          workspaceKind: "directory",
          workspaceDirectory: "/repo/workspace",
          name: "Workspace",
          onArchiveStarted,
        }),
      { wrapper },
    );
    isWorkspaceListed.mockReturnValue(true);
    act(() => result.current.archive());
    act(() => result.current.archive());
    expect(resolve).toHaveLength(2);
    isWorkspaceListed.mockReturnValue(false);
    await act(async () => resolve[0]("canceled"));
    expect(onArchiveStarted).not.toHaveBeenCalled();
    await act(async () => resolve[1]("archived"));
    expect(onArchiveStarted).toHaveBeenCalledTimes(1);
  });
});

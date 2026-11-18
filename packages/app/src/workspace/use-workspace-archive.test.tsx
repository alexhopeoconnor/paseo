/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import type { ToastApi } from "@/components/toast-host";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useWorkspaceArchive } from "./use-workspace-archive";

const archiveWorkspaceOptimistically = vi.hoisted(() => vi.fn());
const isWorkspaceListed = vi.hoisted(() => vi.fn(() => false));
const archiveWorkspaceWithUndo = vi.hoisted(() => vi.fn());
const supportsWorkspaceArchiveUndo = vi.hoisted(() => vi.fn(() => false));
const getClient = vi.hoisted(() =>
  vi.fn(() => ({ archiveWorkspace: vi.fn(async () => ({ error: null })) })),
);

vi.mock("@/workspace/workspace-archive", () => ({
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
    archiveWorkspaceOptimistically.mockReset();
    archiveWorkspaceWithUndo.mockReset();
    supportsWorkspaceArchiveUndo.mockReset().mockReturnValue(false);
    isWorkspaceListed.mockReset().mockReturnValue(false);
    toastError.mockReset();
  });

  it("hides while pending but redirects and purges only after archive confirmation", async () => {
    let resolveArchive!: () => void;
    archiveWorkspaceOptimistically.mockImplementation(
      () => new Promise<void>((resolve) => (resolveArchive = resolve)),
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
      resolveArchive();
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
    let resolveArchive!: () => void;
    supportsWorkspaceArchiveUndo.mockReturnValue(true);
    archiveWorkspaceWithUndo.mockImplementation(
      () => new Promise<void>((resolve) => (resolveArchive = resolve)),
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
      resolveArchive();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onArchiveStarted).toHaveBeenCalledTimes(1);
  });
});

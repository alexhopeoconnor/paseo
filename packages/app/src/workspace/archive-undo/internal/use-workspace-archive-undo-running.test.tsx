/**
 * @vitest-environment jsdom
 */
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ToastApi, ToastShowOptions } from "@/components/toast-host";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearWorkspaceArchivePending } from "@/contexts/session-workspace-upserts";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { seedSessionHosts } from "@/test/seed-session";
import {
  archiveWorkspaceWithUndo,
  undoLatestWorkspaceArchive,
  useWorkspaceArchiveUndoRunning,
  type UndoableWorkspaceArchiveClient,
} from "@/workspace/archive-undo";

const SERVER_ID = "workspace-archive-undo-running";
const WORKSPACE_ID = "retention";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function workspace(id: string): WorkspaceDescriptor {
  return {
    createdAt: null,
    lastUserMessageAt: null,
    id,
    projectId: "project",
    projectDisplayName: "Project",
    projectRootPath: "/repo/project",
    workspaceDirectory: `/repo/project/${id}`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
    status: "done",
    archivingAt: null,
    statusEnteredAt: null,
    diffStat: null,
    scripts: [],
  };
}

function createToastHost() {
  let dismiss: (() => void) | null = null;
  const api: ToastApi = {
    show: (_content, options?: ToastShowOptions) => {
      dismiss = () => options?.onDismiss?.();
      return () => {};
    },
    copied: () => {},
    error: () => {},
  };
  return {
    api,
    timeOut: () => {
      const timeout = dismiss;
      dismiss = null;
      timeout?.();
    },
  };
}

type ArchivePayload = Awaited<ReturnType<UndoableWorkspaceArchiveClient["archiveWorkspace"]>>;

function createClient() {
  const archive = deferred<ArchivePayload>();
  const undo = deferred<void>();
  const client: UndoableWorkspaceArchiveClient = {
    archiveWorkspace: () => archive.promise,
    undoWorkspaceArchive: () => undo.promise,
  };
  return {
    client,
    finishArchive: () => archive.resolve({ error: null }),
    failArchive: () => archive.resolve({ error: "teardown failed" }),
    cancelArchive: () => archive.resolve({ error: null, canceled: true }),
    finishUndo: () => undo.resolve(),
    failUndo: (error: Error) => undo.reject(error),
  };
}

function target() {
  return { serverId: SERVER_ID, workspaceId: WORKSPACE_ID };
}

beforeEach(() => {
  seedSessionHosts([SERVER_ID]);
  useSessionStore.getState().initializeSession(SERVER_ID, {} as DaemonClient);
  getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [workspace(WORKSPACE_ID)]);
});

afterEach(() => {
  undoLatestWorkspaceArchive();
  clearWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID });
  seedSessionHosts([]);
  useSessionStore.setState((state) => ({ ...state, sessions: {} }));
});

describe("useWorkspaceArchiveUndoRunning", () => {
  it("stays true from archive start through the remove intent clear, then releases on commit", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];
    const { result } = renderHook(() =>
      useWorkspaceArchiveUndoRunning({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID }),
    );

    expect(result.current).toBe(false);

    let archive!: Promise<void>;
    act(() => {
      archive = archiveWorkspaceWithUndo({
        client: host.client,
        workspace: target(),
        toast: toast.api,
        onArchiveCommitted: () => committed.push(WORKSPACE_ID),
      });
    });
    expect(result.current).toBe(true);

    act(() => {
      clearWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID });
    });
    expect(result.current).toBe(true);

    host.finishArchive();
    await act(async () => {
      await archive;
    });
    expect(result.current).toBe(true);

    act(() => {
      toast.timeOut();
    });
    expect(result.current).toBe(false);
    expect(committed).toEqual([WORKSPACE_ID]);
  });

  it("stays true through a pending undo and releases after an accepted restore", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];
    const { result } = renderHook(() =>
      useWorkspaceArchiveUndoRunning({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID }),
    );

    let archive!: Promise<void>;
    act(() => {
      archive = archiveWorkspaceWithUndo({
        client: host.client,
        workspace: target(),
        toast: toast.api,
        onArchiveCommitted: () => committed.push(WORKSPACE_ID),
      });
    });
    host.finishArchive();
    await act(async () => {
      await archive;
    });
    expect(result.current).toBe(true);

    act(() => {
      expect(undoLatestWorkspaceArchive()).toBe(true);
    });
    expect(result.current).toBe(true);

    host.finishUndo();
    await waitFor(() => expect(result.current).toBe(false));
    expect(committed).toEqual([]);
  });

  it("stays true through a failed undo until the archive commits", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];
    const { result } = renderHook(() =>
      useWorkspaceArchiveUndoRunning({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID }),
    );

    let archive!: Promise<void>;
    act(() => {
      archive = archiveWorkspaceWithUndo({
        client: host.client,
        workspace: target(),
        toast: toast.api,
        onArchiveCommitted: () => committed.push(WORKSPACE_ID),
      });
    });
    act(() => {
      expect(undoLatestWorkspaceArchive()).toBe(true);
    });

    host.failUndo(new Error("Branch is gone"));
    await waitFor(() => expect(result.current).toBe(true));

    host.finishArchive();
    await act(async () => {
      await archive;
    });
    await waitFor(() => expect(result.current).toBe(false));
    expect(committed).toEqual([WORKSPACE_ID]);
  });
  it.each(["failed", "canceled"] as const)(
    "releases tab reconciliation after a %s archive restores the row",
    async (outcome) => {
      const host = createClient();
      const toast = createToastHost();
      const committed: string[] = [];
      const { result } = renderHook(() => useWorkspaceArchiveUndoRunning(target()));
      let archive!: Promise<void>;
      act(() => {
        archive = archiveWorkspaceWithUndo({
          client: host.client,
          workspace: target(),
          toast: toast.api,
          onArchiveCommitted: () => committed.push(WORKSPACE_ID),
        });
      });
      expect(result.current).toBe(true);
      await act(async () => {
        if (outcome === "failed") {
          const rejected = expect(archive).rejects.toThrow("teardown failed");
          host.failArchive();
          await rejected;
        } else {
          host.cancelArchive();
          await archive;
        }
      });
      expect(result.current).toBe(false);
      expect(committed).toEqual([]);
      act(() => toast.timeOut());
    },
  );
});

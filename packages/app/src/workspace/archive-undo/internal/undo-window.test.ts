import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToastApi, ToastShowOptions } from "@/components/toast-host";
import { clearWorkspaceArchivePending } from "@/contexts/session-workspace-upserts";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { seedSessionHosts } from "@/test/seed-session";
import {
  archiveWorkspaceWithUndo,
  undoLatestWorkspaceArchive,
  type UndoableWorkspaceArchiveClient,
} from "@/workspace/archive-undo";
import {
  getWorkspaceArchiveRecoverySnapshot,
  isWorkspaceArchiveTabRetained,
  retryWorkspaceArchiveRecovery,
  subscribeWorkspaceArchiveRetention,
  type WorkspaceArchiveRecoveryEntry,
} from "./undo-window";

const SERVER_ID = "workspace-archive-undo-window";
const SECOND_SERVER_ID = "workspace-archive-undo-window-2";
const ARCHIVE_IN_PROGRESS = "Workspace archive is already in progress";

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

/** A toast host with one slot, like the app's: a new toast replaces the shown one. */
function createToastHost() {
  let shown: { content: ReactNode; options?: ToastShowOptions; dismiss: () => void } | null = null;
  const errors: string[] = [];
  const api: ToastApi = {
    show: (content, options) => {
      const previous = shown;
      const entry = {
        content,
        options,
        dismiss: () => {
          if (shown !== entry) return;
          shown = null;
          options?.onDismiss?.();
        },
      };
      shown = entry;
      previous?.options?.onDismiss?.();
      return entry.dismiss;
    },
    copied: () => {},
    error: (message) => {
      errors.push(message);
      api.show(message);
    },
  };
  return {
    api,
    errors,
    get shownTestID() {
      return shown?.options?.testID ?? null;
    },
    timeOut: () => shown?.dismiss(),
  };
}

type ArchivePayload = Awaited<ReturnType<UndoableWorkspaceArchiveClient["archiveWorkspace"]>>;

function createClient() {
  const archives = new Map<string, Deferred<ArchivePayload>[]>();
  const undos = new Map<string, Deferred<void>>();
  const archiveRequests: string[] = [];
  const undoRequests: string[] = [];
  const client: UndoableWorkspaceArchiveClient = {
    archiveWorkspace: (workspaceId) => {
      archiveRequests.push(workspaceId);
      const response = deferred<ArchivePayload>();
      const queue = archives.get(workspaceId) ?? [];
      queue.push(response);
      archives.set(workspaceId, queue);
      return response.promise;
    },
    undoWorkspaceArchive: (workspaceId) => {
      undoRequests.push(workspaceId);
      const response = deferred<void>();
      undos.set(workspaceId, response);
      return response.promise;
    },
  };
  return {
    client,
    archiveRequests,
    undoRequests,
    finishArchive: (workspaceId: string, payload: Partial<ArchivePayload> = {}) =>
      archives
        .get(workspaceId)
        ?.shift()
        ?.resolve({ error: null, ...payload }),
    undoRequested: (workspaceId: string) => undos.has(workspaceId),
    finishUndo: (workspaceId: string) => undos.get(workspaceId)?.resolve(),
    failUndo: (workspaceId: string, error: Error) => undos.get(workspaceId)?.reject(error),
  };
}

function storedWorkspace(serverId: string, id: string): WorkspaceDescriptor | undefined {
  return useSessionStore.getState().sessions[serverId]?.workspaces.get(id);
}

function retained(serverId: string, workspaceId: string): boolean {
  return isWorkspaceArchiveTabRetained({ serverId, workspaceId });
}

function recoveryEntries(): readonly WorkspaceArchiveRecoveryEntry[] {
  return getWorkspaceArchiveRecoverySnapshot();
}

const workspaceIds = new Set<string>();

function seedWorkspace(serverId: string, id: string): void {
  workspaceIds.add(id);
  getHostRuntimeStore().acceptWorkspaceSnapshots(serverId, [workspace(id)]);
}

function startArchive(input: {
  serverId?: string;
  host: ReturnType<typeof createClient>;
  toast: ReturnType<typeof createToastHost>;
  workspaceId: string;
  committed: string[];
  onArchiveCommitted?: () => void;
}) {
  const serverId = input.serverId ?? SERVER_ID;
  return archiveWorkspaceWithUndo({
    client: input.host.client,
    workspace: { serverId, workspaceId: input.workspaceId },
    toast: input.toast.api,
    onArchiveCommitted: input.onArchiveCommitted ?? (() => input.committed.push(input.workspaceId)),
  });
}

beforeEach(() => {
  workspaceIds.clear();
  workspaceIds.add("a");
  workspaceIds.add("b");
  seedSessionHosts([SERVER_ID, SECOND_SERVER_ID]);
  for (const serverId of [SERVER_ID, SECOND_SERVER_ID]) {
    useSessionStore.getState().initializeSession(serverId, {} as DaemonClient);
    getHostRuntimeStore().acceptWorkspaceSnapshots(serverId, [workspace("a"), workspace("b")]);
  }
});

afterEach(() => {
  undoLatestWorkspaceArchive();
  for (const serverId of [SERVER_ID, SECOND_SERVER_ID]) {
    for (const workspaceId of workspaceIds) {
      clearWorkspaceArchivePending({ serverId, workspaceId });
    }
  }
  workspaceIds.clear();
  seedSessionHosts([]);
  useSessionStore.setState((state) => ({ ...state, sessions: {} }));
});

describe("archiveWorkspaceWithUndo", () => {
  it("commits the archive only once its toast is gone", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];

    const archive = startArchive({ host, toast, workspaceId: "a", committed });
    expect(toast.shownTestID).toBe("workspace-archived-toast");
    expect(retained(SERVER_ID, "a")).toBe(true);
    host.finishArchive("a");
    await archive;
    expect(committed).toEqual([]);
    expect(retained(SERVER_ID, "a")).toBe(true);

    toast.timeOut();
    expect({
      committed,
      undone: undoLatestWorkspaceArchive(),
      retained: retained(SERVER_ID, "a"),
    }).toEqual({
      committed: ["a"],
      undone: false,
      retained: false,
    });
  });

  it("retains after an external restore and hands off to a later archive", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];
    seedWorkspace(SERVER_ID, "external");

    const archive = startArchive({ host, toast, workspaceId: "external", committed });
    host.finishArchive("external");
    await archive;
    clearWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: "external" });
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [workspace("external")]);
    toast.timeOut();

    expect({
      committed,
      retained: retained(SERVER_ID, "external"),
      row: storedWorkspace(SERVER_ID, "external"),
    }).toEqual({ committed: [], retained: true, row: workspace("external") });

    const successor = startArchive({ host, toast, workspaceId: "external", committed });
    host.finishArchive("external");
    await successor;
    toast.timeOut();

    expect({ committed, retained: retained(SERVER_ID, "external") }).toEqual({
      committed: ["external"],
      retained: false,
    });
  });

  it("commits when the archive finishes after its toast already timed out", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];

    const archive = startArchive({ host, toast, workspaceId: "a", committed });
    toast.timeOut();
    expect({ committed, retained: retained(SERVER_ID, "a") }).toEqual({
      committed: [],
      retained: true,
    });
    host.finishArchive("a");
    await archive;

    expect({ committed, retained: retained(SERVER_ID, "a") }).toEqual({
      committed: ["a"],
      retained: false,
    });
  });

  it("undo during a running archive brings the row back and never commits", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];

    const archive = startArchive({ host, toast, workspaceId: "a", committed });
    expect(storedWorkspace(SERVER_ID, "a")).toBeUndefined();

    expect(undoLatestWorkspaceArchive()).toBe(true);
    expect({
      row: storedWorkspace(SERVER_ID, "a"),
      undoRequested: host.undoRequested("a"),
      toast: toast.shownTestID,
    }).toEqual({ row: workspace("a"), undoRequested: true, toast: null });

    host.finishArchive("a", { canceled: true, error: "Workspace archive was undone" });
    await archive;
    host.finishUndo("a");
    await expect.poll(() => retained(SERVER_ID, "a")).toBe(false);
    toast.timeOut();

    expect({
      committed,
      errors: toast.errors,
      retained: retained(SERVER_ID, "a"),
      row: storedWorkspace(SERVER_ID, "a"),
    }).toEqual({
      committed: [],
      errors: [],
      retained: false,
      row: workspace("a"),
    });
  });

  it("does not claim Cmd+Z when no archive can be undone", async () => {
    const host = createClient();
    const toast = createToastHost();

    expect(undoLatestWorkspaceArchive()).toBe(false);

    const archive = startArchive({ host, toast, workspaceId: "a", committed: [] });
    host.finishArchive("a");
    await archive;
    toast.timeOut();

    expect(undoLatestWorkspaceArchive()).toBe(false);
    expect(host.undoRequested("a")).toBe(false);
  });

  it("a newer archive takes over undo and commits the older one", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];

    const first = startArchive({ host, toast, workspaceId: "a", committed });
    host.finishArchive("a");
    await first;
    const second = startArchive({ host, toast, workspaceId: "b", committed });
    expect(committed).toEqual(["a"]);
    expect({ retainedA: retained(SERVER_ID, "a"), retainedB: retained(SERVER_ID, "b") }).toEqual({
      retainedA: false,
      retainedB: true,
    });

    expect(undoLatestWorkspaceArchive()).toBe(true);
    expect({ undoA: host.undoRequested("a"), undoB: host.undoRequested("b") }).toEqual({
      undoA: false,
      undoB: true,
    });
    host.finishArchive("b", { canceled: true });
    await second;
    host.finishUndo("b");
    await expect.poll(() => retained(SERVER_ID, "b")).toBe(false);
  });

  it("reports a failed undo and hides the row again", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];

    const archive = startArchive({ host, toast, workspaceId: "a", committed });
    host.finishArchive("a");
    await archive;
    undoLatestWorkspaceArchive();
    host.failUndo("a", new Error("Branch is gone"));
    await expect.poll(() => toast.errors).toEqual(["Couldn't undo the archive"]);

    expect({
      committed,
      retained: retained(SERVER_ID, "a"),
      row: storedWorkspace(SERVER_ID, "a"),
    }).toEqual({
      committed: ["a"],
      retained: false,
      row: undefined,
    });
  });

  it("stays quiet about an archive that failed after the user undid it", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];
    seedWorkspace(SERVER_ID, "quiet");

    const archive = startArchive({ host, toast, workspaceId: "quiet", committed });
    undoLatestWorkspaceArchive();
    host.finishArchive("quiet", { error: "registry unavailable" });

    await expect(archive).resolves.toBeUndefined();
    expect(toast.errors).toEqual([]);
    host.finishUndo("quiet");
    await expect
      .poll(() => ({ committed, retained: retained(SERVER_ID, "quiet") }))
      .toEqual({ committed: [], retained: false });
  });

  it("rejects a failed archive without releasing retention", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];
    seedWorkspace(SERVER_ID, "failed");

    const archive = startArchive({ host, toast, workspaceId: "failed", committed });
    host.finishArchive("failed", { error: "registry unavailable" });

    await expect(archive).rejects.toThrow("registry unavailable");
    expect({
      toast: toast.shownTestID,
      undone: undoLatestWorkspaceArchive(),
      committed,
      retained: retained(SERVER_ID, "failed"),
      row: storedWorkspace(SERVER_ID, "failed"),
    }).toEqual({
      toast: null,
      undone: false,
      committed: [],
      retained: true,
      row: workspace("failed"),
    });

    const successor = startArchive({ host, toast, workspaceId: "failed", committed });
    host.finishArchive("failed");
    await successor;
    toast.timeOut();

    expect({ committed, retained: retained(SERVER_ID, "failed") }).toEqual({
      committed: ["failed"],
      retained: false,
    });
  });

  it("retains after a partial archive error and hands off without a false gap", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];
    seedWorkspace(SERVER_ID, "partial");
    const states: boolean[] = [];
    const unsubscribe = subscribeWorkspaceArchiveRetention(() => {
      states.push(retained(SERVER_ID, "partial"));
    });

    const first = startArchive({ host, toast, workspaceId: "partial", committed });
    host.finishArchive("partial", { error: "partial teardown" });
    await expect(first).rejects.toThrow("partial teardown");
    expect(retained(SERVER_ID, "partial")).toBe(true);

    const second = startArchive({ host, toast, workspaceId: "partial", committed });
    expect(states).not.toContain(false);
    host.finishArchive("partial", { canceled: true });
    await second;
    expect(retained(SERVER_ID, "partial")).toBe(true);

    const third = startArchive({ host, toast, workspaceId: "partial", committed });
    host.finishArchive("partial");
    await third;
    expect(states).not.toContain(false);
    toast.timeOut();
    unsubscribe();

    expect(states[states.length - 1]).toBe(false);
    expect({ committed, retained: retained(SERVER_ID, "partial") }).toEqual({
      committed: ["partial"],
      retained: false,
    });
  });

  it("retains after a canceled archive and a failed undo", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];
    seedWorkspace(SERVER_ID, "cancel-fail");

    const archive = startArchive({ host, toast, workspaceId: "cancel-fail", committed });
    undoLatestWorkspaceArchive();
    host.finishArchive("cancel-fail", { canceled: true });
    await archive;
    host.failUndo("cancel-fail", new Error("Branch is gone"));
    await expect.poll(() => toast.errors).toEqual(["Couldn't undo the archive"]);

    expect({ committed, retained: retained(SERVER_ID, "cancel-fail") }).toEqual({
      committed: [],
      retained: true,
    });

    const successor = startArchive({ host, toast, workspaceId: "cancel-fail", committed });
    host.finishArchive("cancel-fail");
    await successor;
    toast.timeOut();

    expect({ committed, retained: retained(SERVER_ID, "cancel-fail") }).toEqual({
      committed: ["cancel-fail"],
      retained: false,
    });
  });

  it("rejects a re-entrant same-workspace archive during successor begin", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];
    seedWorkspace(SERVER_ID, "reentrant");

    const first = startArchive({ host, toast, workspaceId: "reentrant", committed });
    host.finishArchive("reentrant", { error: "partial" });
    await expect(first).rejects.toThrow("partial");
    expect(retained(SERVER_ID, "reentrant")).toBe(true);

    let reentrantError: unknown = null;
    const captureReentrantError = (error: unknown): void => {
      reentrantError = error;
    };
    let reentered = false;
    const unsubscribe = useSessionStore.subscribe(() => {
      if (reentered) return;
      reentered = true;
      const reentrant = archiveWorkspaceWithUndo({
        client: host.client,
        workspace: { serverId: SERVER_ID, workspaceId: "reentrant" },
        toast: toast.api,
        onArchiveCommitted: () => committed.push("reentrant"),
      });
      void reentrant.catch(captureReentrantError);
    });

    const successor = startArchive({ host, toast, workspaceId: "reentrant", committed });
    expect(reentered).toBe(true);
    await expect.poll(() => reentrantError).toBeInstanceOf(Error);
    expect(String(reentrantError)).toContain(ARCHIVE_IN_PROGRESS);
    expect(host.archiveRequests.filter((id) => id === "reentrant")).toHaveLength(2);

    host.finishArchive("reentrant");
    await successor;
    toast.timeOut();
    unsubscribe();

    expect({ committed, retained: retained(SERVER_ID, "reentrant") }).toEqual({
      committed: ["reentrant"],
      retained: false,
    });
  });

  it("rejects a concurrent same-workspace archive before a request", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];
    seedWorkspace(SERVER_ID, "concurrent");

    const first = startArchive({ host, toast, workspaceId: "concurrent", committed });
    const requests = host.archiveRequests.length;

    await expect(
      archiveWorkspaceWithUndo({
        client: host.client,
        workspace: { serverId: SERVER_ID, workspaceId: "concurrent" },
        toast: toast.api,
        onArchiveCommitted: () => committed.push("concurrent"),
      }),
    ).rejects.toThrow(ARCHIVE_IN_PROGRESS);
    expect(host.archiveRequests).toHaveLength(requests);

    host.finishArchive("concurrent");
    await first;
    toast.timeOut();

    expect({ committed, retained: retained(SERVER_ID, "concurrent") }).toEqual({
      committed: ["concurrent"],
      retained: false,
    });
  });

  it("preserves the older purge when a later archive is canceled", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];
    seedWorkspace(SERVER_ID, "purge");

    const first = startArchive({ host, toast, workspaceId: "purge", committed });
    host.finishArchive("purge");
    await first;
    const requests = host.archiveRequests.length;
    await expect(
      archiveWorkspaceWithUndo({
        client: host.client,
        workspace: { serverId: SERVER_ID, workspaceId: "purge" },
        toast: toast.api,
        onArchiveCommitted: () => committed.push("purge"),
      }),
    ).rejects.toThrow(ARCHIVE_IN_PROGRESS);
    expect(host.archiveRequests).toHaveLength(requests);
    toast.timeOut();
    expect({ committed, retained: retained(SERVER_ID, "purge") }).toEqual({
      committed: ["purge"],
      retained: false,
    });

    const second = startArchive({ host, toast, workspaceId: "purge", committed });
    host.finishArchive("purge", { canceled: true });
    await second;
    expect({ committed, retained: retained(SERVER_ID, "purge") }).toEqual({
      committed: ["purge"],
      retained: true,
    });

    const third = startArchive({ host, toast, workspaceId: "purge", committed });
    host.finishArchive("purge");
    await third;
    toast.timeOut();

    expect({ committed, retained: retained(SERVER_ID, "purge") }).toEqual({
      committed: ["purge", "purge"],
      retained: false,
    });
  });

  it("keeps retention when the commit callback throws", async () => {
    const host = createClient();
    const toast = createToastHost();
    seedWorkspace(SERVER_ID, "throw");
    let attempts = 0;

    const archive = archiveWorkspaceWithUndo({
      client: host.client,
      workspace: { serverId: SERVER_ID, workspaceId: "throw" },
      toast: toast.api,
      onArchiveCommitted: () => {
        attempts += 1;
        throw new Error("purge failed");
      },
    });
    host.finishArchive("throw");
    await archive;

    expect(() => toast.timeOut()).toThrow("purge failed");
    expect({ attempts, retained: retained(SERVER_ID, "throw") }).toEqual({
      attempts: 1,
      retained: true,
    });

    await expect(
      archiveWorkspaceWithUndo({
        client: host.client,
        workspace: { serverId: SERVER_ID, workspaceId: "throw" },
        toast: toast.api,
        onArchiveCommitted: () => {},
      }),
    ).rejects.toThrow(ARCHIVE_IN_PROGRESS);
    expect(host.archiveRequests).toHaveLength(1);
  });

  it("isolates the same workspaceId across servers", async () => {
    const firstHost = createClient();
    const secondHost = createClient();
    const firstToast = createToastHost();
    const secondToast = createToastHost();
    const firstCommitted: string[] = [];
    const secondCommitted: string[] = [];
    seedWorkspace(SERVER_ID, "shared");
    seedWorkspace(SECOND_SERVER_ID, "shared");

    const first = startArchive({
      serverId: SERVER_ID,
      host: firstHost,
      toast: firstToast,
      workspaceId: "shared",
      committed: firstCommitted,
    });
    const second = startArchive({
      serverId: SECOND_SERVER_ID,
      host: secondHost,
      toast: secondToast,
      workspaceId: "shared",
      committed: secondCommitted,
    });

    expect({
      first: retained(SERVER_ID, "shared"),
      second: retained(SECOND_SERVER_ID, "shared"),
    }).toEqual({ first: true, second: true });

    await expect(
      archiveWorkspaceWithUndo({
        client: firstHost.client,
        workspace: { serverId: SERVER_ID, workspaceId: "shared" },
        toast: firstToast.api,
        onArchiveCommitted: () => firstCommitted.push("shared"),
      }),
    ).rejects.toThrow(ARCHIVE_IN_PROGRESS);

    firstHost.finishArchive("shared");
    await first;
    firstToast.timeOut();
    expect({
      firstCommitted,
      firstRetained: retained(SERVER_ID, "shared"),
      secondRetained: retained(SECOND_SERVER_ID, "shared"),
    }).toEqual({ firstCommitted: ["shared"], firstRetained: false, secondRetained: true });

    secondHost.finishArchive("shared");
    await second;
    secondToast.timeOut();
    expect({
      secondCommitted,
      secondRetained: retained(SECOND_SERVER_ID, "shared"),
    }).toEqual({ secondCommitted: ["shared"], secondRetained: false });
  });

  it("registers a failed Undo and retries the exact owner", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];
    seedWorkspace(SERVER_ID, "retry");
    const target = { serverId: SERVER_ID, workspaceId: "retry" };

    const archive = startArchive({ host, toast, workspaceId: "retry", committed });
    undoLatestWorkspaceArchive();
    host.finishArchive("retry", { canceled: true });
    await archive;
    host.failUndo("retry", new Error("Branch is gone"));
    await expect.poll(() => toast.errors).toEqual(["Couldn't undo the archive"]);
    expect(recoveryEntries()).toHaveLength(1);

    const [entry] = recoveryEntries();
    expect(entry).toMatchObject({
      key: `${SERVER_ID}:retry`,
      workspaceId: "retry",
      retryable: true,
      retrying: false,
    });
    expect(retained(SERVER_ID, "retry")).toBe(true);
    expect(storedWorkspace(SERVER_ID, "retry")).toBeUndefined();
    expect(host.undoRequests.filter((id) => id === "retry")).toHaveLength(1);

    expect(undoLatestWorkspaceArchive()).toBe(true);
    expect(host.undoRequests.filter((id) => id === "retry")).toHaveLength(2);
    expect(recoveryEntries()[0]).toMatchObject({ retrying: true, retryable: false });
    expect(retryWorkspaceArchiveRecovery({ ...target, token: entry.token })).toBe(false);
    expect(undoLatestWorkspaceArchive()).toBe(false);
    expect(host.undoRequests.filter((id) => id === "retry")).toHaveLength(2);

    host.finishUndo("retry");
    await expect.poll(() => recoveryEntries()).toHaveLength(0);
    expect({
      committed,
      retained: retained(SERVER_ID, "retry"),
      row: storedWorkspace(SERVER_ID, "retry"),
    }).toEqual({ committed: [], retained: false, row: workspace("retry") });
  });

  it("keeps a failed Undo retryable when its archived row arrives late and listed", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];
    seedWorkspace(SERVER_ID, "late-listed");
    const target = { serverId: SERVER_ID, workspaceId: "late-listed" };

    const archive = startArchive({ host, toast, workspaceId: "late-listed", committed });
    expect(storedWorkspace(SERVER_ID, "late-listed")).toBeUndefined();

    expect(undoLatestWorkspaceArchive()).toBe(true);
    expect(host.undoRequested("late-listed")).toBe(true);
    expect(storedWorkspace(SERVER_ID, "late-listed")).toEqual(workspace("late-listed"));

    host.failUndo("late-listed", new Error("Branch is gone"));
    await expect.poll(() => toast.errors).toEqual(["Couldn't undo the archive"]);
    expect(recoveryEntries()).toHaveLength(1);
    expect(recoveryEntries()[0]).toMatchObject({ retryable: false, retrying: false });

    // The failed undo's intent has settled, so a late active upsert is accepted.
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [workspace("late-listed")]);
    expect(storedWorkspace(SERVER_ID, "late-listed")).toEqual(workspace("late-listed"));

    host.finishArchive("late-listed");
    await archive;

    const [entry] = recoveryEntries();
    expect(entry).toMatchObject({
      key: `${SERVER_ID}:late-listed`,
      workspaceId: "late-listed",
      retryable: true,
      retrying: false,
    });
    expect({
      committed,
      retained: retained(SERVER_ID, "late-listed"),
      row: storedWorkspace(SERVER_ID, "late-listed"),
      undoRequests: host.undoRequests.filter((id) => id === "late-listed"),
    }).toEqual({
      committed: [],
      retained: true,
      row: workspace("late-listed"),
      undoRequests: ["late-listed"],
    });

    expect(retryWorkspaceArchiveRecovery({ ...target, token: entry.token })).toBe(true);
    expect(host.undoRequests.filter((id) => id === "late-listed")).toHaveLength(2);
    expect(recoveryEntries()[0]).toMatchObject({
      key: entry.key,
      token: entry.token,
      retryable: false,
      retrying: true,
    });

    host.failUndo("late-listed", new Error("Branch is still gone"));
    await expect.poll(() => recoveryEntries()[0]?.retryable).toBe(true);
    expect(recoveryEntries()).toHaveLength(1);
    expect(recoveryEntries()[0]).toMatchObject({
      key: entry.key,
      token: entry.token,
      retryable: true,
      retrying: false,
    });
    expect(retained(SERVER_ID, "late-listed")).toBe(true);

    expect(retryWorkspaceArchiveRecovery({ ...target, token: entry.token })).toBe(true);
    expect(host.undoRequests.filter((id) => id === "late-listed")).toHaveLength(3);
    host.finishUndo("late-listed");
    await expect.poll(() => recoveryEntries()).toHaveLength(0);
    await expect.poll(() => retained(SERVER_ID, "late-listed")).toBe(false);

    expect({
      committed,
      retained: retained(SERVER_ID, "late-listed"),
      row: storedWorkspace(SERVER_ID, "late-listed"),
    }).toEqual({ committed: [], retained: false, row: workspace("late-listed") });
  });

  it("keeps archive B's shortcut priority until terminal release", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];
    seedWorkspace(SERVER_ID, "priority-a");
    seedWorkspace(SERVER_ID, "priority-b");

    const a = startArchive({ host, toast, workspaceId: "priority-a", committed });
    undoLatestWorkspaceArchive();
    host.finishArchive("priority-a", { canceled: true });
    await a;
    host.failUndo("priority-a", new Error("Branch is gone"));
    await expect.poll(() => toast.errors).toEqual(["Couldn't undo the archive"]);
    expect(recoveryEntries()).toHaveLength(1);
    expect(host.undoRequests.filter((id) => id === "priority-a")).toHaveLength(1);

    const b = startArchive({ host, toast, workspaceId: "priority-b", committed });
    host.finishArchive("priority-b");
    await b;
    expect(retained(SERVER_ID, "priority-b")).toBe(true);

    expect(undoLatestWorkspaceArchive()).toBe(true);
    expect(host.undoRequests.filter((id) => id === "priority-b")).toHaveLength(1);
    expect(host.undoRequests.filter((id) => id === "priority-a")).toHaveLength(1);

    host.finishUndo("priority-b");
    await expect.poll(() => retained(SERVER_ID, "priority-b")).toBe(false);
    expect(recoveryEntries().map((entry) => entry.workspaceId)).toEqual(["priority-a"]);

    expect(undoLatestWorkspaceArchive()).toBe(true);
    expect(host.undoRequests.filter((id) => id === "priority-a")).toHaveLength(2);
    host.finishUndo("priority-a");
    await expect.poll(() => recoveryEntries()).toHaveLength(0);
    expect(committed).toEqual([]);
  });

  it("keeps B priority across toast timeout until its commit releases", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];
    seedWorkspace(SERVER_ID, "timeout-a");
    seedWorkspace(SERVER_ID, "timeout-b");

    const a = startArchive({ host, toast, workspaceId: "timeout-a", committed });
    undoLatestWorkspaceArchive();
    host.finishArchive("timeout-a", { canceled: true });
    await a;
    host.failUndo("timeout-a", new Error("Branch is gone"));
    await expect.poll(() => toast.errors).toEqual(["Couldn't undo the archive"]);

    const b = startArchive({ host, toast, workspaceId: "timeout-b", committed });
    host.finishArchive("timeout-b");
    await b;
    toast.timeOut();
    expect(committed).toEqual(["timeout-b"]);
    expect(recoveryEntries().map((entry) => entry.workspaceId)).toEqual(["timeout-a"]);

    expect(undoLatestWorkspaceArchive()).toBe(true);
    expect(host.undoRequests.filter((id) => id === "timeout-a")).toHaveLength(2);
    host.finishUndo("timeout-a");
    await expect.poll(() => recoveryEntries()).toHaveLength(0);
  });

  it("keeps B priority after toast timeout while its archive is pending", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];
    seedWorkspace(SERVER_ID, "pending-a");
    seedWorkspace(SERVER_ID, "pending-b");

    const a = startArchive({ host, toast, workspaceId: "pending-a", committed });
    undoLatestWorkspaceArchive();
    host.finishArchive("pending-a", { canceled: true });
    await a;
    host.failUndo("pending-a", new Error("Branch is gone"));
    await expect.poll(() => toast.errors).toEqual(["Couldn't undo the archive"]);

    const b = startArchive({ host, toast, workspaceId: "pending-b", committed });
    toast.timeOut();
    expect(undoLatestWorkspaceArchive()).toBe(false);
    expect(host.undoRequests.filter((id) => id === "pending-a")).toHaveLength(1);

    host.finishArchive("pending-b");
    await b;
    expect(committed).toEqual(["pending-b"]);
    expect(undoLatestWorkspaceArchive()).toBe(true);
    expect(host.undoRequests.filter((id) => id === "pending-a")).toHaveLength(2);
    host.finishUndo("pending-a");
    await expect.poll(() => recoveryEntries()).toHaveLength(0);
  });

  it("retries the oldest of multiple independent recovery owners without retry-all", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];
    seedWorkspace(SERVER_ID, "multi-a");
    seedWorkspace(SERVER_ID, "multi-b");

    const a = startArchive({ host, toast, workspaceId: "multi-a", committed });
    undoLatestWorkspaceArchive();
    host.finishArchive("multi-a", { canceled: true });
    await a;
    host.failUndo("multi-a", new Error("Branch is gone"));
    await expect.poll(() => toast.errors).toEqual(["Couldn't undo the archive"]);

    const b = startArchive({ host, toast, workspaceId: "multi-b", committed });
    undoLatestWorkspaceArchive();
    host.finishArchive("multi-b", { canceled: true });
    await b;
    host.failUndo("multi-b", new Error("Branch is gone"));
    await expect.poll(() => recoveryEntries()).toHaveLength(2);

    expect(recoveryEntries().map((entry) => entry.workspaceId)).toEqual(["multi-a", "multi-b"]);
    expect(undoLatestWorkspaceArchive()).toBe(true);
    expect(host.undoRequests.filter((id) => id === "multi-a")).toHaveLength(2);
    expect(host.undoRequests.filter((id) => id === "multi-b")).toHaveLength(1);
    host.finishUndo("multi-a");
    await expect.poll(() => recoveryEntries()).toHaveLength(1);

    expect(recoveryEntries()[0]?.workspaceId).toBe("multi-b");
    expect(undoLatestWorkspaceArchive()).toBe(true);
    expect(host.undoRequests.filter((id) => id === "multi-b")).toHaveLength(2);
    host.finishUndo("multi-b");
    await expect.poll(() => recoveryEntries()).toHaveLength(0);
    expect(committed).toEqual([]);
  });

  it("ignores a stale recovery token after same-workspace supersede", async () => {
    const host = createClient();
    const toast = createToastHost();
    const committed: string[] = [];
    seedWorkspace(SERVER_ID, "stale");
    const target = { serverId: SERVER_ID, workspaceId: "stale" };

    const first = startArchive({ host, toast, workspaceId: "stale", committed });
    undoLatestWorkspaceArchive();
    host.finishArchive("stale", { canceled: true });
    await first;
    host.failUndo("stale", new Error("Branch is gone"));
    await expect.poll(() => toast.errors).toEqual(["Couldn't undo the archive"]);
    expect(recoveryEntries()).toHaveLength(1);
    const [entry] = recoveryEntries();
    expect(host.undoRequests.filter((id) => id === "stale")).toHaveLength(1);

    const successor = startArchive({ host, toast, workspaceId: "stale", committed });
    expect(recoveryEntries()).toHaveLength(0);
    expect(retryWorkspaceArchiveRecovery({ ...target, token: entry.token })).toBe(false);
    expect(host.undoRequests.filter((id) => id === "stale")).toHaveLength(1);

    host.finishArchive("stale");
    await successor;
    toast.timeOut();
    expect({ committed, retained: retained(SERVER_ID, "stale") }).toEqual({
      committed: ["stale"],
      retained: false,
    });
  });
});

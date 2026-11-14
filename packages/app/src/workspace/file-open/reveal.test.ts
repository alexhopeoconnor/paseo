import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import { usePanelStore } from "@/stores/panel-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  acknowledgeExplorerReveal,
  cancelExplorerReveal,
  claimExplorerReveal,
  peekExplorerReveal,
} from "@/file-explorer/reveal";
import { registerFileOpenRequest } from "./requests";
import { revealWorkspaceFile } from "./reveal";

const serverId = "server";
const workspaceId = "workspace";
const workspaceKey = `${serverId}:${workspaceId}`;

function seedWorkspace(root = "/repo") {
  useSessionStore.setState((state) => ({
    ...state,
    sessions: {
      ...state.sessions,
      [serverId]: {
        ...state.sessions[serverId],
        workspaces: new Map([
          [workspaceId, { id: workspaceId, workspaceDirectory: root } as WorkspaceDescriptor],
        ]),
      } as never,
    },
  }));
}

function showFiles() {
  const store = useWorkspaceLayoutStore.getState();
  const paneId = store.showExplorerSidebar(workspaceKey);
  store.openTab({
    workspaceKey,
    target: { kind: "files" },
    intent: "reveal",
    placement: paneId ? { mode: "pane", paneId } : undefined,
  });
}

beforeEach(() => {
  cancelExplorerReveal(workspaceKey);
  useWorkspaceLayoutStore.setState({
    layoutMode: "split-panes",
    layoutByWorkspace: {},
    sheetsByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    pendingOpenByWorkspace: {},
  });
  usePanelStore.setState({ explorerShowHiddenFiles: false });
  seedWorkspace();
});

describe("revealWorkspaceFile", () => {
  it("explicitly opens Explorer on Files and records a scoped selection", async () => {
    const outcome = revealWorkspaceFile({
      serverId,
      request: {
        workspaceId,
        path: "src/index.ts",
        source: "editor",
        intent: "explicit",
      },
    });
    const pending = peekExplorerReveal(workspaceKey)!;
    expect(pending).toMatchObject({
      path: "src/index.ts",
      intent: "explicit",
    });
    claimExplorerReveal(workspaceKey, pending.id);
    acknowledgeExplorerReveal(workspaceKey, pending.id, "revealed");
    await expect(outcome).resolves.toEqual({ status: "revealed" });
    const store = useWorkspaceLayoutStore.getState();
    const paneId = store.explorerSidebarPaneIdByWorkspace[workspaceKey];
    expect(store.getWorkspaceTabs(workspaceKey).some((tab) => tab.target.kind === "files")).toBe(
      true,
    );
    expect(paneId).toBeTruthy();
  });

  it("reports a missing path only after the tree acknowledges it", async () => {
    const outcome = revealWorkspaceFile({
      serverId,
      request: {
        workspaceId,
        path: "src/missing.ts",
        source: "search",
        intent: "explicit",
      },
    });
    const pending = peekExplorerReveal(workspaceKey)!;
    claimExplorerReveal(workspaceKey, pending.id);
    acknowledgeExplorerReveal(workspaceKey, pending.id, "missing");
    await expect(outcome).resolves.toEqual({ status: "unavailable", reason: "missing" });
  });

  it("leaves Explorer untouched for an automatic reveal that is not showing Files", async () => {
    const outcome = await revealWorkspaceFile({
      serverId,
      request: {
        workspaceId,
        path: "src/index.ts",
        source: "chat",
        intent: "auto",
      },
    });

    expect(outcome).toEqual({ status: "unavailable", reason: "not-visible" });
    expect(peekExplorerReveal(workspaceKey)).toBeNull();
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]).toBeUndefined();
  });

  it("updates an automatic reveal while Files stays visible", async () => {
    showFiles();
    const outcome = revealWorkspaceFile({
      serverId,
      request: {
        workspaceId,
        path: "src/index.ts",
        source: "chat",
        intent: "auto",
      },
    });
    const pending = peekExplorerReveal(workspaceKey)!;
    claimExplorerReveal(workspaceKey, pending.id);
    acknowledgeExplorerReveal(workspaceKey, pending.id, "revealed");
    await expect(outcome).resolves.toEqual({ status: "revealed" });
  });

  it("never toggles the hidden-files preference for a hidden path", async () => {
    const outcome = await revealWorkspaceFile({
      serverId,
      request: {
        workspaceId,
        path: ".github/workflows/ci.yml",
        source: "search",
        intent: "explicit",
      },
    });

    expect(outcome).toEqual({ status: "unavailable", reason: "hidden" });
    expect(usePanelStore.getState().explorerShowHiddenFiles).toBe(false);
    expect(peekExplorerReveal(workspaceKey)).toBeNull();
  });

  it("rejects a path outside the workspace", async () => {
    const outcome = await revealWorkspaceFile({
      serverId,
      request: {
        workspaceId,
        path: "/elsewhere/index.ts",
        source: "search",
        intent: "explicit",
      },
    });

    expect(outcome).toEqual({ status: "unavailable", reason: "missing" });
  });

  it("cancels a reveal bound to a settled request", async () => {
    const registration = registerFileOpenRequest({
      requestId: "request-1",
      hostId: serverId,
      workspaceId,
      path: "src/index.ts",
      disposition: "main",
      source: "search",
      signal: new AbortController().signal,
    });
    const outcome = revealWorkspaceFile({
      serverId,
      request: {
        workspaceId,
        path: "src/index.ts",
        source: "search",
        intent: "explicit",
        requestId: "request-1",
      },
    });
    await Promise.resolve();
    expect(peekExplorerReveal(workspaceKey)).not.toBeNull();
    registration.unregister();
    await expect(outcome).resolves.toEqual({ status: "cancelled" });
    expect(peekExplorerReveal(workspaceKey)).toBeNull();
  });

  it("does not reveal for a request bound to another host", async () => {
    const registration = registerFileOpenRequest({
      requestId: "request-2",
      hostId: "other-host",
      workspaceId,
      path: "src/index.ts",
      disposition: "main",
      source: "search",
      signal: new AbortController().signal,
    });
    const outcome = await revealWorkspaceFile({
      serverId,
      request: {
        workspaceId,
        path: "src/index.ts",
        source: "search",
        intent: "explicit",
        requestId: "request-2",
      },
    });
    registration.unregister();
    expect(outcome).toEqual({ status: "cancelled" });
  });

  it("accepts a fresh editor reveal after the confirmed open settled", async () => {
    const registration = registerFileOpenRequest({
      requestId: "request-3",
      hostId: serverId,
      workspaceId,
      path: "src/index.ts",
      disposition: "main",
      source: "search",
      signal: new AbortController().signal,
    });
    registration.unregister();
    const controller = new AbortController();
    const outcome = revealWorkspaceFile({
      serverId,
      request: {
        workspaceId,
        path: "src/index.ts",
        source: "editor",
        intent: "explicit",
      },
      options: { signal: controller.signal },
    });
    const pending = peekExplorerReveal(workspaceKey)!;
    expect(pending.requestId).toBeUndefined();
    claimExplorerReveal(workspaceKey, pending.id);
    acknowledgeExplorerReveal(workspaceKey, pending.id, "revealed");
    await expect(outcome).resolves.toEqual({ status: "revealed" });
  });

  it("cancels a waiting reveal when the editor panel lifetime ends", async () => {
    const controller = new AbortController();
    const outcome = revealWorkspaceFile({
      serverId,
      request: {
        workspaceId,
        path: "src/index.ts",
        source: "editor",
        intent: "explicit",
      },
      options: { signal: controller.signal },
    });
    expect(peekExplorerReveal(workspaceKey)).not.toBeNull();
    controller.abort();
    await expect(outcome).resolves.toEqual({ status: "cancelled" });
    expect(peekExplorerReveal(workspaceKey)).toBeNull();
  });
});

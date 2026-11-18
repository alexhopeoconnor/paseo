/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface TestEntry {
  key: string;
  serverId: string;
  workspaceId: string;
  workspaceName: string;
  token: number;
  retrying: boolean;
  retryable: boolean;
}

const recovery = vi.hoisted(() => ({
  entries: [] as TestEntry[],
  listeners: new Set<() => void>(),
  retry: vi.fn((_input: { serverId: string; workspaceId: string; token: number }) => true),
}));

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    colors: {
      surface0: "#000",
      surface1: "#111",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      destructive: "#f44",
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return { X: createIcon("X") };
});

vi.mock("@/constants/platform", () => ({ isWeb: true }));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [
    { serverId: "s1", label: "Host One" },
    { serverId: "s2", label: "Host Two" },
  ],
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock("@/lib/overlay-root", () => ({
  getOverlayRoot: () => {
    let root = document.getElementById("undo-recovery-overlay");
    if (!root) {
      root = document.createElement("div");
      root.id = "undo-recovery-overlay";
      document.body.appendChild(root);
    }
    return root;
  },
}));

vi.mock("./undo-window", () => ({
  getWorkspaceArchiveRecoverySnapshot: () => recovery.entries,
  subscribeWorkspaceArchiveRecovery: (listener: () => void) => {
    recovery.listeners.add(listener);
    return () => {
      recovery.listeners.delete(listener);
    };
  },
  retryWorkspaceArchiveRecovery: recovery.retry,
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { WorkspaceUndoRecoverySurface } from "./workspace-undo-recovery-surface";

function entry(input: {
  serverId: string;
  workspaceId: string;
  workspaceName: string;
  token: number;
  retrying?: boolean;
  retryable?: boolean;
}): TestEntry {
  return {
    key: `${input.serverId}:${input.workspaceId}`,
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    token: input.token,
    retrying: input.retrying ?? false,
    retryable: input.retryable ?? true,
  };
}

function setEntries(entries: TestEntry[]): void {
  recovery.entries = entries;
  for (const listener of recovery.listeners) listener();
}

describe("WorkspaceUndoRecoverySurface", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    recovery.entries = [];
    recovery.listeners.clear();
    recovery.retry.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    document.getElementById("undo-recovery-overlay")?.remove();
  });

  it("renders multiple owners through the portal and presses exact retry targets", () => {
    setEntries([
      entry({ serverId: "s1", workspaceId: "one", workspaceName: "Alpha", token: 11 }),
      entry({ serverId: "s2", workspaceId: "two", workspaceName: "Beta", token: 22 }),
    ]);

    act(() => {
      root?.render(<WorkspaceUndoRecoverySurface />);
    });

    const overlay = document.getElementById("undo-recovery-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelector('[data-testid="workspace-undo-recovery:s1:one"]')).not.toBeNull();
    expect(overlay?.querySelector('[data-testid="workspace-undo-recovery:s2:two"]')).not.toBeNull();
    expect(overlay?.textContent).toContain("Alpha");
    expect(overlay?.textContent).toContain("Host One");
    expect(overlay?.textContent).toContain("Beta");
    expect(overlay?.textContent).toContain("Host Two");

    const first = overlay?.querySelector(
      '[data-testid="workspace-undo-recovery-retry:s1:one"]',
    ) as HTMLElement | null;
    expect(first).not.toBeNull();
    act(() => {
      first?.click();
    });
    expect(recovery.retry).toHaveBeenCalledWith({
      serverId: "s1",
      workspaceId: "one",
      token: 11,
    });
    expect(recovery.retry).toHaveBeenCalledTimes(1);

    const second = overlay?.querySelector(
      '[data-testid="workspace-undo-recovery-retry:s2:two"]',
    ) as HTMLElement | null;
    act(() => {
      second?.click();
    });
    expect(recovery.retry).toHaveBeenLastCalledWith({
      serverId: "s2",
      workspaceId: "two",
      token: 22,
    });
    expect(recovery.retry).toHaveBeenCalledTimes(2);
  });

  it("keeps a retrying card mounted and removes stale entries without touching other owners", () => {
    setEntries([
      entry({
        serverId: "s1",
        workspaceId: "one",
        workspaceName: "Alpha",
        token: 11,
        retrying: true,
        retryable: false,
      }),
      entry({ serverId: "s2", workspaceId: "two", workspaceName: "Beta", token: 22 }),
    ]);

    act(() => {
      root?.render(<WorkspaceUndoRecoverySurface />);
    });

    const retryButton = document.querySelector(
      '[data-testid="workspace-undo-recovery-retry:s1:one"]',
    ) as HTMLElement | null;
    expect(retryButton).not.toBeNull();
    expect(recovery.retry).not.toHaveBeenCalled();

    act(() => {
      setEntries([entry({ serverId: "s2", workspaceId: "two", workspaceName: "Beta", token: 22 })]);
    });

    expect(document.querySelector('[data-testid="workspace-undo-recovery:s1:one"]')).toBeNull();
    expect(document.querySelector('[data-testid="workspace-undo-recovery:s2:two"]')).not.toBeNull();
    expect(recovery.retry).not.toHaveBeenCalled();
  });
});

import type { PluginFileOpenContext } from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceFileOpenDispatcher } from "./dispatch";
import { confirmFilePanelReplacement } from "@/file-panels/choice/model";
import { filePanelCatalog } from "@/file-panels/catalog";
import type { FilePanel, PluginFilePanel } from "@/file-panels/panels";
import type { FilePanelChoiceModel } from "@/file-panels/choice/model";
import type { InstalledPlugin } from "@/plugins/types";

function fixture(
  handler: (context: PluginFileOpenContext) => Promise<"handled" | "render"> = async () =>
    "handled",
  confirmReplacement?: ConstructorParameters<
    typeof WorkspaceFileOpenDispatcher
  >[0]["confirmReplacement"],
) {
  const onOpen = vi.fn(handler);
  const lifetime = new AbortController();
  const pluginPanel: PluginFilePanel = {
    id: "plugin:editor/file",
    builtin: false,
    files: { extensions: ["md"] },
    plugin: { lifetime } as InstalledPlugin,
    contribution: {
      id: "file",
      title: "Editor",
      icon: "File",
      files: { extensions: ["md"] },
      Component: () => null,
      onOpen,
    },
  };
  const panels: readonly FilePanel[] = filePanelCatalog([pluginPanel]);
  const associations: Record<string, string> = {};
  let shown: FilePanelChoiceModel<FilePanel> | null = null;
  let sequence = 0;
  const dispatcher = new WorkspaceFileOpenDispatcher({
    confirmReplacement,
    hostId: "host",
    workspaceId: "workspace",
    workspaceDirectory: "/repo",
    platform: "web",
    requestId: () => `request_${++sequence}`,
    stat: async () => "text",
    panels: () => panels,
    associations: () => associations,
    remember(key, panelId) {
      if (panelId) associations[key] = panelId;
    },
    present(choice) {
      shown = choice;
    },
  });
  return { dispatcher, onOpen, lifetime, associations, pluginPanel, choice: () => shown };
}

const request = {
  location: { path: "notes.md", lineStart: 4, lineEnd: 8 },
  disposition: "preferred" as const,
};

async function pendingChoice(test: ReturnType<typeof fixture>) {
  await vi.waitFor(() => expect(test.choice()).not.toBeNull());
  return test.choice()!;
}

describe("confirmed file dispatch", () => {
  it("selecting and cancelling never opens a viewer or constructs a tab", async () => {
    const test = fixture();
    const render = vi.fn();
    const operation = test.dispatcher.open(request, render);
    const choice = await pendingChoice(test);
    choice.selectInPicker(test.pluginPanel.id);
    expect(test.onOpen).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    choice.setRemember(true);
    choice.dismissPicker();
    await operation;
    expect(test.onOpen).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(test.associations).toEqual({});
    test.dispatcher.dispose();
  });

  it("dispatches confirmed and remembered opens once each with host, location and fresh intent identity", async () => {
    const test = fixture();
    const render = vi.fn();
    const first = test.dispatcher.open(request, render);
    const choice = await pendingChoice(test);
    choice.selectInPicker(test.pluginPanel.id);
    choice.setRemember(true);
    await Promise.all([choice.confirmPicker(), choice.confirmPicker()]);
    await first;
    await test.dispatcher.open(request, render);
    expect(test.onOpen).toHaveBeenCalledTimes(2);
    expect(test.onOpen.mock.calls[0]?.[0]).toMatchObject({
      hostId: "host",
      workspaceId: "workspace",
      workspaceDirectory: "/repo",
      path: "notes.md",
      lineStart: 4,
      lineEnd: 8,
      disposition: "preferred",
      requestId: "request_1",
    });
    expect(test.onOpen.mock.calls[1]?.[0]).toMatchObject({ requestId: "request_2" });
    expect(render).not.toHaveBeenCalled();
    test.dispatcher.dispose();
  });

  it("renders the explicitly selected built-in and preserves the line range", async () => {
    const test = fixture();
    test.associations["ext:md"] = test.pluginPanel.id;
    const render = vi.fn();
    await test.dispatcher.open(
      { ...request, viewer: { kind: "panel", panelId: "builtin:markdown" } },
      render,
    );
    expect(render).toHaveBeenCalledExactlyOnceWith({
      kind: "file",
      path: "notes.md",
      lineStart: 4,
      lineEnd: 8,
      panelId: "builtin:markdown",
    });
    expect(test.onOpen).not.toHaveBeenCalled();
    test.dispatcher.dispose();
  });

  it("does not fall through after an opener may have produced side effects", async () => {
    const test = fixture(
      vi.fn(async (_context: PluginFileOpenContext): Promise<"handled" | "render"> => {
        throw new Error("Editor unavailable");
      }),
    );
    const render = vi.fn();
    await expect(
      test.dispatcher.open(
        { ...request, viewer: { kind: "panel", panelId: test.pluginPanel.id } },
        render,
      ),
    ).rejects.toThrow("Editor unavailable");
    expect(render).not.toHaveBeenCalled();
    test.dispatcher.dispose();
  });

  it("rejects dirty viewer replacement before invoking or remembering the selected opener", async () => {
    const test = fixture(
      async () => "render",
      (_location, _panelId, open) =>
        confirmFilePanelReplacement({ modified: true, confirmDiscard: async () => false, open }),
    );
    const render = vi.fn();
    const operation = test.dispatcher.open(request, render);
    const choice = await pendingChoice(test);
    choice.selectInPicker(test.pluginPanel.id);
    choice.setRemember(true);
    await choice.confirmPicker();
    await expect(operation).resolves.toBe("cancelled");
    expect(test.onOpen).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(test.associations).toEqual({});
    test.dispatcher.dispose();
  });

  it("unloading a plugin cancels an unresolved handler and releases later file opens", async () => {
    const onOpen = vi.fn((_context: PluginFileOpenContext) => new Promise<"handled">(() => {}));
    const test = fixture(onOpen);
    const render = vi.fn();
    const operation = test.dispatcher.open(
      { ...request, viewer: { kind: "panel", panelId: test.pluginPanel.id } },
      render,
    );
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
    const context = onOpen.mock.calls[0]?.[0];
    test.lifetime.abort();
    expect(context?.signal.aborted).toBe(true);
    await expect(operation).resolves.toBe("cancelled");
    expect(render).not.toHaveBeenCalled();
    await expect(
      test.dispatcher.open(
        { ...request, viewer: { kind: "panel", panelId: "builtin:markdown" } },
        render,
      ),
    ).resolves.toBe("render");
    expect(render).toHaveBeenCalledOnce();
    test.dispatcher.dispose();
  });

  it("cancels a pending choice when its workspace disappears", async () => {
    const test = fixture();
    const render = vi.fn();
    const operation = test.dispatcher.open(request, render);
    await pendingChoice(test);
    test.dispatcher.dispose();
    await operation;
    expect(test.choice()).toBeNull();
    expect(render).not.toHaveBeenCalled();
    expect(test.onOpen).not.toHaveBeenCalled();
  });
});

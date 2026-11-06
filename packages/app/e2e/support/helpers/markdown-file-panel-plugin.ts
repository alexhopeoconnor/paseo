import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { pluginRequirements } from "./plugin-fixture";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { openFileFromExplorer } from "./file-explorer";

/** A directory plugin whose "Rich Markdown" file panel claims `.md`, next to the built-in. */
export const MARKDOWN_PANEL_PLUGIN_ID = "file-panel-picker-e2e";
export const MARKDOWN_PANEL_ID = `plugin:${MARKDOWN_PANEL_PLUGIN_ID}/rich-markdown`;
export const BUILTIN_MARKDOWN_OPTION = "Markdown — Paseo";
export const PLUGIN_MARKDOWN_OPTION = `Rich Markdown — ${MARKDOWN_PANEL_PLUGIN_ID}`;

const SOURCE = `import React, { useEffect } from "react";
import { Text, View } from "react-native";
const observations = globalThis.__filePanelObservations = { mounts: 0, editorMounts: 0, editorUnmounts: 0, opens: [] };
function RichMarkdown({ file }) {
  useEffect(() => { observations.mounts += 1; }, []);
  return <View><Text>Rich Markdown plugin: {file.name}</Text></View>;
}
export default function contribute(client) {
  client.addFilePanel({ id: "rich-markdown", title: "Rich Markdown", icon: "FileType",
    files: { extensions: ["md"] }, Component: RichMarkdown });
  return () => {};
}`;

const DIRECT_SOURCE = `import React, { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
const observations = globalThis.__filePanelObservations = { mounts: 0, editorMounts: 0, editorUnmounts: 0, opens: [] };
export default function contribute(client) {
  function Editor({ tab }) {
    const [identity] = useState(() => Math.random().toString(36));
    useEffect(() => { observations.editorMounts += 1; tab.setRetained?.(true); return () => { observations.editorUnmounts += 1; tab.setRetained?.(false); }; }, [tab.setRetained]);
    return <View><Text testID="retained-editor-identity">{identity}</Text><Pressable accessibilityRole="button" onPress={() => client.openPanel("filler-1", { workspaceId: observations.workspaceId })}><Text>Open next panel 1</Text></Pressable></View>;
  }
  client.addWorkspacePanel({ id: "editor", title: "Editor", icon: "FileText", Component: Editor });
  for (let index = 1; index <= 4; index++) {
    client.addWorkspacePanel({ id: "filler-" + index, title: "Other " + index, icon: "FileText", Component() {
      return <Pressable accessibilityRole="button" onPress={() => client.openPanel(index === 4 ? "editor" : "filler-" + (index + 1), { workspaceId: observations.workspaceId })}><Text>{index === 4 ? "Return to editor" : "Open next panel " + (index + 1)}</Text></Pressable>;
    } });
  }
  client.addFilePanel({ id: "rich-markdown", title: "Rich Markdown", icon: "FileType", files: { extensions: ["md"] },
    onOpen(request) { observations.opens.push({ requestId: request.requestId, path: request.path }); observations.workspaceId = request.workspaceId; client.openPanel("editor", { workspaceId: request.workspaceId }); return "handled"; },
    Component() { useEffect(() => { observations.mounts += 1; }, []); return <Text>Unexpected file viewer</Text>; } });
  return () => {};
}`;

export function filePanelObservations(page: Page): Promise<{
  mounts: number;
  editorMounts: number;
  editorUnmounts: number;
  opens: { requestId: string; path: string }[];
}> {
  return page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __filePanelObservations: {
            mounts: number;
            editorMounts: number;
            editorUnmounts: number;
            opens: { requestId: string; path: string }[];
          };
        }
      ).__filePanelObservations,
  );
}

/** Enables plugins on the test daemon and installs the plugin; `uninstall` restores both. */
export async function installMarkdownPanelPlugin(
  options: { directOpen?: boolean } = {},
): Promise<{ uninstall(): Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-markdown-file-panel-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  const uninstall = async () => {
    await client.removePlugin(MARKDOWN_PANEL_PLUGIN_ID);
    await client.patchDaemonConfig({
      pluginsEnabled: previousConfig.config.pluginsEnabled ?? false,
    });
    await client.close();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: MARKDOWN_PANEL_PLUGIN_ID, requirements: pluginRequirements }),
    );
    await writeFile(
      path.join(directory, "index.client.tsx"),
      options.directOpen ? DIRECT_SOURCE : SOURCE,
    );
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
  } catch (error) {
    await uninstall();
    throw error;
  }
  return { uninstall };
}

export function filePanelPicker(page: Page) {
  return page.getByText("Open .md files with", { exact: true });
}

export async function openMarkdown(page: Page, name: string): Promise<void> {
  await openFileFromExplorer(page, name);
}

export async function expectBuiltinMarkdown(page: Page, heading: string): Promise<void> {
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
}

export async function expectPluginMarkdown(page: Page, name: string): Promise<void> {
  await expect(page.getByText(`Rich Markdown plugin: ${name}`, { exact: true })).toBeVisible();
}

export async function storedFilePanelAssociations(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("@paseo:app-settings") ?? "{}");
    return settings.filePanelAssociations ?? {};
  });
}

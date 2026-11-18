import type { TestInfo } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { gotoWorkspace } from "../support/helpers/launcher";
import { expectFileTabOpen, openFileExplorer } from "../support/helpers/file-explorer";
import {
  BUILTIN_MARKDOWN_OPTION,
  MARKDOWN_PANEL_ID,
  PLUGIN_MARKDOWN_OPTION,
  expectBuiltinMarkdown,
  expectPluginMarkdown,
  filePanelPicker,
  filePanelObservations,
  installMarkdownPanelPlugin,
  openMarkdown,
  storedFilePanelAssociations,
} from "../support/helpers/markdown-file-panel-plugin";

async function choosePanel(page: Page, option: string, options: { remember: boolean }) {
  await page.getByRole("radio", { name: option, exact: true }).click();
  if (options.remember) {
    await page.getByRole("checkbox", { name: "Don't ask me again", exact: true }).click();
  }
  await page.getByRole("button", { name: "Use", exact: true }).click();
  await expect(filePanelPicker(page)).toBeHidden();
}

async function openWithFromTabMenu(page: Page, name: string, option: string) {
  await page.getByTestId(`workspace-tab-file_${name}`).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open with…" }).hover();
  await page.getByRole("menuitem", { name: option }).click();
}

async function toggleAlwaysUseFromTabMenu(page: Page, name: string) {
  await openWithFromTabMenu(page, name, "Always use for .md");
}

/** The built-in panel's toolbar control between its Preview and Source views. */
function viewControl(page: Page) {
  return page.getByTestId("file-preview-mode").filter({ visible: true });
}

async function selectFileView(page: Page, view: "Preview" | "Source") {
  const option = viewControl(page).getByRole("button", { name: view, exact: true });
  await option.click();
  await expect(option).toHaveAttribute("aria-selected", "true");
}

async function expectNoOpenWith(page: Page, name: string) {
  await page.getByTestId(`workspace-tab-file_${name}`).first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Close", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Open with…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const file = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: "image/png" });
}

test("opens Markdown with the built-in panel and its Preview and Source without asking", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({
    repoPrefix: "file-panel-builtins-",
    repo: { files: [{ path: "notes.md", content: "# notes heading\n" }] },
  });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);
    await openMarkdown(page, "notes.md");
    await expectBuiltinMarkdown(page, "notes heading");
    await expect(viewControl(page).getByRole("button")).toHaveText(["Preview", "Source"]);
    await expect(filePanelPicker(page)).toBeHidden();
    await expectNoOpenWith(page, "notes.md");
    await capture(page, testInfo, "file-panel-builtins-wide");

    await selectFileView(page, "Source");
    await expect(page.getByTestId("file-source-editor").filter({ visible: true })).toBeVisible();
    await selectFileView(page, "Preview");
    await expectBuiltinMarkdown(page, "notes heading");

    await page.setViewportSize({ width: 390, height: 844 });
    await expectBuiltinMarkdown(page, "notes heading");
    await expect(
      viewControl(page).getByRole("button", { name: "Source", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(filePanelPicker(page)).toBeHidden();
    await capture(page, testInfo, "file-panel-builtins-compact");
  } finally {
    await workspace.cleanup();
  }
});

test("asks once which panel opens Markdown and remembers it when told to", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({
    repoPrefix: "file-panel-picker-",
    repo: {
      files: ["first", "second", "third", "fourth"].map((name) => ({
        path: `${name}.md`,
        content: `# ${name} heading\n`,
      })),
    },
  });
  const plugin = await installMarkdownPanelPlugin();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);

    // First open: no file tab or viewer exists before confirmation.
    await openMarkdown(page, "first.md");
    await expect(filePanelPicker(page)).toBeVisible();
    await expect(page.getByRole("radio", { name: BUILTIN_MARKDOWN_OPTION })).toBeChecked();
    await expect(page.getByRole("radio", { name: PLUGIN_MARKDOWN_OPTION })).not.toBeChecked();
    await expect(page.getByRole("radio")).toHaveCount(2);
    await expect(page.getByTestId("workspace-tab-file_first.md")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "first heading", exact: true })).toHaveCount(0);
    expect((await filePanelObservations(page)).mounts).toBe(0);
    await capture(page, testInfo, "file-panel-picker-wide");

    // Don't ask me again: the plugin renders and later opens use it silently.
    await choosePanel(page, PLUGIN_MARKDOWN_OPTION, { remember: true });
    await expectPluginMarkdown(page, "first.md");
    expect(await storedFilePanelAssociations(page)).toEqual({ "ext:md": MARKDOWN_PANEL_ID });
    await openMarkdown(page, "second.md");
    await expectPluginMarkdown(page, "second.md");
    await expect(filePanelPicker(page)).toBeHidden();

    // Forgetting from the tab menu keeps the tab on the plugin.
    await toggleAlwaysUseFromTabMenu(page, "second.md");
    await expect.poll(() => storedFilePanelAssociations(page)).toEqual({});
    await expectPluginMarkdown(page, "second.md");

    // An unremembered choice applies to this tab only; the next open asks again.
    await openMarkdown(page, "third.md");
    await expect(filePanelPicker(page)).toBeVisible();
    await choosePanel(page, PLUGIN_MARKDOWN_OPTION, { remember: false });
    await expectPluginMarkdown(page, "third.md");
    expect(await storedFilePanelAssociations(page)).toEqual({});

    // "Open with…" switches the open tab back to the built-in in place, with its own views.
    await openWithFromTabMenu(page, "third.md", BUILTIN_MARKDOWN_OPTION);
    await expectPluginMarkdown(page, "third.md");
    await choosePanel(page, BUILTIN_MARKDOWN_OPTION, { remember: false });
    await expectBuiltinMarkdown(page, "third heading");
    await expectFileTabOpen(page, "third.md");
    await selectFileView(page, "Source");
    await expect(page.getByTestId("file-source-editor").filter({ visible: true })).toBeVisible();
    await selectFileView(page, "Preview");
    await expectBuiltinMarkdown(page, "third heading");

    // A rendered replacement mounts once, including the target metadata update.
    const mountsBeforeReplacement = (await filePanelObservations(page)).mounts;
    await openWithFromTabMenu(page, "third.md", PLUGIN_MARKDOWN_OPTION);
    await choosePanel(page, PLUGIN_MARKDOWN_OPTION, { remember: false });
    await expectPluginMarkdown(page, "third.md");
    expect((await filePanelObservations(page)).mounts).toBe(mountsBeforeReplacement + 1);
    await openWithFromTabMenu(page, "third.md", BUILTIN_MARKDOWN_OPTION);
    await choosePanel(page, BUILTIN_MARKDOWN_OPTION, { remember: false });
    await expectBuiltinMarkdown(page, "third heading");

    // Dismissing keeps the prior tab; a fresh user open asks again.
    await openMarkdown(page, "fourth.md");
    await expect(filePanelPicker(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(filePanelPicker(page)).toBeHidden();
    await expect(page.getByTestId("workspace-tab-file_fourth.md")).toHaveCount(0);
    await expectBuiltinMarkdown(page, "third heading");

    await page.setViewportSize({ width: 390, height: 844 });
    await openFileExplorer(page);
    await openMarkdown(page, "fourth.md");
    await expect(filePanelPicker(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Use", exact: true })).toBeInViewport({
      ratio: 1,
    });
    await capture(page, testInfo, "file-panel-picker-compact");
  } finally {
    await plugin.uninstall();
    await workspace.cleanup();
  }
});

test("a retained editor closes when freshly clean and protects dirty or unavailable state", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({
    repoPrefix: "editor-close-protection-",
    repo: { files: [{ path: "notes.md", content: "# notes\n" }] },
  });
  const plugin = await installMarkdownPanelPlugin({ closeProtection: true });
  const editor = page.getByTestId("retained-editor-identity");
  const prompts: string[] = [];
  page.on("dialog", async (dialog) => {
    prompts.push(dialog.message());
    await dialog.dismiss();
  });
  async function closeEditor() {
    await page.getByRole("button", { name: "Editor", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close", exact: true }).click();
  }
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);
    await openMarkdown(page, "notes.md");
    await choosePanel(page, PLUGIN_MARKDOWN_OPTION, { remember: true });
    await expect(editor).toBeVisible();
    await closeEditor();
    await expect(editor).toHaveCount(0);
    expect(prompts).toEqual([]);

    await openMarkdown(page, "notes.md");
    await expect(editor).toBeVisible();
    await page.getByRole("button", { name: "Mark editor dirty", exact: true }).click();
    await closeEditor();
    await expect.poll(() => prompts.length).toBe(1);
    expect(prompts[0]).toContain("Closing it will discard the draft.");
    await expect(editor).toBeVisible();
    await page.getByRole("button", { name: "Save editor", exact: true }).click();
    await closeEditor();
    await expect(editor).toHaveCount(0);
    expect(prompts).toHaveLength(1);

    await openMarkdown(page, "notes.md");
    await expect(editor).toBeVisible();
    await page.getByRole("button", { name: "Disconnect editor", exact: true }).click();
    await closeEditor();
    await expect.poll(() => prompts.length).toBe(2);
    expect(prompts[1]).toContain("Closing it will discard the draft.");
    await expect(editor).toBeVisible();
  } finally {
    await plugin.uninstall();
    await workspace.cleanup();
  }
});

test("confirmed opens focus one retained editor without mounting a file viewer or intermediate tab", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({
    repoPrefix: "confirmed-editor-",
    repo: { files: [{ path: "notes.md", content: "# notes\n" }] },
  });
  const plugin = await installMarkdownPanelPlugin({ directOpen: true });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);
    await openMarkdown(page, "notes.md");
    await expect(filePanelPicker(page)).toBeVisible();
    await page.getByRole("radio", { name: PLUGIN_MARKDOWN_OPTION, exact: true }).click();
    expect(await filePanelObservations(page)).toMatchObject({
      mounts: 0,
      editorMounts: 0,
      opens: [],
    });
    await expect(page.getByTestId("workspace-tab-file_notes.md")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(filePanelPicker(page)).toBeHidden();
    expect((await filePanelObservations(page)).opens).toEqual([]);

    await openMarkdown(page, "notes.md");
    await choosePanel(page, PLUGIN_MARKDOWN_OPTION, { remember: true });
    const editor = page.getByTestId("retained-editor-identity");
    await expect(editor).toBeVisible();
    const identity = await editor.textContent();
    await expect(page.getByTestId("workspace-tab-file_notes.md")).toHaveCount(0);
    expect(await filePanelObservations(page)).toMatchObject({
      mounts: 0,
      editorMounts: 1,
      editorUnmounts: 0,
    });
    expect((await filePanelObservations(page)).opens).toHaveLength(1);
    for (let index = 1; index <= 4; index++)
      await page.getByRole("button", { name: "Open next panel " + index, exact: true }).click();
    await page.getByRole("button", { name: "Return to editor", exact: true }).click();
    await expect(editor).toHaveText(identity!);
    expect(await filePanelObservations(page)).toMatchObject({ editorMounts: 1, editorUnmounts: 0 });

    await openMarkdown(page, "notes.md");
    await expect.poll(async () => (await filePanelObservations(page)).opens.length).toBe(2);
    const requests = (await filePanelObservations(page)).opens;
    expect(requests[0]?.requestId).not.toBe(requests[1]?.requestId);
    await expect(editor).toHaveText(identity!);
    await expect(page.getByTestId("workspace-tab-file_notes.md")).toHaveCount(0);
    await page.getByRole("button", { name: "Editor", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close", exact: true }).click();
    await expect.poll(async () => (await filePanelObservations(page)).editorUnmounts).toBe(1);
  } finally {
    await plugin.uninstall();
    await workspace.cleanup();
  }
});

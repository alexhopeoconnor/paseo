import { describe, expect, it } from "vitest";
import { filePanelCatalog, sourceFilePanel } from "../catalog";
import { resolveFilePanel, type FilePanelCandidate } from "../resolve";
import { chosenPanelFor, FilePanelChoiceModel } from "./model";

const rich: FilePanelCandidate = {
  id: "plugin:notes/rich",
  builtin: false,
  files: { extensions: ["md", "markdown"] },
};
const richTypeScript: FilePanelCandidate = {
  id: "plugin:ts/outline",
  builtin: false,
  files: { extensions: ["ts"] },
};
const markdown = "builtin:markdown";
const source = sourceFilePanel.id;

/** A file tab: resolves against the shared associations and feeds the result to its model. */
function openTab(
  associations: Record<string, string>,
  candidates: FilePanelCandidate[] = [...filePanelCatalog([rich])],
  options: { presentable?: boolean; path?: string; lineNavigation?: number | null } = {},
) {
  const model = new FilePanelChoiceModel<FilePanelCandidate>({
    remember(selectorKey, panelId) {
      if (panelId === null) delete associations[selectorKey];
      else associations[selectorKey] = panelId;
    },
  });
  let targetKey = `/repo:${options.path ?? "notes.md"}`;
  let presentable = options.presentable ?? true;
  let lineNavigation = options.lineNavigation ?? null;
  const resolve = () =>
    resolveFilePanel({
      file: { path: targetKey.split(":")[1]!, kind: "text" },
      candidates,
      associations,
      choice: chosenPanelFor(model.getSnapshot(), targetKey),
    });
  // Like the hook: observe, then render what the model's choice resolves to.
  const render = () => {
    model.observe({ targetKey, resolution: resolve(), presentable, lineNavigation });
    return model.panelFor(targetKey, resolve())?.id ?? null;
  };
  render();
  return {
    model,
    render,
    panel: () => render(),
    picker: () => model.getSnapshot().picker,
    retarget(path: string) {
      targetKey = `/repo:${path}`;
      return render();
    },
    setPresentable(next: boolean) {
      presentable = next;
      return render();
    },
    navigateToLine(revision: number) {
      lineNavigation = revision;
      return render();
    },
  };
}

describe("FilePanelChoiceModel", () => {
  it("does not mount a first candidate before confirmation or after cancellation", () => {
    const associations = {};
    const tab = openTab(associations);
    expect(tab.panel()).toBeNull();
    expect(tab.picker()).toMatchObject({
      selectorKey: "ext:md",
      selectedPanelId: markdown,
      remember: false,
    });
    expect(tab.picker()?.candidates.map((candidate) => candidate.id)).toEqual([markdown, rich.id]);
    tab.model.dismissPicker();
    expect(tab.picker()).toBeNull();
    expect(tab.panel()).toBeNull();
    expect(tab.picker()).toBeNull();
    expect(associations).toEqual({});

    expect(openTab(associations).picker()).not.toBeNull();
  });

  it("opens a file a built-in claims with that built-in alone and nothing to choose", () => {
    const tab = openTab({}, [...filePanelCatalog([])]);
    expect(tab.panel()).toBe(markdown);
    expect(tab.picker()).toBeNull();
    expect(tab.model.getSnapshot().openWith).toBeNull();
    tab.model.openWith(source);
    expect(tab.panel()).toBe(markdown);
  });

  it("opens a file only Source claims with Source and nothing to choose", () => {
    const tab = openTab({}, [...filePanelCatalog([rich])], { path: "index.ts" });
    expect(tab.panel()).toBe(source);
    expect(tab.picker()).toBeNull();
    expect(tab.model.getSnapshot().openWith).toBeNull();
  });

  it("remembers the choice when Don't ask me again is checked", () => {
    const associations: Record<string, string> = {};
    const tab = openTab(associations);
    tab.model.selectInPicker(rich.id);
    tab.model.setRemember(true);
    tab.model.confirmPicker();
    expect(tab.panel()).toBe(rich.id);
    expect(associations).toEqual({ "ext:md": rich.id });

    const next = openTab(associations);
    expect(next.panel()).toBe(rich.id);
    expect(next.picker()).toBeNull();
  });

  it("uses an unremembered choice for this tab only and asks again on the next open", () => {
    const associations = {};
    const tab = openTab(associations);
    tab.model.selectInPicker(rich.id);
    tab.model.confirmPicker();
    expect(tab.panel()).toBe(rich.id);
    expect(associations).toEqual({});

    const next = openTab(associations);
    expect(next.panel()).toBeNull();
    expect(next.picker()).not.toBeNull();
  });

  it("does not ask with an association or while the tab is in the background", () => {
    expect(openTab({ "ext:md": rich.id }).picker()).toBeNull();
    expect(openTab({ "ext:md": source }).panel()).toBeNull();

    const background = openTab({}, undefined, { presentable: false });
    expect(background.picker()).toBeNull();
    background.setPresentable(true);
    expect(background.picker()).not.toBeNull();
  });

  it("keeps line coordinates independent of the remembered viewer", () => {
    const tab = openTab({ "ext:md": rich.id }, undefined, { lineNavigation: 1 });
    expect(tab.panel()).toBe(rich.id);
    expect(tab.picker()).toBeNull();
    expect(tab.navigateToLine(2)).toBe(rich.id);
    const typescript = openTab(
      { "ext:ts": richTypeScript.id },
      [...filePanelCatalog([richTypeScript])],
      { path: "index.ts" },
    );
    expect(typescript.navigateToLine(1)).toBe(richTypeScript.id);
  });

  it("gates the first render synchronously, before observe runs", () => {
    const model = new FilePanelChoiceModel<FilePanelCandidate>({ remember() {} });
    const resolution = resolveFilePanel({
      file: { path: "notes.md", kind: "text" },
      candidates: filePanelCatalog([rich]),
      associations: {},
    });
    expect(model.panelFor("/repo:notes.md", resolution)).toBeNull();
  });

  it("starts a new open when the tab is retargeted", () => {
    const tab = openTab({});
    tab.model.selectInPicker(rich.id);
    tab.model.confirmPicker();
    expect(tab.retarget("other.md")).toBeNull();
    expect(tab.picker()).not.toBeNull();
  });

  it("switches with Open with and toggles Always use without moving the tab", () => {
    const associations: Record<string, string> = {};
    const tab = openTab(associations);
    tab.model.confirmPicker();
    expect(tab.model.getSnapshot().openWith).toMatchObject({
      activePanelId: markdown,
      remembered: false,
    });

    tab.model.openWith(rich.id);
    tab.model.confirmPicker();
    expect(tab.panel()).toBe(rich.id);
    tab.model.toggleAlwaysUse();
    expect(associations).toEqual({ "ext:md": rich.id });
    tab.render();
    expect(tab.model.getSnapshot().openWith?.remembered).toBe(true);

    tab.model.openWith(markdown);
    tab.model.confirmPicker();
    expect(tab.panel()).toBe(markdown);
    expect(tab.model.getSnapshot().openWith?.remembered).toBe(false);
    tab.model.openWith(rich.id);
    tab.model.confirmPicker();
    tab.render();
    tab.model.toggleAlwaysUse();
    expect(associations).toEqual({});
    expect(tab.panel()).toBe(rich.id);
  });

  it("keeps an existing built-in viewer when a plugin panel arrives later", () => {
    const candidates: FilePanelCandidate[] = [...filePanelCatalog([])];
    const tab = openTab({}, candidates);
    expect(tab.picker()).toBeNull();
    candidates.splice(1, 0, rich);
    tab.render();
    expect(tab.picker()).toBeNull();
    expect(tab.panel()).toBe(markdown);
  });
  it("does not mount a default when Open with follows a cancelled unresolved choice", () => {
    const tab = openTab({});
    tab.model.dismissPicker();
    tab.model.openWith(rich.id);
    expect(tab.panel()).toBeNull();
    tab.model.selectInPicker(markdown);
    expect(tab.panel()).toBeNull();
    tab.model.confirmPicker();
    expect(tab.panel()).toBe(markdown);
  });

  it("does not render a remembered handled choice when this restored tab had no viewer", async () => {
    const associations: Record<string, string> = {};
    const model = new FilePanelChoiceModel<FilePanelCandidate>({
      remember(key, panelId) {
        if (panelId) associations[key] = panelId;
      },
      confirm: async () => "handled" as const,
    });
    const resolve = () =>
      resolveFilePanel({
        file: { path: "notes.md", kind: "text" },
        candidates: filePanelCatalog([rich]),
        associations,
      });
    model.observe({
      targetKey: "file",
      resolution: resolve(),
      presentable: true,
      lineNavigation: null,
    });
    model.selectInPicker(rich.id);
    model.setRemember(true);
    await model.confirmPicker();
    expect(associations["ext:md"]).toBe(rich.id);
    model.observe({
      targetKey: "file",
      resolution: resolve(),
      presentable: true,
      lineNavigation: null,
    });
    expect(model.panelFor("file", resolve())).toBeNull();
    model.openWith(markdown);
    expect(model.panelFor("file", resolve())).toBeNull();
  });

  it("keeps the existing viewer while Open with is selected or cancelled", () => {
    const tab = openTab({ "ext:md": markdown });
    tab.model.openWith(rich.id);
    expect(tab.panel()).toBe(markdown);
    tab.model.dismissPicker();
    expect(tab.panel()).toBe(markdown);
  });

  it("does not replace an existing viewer when its unsaved guard declines", async () => {
    const model = new FilePanelChoiceModel<FilePanelCandidate>({
      remember() {},
      confirm: async () => "cancelled" as const,
    });
    const resolution = resolveFilePanel({
      file: { path: "notes.md", kind: "text" },
      candidates: filePanelCatalog([rich]),
      associations: { "ext:md": markdown },
    });
    model.observe({ targetKey: "file", resolution, presentable: true, lineNavigation: null });
    model.openWith(rich.id);
    await model.confirmPicker();
    expect(model.getSnapshot().chosenPanelId).toBe(markdown);
  });
  it("remembers a handled Open with selection while preserving the old viewer", async () => {
    const associations: Record<string, string> = { "ext:md": markdown };
    const model = new FilePanelChoiceModel<FilePanelCandidate>({
      remember(key, panelId) {
        if (panelId) associations[key] = panelId;
      },
      confirm: async () => "handled" as const,
    });
    const resolution = resolveFilePanel({
      file: { path: "notes.md", kind: "text" },
      candidates: filePanelCatalog([rich]),
      associations,
    });
    model.observe({ targetKey: "file", resolution, presentable: true, lineNavigation: null });
    model.openWith(rich.id);
    model.setRemember(true);
    await model.confirmPicker();
    expect(associations["ext:md"]).toBe(rich.id);
    expect(model.getSnapshot().chosenPanelId).toBe(markdown);
  });
});

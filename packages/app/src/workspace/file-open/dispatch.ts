import type { PluginFileOpenContext } from "@getpaseo/plugin/client";
import { FilePanelChoiceModel } from "@/file-panels/choice/model";
import type { FilePanel } from "@/file-panels/panels";
import { resolveFilePanel, type FilePanelFileKind } from "@/file-panels/resolve";
import type { WorkspaceFileLocation, WorkspaceFileOpenRequest, WorkspaceFileTabTarget } from ".";
import { createWorkspaceFileTabTarget, normalizeWorkspaceFileLocation } from ".";

export type FileOpenOutcome = "handled" | "render" | "cancelled";

interface FileOpenDispatcherDependencies {
  hostId: string;
  workspaceId: string;
  workspaceDirectory: string;
  platform: PluginFileOpenContext["platform"];
  requestId(): string;
  stat(path: string, signal: AbortSignal): Promise<FilePanelFileKind>;
  panels(): readonly FilePanel[];
  associations(): Readonly<Record<string, string>>;
  remember(selectorKey: string, panelId: string | null): void;
  present(choice: FilePanelChoiceModel<FilePanel> | null): void;
  confirmReplacement?(
    location: WorkspaceFileLocation,
    panelId: string | undefined,
    open: (canRender?: () => boolean) => Promise<FileOpenOutcome>,
  ): Promise<FileOpenOutcome>;
}

/** Owns user intents, never persisted layout restoration. No tab exists until render is confirmed. */
export class WorkspaceFileOpenDispatcher {
  private readonly lifetime = new AbortController();
  private readonly pluginSignals = new Map<
    AbortSignal,
    { controller: AbortController; unlink(): void }
  >();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: FileOpenDispatcherDependencies) {}

  open(
    request: WorkspaceFileOpenRequest,
    render: (target: WorkspaceFileTabTarget) => void,
  ): Promise<FileOpenOutcome> {
    const requestId = this.deps.requestId();
    const result = this.queue
      .then(() => this.dispatch(request, requestId, render))
      .catch((error: unknown) => {
        if (!this.lifetime.signal.aborted) throw error;
        return "cancelled" as const;
      });
    this.queue = result.catch(() => {});
    return result;
  }

  dispose(): void {
    this.lifetime.abort();
    this.deps.present(null);
    for (const { controller, unlink } of this.pluginSignals.values()) {
      unlink();
      controller.abort();
    }
    this.pluginSignals.clear();
  }

  private pluginSignal(signal: AbortSignal): AbortSignal {
    const previous = this.pluginSignals.get(signal);
    if (previous) return previous.controller.signal;
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
      this.pluginSignals.delete(signal);
    };
    const unlink = () => signal.removeEventListener("abort", abort);
    if (signal.aborted || this.lifetime.signal.aborted) controller.abort();
    else {
      signal.addEventListener("abort", abort, { once: true });
      this.pluginSignals.set(signal, { controller, unlink });
    }
    return controller.signal;
  }

  private async dispatch(
    request: WorkspaceFileOpenRequest,
    requestId: string,
    render: (target: WorkspaceFileTabTarget) => void,
  ): Promise<FileOpenOutcome> {
    const signal = this.lifetime.signal;
    if (signal.aborted) return "cancelled";
    const location = normalizeWorkspaceFileLocation(request.location);
    if (!location) throw new Error("The file path is empty.");
    const kind = await untilCancelled(this.deps.stat(location.path, signal), signal);
    if (kind === CANCELLED) return "cancelled";
    const explicit = request.viewer?.kind === "panel" ? request.viewer.panelId : undefined;
    const resolution = resolveFilePanel({
      file: { path: location.path, kind },
      candidates: this.deps.panels(),
      associations: this.deps.associations(),
      choice: explicit,
    });
    if (explicit && resolution.panel?.id !== explicit)
      throw new Error("The selected file viewer is unavailable.");
    const selection: { remembered?: { selectorKey: string; panelId: string | null } } = {};
    const choice = new FilePanelChoiceModel<FilePanel>({
      remember(selectorKey, panelId) {
        selection.remembered = { selectorKey, panelId };
      },
    });
    choice.observe({ targetKey: requestId, resolution, presentable: true, lineNavigation: null });
    if (explicit) choice.confirmPanel(explicit);
    let panel = choice.panelFor(requestId, resolution);
    if (!panel && choice.getSnapshot().picker)
      panel = await this.choose(choice, resolution.candidates);
    if (signal.aborted || choice.getSnapshot().cancelled) return "cancelled";
    const open = (canRender?: () => boolean) =>
      this.openResolved(panel, location, request, requestId, render, canRender);
    const outcome = this.deps.confirmReplacement
      ? await this.deps.confirmReplacement(location, panel?.id, open)
      : await open();
    if (outcome !== "cancelled" && selection.remembered) {
      this.deps.remember(selection.remembered.selectorKey, selection.remembered.panelId);
    }
    return outcome;
  }

  private async openResolved(
    panel: FilePanel | null,
    location: WorkspaceFileLocation,
    request: WorkspaceFileOpenRequest,
    requestId: string,
    render: (target: WorkspaceFileTabTarget) => void,
    canRender?: () => boolean,
  ): Promise<FileOpenOutcome> {
    if (this.lifetime.signal.aborted) return "cancelled";
    if (panel) {
      const outcome = await this.invokePanel(panel, {
        ...location,
        requestId,
        hostId: this.deps.hostId,
        workspaceId: this.deps.workspaceId,
        workspaceDirectory: this.deps.workspaceDirectory,
        disposition: request.disposition,
        platform: this.deps.platform,
      });
      if (outcome !== "render") return outcome;
    }
    if (this.lifetime.signal.aborted || (canRender && !canRender())) return "cancelled";
    render(createWorkspaceFileTabTarget(location, panel?.id));
    return "render";
  }

  private async invokePanel(
    panel: FilePanel,
    context: Omit<PluginFileOpenContext, "signal">,
  ): Promise<FileOpenOutcome> {
    if (panel.builtin) return "render";
    if (
      panel.plugin.lifetime.signal.aborted ||
      !this.deps
        .panels()
        .some(
          (candidate) =>
            !candidate.builtin &&
            candidate.id === panel.id &&
            candidate.plugin.lifetime === panel.plugin.lifetime,
        )
    ) {
      throw new Error("The selected file viewer was unloaded. Open the file again.");
    }
    const handler = panel.contribution.onOpen;
    if (!handler) return "render";
    const signal = this.pluginSignal(panel.plugin.lifetime.signal);
    const outcome = await untilCancelled(
      Promise.resolve().then(() => {
        if (signal.aborted) return CANCELLED;
        return handler({ ...context, signal });
      }),
      signal,
    );
    if (outcome === CANCELLED) return "cancelled";
    if (outcome !== "handled" && outcome !== "render")
      throw new Error("The file viewer returned an invalid open result.");
    return outcome;
  }

  private choose(
    choice: FilePanelChoiceModel<FilePanel>,
    candidates: readonly FilePanel[],
  ): Promise<FilePanel | null> {
    return new Promise((resolve) => {
      const signal = this.lifetime.signal;
      const finish = (panel: FilePanel | null) => {
        unsubscribe();
        signal.removeEventListener("abort", abort);
        this.deps.present(null);
        resolve(panel);
      };
      const abort = () => finish(null);
      const unsubscribe = choice.subscribe(() => {
        const snapshot = choice.getSnapshot();
        if (snapshot.cancelled) finish(null);
        else if (!snapshot.picker && snapshot.chosenPanelId)
          finish(candidates.find((panel) => panel.id === snapshot.chosenPanelId) ?? null);
      });
      signal.addEventListener("abort", abort, { once: true });
      this.deps.present(choice);
    });
  }
}

const CANCELLED = Symbol("cancelled file open");

/** Cancellation releases the queue even when a removed plugin never settles its handler. */
function untilCancelled<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof CANCELLED> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      resolve(CANCELLED);
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(signal.aborted ? CANCELLED : value);
        return undefined;
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) resolve(CANCELLED);
        else reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

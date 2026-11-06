import { asksForFilePanel, type FilePanelCandidate, type FilePanelResolution } from "../resolve";

/** What the file tab currently resolves; `resolution` is null until the file has been read. */
export interface FilePanelChoiceSource<Candidate extends FilePanelCandidate> {
  targetKey: string | null;
  resolution: FilePanelResolution<Candidate> | null;
  /** The tab is on screen, so a picker shown now is seen over the panel it chooses for. */
  presentable: boolean;
  /** Identifies the tab's latest request to show a line, or null when it targets no line. */
  lineNavigation: number | null;
}

export interface FilePanelPickerState<Candidate> {
  selectorKey: string;
  candidates: readonly Candidate[];
  selectedPanelId: string;
  remember: boolean;
}

export interface FilePanelOpenWithState<Candidate> {
  selectorKey: string;
  candidates: readonly Candidate[];
  activePanelId: string;
  /** The active panel is the one remembered for `selectorKey`. */
  remembered: boolean;
}

export interface FilePanelChoiceSnapshot<Candidate> {
  targetKey: string | null;
  /** The panel picked for this tab open. Resolution prefers it over the association. */
  chosenPanelId: string | null;
  cancelled: boolean;
  picker: FilePanelPickerState<Candidate> | null;
  /** Present only when the file has more than one candidate; drives "Open with…". */
  openWith: FilePanelOpenWithState<Candidate> | null;
}

export interface FilePanelChoiceDeps {
  /** Writes (or clears, with null) the device-wide association for a selector key. */
  remember(selectorKey: string, panelId: string | null): void;
  /** Existing tabs may dispatch to an editor or guard replacement of unsaved work. */
  confirm?(
    panelId: string,
  ): "handled" | "render" | "cancelled" | Promise<"handled" | "render" | "cancelled">;
}

/** Guard replacement before invoking an opener; a handled open keeps the old viewer alive. */
export async function confirmFilePanelReplacement(input: {
  modified: boolean;
  suspendPendingSave?: () => () => void;
  confirmDiscard(): Promise<boolean>;
  open(): Promise<"handled" | "render" | "cancelled">;
}): Promise<"handled" | "render" | "cancelled"> {
  const resume = input.modified ? input.suspendPendingSave?.() : undefined;
  let replaced = false;
  try {
    if (input.modified && !(await input.confirmDiscard())) return "cancelled";
    const outcome = await input.open();
    replaced = outcome === "render";
    return outcome;
  } finally {
    if (!replaced) resume?.();
  }
}

/** The tab choice that applies to `targetKey`; a choice never outlives its open. */
export function chosenPanelFor(
  snapshot: FilePanelChoiceSnapshot<unknown>,
  targetKey: string | null,
): string | null {
  return snapshot.targetKey === targetKey ? snapshot.chosenPanelId : null;
}

const EMPTY: FilePanelChoiceSnapshot<never> = {
  targetKey: null,
  chosenPanelId: null,
  cancelled: false,
  picker: null,
  openWith: null,
};

/**
 * Which file panel one file tab shows, and whether to ask.
 *
 * A tab open is one target in one tab: the picker is offered at most once per open, the first
 * time the tab is on screen with a plugin panel among several candidates and nothing remembered.
 * Built-in panels alone never ask. Line coordinates are independent of viewer selection.
 * Retargeting the tab starts a new open. Choices made here apply to this tab; only "Don't ask me
 * again" and "Always use" write the association every later open reads.
 */
export class FilePanelChoiceModel<Candidate extends FilePanelCandidate> {
  private readonly listeners = new Set<() => void>();
  private snapshot: FilePanelChoiceSnapshot<Candidate> = EMPTY;
  private asked = false;
  private confirming = false;

  constructor(private readonly deps: FilePanelChoiceDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): FilePanelChoiceSnapshot<Candidate> => this.snapshot;

  /** Render-time decision: no first-frame viewer mount while the effect opens the chooser. */
  panelFor(
    targetKey: string | null,
    resolution: FilePanelResolution<Candidate> | null,
  ): Candidate | null {
    if (!resolution) return null;
    const current = this.snapshot.targetKey === targetKey ? this.snapshot : EMPTY;
    if (current.cancelled || (current.picker && !current.chosenPanelId)) return null;
    if (
      current.chosenPanelId ||
      resolution.associatedPanelId ||
      !asksForFilePanel(resolution.candidates)
    ) {
      return resolution.panel;
    }
    return null;
  }

  observe(source: FilePanelChoiceSource<Candidate>): void {
    let current = this.snapshot;
    if (source.targetKey !== current.targetKey) {
      this.asked = false;
      current = { ...EMPTY, targetKey: source.targetKey };
    }
    // Commit automatic decisions for this open so later association/catalog changes cannot
    // unmount an existing viewer (including its unsaved work) behind a new chooser.
    if (
      !current.chosenPanelId &&
      !current.cancelled &&
      !current.picker &&
      source.resolution?.panel &&
      (source.resolution.associatedPanelId || !asksForFilePanel(source.resolution.candidates))
    ) {
      current = { ...current, chosenPanelId: source.resolution.panel.id };
    }
    const openWith = stableOpenWith(current.openWith, openWithState(source.resolution));
    let picker = openWith ? current.picker : null;
    // Decided once per open, the first time there is something to ask about on screen. An
    // association forgotten while the tab stays open is asked about on the next open.
    if (!this.asked && source.presentable && openWith && asksForFilePanel(openWith.candidates)) {
      this.asked = true;
      const remembered = Boolean(source.resolution?.associatedPanelId);
      if (!remembered && current.chosenPanelId === null) {
        picker = {
          selectorKey: openWith.selectorKey,
          candidates: openWith.candidates,
          selectedPanelId: openWith.activePanelId,
          remember: false,
        };
      }
    }
    this.publish({ ...current, openWith, picker });
  }

  /** An explicit already-confirmed host dispatch, including restored viewer selection. */
  confirmPanel(panelId: string): void {
    this.asked = true;
    this.publish({ ...this.snapshot, chosenPanelId: panelId, cancelled: false, picker: null });
  }

  selectInPicker(panelId: string): void {
    const picker = this.snapshot.picker;
    if (!picker) return;
    this.publish({ ...this.snapshot, picker: { ...picker, selectedPanelId: panelId } });
  }

  setRemember(remember: boolean): void {
    const picker = this.snapshot.picker;
    if (!picker) return;
    this.publish({ ...this.snapshot, picker: { ...picker, remember } });
  }

  async confirmPicker(): Promise<void> {
    const picker = this.snapshot.picker;
    if (!picker || this.confirming) return;
    this.confirming = true;
    try {
      const outcome = this.deps.confirm
        ? await this.deps.confirm(picker.selectedPanelId)
        : "render";
      if (outcome === "cancelled") {
        if (this.snapshot.picker === picker) this.publish({ ...this.snapshot, picker: null });
        return;
      }
      if (this.snapshot.picker !== picker) return;
      if (picker.remember) this.deps.remember(picker.selectorKey, picker.selectedPanelId);
      this.publish({
        ...this.snapshot,
        chosenPanelId: outcome === "render" ? picker.selectedPanelId : this.snapshot.chosenPanelId,
        cancelled: outcome === "handled" && this.snapshot.chosenPanelId === null,
        picker: null,
      });
    } finally {
      this.confirming = false;
    }
  }

  /** Cancels an unresolved first open; an existing confirmed viewer remains selected. */
  dismissPicker(): void {
    if (!this.snapshot.picker) return;
    this.publish({
      ...this.snapshot,
      cancelled: this.snapshot.chosenPanelId === null,
      picker: null,
    });
  }

  openWith(panelId: string): void {
    const current = this.snapshot;
    const openWith = current.openWith;
    if (!openWith || !openWith.candidates.some((candidate) => candidate.id === panelId)) return;
    this.publish({
      ...current,
      chosenPanelId: current.chosenPanelId,
      cancelled: false,
      picker: {
        selectorKey: openWith.selectorKey,
        candidates: openWith.candidates,
        selectedPanelId: panelId,
        remember: false,
      },
    });
  }

  /** Remembers the active panel, or forgets it when it already is the remembered one. */
  toggleAlwaysUse(): void {
    const openWith = this.snapshot.openWith;
    if (!openWith) return;
    if (!openWith.remembered) {
      this.deps.remember(openWith.selectorKey, openWith.activePanelId);
      return;
    }
    // Forgetting must not move the tab off the panel it is showing.
    this.publish({ ...this.snapshot, chosenPanelId: openWith.activePanelId });
    this.deps.remember(openWith.selectorKey, null);
  }

  private publish(next: FilePanelChoiceSnapshot<Candidate>): void {
    const current = this.snapshot;
    if (
      current.targetKey === next.targetKey &&
      current.chosenPanelId === next.chosenPanelId &&
      current.cancelled === next.cancelled &&
      current.picker === next.picker &&
      current.openWith === next.openWith
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

function openWithState<Candidate extends FilePanelCandidate>(
  resolution: FilePanelResolution<Candidate> | null,
): FilePanelOpenWithState<Candidate> | null {
  if (!resolution?.panel || resolution.candidates.length < 2) return null;
  return {
    selectorKey: resolution.selectorKey,
    candidates: resolution.candidates,
    activePanelId: resolution.panel.id,
    remembered: resolution.associatedPanelId === resolution.panel.id,
  };
}

/** Keeps the published object when nothing in it changed, so subscribers do not re-render. */
function stableOpenWith<Candidate>(
  current: FilePanelOpenWithState<Candidate> | null,
  next: FilePanelOpenWithState<Candidate> | null,
): FilePanelOpenWithState<Candidate> | null {
  if (!current || !next) return next;
  const same =
    current.selectorKey === next.selectorKey &&
    current.activePanelId === next.activePanelId &&
    current.remembered === next.remembered &&
    current.candidates.length === next.candidates.length &&
    current.candidates.every((candidate, index) => candidate === next.candidates[index]);
  return same ? current : next;
}

/**
 * @vitest-environment jsdom
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  acknowledgeExplorerReveal,
  claimExplorerReveal,
  requestExplorerReveal,
  useExplorerReveal,
} from "./reveal";

const workspaceKey = "server:workspace";
const statuses: string[] = [];
const recordRevealStatus = (status: "revealed" | "cancelled") => statuses.push(status);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({
  revision,
  listing,
  onSettled,
}: {
  revision: number;
  listing: Promise<void>;
  onSettled(status: "revealed" | "cancelled"): void;
}) {
  const request = useExplorerReveal(workspaceKey);
  useEffect(() => {
    if (!request) return;
    const claimed = claimExplorerReveal(workspaceKey, request.id);
    if (!claimed) return;
    let cancelled = false;
    void (async () => {
      await listing;
      const status = cancelled ? "cancelled" : "revealed";
      acknowledgeExplorerReveal(workspaceKey, claimed.id, status);
      onSettled(status);
    })();
    return () => {
      cancelled = true;
      acknowledgeExplorerReveal(workspaceKey, claimed.id, "cancelled");
    };
  }, [listing, onSettled, request]);
  return <span>{revision}</span>;
}

describe("useExplorerReveal ownership", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
  });

  it("keeps a claimed request through a rerender while its listing is pending", async () => {
    let resolveListing!: () => void;
    const listing = new Promise<void>((resolve) => {
      resolveListing = resolve;
    });
    statuses.length = 0;
    const pending = requestExplorerReveal({
      workspaceKey,
      path: "src/index.ts",
      intent: "explicit",
      ttlMs: 30_000,
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<Probe revision={0} listing={listing} onSettled={recordRevealStatus} />);
    });
    // A directory-listing store update normally rerenders the owning pane here.
    act(() => {
      root?.render(<Probe revision={1} listing={listing} onSettled={recordRevealStatus} />);
    });
    resolveListing();
    await act(async () => {
      await listing;
    });

    await expect(pending.result).resolves.toBe("revealed");
    expect(statuses).toEqual(["revealed"]);
  });
});

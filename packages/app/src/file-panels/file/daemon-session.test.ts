import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createDaemonFileSession } from "./daemon-session";

const target = { cwd: "/repo", path: "src/index.ts" };
const ready = {
  status: "ready" as const,
  cwd: "/repo",
  path: "src/index.ts",
  size: 12,
  modifiedAt: "2026-01-01T00:00:00.000Z",
  revision: "r1",
  kind: "text" as const,
  mime: "text/plain",
};

describe("daemon file session classification fallback", () => {
  it("reads only a bounded sample when the daemon cannot observe files", async () => {
    const readFile = vi.fn(async () => ready);
    const session = createDaemonFileSession({ readFile } as unknown as DaemonClient, {
      workspaceFileEditing: false,
      fileByteWrites: false,
    });

    const observation = await session.observe(target, () => undefined);

    expect(observation.initial).toMatchObject({ status: "ready", kind: "text" });
    expect(readFile).toHaveBeenCalledWith(target.cwd, target.path, undefined, 8 * 1024);
  });

  it("bounds the legacy kind fallback after a version without a kind", async () => {
    const readFile = vi.fn(async () => ready);
    const unsubscribe = vi.fn(async () => undefined);
    const subscribeFile = vi.fn(async () => ({
      initial: { ...ready, kind: undefined, mime: undefined },
      unsubscribe,
    }));
    const session = createDaemonFileSession(
      { readFile, subscribeFile } as unknown as DaemonClient,
      { workspaceFileEditing: true, fileByteWrites: false },
    );

    const observation = await session.observe(target, () => undefined);

    expect(observation.initial).toMatchObject({ status: "ready", kind: "text" });
    expect(readFile).toHaveBeenCalledWith(target.cwd, target.path, undefined, 8 * 1024);
    observation.unsubscribe();
    expect(unsubscribe).toHaveBeenCalled();
  });
});

import { afterEach, expect, test } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import type { UserMessageItem } from "@/types/stream";
import { createMessageSubmissionWriter } from "./writer";

const CANONICAL_ONLY_SERVER_ID = "canonical-only";
const LEGACY_SERVER_ID = "legacy-presentation";

function submittedMessage(clientMessageId: string): UserMessageItem {
  return {
    kind: "user_message",
    id: clientMessageId,
    clientMessageId,
    text: "hello",
    timestamp: new Date("2026-07-31T10:00:00.000Z"),
  };
}

function initializeSession(serverId: string, features: Record<string, boolean>): void {
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  store.updateSessionServerInfo(serverId, {
    serverId,
    hostname: null,
    version: "0.2.6",
    features,
  });
}

function submissionIds(serverId: string): string[] {
  return (
    useSessionStore.getState().sessions[serverId]?.messageSubmissions.get("agent-1") ?? []
  ).map((submission) => submission.clientMessageId);
}

afterEach(() => {
  useSessionStore.getState().clearSession(CANONICAL_ONLY_SERVER_ID);
  useSessionStore.getState().clearSession(LEGACY_SERVER_ID);
});

test("tracks submissions when canonical prompts are supported", () => {
  initializeSession(CANONICAL_ONLY_SERVER_ID, { canonicalSubmittedPrompts: true });

  createMessageSubmissionWriter(CANONICAL_ONLY_SERVER_ID).begin(
    "agent-1",
    submittedMessage("canonical-only-message"),
  );

  expect(submissionIds(CANONICAL_ONLY_SERVER_ID)).toEqual(["canonical-only-message"]);
});

test("retires a successful legacy presentation without removing its local row", () => {
  initializeSession(LEGACY_SERVER_ID, { canonicalSubmittedPrompts: false });
  const writer = createMessageSubmissionWriter(LEGACY_SERVER_ID);
  writer.begin("agent-1", submittedMessage("legacy-wire-id"), {
    presentationToken: "legacy-token",
    ownerIdentity: "composer-owner",
    phase: "preparing",
    compatibility: "legacy",
  });

  expect(writer.promote?.("agent-1", "legacy-wire-id", "legacy-token")).toBe("promoted");
  writer.accept("agent-1", "legacy-wire-id", "legacy-token");
  writer.reject("agent-1", "legacy-wire-id", "stale-token");

  expect(submissionIds(LEGACY_SERVER_ID)).toEqual([]);
  expect(
    useSessionStore.getState().sessions[LEGACY_SERVER_ID]?.agentStreamTail.get("agent-1"),
  ).toMatchObject([{ clientMessageId: "legacy-wire-id", text: "hello" }]);
});

test("keeps a remounted legacy preparation when an older delayed rejection reuses its wire id", () => {
  initializeSession(LEGACY_SERVER_ID, { canonicalSubmittedPrompts: false });
  const firstWriter = createMessageSubmissionWriter(LEGACY_SERVER_ID);
  firstWriter.begin("agent-1", submittedMessage("legacy-reused-wire-id"), {
    presentationToken: "attempt-a",
    ownerIdentity: "composer-a",
    phase: "preparing",
    compatibility: "legacy",
  });

  expect(firstWriter.abort?.("agent-1", "legacy-reused-wire-id", "attempt-a")).toBe("rejected");

  // The host remounts after A's preparation ended. B owns the same
  // deterministic id, so a late error from A must not remove B's row.
  const remountedWriter = createMessageSubmissionWriter(LEGACY_SERVER_ID);
  remountedWriter.begin("agent-1", submittedMessage("legacy-reused-wire-id"), {
    presentationToken: "attempt-b",
    ownerIdentity: "composer-b",
    phase: "preparing",
    compatibility: "legacy",
  });
  expect(remountedWriter.reject("agent-1", "legacy-reused-wire-id", "attempt-a")).toBe("stale");

  expect(submissionIds(LEGACY_SERVER_ID)).toEqual(["legacy-reused-wire-id"]);
  expect(
    useSessionStore.getState().sessions[LEGACY_SERVER_ID]?.agentStreamTail.get("agent-1"),
  ).toMatchObject([{ clientMessageId: "legacy-reused-wire-id", text: "hello" }]);
});

import { describe, expect, it } from "vitest";
import {
  acceptMessageSubmission,
  abortMessageSubmission,
  beginMessageSubmission,
  getPreparingClientMessageIds,
  getActiveMessageSubmissions,
  getSendingClientMessageIds,
  hasActiveMessageSubmission,
  findMessageSubmissionPresentation,
  observeMessageSubmissionCanonical,
  promoteMessageSubmission,
  rejectMessageSubmission,
} from "./model";

describe("message submission transactions", () => {
  it("tracks every in-flight submission independently", () => {
    const first = beginMessageSubmission([], { clientMessageId: "client-1" });
    const both = beginMessageSubmission(first, { clientMessageId: "client-2" });

    expect(getActiveMessageSubmissions(both).map((item) => item.clientMessageId)).toEqual([
      "client-1",
      "client-2",
    ]);
    expect(getSendingClientMessageIds(both)).toEqual(["client-1", "client-2"]);
  });

  it("settles only the accepted transaction on RPC acceptance", () => {
    const both = beginMessageSubmission(
      beginMessageSubmission([], { clientMessageId: "client-1" }),
      { clientMessageId: "client-2" },
    );
    const acknowledged = observeMessageSubmissionCanonical(both, ["client-1"]);

    expect(acceptMessageSubmission(acknowledged, "client-1")).toEqual([
      {
        clientMessageId: "client-2",
        providerAcknowledged: false,
        rpcSettled: false,
      },
    ]);
  });

  it("keeps activity until an accepted RPC's canonical row is observed", () => {
    const sending = beginMessageSubmission([], { clientMessageId: "client-1" });
    const accepted = acceptMessageSubmission(sending, "client-1");

    expect(accepted).toEqual([
      {
        clientMessageId: "client-1",
        providerAcknowledged: false,
        rpcSettled: true,
      },
    ]);
    expect(getActiveMessageSubmissions(accepted).map((item) => item.clientMessageId)).toEqual([
      "client-1",
    ]);
    expect(observeMessageSubmissionCanonical(accepted, ["client-1"])).toEqual([]);
  });

  it("reports activity until every submission is provider acknowledged", () => {
    const both = beginMessageSubmission(
      beginMessageSubmission([], { clientMessageId: "client-1" }),
      { clientMessageId: "client-2" },
    );
    const oneAcknowledged = observeMessageSubmissionCanonical(both, ["client-1"]);

    expect(hasActiveMessageSubmission(undefined)).toBe(false);
    expect(hasActiveMessageSubmission(both)).toBe(true);
    expect(hasActiveMessageSubmission(oneAcknowledged)).toBe(true);
    expect(
      hasActiveMessageSubmission(observeMessageSubmissionCanonical(oneAcknowledged, ["client-2"])),
    ).toBe(false);
  });

  it("keeps a legacy lease fenced without presenting an agent turn", () => {
    const legacy = beginMessageSubmission([], {
      clientMessageId: "legacy-wire-id",
      presentation: {
        presentationToken: "legacy-attempt",
        ownerIdentity: "composer-a",
        phase: "dispatching",
        compatibility: "legacy",
      },
    });

    expect(getActiveMessageSubmissions(legacy)).toEqual([]);
    expect(getSendingClientMessageIds(legacy)).toEqual(["legacy-wire-id"]);
    expect(hasActiveMessageSubmission(legacy)).toBe(false);
  });

  it("presents a canonical lease only after durable promotion", () => {
    const preparing = beginMessageSubmission([], {
      clientMessageId: "canonical-wire-id",
      presentation: {
        presentationToken: "canonical-attempt",
        ownerIdentity: "composer-a",
        phase: "preparing",
        compatibility: "canonical",
      },
    });

    expect(getPreparingClientMessageIds(preparing)).toEqual(["canonical-wire-id"]);
    expect(hasActiveMessageSubmission(preparing)).toBe(false);

    const dispatching = promoteMessageSubmission(preparing, {
      clientMessageId: "canonical-wire-id",
      presentationToken: "canonical-attempt",
    });
    expect(getActiveMessageSubmissions(dispatching).map((item) => item.clientMessageId)).toEqual([
      "canonical-wire-id",
    ]);

    const acknowledged = observeMessageSubmissionCanonical(dispatching, ["canonical-wire-id"]);
    expect(hasActiveMessageSubmission(acknowledged)).toBe(false);
    expect(findMessageSubmissionPresentation(acknowledged, "composer-a")).toMatchObject({
      phase: "dispatching",
      compatibility: "canonical",
    });
  });

  it("keeps a dispatching lease addressable after canonical acknowledgement", () => {
    const dispatching = beginMessageSubmission([], {
      clientMessageId: "canonical-wire-id",
      presentation: {
        presentationToken: "canonical-attempt",
        ownerIdentity: "composer-a",
        phase: "dispatching",
        compatibility: "canonical",
      },
    });
    const observed = observeMessageSubmissionCanonical(dispatching, ["canonical-wire-id"]);

    expect(findMessageSubmissionPresentation(observed, "composer-a")).toMatchObject({
      presentationToken: "canonical-attempt",
      phase: "dispatching",
    });
  });

  it("records provider acknowledgement without settling another transaction", () => {
    const both = beginMessageSubmission(
      beginMessageSubmission([], { clientMessageId: "client-1" }),
      { clientMessageId: "client-2" },
    );
    const observed = observeMessageSubmissionCanonical(both, ["client-1"]);

    expect(observed).toEqual([
      {
        clientMessageId: "client-1",
        providerAcknowledged: true,
        rpcSettled: false,
      },
      {
        clientMessageId: "client-2",
        providerAcknowledged: false,
        rpcSettled: false,
      },
    ]);
    expect(getSendingClientMessageIds(observed)).toEqual(["client-2"]);
  });

  it("does not roll back a provider-acknowledged prompt on a later transport error", () => {
    const sending = beginMessageSubmission([], { clientMessageId: "client-1" });
    const observed = observeMessageSubmissionCanonical(sending, ["client-1"]);

    expect(rejectMessageSubmission(observed, "client-1")).toEqual({
      outcome: "accepted",
      submissions: [],
    });
  });

  it("keeps a canonical-promotion collision fenced against stale terminal callbacks", () => {
    const collision = [
      {
        clientMessageId: "stable-wire-id",
        providerAcknowledged: true,
        rpcSettled: false,
        canonicalObservedAtPromotion: true,
        presentation: {
          presentationToken: "attempt-b",
          ownerIdentity: "composer-b",
          phase: "dispatching" as const,
          compatibility: "canonical" as const,
        },
      },
    ];

    expect(acceptMessageSubmission(collision, "stable-wire-id", "attempt-b")).toBe(collision);
    expect(hasActiveMessageSubmission(collision)).toBe(false);
    expect(findMessageSubmissionPresentation(collision, "composer-b")).toBeNull();
    expect(rejectMessageSubmission(collision, "stable-wire-id", "attempt-b")).toEqual({
      outcome: "stale",
      submissions: collision,
    });
    expect(
      abortMessageSubmission(collision, {
        clientMessageId: "stable-wire-id",
        presentationToken: "attempt-b",
      }),
    ).toEqual({ outcome: "stale", submissions: collision });
  });

  it("rejects an unacknowledged transaction", () => {
    const sending = beginMessageSubmission([], { clientMessageId: "client-1" });

    expect(rejectMessageSubmission(sending, "client-1")).toEqual({
      outcome: "rejected",
      submissions: [],
    });
  });

  it("does not create duplicate transaction identity", () => {
    const sending = beginMessageSubmission([], { clientMessageId: "client-1" });

    expect(() => beginMessageSubmission(sending, { clientMessageId: "client-1" })).toThrow(
      "Message submission already exists",
    );
  });

  it("does not let a wire-id-only canonical acknowledgement consume a newer preparation", () => {
    const preparing = beginMessageSubmission([], {
      clientMessageId: "stable-wire-id",
      presentation: {
        presentationToken: "attempt-b",
        ownerIdentity: "composer-b",
        phase: "preparing",
        compatibility: "canonical",
      },
    });

    expect(getPreparingClientMessageIds(preparing)).toEqual(["stable-wire-id"]);
    expect(observeMessageSubmissionCanonical(preparing, ["stable-wire-id"])).toBe(preparing);
    expect(rejectMessageSubmission(preparing, "stable-wire-id", "attempt-a")).toEqual({
      outcome: "stale",
      submissions: preparing,
    });
  });

  it("retires only the exact legacy presentation after RPC success while retaining its row", () => {
    const preparing = beginMessageSubmission([], {
      clientMessageId: "legacy-wire-id",
      presentation: {
        presentationToken: "legacy-attempt",
        ownerIdentity: "composer-a",
        phase: "preparing",
        compatibility: "legacy",
      },
    });
    const dispatching = promoteMessageSubmission(preparing, {
      clientMessageId: "legacy-wire-id",
      presentationToken: "legacy-attempt",
    });

    expect(acceptMessageSubmission(dispatching, "legacy-wire-id", "legacy-attempt")).toEqual([]);
    expect(rejectMessageSubmission(dispatching, "legacy-wire-id", "old-attempt")).toEqual({
      outcome: "stale",
      submissions: dispatching,
    });
  });
});

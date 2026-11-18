import { createPaseoApi } from "@getpaseo/client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { expect, test, vi } from "vitest";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

test("passive native snapshots distinguish residency without loading or replaying history", async () => {
  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    agentClients: createTestAgentClients({
      historyEvents: [
        {
          type: "provider_subagent",
          provider: "codex",
          event: { type: "upsert", id: "native-child", title: "Review", status: "completed" },
        },
        {
          type: "provider_subagent",
          provider: "codex",
          event: {
            type: "timeline",
            id: "native-child",
            item: { type: "assistant_message", text: "Old output" },
          },
        },
      ],
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    const parent = await client.createAgent({ provider: "codex", cwd: daemon.staticDir });
    const manager = daemon.daemon.agentManager;
    const create = vi.spyOn(manager, "createAgent");
    const resume = vi.spyOn(manager, "resumeAgentFromPersistence");
    const hydrate = vi.spyOn(manager, "hydrateTimelineFromProvider");
    const handle = api.agents.ref(parent.id);
    const empty = await handle.providerSubagents.snapshot();
    expect(empty).toMatchObject({ availability: "resident", subagents: [] });
    expect(create).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();

    const messages: SessionOutboundMessage[] = [];
    const observation = api.observeEvents(["agent.provider_subagents.update"]);
    observation.subscribe({ snapshot: () => {}, update: (message) => messages.push(message) });
    await observation.ready;
    // A different consumer hydrates quietly. Roster changes still reach the observer.
    await manager.hydrateTimelineFromProvider(parent.id, { force: true });
    await expect.poll(() => messages.length).toBeGreaterThan(0);
    const populated = await handle.providerSubagents.snapshot();
    expect(populated.availability).toBe("resident");
    expect(populated.subagents).toMatchObject([{ id: "native-child", status: "completed" }]);
    expect(populated.cursor.revision).toBeGreaterThan(empty.cursor.revision);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent.provider_subagents.update",
          payload: expect.objectContaining({
            kind: "upsert",
            replayed: true,
            cursor: populated.cursor,
          }),
        }),
      ]),
    );
    expect(
      messages.some(
        (message) =>
          message.type === "agent.provider_subagents.update" && message.payload.kind === "timeline",
      ),
    ).toBe(false);

    await manager.closeAgent(parent.id);
    hydrate.mockClear();
    for (let index = 0; index < 3; index++) {
      expect(await handle.providerSubagents.snapshot()).toMatchObject({
        parentAgentId: parent.id,
        availability: "not_resident",
        subagents: [],
      });
    }
    expect(manager.getAgent(parent.id)).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
    await expect(api.agents.ref("missing").providerSubagents.snapshot()).rejects.toThrow(
      "Agent not found",
    );
    await manager.archiveSnapshot(parent.id, new Date().toISOString());
    await expect(handle.providerSubagents.snapshot()).rejects.toThrow("Agent is archived");
    const internal = await manager.createAgent(
      { provider: "codex", cwd: daemon.staticDir, internal: true },
      undefined,
      { workspaceId: undefined },
    );
    await expect(api.agents.ref(internal.id).providerSubagents.snapshot()).rejects.toThrow(
      "Agent not found",
    );
  } finally {
    vi.restoreAllMocks();
    await api.dispose();
    await client.close();
    await daemon.close();
  }
});

test("passive snapshot rechecks residency after asynchronous metadata lookup", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const parent = await client.createAgent({ provider: "codex", cwd: daemon.staticDir });
    const storage = daemon.daemon.agentStorage;
    const originalGet = storage.get.bind(storage);
    let arrived = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookup = vi.spyOn(storage, "get").mockImplementation(async (id) => {
      const record = await originalGet(id);
      if (id === parent.id && !arrived) {
        arrived = true;
        await gate;
      }
      return record;
    });
    const pending = client.snapshotProviderSubagents(parent.id);
    await expect.poll(() => arrived).toBe(true);
    await daemon.daemon.agentManager.closeAgent(parent.id);
    release();
    expect(await pending).toMatchObject({ availability: "not_resident", subagents: [] });
    lookup.mockRestore();
  } finally {
    vi.restoreAllMocks();
    await client.close();
    await daemon.close();
  }
});

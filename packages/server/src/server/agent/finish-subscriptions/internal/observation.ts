import type { Logger } from "pino";
import type { AgentManager } from "../../agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../../agent-storage.js";
import type { AgentMessageDelivery } from "../../agent-messages/index.js";
import { buildStoredAgentPayload } from "../../agent-projections.js";
import { serializeSnapshotWithMetadata } from "../../mcp-shared.js";
import { createHostObservationResolver, type ToolHosts } from "../../host-operations/index.js";
import { openFinishObservation } from "./observation-stream.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { FinishObservation } from "../index.js";

export function createFinishObservation(input: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  /** A child chosen for restart recovery reports its state only after its resume was sent. */
  waitForResume(agentId: string, signal: AbortSignal): Promise<void>;
  messages(): AgentMessageDelivery;
  hosts(): ToolHosts;
  serverId: string;
  logger: Logger;
}): FinishObservation {
  const { agentManager, agentStorage } = input;

  async function serializeStoredSnapshot(
    record: StoredAgentRecord | null,
  ): Promise<AgentSnapshotPayload | null> {
    if (!record) return null;
    const archiveOperation = await agentManager.getArchiveOperation(record.id);
    return buildStoredAgentPayload(record, [record.provider], { archiveOperation });
  }

  async function serializeCurrentSnapshot(agentId: string): Promise<AgentSnapshotPayload | null> {
    const live = agentManager.getAgent(agentId);
    if (live) {
      const archiveOperation = await agentManager.getArchiveOperation(agentId);
      // Do not publish the event's captured managed-agent object after an async
      // summary lookup. Re-read resident state so this queued callback always
      // reflects the newest authoritative lifecycle snapshot.
      const current = agentManager.getAgent(agentId);
      if (current) {
        return serializeSnapshotWithMetadata(agentStorage, current, input.logger, {
          archiveOperation,
        });
      }
    }
    return serializeStoredSnapshot(await agentStorage.get(agentId));
  }

  const resolver = createHostObservationResolver({
    serverId: input.serverId,
    hosts: input.hosts,
    local: {
      async wait(agentId, signal) {
        await input.waitForResume(agentId, signal);
        await input.messages().waitForDispatch(agentId, signal);
        signal.throwIfAborted();
        const live = agentManager.getAgent(agentId);
        if (!live) {
          const stored = await agentStorage.get(agentId);
          return {
            status: stored?.lastStatus === "error" ? "error" : "idle",
            final: await serializeStoredSnapshot(stored),
            lastMessage: await agentManager.getLastAssistantMessage(agentId),
            error: stored?.lastError ?? null,
          };
        }
        const result = await agentManager.waitForAgentEvent(agentId, {
          signal,
          waitForActive: true,
        });
        const current = agentManager.getAgent(agentId);
        const status = result.permission ? "permission" : result.status;
        return {
          status: status === "permission" || status === "error" ? status : "idle",
          final: current ? await serializeCurrentSnapshot(agentId) : null,
          lastMessage: result.lastMessage,
          error: current?.lastError ?? null,
        };
      },
      async observe(agentId, handler, signal, onError) {
        await input.waitForResume(agentId, signal);
        let updates = Promise.resolve();
        const publishCurrent = (event?: AgentStreamEvent) => {
          updates = updates
            .then(async () => {
              if (signal.aborted) return undefined;
              const snapshot = await serializeCurrentSnapshot(agentId);
              if (signal.aborted) return undefined;
              const lastMessage = await agentManager.getLastAssistantMessage(agentId);
              if (signal.aborted) return undefined;
              handler(snapshot, event, lastMessage);
              return undefined;
            })
            .catch((error) => {
              if (!signal.aborted) onError(error);
              return undefined;
            });
        };
        signal.throwIfAborted();
        const unsubscribe = agentManager.subscribe(
          (event) => {
            if (event.type === "agent_state") {
              // Recovery summaries can change while a retained archive parent
              // remains idle. They must take the same ordered, fresh projection
              // path as every other manager state update.
              publishCurrent();
            } else if (
              event.type === "agent_stream" &&
              [
                "permission_requested",
                "permission_resolved",
                "turn_started",
                "turn_completed",
                "turn_canceled",
                "turn_failed",
              ].includes(event.event.type)
            ) {
              const current = agentManager.getAgent(agentId);
              if (current) publishCurrent(event.event);
            }
          },
          { agentId, replayState: false },
        );
        const stop = () => unsubscribe();
        signal.addEventListener("abort", stop, { once: true });
        return async () => {
          signal.removeEventListener("abort", stop);
          unsubscribe();
        };
      },
    },
  });
  return { open: (record, signal) => openFinishObservation(resolver, record, signal) };
}

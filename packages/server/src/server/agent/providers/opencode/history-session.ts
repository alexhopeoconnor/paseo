import type {
  AgentCapabilityFlags,
  AgentPersistenceHandle,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentStreamEvent,
} from "../../agent-sdk-types.js";

/** A saved transcript owns no interactive connection or native execution. */
export class OpenCodeHistorySession implements AgentSession {
  readonly provider = "opencode";

  constructor(
    private readonly handle: AgentPersistenceHandle,
    readonly capabilities: AgentCapabilityFlags,
    private readonly runtimeInfo: AgentRuntimeInfo,
    private readonly history: readonly AgentStreamEvent[],
  ) {}

  get id() {
    return this.handle.sessionId;
  }

  async run(): Promise<AgentRunResult> {
    throw new Error("OpenCode history session cannot start a turn");
  }

  async startTurn(): Promise<{ turnId: string }> {
    throw new Error("OpenCode history session cannot start a turn");
  }

  subscribe() {
    return () => undefined;
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    yield* this.history;
  }

  async getRuntimeInfo() {
    return this.runtimeInfo;
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return this.runtimeInfo.modeId ?? null;
  }

  async setMode(): Promise<void> {
    throw new Error("OpenCode history session cannot change mode");
  }

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {
    throw new Error("OpenCode history session has no pending permissions");
  }

  describePersistence() {
    return this.handle;
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

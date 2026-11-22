/** Private durable metadata; keep it in storage, outside session config and public projections. */
export const ARCHIVE_STOP_PENDING_METADATA_KEY = "paseoArchiveStopPending";
export const DETACHED_NATIVE_PARENT_AGENT_ID_METADATA_KEY = "paseoDetachedNativeParentAgentId";
export const OPENCODE_V2_SERVICE_IDENTITY_METADATA_KEY = "paseoOpenCodeV2ServiceIdentity";

export const PRIVATE_PERSISTENCE_METADATA_KEYS = [
  ARCHIVE_STOP_PENDING_METADATA_KEY,
  DETACHED_NATIVE_PARENT_AGENT_ID_METADATA_KEY,
  OPENCODE_V2_SERVICE_IDENTITY_METADATA_KEY,
] as const;

export const PRIVATE_WIRE_PERSISTENCE_METADATA_KEYS = [
  ...PRIVATE_PERSISTENCE_METADATA_KEYS,
  "mcpServers",
  "pluginAppendSystemPrompt",
  "daemonAppendSystemPrompt",
  "paseoInstructionReceipt",
] as const;

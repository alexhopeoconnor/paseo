import type { AgentMetadata } from "../../../agent-sdk-types.js";

/**
 * Private persistence metadata. It identifies the OpenCode service that owns
 * a native session without exposing credentials or changing session config.
 */
export const OPENCODE_V2_SERVICE_IDENTITY_METADATA_KEY = "paseoOpenCodeV2ServiceIdentity";

export function readOpenCodeV2ServiceIdentity(metadata: AgentMetadata | undefined): string | null {
  const identity = metadata?.[OPENCODE_V2_SERVICE_IDENTITY_METADATA_KEY];
  return typeof identity === "string" && identity.length > 0 ? identity : null;
}

export function withOpenCodeV2ServiceIdentity(
  metadata: AgentMetadata,
  identity: string | undefined,
): AgentMetadata {
  if (!identity) return { ...metadata };
  return { ...metadata, [OPENCODE_V2_SERVICE_IDENTITY_METADATA_KEY]: identity };
}

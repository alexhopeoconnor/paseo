import { createPlayAudio, type AudioEngine } from "@/audio";
import { getPluginClientApi } from "./client-state/api";
import type {
  PluginClientOpenPanelOptions,
  PluginFileRevealOptions,
  PluginFileRevealOutcome,
  PluginFileRevealRequest,
} from "@getpaseo/plugin/client";
import { subscribePluginRpc } from "@getpaseo/plugin/client/host";
import {
  createPluginAgentActionContext,
  createPluginCapabilities,
  createPluginWorkspaceActionContext,
} from "./actions";
import { createPluginClientStateSource } from "./client-state/source";
import type { PluginClientRuntime } from "./evaluate";
import { createPluginNavigation } from "./navigation";
import { pluginButtonStore } from "./buttons";
import { getFileOpenRequest } from "@/workspace/file-open/requests";
import { revealWorkspaceFile } from "@/workspace/file-open/reveal";
import { resolveFileOpenPanelPlacement } from "./workspace-panels/placement";
import type { InstalledPlugin } from "./types";

export function createPluginClientRuntime(
  installation: InstalledPlugin,
  audio: Pick<AudioEngine, "play">,
): PluginClientRuntime {
  const state = createPluginClientStateSource(installation.serverId);
  const capabilities = createPluginCapabilities(
    installation,
    createPluginNavigation({ serverId: installation.serverId, workspaceId: null }),
  );
  return {
    ...capabilities,
    i18n: installation.i18n,
    playAudio: createPlayAudio(audio, installation.lifetime.signal),
    hosts: getPluginClientApi(installation).hosts,
    addComposerPill(contribution) {
      return pluginButtonStore.addComposerPill(installation, contribution);
    },
    addHeaderButton(contribution) {
      return pluginButtonStore.addHeaderButton(installation, contribution);
    },
    openPanel(panelId, options) {
      openClientPanel({ installation, state, panelId, options });
    },
    subscribe: (contract, input, onEvent, options) =>
      subscribePluginRpc(contract, installation.subscribe, input, onEvent, options),
    revealFile(
      request: PluginFileRevealRequest,
      options?: PluginFileRevealOptions,
    ): Promise<PluginFileRevealOutcome> {
      return revealWorkspaceFile({ serverId: installation.serverId, request, options });
    },
  };
}

function openClientPanel(input: {
  installation: InstalledPlugin;
  state: ReturnType<typeof createPluginClientStateSource>;
  panelId: string;
  options: PluginClientOpenPanelOptions;
}): void {
  const { installation, state, panelId, options } = input;
  const workspaceId = options.workspaceId.trim();
  const agentId = options.agentId?.trim();
  const request = options.requestId ? getFileOpenRequest(options.requestId) : null;
  if (
    options.requestId &&
    (!request || request.hostId !== installation.serverId || request.workspaceId !== workspaceId)
  ) {
    return;
  }
  const navigation = createPluginNavigation({ serverId: installation.serverId, workspaceId });
  const action = agentId
    ? createPluginAgentActionContext({
        plugin: installation,
        navigation,
        state,
        workspaceId,
        agentId,
      })
    : createPluginWorkspaceActionContext({
        plugin: installation,
        navigation,
        state,
        workspaceId,
      });
  if (!action) throw new Error("Plugin panel context is unavailable");
  const panel = installation.workspacePanels.find((candidate) => candidate.id === panelId);
  const target =
    panel?.context === "agent" && agentId
      ? {
          kind: "plugin" as const,
          pluginId: installation.id,
          panelId,
          context: "agent" as const,
          agentId,
        }
      : {
          kind: "plugin" as const,
          pluginId: installation.id,
          panelId,
          context: "workspace" as const,
        };
  action.openPanel(
    panelId,
    { location: options.location },
    request ? resolveFileOpenPanelPlacement({ request, target }) : undefined,
  );
}

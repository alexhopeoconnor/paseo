import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { getPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { getFilePanelChoice } from "@/file-panels/choice/registry";
import { confirmFilePanelReplacement } from "@/file-panels/choice/model";
import { confirmDialog } from "@/utils/confirm-dialog";
import { i18n } from "@/i18n/i18next";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useFilePanelCatalogReady, useFilePanels } from "@/file-panels/panels";
import { useFilePanelAssociations } from "@/file-panels/associations";
import type { FilePanelChoice } from "@/file-panels/choice/hook";
import { createDaemonFileSession } from "@/file-panels/file/daemon-session";
import { resolvePluginPlatform } from "@/plugins/platform";
import { generateMessageId } from "@/types/stream";
import { useToast } from "@/contexts/toast-context";
import { WorkspaceFileOpenDispatcher, type FileOpenOutcome } from "./dispatch";
import type { WorkspaceFileOpenRequest, WorkspaceFileTabTarget } from ".";

export type OpenConfirmedWorkspaceFile = (
  request: WorkspaceFileOpenRequest,
  render: (target: WorkspaceFileTabTarget) => void,
) => Promise<FileOpenOutcome>;
export const WorkspaceFileDispatchContext = createContext<OpenConfirmedWorkspaceFile | null>(null);

export function useWorkspaceFileOpen(input: {
  serverId: string;
  workspaceId: string;
  workspaceDirectory: string | null;
}) {
  const { serverId, workspaceId, workspaceDirectory } = input;
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const catalogReady = useFilePanelCatalogReady(serverId);
  const workspaceFileEditing = useHostFeature(serverId, "workspaceFileEditing");
  const fileByteWrites = useHostFeature(serverId, "fileByteWrites");
  const panels = useFilePanels(serverId);
  const { associations, remember } = useFilePanelAssociations();
  const current = useRef({ panels, associations, remember });
  current.current = { panels, associations, remember };
  const [choice, present] = useState<FilePanelChoice | null>(null);
  const toast = useToast();
  const [scope, setScope] = useState<{
    dispatcher: WorkspaceFileOpenDispatcher;
    client: typeof client;
    serverId: string;
    workspaceId: string;
    directory: string;
  } | null>(null);
  const dispatcher =
    scope &&
    scope.client === client &&
    scope.serverId === serverId &&
    scope.workspaceId === workspaceId &&
    scope.directory === workspaceDirectory
      ? scope.dispatcher
      : null;
  useEffect(() => {
    if (!client || !connected || !workspaceDirectory || !catalogReady) {
      setScope(null);
      return;
    }
    const session = createDaemonFileSession(client, { workspaceFileEditing, fileByteWrites });
    const next = new WorkspaceFileOpenDispatcher({
      hostId: serverId,
      workspaceId,
      workspaceDirectory,
      platform: resolvePluginPlatform(),
      requestId: generateMessageId,
      async stat(path, signal) {
        const target = resolveFilePreviewReadTarget({ path, workspaceRoot: workspaceDirectory });
        if (!target) throw new Error("The file path could not be resolved.");
        const observation = await session.observe(target, () => {});
        observation.unsubscribe();
        if (signal.aborted) throw new Error("File opening was cancelled.");
        if (observation.initial.status !== "ready")
          throw new Error(
            observation.initial.status === "error"
              ? observation.initial.error
              : "The file was not found.",
          );
        return observation.initial.kind;
      },
      panels: () => current.current.panels,
      associations: () => current.current.associations,
      remember: (selectorKey, panelId) => current.current.remember(selectorKey, panelId),
      present,
      confirmReplacement(location, panelId, open) {
        const workspaceKey = `${serverId}:${workspaceId}`;
        const store = useWorkspaceLayoutStore.getState();
        const layout = store.layoutByWorkspace[workspaceKey];
        const tabs = [
          ...(layout ? collectAllTabs(layout.root) : []),
          ...(store.sheetsByWorkspace[workspaceKey] ?? []).map((sheet) => sheet.tab),
        ];
        const tab = tabs.find(
          (entry) => entry.target.kind === "file" && entry.target.path === location.path,
        );
        if (!tab || tab.target.kind !== "file") return open();
        const identity = { serverId, workspaceId, tabId: tab.tabId };
        const currentPanelId =
          getFilePanelChoice(identity)?.getSnapshot().openWith?.activePanelId ?? tab.target.panelId;
        if (currentPanelId === panelId) return open();
        const attributes = getPanelInstanceAttributes(identity);
        return confirmFilePanelReplacement({
          ...attributes,
          confirmDiscard: () =>
            confirmDialog({
              title: i18n.t("workspace.tabs.confirmations.unsavedTitle"),
              message: i18n.t("workspace.tabs.confirmations.unsavedMessage"),
              confirmLabel: i18n.t("workspace.tabs.confirmations.closeWithoutSaving"),
              cancelLabel: i18n.t("workspace.tabs.confirmations.cancel"),
              destructive: true,
            }),
          open,
        });
      },
    });
    setScope({ dispatcher: next, client, serverId, workspaceId, directory: workspaceDirectory });
    return () => next.dispose();
  }, [
    client,
    connected,
    workspaceDirectory,
    catalogReady,
    serverId,
    workspaceId,
    workspaceFileEditing,
    fileByteWrites,
  ]);
  const open = useCallback<OpenConfirmedWorkspaceFile>(
    async (request, render) => {
      if (!dispatcher || !client || !connected || !workspaceDirectory || !catalogReady) {
        toast.error(
          "The workspace and its file viewers are still connecting. Try again when the host is ready.",
        );
        return "cancelled";
      }
      return dispatcher.open(request, render).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
        return "cancelled" as const;
      });
    },
    [dispatcher, toast, client, connected, workspaceDirectory, catalogReady],
  );
  return {
    open,
    choice,
    ready: dispatcher !== null && connected && catalogReady && workspaceDirectory !== null,
  };
}

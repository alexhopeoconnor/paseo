import { confirmFilePanelReplacement } from "@/file-panels/choice/model";
import { pluginSurfaceKey } from "@/plugins/surface-error-boundary";
import { WorkspaceFileDispatchContext } from "@/workspace/file-open/hook";
import { getPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { confirmDialog } from "@/utils/confirm-dialog";
import { usePaneContext } from "@/panels/pane-context";
import { useContext, useEffect, useMemo, useState } from "react";
import type { PluginFile, PluginTab } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFileHandle, useFileHandleSnapshot } from "@/file-panels/file";
import { FilePanelLoading } from "@/file-panels/loading";
import { FilePanelPicker, FilePanelView, useFilePanelChoice, type FilePanel } from "@/file-panels";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { usePublishPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { useSessionStore } from "@/stores/session-store";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { formatFileSize } from "@/utils/format-file-size";
import type { WorkspaceFileLocation } from "@/workspace/file-open";

/**
 * The file tab: stats the file, picks its panel and mounts it. The panel reads, saves and shows
 * its own loading; the tab only knows the file exists, its kind, and whether the panel has
 * unsaved changes.
 */
export function FilePane({
  serverId,
  workspaceRoot,
  location,
  navigationRevision,
  panelId,
}: {
  serverId: string;
  workspaceRoot: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  panelId?: string;
}) {
  const { t } = useTranslation();
  const identity = usePaneContext();
  const dispatchFile = useContext(WorkspaceFileDispatchContext);
  const connected = useSessionStore((state) => Boolean(state.sessions[serverId]?.client));
  const root = workspaceRoot.trim();
  const path = location.path.trim();
  const target = useMemo(
    () => (path ? resolveFilePreviewReadTarget({ path, workspaceRoot: root }) : null),
    [path, root],
  );
  const absolutePath = useMemo(
    () => buildAbsoluteExplorerPath({ workspaceRoot: root, entryPath: path }),
    [path, root],
  );
  // A hidden tab or a backgrounded app stops observing; observing again reports what changed.
  const isActive = useRetainedPanelActive();
  const isAppVisible = useAppActivelyVisible();
  const handle = useFileHandle({
    serverId,
    target,
    absolutePath,
    observing: isActive && isAppVisible,
  });
  const snapshot = useFileHandleSnapshot(handle);
  const resourceKey = target ? `${target.cwd}:${target.path}` : null;
  const targetKey = resourceKey ? `${resourceKey}:${panelId ?? ""}` : null;
  const { panel, choice, unresolved, confirmedPanelId } = useFilePanelChoice({
    serverId,
    panelId,
    targetKey,
    path,
    fileKind: snapshot.status === "ready" ? snapshot.kind : null,
    presentable: isActive,
    lineNavigation: location.lineStart ? navigationRevision : null,
    confirm(selectedPanelId) {
      if (dispatchFile)
        return dispatchFile(
          { location, disposition: "main", viewer: { kind: "panel", panelId: selectedPanelId } },
          () => {},
        );
      const attributes = getPanelInstanceAttributes(identity);
      return confirmFilePanelReplacement({
        ...attributes,
        confirmDiscard: () =>
          confirmDialog({
            title: t("workspace.tabs.confirmations.unsavedTitle"),
            message: t("workspace.tabs.confirmations.unsavedMessage"),
            confirmLabel: t("workspace.tabs.confirmations.closeWithoutSaving"),
            cancelLabel: t("workspace.tabs.confirmations.cancel"),
            destructive: true,
          }),
        open: async () => "render" as const,
      });
    },
  });
  const { target: tabTarget, retargetCurrentTab } = identity;
  useEffect(() => {
    if (confirmedPanelId && tabTarget.kind === "file" && tabTarget.panelId !== confirmedPanelId) {
      retargetCurrentTab({ ...tabTarget, panelId: confirmedPanelId });
    }
  }, [confirmedPanelId, tabTarget, retargetCurrentTab]);
  const panelLocation = useMemo(
    () => ({
      lineStart: location.lineStart,
      lineEnd: location.lineEnd,
      path,
    }),
    [location.lineEnd, location.lineStart, path],
  );

  let body;
  if (!connected && target) {
    body = <Text style={styles.errorText}>{t("workspace.terminal.hostDisconnected")}</Text>;
  } else if (!handle || snapshot.status === "loading") {
    return (
      <View style={styles.container} testID="workspace-file-pane">
        <FilePanelLoading />
      </View>
    );
  } else if (snapshot.status === "missing" || snapshot.status === "error") {
    body = (
      <>
        <Text style={styles.errorText}>
          {snapshot.status === "error" ? snapshot.error : t("panels.file.notFound")}
        </Text>
        <Button variant="outline" onPress={handle.retry}>
          {t("common.actions.retry")}
        </Button>
      </>
    );
  } else if (!panel && unresolved) {
    return (
      <View style={styles.container} testID="workspace-file-pane">
        <FilePanelPicker choice={choice} />
      </View>
    );
  } else if (!panel) {
    body = (
      <>
        <Text style={styles.mutedText}>{t("panels.file.binaryPreviewUnavailable")}</Text>
        <Text style={styles.mutedText}>{formatFileSize(snapshot.size)}</Text>
      </>
    );
  } else {
    return (
      <View style={styles.container} testID="workspace-file-pane">
        <FilePanelPicker choice={choice} />
        <MountedFilePanel
          key={filePanelMountKey(panel, resourceKey)}
          panel={panel}
          file={handle.file}
          params={panelLocation}
          revision={navigationRevision}
          suspendPendingSave={handle.holdWrites}
        />
      </View>
    );
  }
  return (
    <View style={styles.container} testID="workspace-file-pane">
      <FilePanelPicker choice={choice} />
      <View style={styles.centerState}>{body}</View>
    </View>
  );
}

function filePanelMountKey(panel: FilePanel, targetKey: string | null): string {
  const installation = panel.builtin
    ? "builtin"
    : pluginSurfaceKey(panel.plugin.lifetime, panel.contribution.Component);
  return `${panel.id}:${installation}:${targetKey}`;
}

/** One panel mount owns its attributes until close or installation replacement. */
function MountedFilePanel({
  panel,
  file,
  params,
  revision,
  suspendPendingSave,
}: {
  panel: FilePanel;
  file: PluginFile;
  params: { path: string; lineStart?: number; lineEnd?: number };
  revision: number;
  suspendPendingSave?: () => () => void;
}) {
  const { state, setCurrentTabState } = usePaneContext();
  const [modified, setModified] = useState(false);
  const [retained, setRetained] = useState(false);
  usePublishPanelInstanceAttributes({ modified, retained, suspendPendingSave });
  const tab = useMemo<PluginTab>(
    () => ({
      setModified,
      setRetained,
      state,
      setState: setCurrentTabState,
    }),
    [state, setCurrentTabState],
  );
  return <FilePanelView panel={panel} file={file} tab={tab} params={params} revision={revision} />;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));

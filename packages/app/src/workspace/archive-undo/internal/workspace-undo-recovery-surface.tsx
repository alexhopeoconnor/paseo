import { useMemo, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { SidebarCallout } from "@/components/sidebar-callout";
import { isWeb } from "@/constants/platform";
import { getOverlayRoot } from "@/lib/overlay-root";
import { useHosts } from "@/runtime/host-runtime";
import {
  getWorkspaceArchiveRecoverySnapshot,
  retryWorkspaceArchiveRecovery,
  subscribeWorkspaceArchiveRecovery,
  type WorkspaceArchiveRecoveryEntry,
} from "./undo-window";

/**
 * Persistent, non-dismissible recovery surface for failed local workspace-archive Undo.
 *
 * Rendered by the root-mounted undo host, outside ToastApi's single slot. The outer
 * overlay and wrappers are non-blocking; only the bounded scroll view/cards are touchable.
 */
export function WorkspaceUndoRecoverySurface() {
  const entries = useSyncExternalStore(
    subscribeWorkspaceArchiveRecovery,
    getWorkspaceArchiveRecoverySnapshot,
    getWorkspaceArchiveRecoverySnapshot,
  );
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const hosts = useHosts();
  const serverLabels = useMemo(
    () => new Map(hosts.map((host) => [host.serverId, host.label])),
    [hosts],
  );

  if (entries.length === 0) {
    return null;
  }

  const content = (
    <View pointerEvents="box-none" style={[styles.overlay, { bottom: insets.bottom + 12 }]}>
      <View pointerEvents="box-none" style={styles.stack}>
        <ScrollView
          pointerEvents="auto"
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={entries.length > 1}
        >
          {entries.map((entry) => (
            <RecoveryCallout
              key={`${entry.key}:${entry.token}`}
              entry={entry}
              serverLabel={serverLabels.get(entry.serverId)?.trim() || entry.serverId}
              retryLabel={t("common.actions.retry")}
              title={t("sidebar.workspace.toasts.undoArchiveFailed")}
            />
          ))}
        </ScrollView>
      </View>
    </View>
  );

  return isWeb ? createPortal(content, getOverlayRoot()) : content;
}

function RecoveryCallout({
  entry,
  serverLabel,
  retryLabel,
  title,
}: {
  entry: WorkspaceArchiveRecoveryEntry;
  serverLabel: string;
  retryLabel: string;
  title: string;
}) {
  return (
    <View pointerEvents="auto" style={styles.card}>
      <SidebarCallout
        variant="error"
        title={title}
        description={`${entry.workspaceName} · ${serverLabel}`}
        testID={`workspace-undo-recovery:${entry.key}`}
        actions={[
          {
            label: retryLabel,
            variant: "primary",
            disabled: !entry.retryable || entry.retrying,
            testID: `workspace-undo-recovery-retry:${entry.key}`,
            onPress: () =>
              retryWorkspaceArchiveRecovery({
                serverId: entry.serverId,
                workspaceId: entry.workspaceId,
                token: entry.token,
              }),
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    left: 12,
    right: 12,
    alignItems: "flex-start",
    zIndex: 9000,
  },
  stack: {
    width: "100%",
    maxWidth: 360,
  },
  scroll: {
    maxHeight: 360,
  },
  scrollContent: {
    gap: theme.spacing[2],
  },
  card: {
    width: "100%",
    overflow: "hidden",
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
}));

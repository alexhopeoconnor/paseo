import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { PastedTextComposerAttachment } from "@/attachments/types";
import { readPastedTextAttachment } from "@/composer/pasted-text";
import {
  getSubmissionRecoveryInspectionState,
  type SubmissionRecoveryRecord,
} from "@/stores/workspace-draft-submission-recovery";
import { copyToClipboard } from "@/utils/copy-to-clipboard";

interface RecoveredPastedText {
  id: string;
  text: string;
  error: string | null;
}

function getRecoveryHeader(record: SubmissionRecoveryRecord | null): {
  title: string;
  subtitle: string;
} {
  if (!record) {
    return { title: "Submission recovery", subtitle: "It will not be sent automatically." };
  }
  switch (getSubmissionRecoveryInspectionState(record)) {
    case "queued":
      return {
        title: "Queued submission retained",
        subtitle: "It was not sent automatically after reload.",
      };
    case "dispatching_unknown":
      return {
        title: "Submission outcome unknown",
        subtitle: "It will not be retried automatically.",
      };
    case "accepted":
      return {
        title: "Submission accepted",
        subtitle: "This submission was accepted. It will not be retried automatically.",
      };
    default:
      return {
        title: "Submission needs review",
        subtitle: "It will not be sent automatically.",
      };
  }
}

function getRecoveryDetail(record: SubmissionRecoveryRecord | null): string {
  if (!record) return "No submission checkpoint is selected.";
  if (record.errorMessage) return record.errorMessage;
  switch (getSubmissionRecoveryInspectionState(record)) {
    case "queued":
      return "This submission remains queued for explicit review; recovery will not send it.";
    case "accepted":
      return "The original draft text remains available to copy, and a new message can be sent manually.";
    case "dispatching_unknown":
      return "The previous send may have reached the provider. Inspect it before retrying.";
    default:
      return "This submission needs review before any retry.";
  }
}

function RecoveredPastedTextSection({
  attachment,
  index,
}: {
  attachment: RecoveredPastedText;
  index: number;
}) {
  const handleCopy = useCallback(() => {
    if (attachment.error !== null) return;
    void copyToClipboard(attachment.text);
  }, [attachment.error, attachment.text]);

  return (
    <View style={styles.pastedTextSection}>
      <Text style={styles.attachmentSummary}>{`Pasted text ${index + 1}`}</Text>
      {attachment.error ? (
        <Text style={styles.error}>{attachment.error}</Text>
      ) : (
        <Text
          selectable
          style={styles.text}
          testID="composer-submission-recovery-pasted-text-preview"
        >
          {attachment.text}
        </Text>
      )}
      <Button
        accessibilityLabel={`Copy exact pasted text ${index + 1}`}
        disabled={attachment.error !== null}
        onPress={handleCopy}
        size="sm"
        variant="secondary"
      >
        Copy pasted text
      </Button>
    </View>
  );
}

/**
 * Inspection is deliberately read-only with respect to delivery. A persisted
 * uncertain outcome may be discarded by the user, but never automatically
 * dispatched again from recovery hydration.
 */
export function SubmissionRecoverySheet({
  record,
  onClose,
  onDiscard,
  onRestore,
}: {
  record: SubmissionRecoveryRecord | null;
  onClose: () => void;
  onDiscard: (record: SubmissionRecoveryRecord) => void;
  onRestore: (record: SubmissionRecoveryRecord) => void;
}) {
  const [pastedText, setPastedText] = useState<RecoveredPastedText[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!record) {
      setPastedText([]);
      return () => {
        cancelled = true;
      };
    }
    const attachments = record.originalDraft.attachments.filter(
      (attachment): attachment is PastedTextComposerAttachment => attachment.kind === "pasted_text",
    );
    void (async () => {
      const next = await Promise.all(
        attachments.map(async (attachment) => {
          try {
            return {
              id: attachment.metadata.id,
              text: await readPastedTextAttachment(attachment),
              error: null,
            };
          } catch (error) {
            return {
              id: attachment.metadata.id,
              text: "",
              error: error instanceof Error ? error.message : "Unable to read pasted text.",
            };
          }
        }),
      );
      if (!cancelled) setPastedText(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [record]);
  const handleCopy = useCallback(() => {
    if (!record) return;
    void copyToClipboard(record.originalDraft.text);
  }, [record]);
  const handleRestore = useCallback(() => {
    if (!record || record.state === "settled") return;
    onRestore(record);
  }, [onRestore, record]);
  const handleDiscard = useCallback(() => {
    if (!record) return;
    onDiscard(record);
  }, [onDiscard, record]);
  const header = useMemo(() => getRecoveryHeader(record), [record]);
  const attachmentCount = record?.originalDraft.attachments.length ?? 0;

  return (
    <AdaptiveModalSheet
      visible={record !== null}
      onClose={onClose}
      header={header}
      snapPoints={["48%", "76%"]}
      testID="composer-submission-recovery-sheet"
      desktopMaxWidth={680}
    >
      <View style={styles.content}>
        <Text style={styles.message} testID="composer-submission-recovery-error">
          {getRecoveryDetail(record)}
        </Text>
        <ScrollView style={styles.preview} contentContainerStyle={styles.previewContent}>
          <Text selectable style={styles.text} testID="composer-submission-recovery-preview">
            {record?.originalDraft.text ?? ""}
          </Text>
          {attachmentCount > 0 ? (
            <Text
              style={styles.attachmentSummary}
              testID="composer-submission-recovery-attachments"
            >
              {`${attachmentCount} original attachment${attachmentCount === 1 ? "" : "s"} retained`}
            </Text>
          ) : null}
          {pastedText.map((attachment, index) => (
            <RecoveredPastedTextSection key={attachment.id} attachment={attachment} index={index} />
          ))}
        </ScrollView>
        <View style={styles.actions}>
          <Button
            accessibilityLabel="Copy recoverable draft"
            disabled={!record}
            onPress={handleCopy}
            size="sm"
            variant="secondary"
          >
            Copy
          </Button>
          {record?.state !== "settled" ? (
            <Button
              accessibilityLabel="Restore original draft snapshot"
              disabled={!record}
              onPress={handleRestore}
              size="sm"
              variant="secondary"
            >
              Restore draft
            </Button>
          ) : null}
          <Button
            accessibilityLabel="Discard submission checkpoint"
            disabled={!record}
            onPress={handleDiscard}
            size="sm"
            variant="destructive"
          >
            Discard checkpoint
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  message: {
    color: theme.colors.foregroundMuted,
  },
  preview: {
    maxHeight: 360,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  previewContent: {
    padding: theme.spacing[3],
  },
  text: {
    color: theme.colors.foreground,
    fontFamily: "monospace",
  },
  attachmentSummary: {
    color: theme.colors.foregroundMuted,
  },
  pastedTextSection: {
    gap: theme.spacing[2],
    marginTop: theme.spacing[3],
  },
  error: {
    color: theme.colors.destructive,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));

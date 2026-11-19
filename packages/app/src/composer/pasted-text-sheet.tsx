import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { PastedTextComposerAttachment } from "@/attachments/types";
import { readPastedTextAttachment } from "@/composer/pasted-text-attachment";
import { copyToClipboard } from "@/utils/copy-to-clipboard";

export interface PastedTextInspectorTarget {
  attachment: PastedTextComposerAttachment;
  index: number;
}

/**
 * A timeline attachment already carries its exact text, so it has no draft storage or remove
 * action.
 */
export interface ReadOnlyPastedTextInspectorTarget {
  kind: "read_only";
  text: string;
  title: string;
}

export type PastedTextSheetTarget = PastedTextInspectorTarget | ReadOnlyPastedTextInspectorTarget;

function isReadOnlyPastedTextInspectorTarget(
  target: PastedTextSheetTarget | null,
): target is ReadOnlyPastedTextInspectorTarget {
  return target !== null && "kind" in target && target.kind === "read_only";
}

export function PastedTextSheet({
  target,
  onClose,
  onRemove,
  testID = "composer-pasted-text-sheet",
  previewTestID = "composer-pasted-text-preview",
}: {
  target: PastedTextSheetTarget | null;
  onClose: () => void;
  onRemove?: (index: number) => void;
  testID?: string;
  previewTestID?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readOnlyTarget = isReadOnlyPastedTextInspectorTarget(target) ? target : null;

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    if (!target) return;
    if (isReadOnlyPastedTextInspectorTarget(target)) {
      setText(target.text);
      return;
    }
    void (async () => {
      try {
        const nextText = await readPastedTextAttachment(target.attachment);
        if (!cancelled) setText(nextText);
      } catch {
        if (!cancelled) setError("The pasted text is no longer available.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  const handleCopy = useCallback(() => {
    if (text === null) return;
    void copyToClipboard(text);
  }, [text]);
  const handleRemove = useCallback(() => {
    if (!target || isReadOnlyPastedTextInspectorTarget(target) || !onRemove) return;
    onRemove(target.index);
    onClose();
  }, [onClose, onRemove, target]);

  const subtitle =
    target && !isReadOnlyPastedTextInspectorTarget(target)
      ? `${target.attachment.codePointCount.toLocaleString()} characters · ${target.attachment.logicalLineCount.toLocaleString()} lines`
      : undefined;
  const header = useMemo(
    () => ({ title: readOnlyTarget?.title ?? "Pasted text", ...(subtitle ? { subtitle } : {}) }),
    [readOnlyTarget?.title, subtitle],
  );

  return (
    <AdaptiveModalSheet
      visible={target !== null}
      onClose={onClose}
      header={header}
      snapPoints={["55%", "88%"]}
      testID={testID}
      desktopMaxWidth={760}
    >
      <View style={styles.content}>
        <ScrollView style={styles.preview} contentContainerStyle={styles.previewContent}>
          <Text selectable style={styles.text} testID={previewTestID}>
            {error ?? text ?? "Loading pasted text…"}
          </Text>
        </ScrollView>
        <View style={styles.actions}>
          <Button
            accessibilityLabel="Copy pasted text"
            disabled={text === null}
            onPress={handleCopy}
            size="sm"
            variant="secondary"
          >
            Copy
          </Button>
          {!readOnlyTarget && onRemove ? (
            <Button
              accessibilityLabel="Remove pasted text"
              onPress={handleRemove}
              size="sm"
              variant="destructive"
            >
              Remove
            </Button>
          ) : null}
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
  preview: {
    maxHeight: 520,
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
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));

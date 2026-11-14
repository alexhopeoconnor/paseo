import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { PastedTextComposerAttachment } from "@/attachments/types";
import { readPastedTextAttachment } from "@/composer/pasted-text";
import { copyToClipboard } from "@/utils/copy-to-clipboard";

export interface PastedTextInspectorTarget {
  attachment: PastedTextComposerAttachment;
  index: number;
}

export function PastedTextSheet({
  target,
  onClose,
  onRemove,
}: {
  target: PastedTextInspectorTarget | null;
  onClose: () => void;
  onRemove: (index: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    if (!target) return;
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
    if (!target) return;
    onRemove(target.index);
    onClose();
  }, [onClose, onRemove, target]);

  const subtitle = target
    ? `${target.attachment.codePointCount.toLocaleString()} characters · ${target.attachment.logicalLineCount.toLocaleString()} lines`
    : undefined;
  const header = useMemo(
    () => ({ title: "Pasted text", ...(subtitle ? { subtitle } : {}) }),
    [subtitle],
  );

  return (
    <AdaptiveModalSheet
      visible={target !== null}
      onClose={onClose}
      header={header}
      snapPoints={["55%", "88%"]}
      testID="composer-pasted-text-sheet"
      desktopMaxWidth={760}
    >
      <View style={styles.content}>
        <ScrollView style={styles.preview} contentContainerStyle={styles.previewContent}>
          <Text selectable style={styles.text} testID="composer-pasted-text-preview">
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
          <Button
            accessibilityLabel="Remove pasted text"
            onPress={handleRemove}
            size="sm"
            variant="destructive"
          >
            Remove
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

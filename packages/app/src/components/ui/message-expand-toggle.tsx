import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";

interface MessageExpandToggleProps {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  testID?: string;
}

export function MessageExpandToggle({
  expanded,
  onExpandedChange,
  testID,
}: MessageExpandToggleProps) {
  const { t } = useTranslation();
  const toggle = useCallback(() => onExpandedChange(!expanded), [expanded, onExpandedChange]);
  return (
    <Button
      testID={testID}
      variant="ghost"
      size="sm"
      style={[styles.toggle, expanded && styles.expandedToggle]}
      aria-expanded={expanded}
      onPress={toggle}
    >
      {t(expanded ? "turnSummary.showLess" : "turnSummary.showMore")}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  toggle: { alignSelf: "flex-start", paddingHorizontal: 0, minHeight: 0, borderWidth: 0 },
  expandedToggle: { marginTop: theme.spacing[2] },
}));

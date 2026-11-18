import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp } from "lucide-react-native";

interface MessageExpandToggleProps {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  testID?: string;
  compact?: boolean;
}

export function MessageExpandToggle({
  expanded,
  onExpandedChange,
  testID,
  compact = true,
}: MessageExpandToggleProps) {
  const { t } = useTranslation();
  const toggle = useCallback(() => onExpandedChange(!expanded), [expanded, onExpandedChange]);
  const icon = expanded ? ChevronUp : ChevronDown;
  return (
    <Button
      testID={testID}
      variant="ghost"
      size={compact ? "sm" : undefined}
      style={[
        styles.toggle,
        compact && styles.compactToggle,
        compact && expanded && styles.expandedToggle,
      ]}
      textStyle={!compact && styles.label}
      leftIcon={compact ? undefined : icon}
      aria-expanded={expanded}
      onPress={toggle}
    >
      {t(expanded ? "turnSummary.showLess" : "turnSummary.showMore")}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  toggle: { alignSelf: "flex-start" },
  compactToggle: { paddingHorizontal: 0, minHeight: 0, borderWidth: 0 },
  label: { color: theme.colors.foreground },
  expandedToggle: { marginTop: theme.spacing[2] },
}));

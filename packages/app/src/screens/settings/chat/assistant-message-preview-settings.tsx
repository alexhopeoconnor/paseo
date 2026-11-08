import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useStableEvent } from "@/hooks/use-stable-event";
import {
  parseAssistantMessagePreviewLimit,
  type AssistantMessagePreview,
  type UseAppSettingsReturn,
} from "@/hooks/use-settings";

interface AssistantMessagePreviewSettingsProps {
  preview: AssistantMessagePreview;
  updateSettings: UseAppSettingsReturn["updateSettings"];
}

export function AssistantMessagePreviewSettings({
  preview,
  updateSettings,
}: AssistantMessagePreviewSettingsProps) {
  const { t } = useTranslation();
  const input = useRef<EditingTextInputHandle>(null);
  const [invalidLimit, setInvalidLimit] = useState(false);
  const save = useMutation({
    mutationFn: (assistantMessagePreview: AssistantMessagePreview) =>
      updateSettings({ assistantMessagePreview }),
  });

  useEffect(() => {
    input.current?.replaceText(String(preview.characterLimit));
  }, [preview.characterLimit]);

  const applyLimit = useStableEvent(() => {
    const characterLimit = parseAssistantMessagePreviewLimit(input.current?.getText() ?? "");
    setInvalidLimit(characterLimit === null);
    if (characterLimit === null) return;
    input.current?.replaceText(String(characterLimit));
    save.mutate({ ...preview, characterLimit });
  });

  const changeEnabled = useStableEvent((enabled: boolean) => {
    setInvalidLimit(false);
    input.current?.replaceText(String(preview.characterLimit));
    save.mutate({ ...preview, enabled });
  });
  const clearInvalidLimit = useStableEvent(() => setInvalidLimit(false));

  const limitError = invalidLimit
    ? t("settings.general.assistantMessagePreview.invalidLimit")
    : null;
  const saveError = save.isError ? t("settings.general.assistantMessagePreview.saveError") : null;
  const limitDisabled = !preview.enabled || save.isPending;
  const applyLabel = save.isPending
    ? t("settings.general.assistantMessagePreview.saving")
    : t("settings.general.assistantMessagePreview.apply");

  return (
    <SettingsSection title={t("settings.general.assistantMessagePreview.title")}>
      <SettingsCard>
        <SettingsSwitch
          testID="assistant-message-preview-toggle"
          label={t("settings.general.assistantMessagePreview.label")}
          hint={t("settings.general.assistantMessagePreview.description")}
          value={preview.enabled}
          onValueChange={changeEnabled}
          disabled={save.isPending}
          error={saveError}
        />
        <SettingsRow
          label={t("settings.general.assistantMessagePreview.limitLabel")}
          error={limitError}
        >
          <View style={styles.limitControls}>
            <FormTextInput
              ref={input}
              testID="assistant-message-preview-limit"
              initialValue={String(preview.characterLimit)}
              accessibilityLabel={t("settings.general.assistantMessagePreview.limitLabel")}
              onChangeText={clearInvalidLimit}
              onSubmitEditing={applyLimit}
              keyboardType="number-pad"
              inputMode="numeric"
              editable={!limitDisabled}
              selectTextOnFocus
              style={styles.limitInput}
            />
            <Button
              testID="assistant-message-preview-apply"
              variant="outline"
              onPress={applyLimit}
              disabled={limitDisabled}
              loading={save.isPending}
            >
              {applyLabel}
            </Button>
          </View>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  limitControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  limitInput: {
    width: 112,
    textAlign: "right",
  },
}));

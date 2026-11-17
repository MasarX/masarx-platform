import * as React from "react";
import { Pressable, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import type { FieldOpsStrings } from "./i18n";
import { composeStopAddressText, runStopAddressAction } from "./mobile-address-actions";

export function StopAddressActions({
  address,
  note,
  reference,
  disabled,
  runAction,
  strings,
  styles,
}: {
  address: string | null;
  note: string | null;
  reference: string | null;
  disabled: boolean;
  runAction: (action: () => Promise<void>) => Promise<void>;
  strings: FieldOpsStrings["addressActions"];
  styles: {
    screenActionsRow: StyleProp<ViewStyle>;
    actionButton: StyleProp<ViewStyle>;
    syncButtonDisabled: StyleProp<ViewStyle>;
    navItemPressed: StyleProp<ViewStyle>;
    actionButtonText: StyleProp<TextStyle>;
    noticeText: StyleProp<TextStyle>;
  };
}) {
  const text = composeStopAddressText({ address, note, reference });
  const [feedback, setFeedback] = React.useState<{ text: string; message: string } | null>(null);
  const unavailable = disabled || !text;
  const handleAction = (action: "copy" | "share") => {
    if (unavailable) return;
    setFeedback(null);
    void runAction(async () => {
      const result = await runStopAddressAction(action, text);
      if (result === "cancelled") return;
      if (result === "copied" || result === "shared") {
        setFeedback({ text, message: result === "copied" ? strings.copied : strings.shared });
      } else {
        const message = result === "missing"
          ? strings.missing
          : result === "unsupported"
            ? (action === "share" ? strings.shareUnsupported : strings.copyUnsupported)
            : strings.failed;
        setFeedback({ text, message: `${strings.unavailable}: ${message}` });
      }
    });
  };
  return (
    <View>
      <View style={styles.screenActionsRow}>
        {(["copy", "share"] as const).map((action) => (
          <Pressable
            key={action}
            accessibilityRole="button"
            accessibilityLabel={strings[action]}
            disabled={unavailable}
            onPress={() => handleAction(action)}
            style={({ pressed }) => [
              styles.actionButton,
              unavailable && styles.syncButtonDisabled,
              pressed && styles.navItemPressed,
            ]}
          >
            <Text style={styles.actionButtonText}>{strings[action]}</Text>
          </Pressable>
        ))}
      </View>
      <Text accessibilityLiveRegion="polite" style={styles.noticeText}>
        {feedback?.text === text ? feedback.message : null}
      </Text>
    </View>
  );
}

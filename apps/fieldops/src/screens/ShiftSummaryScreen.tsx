import { Text, View, type StyleProp, type TextStyle } from "react-native";
import { StatusChip } from "../components/StatusChip";

export function ShiftSummaryScreen({ shift, activeLabel, inactiveLabel, openedLabel, textStyle }: {
  shift: { openedAt: string | null } | null;
  activeLabel: string;
  inactiveLabel: string;
  openedLabel: string;
  textStyle?: StyleProp<TextStyle>;
}) {
  return (
    <View testID="mobile-driver-shift-status" style={{ gap: 4 }}>
      <StatusChip label={shift ? activeLabel : inactiveLabel} tone={shift ? "success" : "neutral"} />
      {shift?.openedAt ? <Text style={textStyle}>{openedLabel} {shift.openedAt}</Text> : null}
    </View>
  );
}

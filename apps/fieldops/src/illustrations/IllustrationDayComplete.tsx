import * as React from "react";
import { Text, View } from "react-native";

import { useTheme } from "../mobile-theme-context";

export type IllustrationDayCompleteProps = {
  /** Pixel size of the square illustration. Defaults to 160. */
  size?: number;
  /** Optional testID override. Defaults to `day-complete-illustration`. */
  testID?: string;
};

const DEFAULT_SIZE = 160;
const DEFAULT_TEST_ID = "day-complete-illustration";

export function IllustrationDayComplete(
  props: IllustrationDayCompleteProps = {},
): React.JSX.Element {
  const { size = DEFAULT_SIZE, testID = DEFAULT_TEST_ID } = props;
  const { tokens } = useTheme();

  // Day-complete uses a slightly larger center accent than the other four
  // illustrations to read as the "louder" celebration moment in the shell.
  const outerSize = size;
  const innerSize = Math.round(size * 0.7);
  const accentFontSize = Math.round(size * 0.52);

  return (
    <View
      testID={testID}
      accessible={true}
      accessibilityRole="image"
      accessibilityLabel="Day complete celebration illustration"
      style={{
        width: outerSize,
        height: outerSize,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tokens.color.successSoft,
        borderRadius: outerSize / 2,
        padding: tokens.spacing.sm,
      }}
    >
      <View
        testID={`${testID}-inner`}
        style={{
          width: innerSize,
          height: innerSize,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: innerSize / 2,
          borderWidth: 1,
          borderColor: tokens.color.borderMuted,
          backgroundColor: tokens.color.successSoft,
        }}
      >
        <Text
          testID={`${testID}-accent`}
          style={{
            color: tokens.color.success,
            fontSize: accentFontSize,
            lineHeight: accentFontSize,
            fontWeight: "700",
            textAlign: "center",
          }}
        >
          {"\u2713"}
        </Text>
      </View>
    </View>
  );
}

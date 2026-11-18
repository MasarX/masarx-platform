import * as React from "react";
import { Text, View } from "react-native";

import { useTheme } from "../mobile-theme-context";

export type IllustrationOfflineProps = {
  /** Pixel size of the square illustration. Defaults to 160. */
  size?: number;
  /** Optional testID override. Defaults to `offline-illustration`. */
  testID?: string;
};

const DEFAULT_SIZE = 160;
const DEFAULT_TEST_ID = "offline-illustration";

export function IllustrationOffline(
  props: IllustrationOfflineProps = {},
): React.JSX.Element {
  const { size = DEFAULT_SIZE, testID = DEFAULT_TEST_ID } = props;
  const { tokens } = useTheme();

  const outerSize = size;
  const innerSize = Math.round(size * 0.62);
  const accentFontSize = Math.round(size * 0.42);

  return (
    <View
      testID={testID}
      accessible={true}
      accessibilityRole="image"
      accessibilityLabel="Offline mode illustration"
      style={{
        width: outerSize,
        height: outerSize,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tokens.color.warningSoft,
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
          backgroundColor: tokens.color.warningSoft,
        }}
      >
        <Text
          testID={`${testID}-accent`}
          style={{
            color: tokens.color.warning,
            fontSize: accentFontSize,
            lineHeight: accentFontSize,
            fontWeight: "700",
            textAlign: "center",
          }}
        >
          {"\u2014"}
        </Text>
      </View>
    </View>
  );
}

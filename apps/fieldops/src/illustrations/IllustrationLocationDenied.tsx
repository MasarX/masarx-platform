import * as React from "react";
import { Text, View } from "react-native";

import { useTheme } from "../mobile-theme-context";

export type IllustrationLocationDeniedProps = {
  /** Pixel size of the square illustration. Defaults to 160. */
  size?: number;
  /** Optional testID override. Defaults to `location-denied-illustration`. */
  testID?: string;
};

const DEFAULT_SIZE = 160;
const DEFAULT_TEST_ID = "location-denied-illustration";

export function IllustrationLocationDenied(
  props: IllustrationLocationDeniedProps = {},
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
      accessibilityLabel="Location permission needed illustration"
      style={{
        width: outerSize,
        height: outerSize,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tokens.color.dangerSoft,
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
          backgroundColor: tokens.color.dangerSoft,
        }}
      >
        <Text
          testID={`${testID}-accent`}
          style={{
            color: tokens.color.danger,
            fontSize: accentFontSize,
            lineHeight: accentFontSize,
            fontWeight: "700",
            textAlign: "center",
          }}
        >
          {"!"}
        </Text>
      </View>
    </View>
  );
}

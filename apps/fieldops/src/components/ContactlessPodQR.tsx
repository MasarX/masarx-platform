import React from "react";
import { View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { buildSigningQr } from "../mobile-qr-bitmap";
import type { ContactlessPodQRProps } from "./ContactlessPodQR.types";

export function ContactlessPodQR({ signingUrl, accessibilityLabel, size = 200, testID }: ContactlessPodQRProps) {
  const qr = React.useMemo(() => buildSigningQr(signingUrl), [signingUrl]);
  return (
    <View testID={testID}>
      <Svg width={size} height={size} viewBox={`0 0 ${qr.size} ${qr.size}`}
        accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel}>
        <Rect width={qr.size} height={qr.size} fill="#fff" />
        <Path d={qr.path} fill="#000" />
      </Svg>
    </View>
  );
}

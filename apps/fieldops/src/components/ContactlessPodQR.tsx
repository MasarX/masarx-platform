import React from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { buildSigningQr } from "../mobile-qr-bitmap";
import type { ContactlessPodQRProps } from "./ContactlessPodQR.types";

export function ContactlessPodQR({ signingUrl, size = 200, testID, onCopyLink }: ContactlessPodQRProps) {
  const qr = React.useMemo(() => buildSigningQr(signingUrl), [signingUrl]);
  return (
    <View testID={testID}>
      <Svg width={size} height={size} viewBox={`0 0 ${qr.size} ${qr.size}`}
        accessible accessibilityRole="image" accessibilityLabel="Customer signing QR code">
        <Rect width={qr.size} height={qr.size} fill="#fff" />
        <Path d={qr.path} fill="#000" />
      </Svg>
      {onCopyLink ? (
        <Pressable accessibilityRole="button" onPress={() => onCopyLink(signingUrl)} style={{ minHeight: 48 }}>
          <Text>Copy signing link</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

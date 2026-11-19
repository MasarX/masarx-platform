// Mobile V2 Phone-Frame chrome — pixel-faithful port of design source
// `_kit.jsx` FxFrame / FxStatusBar / FxNavPill. Wraps a screen with a
// synthetic status bar (9:41 + battery + wifi-off + center notch dot)
// at the top and a home-indicator nav pill at the bottom, matching
// what the design canvas renders inside every artboard.
//
// AUDIT-ONLY: in production, the device OS provides the status bar and
// home indicator natively. This component is used by the gallery
// (`mobile-v2-preview-gallery.tsx`) so audit screenshots match the
// design canvas frame-for-frame. Do not wire it into the production
// driver shell.

import * as React from "react";
import { Text, View } from "react-native";

import { FxIcon } from "./mobile-v2-icon";
import {
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2StatusBarProps {
  readonly theme: MobileV2Theme;
  /** Clock label rendered top-left. Defaults to "9:41" (Apple/design canonical). */
  readonly clockLabel?: string;
  /** Battery percentage rendered top-right. Defaults to "87%". */
  readonly batteryLabel?: string;
}

/**
 * Synthetic iOS-style status bar. 30px tall, time on the left, center
 * notch dot, signal/wifi/battery cluster on the right. Pixel-faithful
 * port of `FxStatusBar` from the design's `_kit.jsx`.
 */
export function MobileV2StatusBar(
  props: MobileV2StatusBarProps,
): React.ReactElement {
  const { theme } = props;
  return (
    <View
      style={{
        height: 30,
        paddingHorizontal: 18,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        position: "relative",
        flexShrink: 0,
        backgroundColor: theme.bg,
      }}
    >
      <Text
        style={{
          color: theme.ink,
          fontFamily: MOBILE_V2_FONT_SANS,
          fontSize: 12,
          fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
          letterSpacing: 0.2,
        }}
      >
        {props.clockLabel ?? "9:41"}
      </Text>
      {/* Center notch / camera dot */}
      <View
        style={{
          position: "absolute",
          left: "50%",
          top: 6,
          transform: [{ translateX: -9 }],
          width: 18,
          height: 18,
          borderRadius: 9,
          backgroundColor: "#000",
        }}
      />
      <View style={{ flexDirection: "row", alignItems: "center", columnGap: 5 }}>
        <FxIcon name="dot" size={14} color={theme.ink} />
        <FxIcon name="wifi-off" size={14} color={theme.ink} />
        <Text
          style={{
            color: theme.ink,
            fontFamily: MOBILE_V2_FONT_SANS,
            fontSize: 11,
            fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
          }}
        >
          {props.batteryLabel ?? "87%"}
        </Text>
      </View>
    </View>
  );
}

export interface MobileV2NavPillProps {
  readonly theme: MobileV2Theme;
}

/**
 * Synthetic iOS home-indicator pill at the bottom of the phone frame.
 * Pixel-faithful port of `FxNavPill` from the design's `_kit.jsx`.
 */
export function MobileV2NavPill(
  props: MobileV2NavPillProps,
): React.ReactElement {
  const { theme } = props;
  return (
    <View
      style={{
        height: 18,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        backgroundColor: theme.bg,
      }}
    >
      <View
        style={{
          width: 110,
          height: 4,
          borderRadius: 2,
          backgroundColor: theme.ink,
          opacity: 0.5,
        }}
      />
    </View>
  );
}

export interface MobileV2PhoneFrameProps {
  readonly theme: MobileV2Theme;
  readonly children: React.ReactNode;
  /** Override the status-bar clock label. */
  readonly clockLabel?: string;
  /** Override the status-bar battery label. */
  readonly batteryLabel?: string;
}

/**
 * Wraps a screen in synthetic status bar + content + home-indicator
 * pill, matching the design's FxFrame chrome contract. Used by the
 * audit gallery only.
 */
export function MobileV2PhoneFrame(
  props: MobileV2PhoneFrameProps,
): React.ReactElement {
  const { theme } = props;
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <MobileV2StatusBar
        theme={theme}
        clockLabel={props.clockLabel}
        batteryLabel={props.batteryLabel}
      />
      <View style={{ flex: 1, position: "relative" }}>{props.children}</View>
      <MobileV2NavPill theme={theme} />
    </View>
  );
}

// Mobile V2 Bottom Sheet primitive — used by the 14 inline action sheets
// per FieldOps V2.html section 08. Match the demo's app-shell.jsx
// SheetShell visual contract: backdrop dim + bottom-aligned sheet with
// drag-handle bar + rounded-top container + content scroll area.
//
// Renders as an absolutely-positioned overlay inside its parent (not
// a Modal portal), so the sheet docks to its host container's bottom
// edge. In production the host is the full driver shell (so the sheet
// docks to the device screen edges). In the audit gallery the host is
// the 390×844 phone frame card (so the sheet docks inside the frame,
// matching the FieldOps V2.html design contract).
//
// The parent View MUST have `position: "relative"` (the React Native
// default) and `overflow: "hidden"` if you want the sheet to clip to
// rounded corners. Both are already true for the gallery phone frame
// and for the driver shell wrappers.

import * as React from "react";
import {
  Animated,
  BackHandler,
  Easing,
  Pressable,
  ScrollView,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { FxIcon } from "./mobile-v2-icon";
import {
  MOBILE_V2_BOTTOM_SHEET_BACKDROP_ELEVATION,
  MOBILE_V2_BOTTOM_SHEET_BACKDROP_Z_INDEX,
  MOBILE_V2_BOTTOM_SHEET_DEFAULT_HEIGHT_FRACTION,
  MOBILE_V2_BOTTOM_SHEET_OVERLAY_ELEVATION,
  MOBILE_V2_BOTTOM_SHEET_OVERLAY_Z_INDEX,
  MOBILE_V2_BOTTOM_SHEET_PANEL_ELEVATION,
  MOBILE_V2_BOTTOM_SHEET_PANEL_Z_INDEX,
} from "./mobile-v2-bottom-sheet-layering";
import {
  MOBILE_V2_DIMENSIONS,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2BottomSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  /** Title rendered in the header. */
  readonly title?: string;
  /** Optional secondary line below the title. */
  readonly subtitle?: string;
  /** Right-aligned chip / button slot inside the header row. */
  readonly headerRight?: React.ReactNode;
  /** When true, tapping the backdrop calls onClose. Defaults to true. */
  readonly dismissOnBackdrop?: boolean;
  /**
   * Optional max-height fraction of the host height (0..1). Defaults
   * to 0.85; sheets that need full coverage can pass 0.95.
   */
  readonly maxHeightFraction?: number;
  readonly children: React.ReactNode;
  /**
   * Primary CTA rendered in a footer band below the content with a
   * border-top separator. Mirrors design canvas `FxSheet.primary`
   * (app-shell.jsx:300-304). When omitted, no footer band renders.
   */
  readonly primary?: React.ReactNode;
  /**
   * Optional secondary action rendered left of the primary in the
   * footer band. Mirrors design canvas `FxSheet.secondary`.
   */
  readonly secondary?: React.ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}

/**
 * Bottom sheet primitive. Slides up from the bottom of its parent
 * container, dims the parent, exposes a drag-handle bar + close
 * button. The sheet content scrolls inside the rounded container;
 * callers provide their own ScrollView when needed.
 */
export function MobileV2BottomSheet(
  props: MobileV2BottomSheetProps,
): React.ReactElement | null {
  const { theme } = props;
  const dismissBackdrop = props.dismissOnBackdrop !== false;
  // Design FxSheet (app-shell.jsx:285) caps the panel at 82% of the host.
  const maxHeight = props.maxHeightFraction ?? MOBILE_V2_BOTTOM_SHEET_DEFAULT_HEIGHT_FRACTION;
  // Slide animation: 0 = off-screen below, 1 = fully visible.
  const slide = React.useRef(new Animated.Value(0)).current;
  // Keep the overlay mounted briefly after `visible: false` so the
  // exit animation can play before unmount.
  const [mounted, setMounted] = React.useState<boolean>(props.visible);

  React.useEffect(() => {
    if (props.visible) {
      setMounted(true);
    }
    Animated.timing(slide, {
      toValue: props.visible ? 1 : 0,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !props.visible) {
        setMounted(false);
      }
    });
  }, [props.visible, slide]);

  // Android hardware-back support (replaces Modal.onRequestClose).
  React.useEffect(() => {
    if (!props.visible) return undefined;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      props.onClose();
      return true;
    });
    return () => sub.remove();
  }, [props.visible, props.onClose]);

  if (!mounted) {
    return null;
  }

  const translateY = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [800, 0],
  });
  const backdropOpacity = slide.interpolate({
    inputRange: [0, 1],
    // Design FxSheet backdrop is rgba(0,0,0,0.45).
    outputRange: [0, 0.45],
  });

  return (
    <View
      style={ABSOLUTE_FILL}
      pointerEvents={props.visible ? "auto" : "none"}
    >
      {/* Backdrop */}
      <Animated.View
        style={[
          BACKDROP_FILL,
          {
            backgroundColor: "#000",
            opacity: backdropOpacity,
          },
        ]}
      >
        <Pressable
          onPress={dismissBackdrop ? props.onClose : undefined}
          accessibilityRole="button"
          accessibilityLabel="Dismiss sheet"
          style={{ flex: 1 }}
        />
      </Animated.View>

      {/* Bottom-aligned sheet container */}
      <View
        style={{
          flex: 1,
          justifyContent: "flex-end",
          zIndex: MOBILE_V2_BOTTOM_SHEET_PANEL_Z_INDEX,
          elevation: MOBILE_V2_BOTTOM_SHEET_PANEL_ELEVATION,
        }}
        pointerEvents="box-none"
      >
        <Animated.View
          style={[
            {
              backgroundColor: theme.surface,
              borderTopLeftRadius: MOBILE_V2_RADII.sheetTop,
              borderTopRightRadius: MOBILE_V2_RADII.sheetTop,
              height: `${Math.round(maxHeight * 100)}%`,
              maxHeight: `${Math.round(maxHeight * 100)}%`,
              overflow: "hidden",
              zIndex: MOBILE_V2_BOTTOM_SHEET_PANEL_Z_INDEX,
              elevation: MOBILE_V2_BOTTOM_SHEET_PANEL_ELEVATION,
              transform: [{ translateY }],
              // Per-section padding mirrors design FxSheet (app-shell.jsx:285):
              // the panel owns no padding at all — handle/header/content/footer
              // each carry their own. Header/footer inset 16px; the content
              // area's 14px side inset lives on the ScrollView so a full-bleed
              // child can escape it, exactly like the design.
            },
            props.style,
          ]}
          pointerEvents={props.visible ? "auto" : "none"}
        >
          {/* Drag handle — design FxSheet uses the stronger border token
              and a 10px-top / 4px-bottom margin (app-shell.jsx:291). */}
          <View style={{ alignItems: "center" }}>
            <View
              style={{
                width: MOBILE_V2_DIMENSIONS.sheetDragHandleWidth,
                height: MOBILE_V2_DIMENSIONS.sheetDragHandleHeight,
                borderRadius: MOBILE_V2_DIMENSIONS.sheetDragHandleHeight / 2,
                backgroundColor: theme.borderStrong,
                marginTop: MOBILE_V2_SPACING.xl,
                marginBottom: MOBILE_V2_SPACING.sm,
              }}
            />
          </View>

          {/* Header — title + close */}
          {(props.title !== undefined || props.subtitle !== undefined || props.headerRight !== undefined) ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                columnGap: MOBILE_V2_SPACING.md,
                // Design FxSheet header padding: 8px top / 12px bottom /
                // 16px sides + 1px divider.
                paddingTop: MOBILE_V2_SPACING.lg,
                paddingBottom: MOBILE_V2_SPACING["2xl"],
                paddingHorizontal: MOBILE_V2_SPACING["4xl"],
                borderBottomWidth: 1,
                borderBottomColor: theme.border,
              }}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                {props.title !== undefined ? (
                  <Text
                    style={{
                      color: theme.ink,
                      fontFamily: MOBILE_V2_FONT_SANS,
                      fontSize: MOBILE_V2_TYPE_SIZES.sheetTitle,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    }}
                  >
                    {props.title}
                  </Text>
                ) : null}
                {props.subtitle !== undefined ? (
                  <Text
                    style={{
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_SANS,
                      fontSize: MOBILE_V2_TYPE_SIZES.sheetSubtitle,
                      marginTop: 2,
                    }}
                  >
                    {props.subtitle}
                  </Text>
                ) : null}
              </View>
              {props.headerRight}
              {/* U-q: the design `FxSheet` close (app-shell.jsx:297) is a
                  bare 32x32 hit area — `all:'unset'`, no fill, no radius —
                  with the `x` glyph inheriting `currentColor` (ink). The
                  tap target + hitSlop stay; the surfaceAlt tile + radius
                  are dropped and the glyph uses the bright ink token. */}
              <Pressable
                onPress={props.onClose}
                accessibilityRole="button"
                accessibilityLabel="Close sheet"
                hitSlop={MOBILE_V2_SPACING.lg}
                style={{
                  width: MOBILE_V2_DIMENSIONS.sheetCloseTile,
                  height: MOBILE_V2_DIMENSIONS.sheetCloseTile,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <FxIcon name="x" size={MOBILE_V2_SPACING["4xl"]} color={theme.ink} />
              </Pressable>
            </View>
          ) : null}

          {/* Content — scrolls within the sheet's maxHeight so tall forms
              (e.g. the cash-drop numberpad) stay fully reachable. The design
              FxSheet content area is `overflow:auto`. */}
          <ScrollView
            style={{ flexShrink: 1 }}
            contentContainerStyle={{
              // Design FxSheet content is 10px top / 14px bottom with 0 side
              // padding — its sheet bodies each own their side inset. The impl
              // applies the 14px side inset once here, so bodies stay
              // inset-free; a child opts into full-bleed with a -14px margin.
              paddingTop: MOBILE_V2_SPACING.xl,
              paddingBottom: MOBILE_V2_SPACING["3xl"],
              paddingHorizontal: MOBILE_V2_SPACING["3xl"],
              rowGap: MOBILE_V2_SPACING.lg,
            }}
            showsVerticalScrollIndicator={false}
          >
            {props.children}
          </ScrollView>

          {/* Primary/secondary footer band — design canvas FxSheet
              (app-shell.jsx:300-304) renders these with a border-top
              separator + edge-to-edge horizontal padding. */}
          {(props.primary !== undefined || props.secondary !== undefined) ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                columnGap: MOBILE_V2_SPACING.lg,
                // Design FxSheet footer padding: 10px top / 14px bottom /
                // 16px sides + 1px divider.
                paddingTop: MOBILE_V2_SPACING.xl,
                paddingBottom: MOBILE_V2_SPACING["3xl"],
                paddingHorizontal: MOBILE_V2_SPACING["4xl"],
                borderTopWidth: 1,
                borderTopColor: theme.border,
              }}
            >
              {props.secondary}
              {props.primary !== undefined ? (
                <View style={{ flex: 1 }}>{props.primary}</View>
              ) : null}
            </View>
          ) : null}
        </Animated.View>
      </View>
    </View>
  );
}

const ABSOLUTE_FILL = {
  position: "absolute" as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: MOBILE_V2_BOTTOM_SHEET_OVERLAY_Z_INDEX,
  elevation: MOBILE_V2_BOTTOM_SHEET_OVERLAY_ELEVATION,
} as const;

const BACKDROP_FILL = {
  position: "absolute" as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: MOBILE_V2_BOTTOM_SHEET_BACKDROP_Z_INDEX,
  elevation: MOBILE_V2_BOTTOM_SHEET_BACKDROP_ELEVATION,
} as const;

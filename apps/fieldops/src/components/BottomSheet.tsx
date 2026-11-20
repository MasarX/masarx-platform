import * as React from "react";
import {
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useThemedStyles } from "../mobile-theme-context";
import type { ThemeTokens } from "../mobile-theme";

import type { BottomSheetProps } from "./BottomSheet.types";

// Re-export the type surface from the JSX module so existing callers can
// `import { BottomSheet, type BottomSheetProps } from ".../BottomSheet"`
// without remembering the sibling `.types` file. The canonical declaration
// still lives in `BottomSheet.types.ts` so non-rendering consumers do not
// pull JSX.
export type { BottomSheetProps } from "./BottomSheet.types";

/**
 * WCAG 2.5.5 (Target Size, AAA) policy floor in density-independent pixels.
 * Mirrors the constant used by AppButton so the close button on the sheet
 * stays consistent with the rest of the FieldOps tap-target policy.
 */
const MIN_TOUCH_TARGET = 44 as const;

/**
 * Default max-height fraction of the viewport. The sheet caps at 90 % so
 * the backdrop scrim is always visible above it — that residual scrim is
 * the visual affordance that the sheet is dismissible by tap-outside.
 */
const DEFAULT_MAX_HEIGHT_PCT = 0.9 as const;

/** Use the same top corner radius for each sheet surface. */
const SHEET_TOP_RADIUS = 24 as const;

/**
 * Resolve the viewport height once per render. Wrapped in a helper so unit
 * tests can mock `Dimensions.get` without coupling to the call-site shape.
 */
function getViewportHeight(): number {
  const win = Dimensions.get("window");
  return typeof win?.height === "number" && win.height > 0 ? win.height : 800;
}

/**
 * Clamp a max-height fraction into the (0, 1] range. Negative / zero / NaN
 * fall back to the default so callers cannot accidentally collapse the
 * sheet to zero height.
 */
function clampMaxHeightPct(value: number | undefined): number {
  if (typeof value !== "number" || !isFinite(value) || value <= 0) {
    return DEFAULT_MAX_HEIGHT_PCT;
  }
  if (value > 1) return 1;
  return value;
}

/**
 * Stylesheet factory — invoked through `useThemedStyles` so styles refresh
 * whenever the active tokens change (theme mode swap, density swap, etc.).
 * Keeps the component body focused on layout and lets the theme system
 * stay the single source of truth for visual values.
 */
export function buildBottomSheetStyles(tokens: ThemeTokens) {
  return StyleSheet.create({
    // Modal-root container. Fills the viewport and aligns the sheet to the
    // bottom edge. The Modal itself supplies the slide animation; this
    // wrapper just supplies the column flex so backdrop + sheet stack.
    root: {
      flex: 1,
      justifyContent: "flex-end",
    },
    // Backdrop scrim. Fills the viewport BEHIND the sheet (zIndex lower).
    // Pressable so callers can opt into tap-to-dismiss via dismissOnBackdrop.
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: tokens.color.overlayScrim,
    },
    // Bottom-anchored sheet container. Top corners only (xl radius), padding
    // resolved from the lg spacing token, cardBg fill so dark-mode swap is
    // automatic.
    sheet: {
      backgroundColor: tokens.color.cardBg,
      borderTopLeftRadius: SHEET_TOP_RADIUS,
      borderTopRightRadius: SHEET_TOP_RADIUS,
      padding: tokens.spacing.lg,
      // Drop shadow gives the sheet visual lift above the scrim. Values
      // are conservative so the dark-mode card tone (which is already
      // contrasted against the dark page bg) does not look haloed.
      shadowColor: "#000",
      shadowOffset: { width: 0, height: -4 },
      shadowOpacity: 0.15,
      shadowRadius: 16,
      elevation: 16,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: tokens.spacing.md,
      // Reserve a row height equal to the close button so the title baseline
      // lines up with the close glyph centerline regardless of title length.
      minHeight: MIN_TOUCH_TARGET,
    },
    title: {
      flex: 1,
      fontSize: tokens.font.scale.xl,
      fontWeight: "600",
      color: tokens.color.text,
      fontFamily: tokens.font.sans,
      // Padding right so a long title never visually collides with the
      // close button on the right edge of the header row.
      paddingRight: tokens.spacing.md,
    },
    closeButton: {
      width: MIN_TOUCH_TARGET,
      height: MIN_TOUCH_TARGET,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: tokens.radius.md,
    },
    closeGlyph: {
      fontSize: tokens.font.scale["2xl"],
      color: tokens.color.textMuted,
      fontWeight: "400",
      // Line-height clamp so the glyph sits visually centered inside the
      // 44dp tap target on both iOS and Android (RN font metrics differ).
      lineHeight: tokens.font.scale["2xl"] + 4,
    },
    children: {
      flexShrink: 1,
    },
    actions: {
      marginTop: tokens.spacing.md,
      paddingTop: tokens.spacing.md,
      borderTopWidth: 1,
      borderTopColor: tokens.color.borderMuted,
    },
  });
}

/**
 * BottomSheet — the canonical primitive. See module header for invariants.
 */
export function BottomSheet(props: BottomSheetProps): React.JSX.Element {
  const {
    visible,
    onDismiss,
    title,
    children,
    actions,
    dismissOnBackdrop = true,
    maxHeightPct,
    testID = "bottom-sheet",
    accessibilityLabel,
  } = props;

  const styles = useThemedStyles(buildBottomSheetStyles);

  // Compute the effective max-height in pixels. Computed inside the body
  // (not memoised) because the cost is a single multiplication and the
  // viewport can change on rotation between renders — caching would
  // require a Dimensions.addEventListener subscription and a re-render
  // trigger which is more state than the primitive needs to own.
  const effectiveMaxHeightPct = clampMaxHeightPct(maxHeightPct);
  const viewportHeight = getViewportHeight();
  const maxHeightPx = Math.floor(viewportHeight * effectiveMaxHeightPct);

  // Resolved a11y label: explicit override > title > generic fallback.
  const resolvedA11yLabel =
    accessibilityLabel ?? title ?? "Bottom sheet";

  // Backdrop press handler. Skipped (no-op) when dismissOnBackdrop is
  // false so callers can lock the sheet against accidental dismissal
  // (e.g. partially-filled forms).
  const handleBackdropPress = (): void => {
    if (!dismissOnBackdrop) return;
    onDismiss();
  };

  // Close button press handler. Always dismisses regardless of the
  // dismissOnBackdrop setting — the close button is the explicit
  // dismissal affordance and must always work.
  const handleClosePress = (): void => {
    onDismiss();
  };

  return (
    <Modal
      testID={testID}
      visible={visible}
      transparent={true}
      animationType="slide"
      onRequestClose={onDismiss}
      accessibilityLabel={resolvedA11yLabel}
      accessibilityViewIsModal={true}
      // RN's typed AccessibilityRole union excludes "dialog"; cast preserves
      // VoiceOver/TalkBack semantic intent without changing runtime behaviour.
      accessibilityRole={"dialog" as unknown as "alert"}
    >
      <View
        testID={`${testID}-root`}
        style={styles.root}
      >
        <Pressable
          testID={`${testID}-backdrop`}
          accessibilityRole="button"
          accessibilityLabel="Close bottom sheet"
          onPress={handleBackdropPress}
          style={styles.backdrop}
        />
        <View
          testID={`${testID}-sheet`}
          style={[styles.sheet, { maxHeight: maxHeightPx }]}
        >
          <View
            testID={`${testID}-header`}
            style={styles.header}
          >
            {title ? (
              <Text
                testID={`${testID}-title`}
                style={styles.title}
                numberOfLines={1}
              >
                {title}
              </Text>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            <Pressable
              testID={`${testID}-close`}
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={handleClosePress}
              style={styles.closeButton}
            >
              <Text style={styles.closeGlyph}>×</Text>
            </Pressable>
          </View>
          <View
            testID={`${testID}-children`}
            style={styles.children}
          >
            {children}
          </View>
          {actions ? (
            <View
              testID={`${testID}-actions`}
              style={styles.actions}
            >
              {actions}
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

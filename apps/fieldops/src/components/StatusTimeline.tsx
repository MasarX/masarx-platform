import * as React from "react";
import { StyleSheet, Text, View } from "react-native";

import { useThemedStyles } from "../mobile-theme-context";
import type { ThemeTokens } from "../mobile-theme";

import type {
  StatusTimelineProps,
  StatusTimelineStep,
  StatusTimelineStepState,
} from "./StatusTimeline.types";

// Re-export the type surface from the JSX module so existing callers can
// `import { StatusTimeline, type StatusTimelineProps } from ".../StatusTimeline"`
// without remembering the sibling `.types` file. The canonical declaration
// still lives in `StatusTimeline.types.ts` so non-rendering consumers do
// not pull JSX into their bundle.
export type {
  StatusTimelineProps,
  StatusTimelineStep,
  StatusTimelineStepState,
} from "./StatusTimeline.types";

/**
 * Diameter of the lifecycle dot in density-independent pixels. Picked to
 * sit comfortably alongside the step label at scale.md (14dp) without
 * dominating the row. The connector line width derives from this so the
 * dot + line stay in proportion across density experiments.
 */
const DOT_DIAMETER = 8 as const;

/** The connector uses a thin stroke so it stays subordinate to the timeline markers. */
const CONNECTOR_THICKNESS = 2 as const;

/**
 * Length of the connector line in the *along-axis* direction (height for
 * vertical orientation, width for horizontal). Picked to keep the gap
 * visually balanced with the dot diameter while leaving room for a single
 * line of label + timestamp text in vertical mode.
 */
const CONNECTOR_LENGTH = 24 as const;

/**
 * Per-state tone palette resolved from the active theme tokens.
 *
 *  - complete  -> success bg dot + successFg label (lifecycle reached)
 *  - current   -> accent bg dot + accent label (active step)
 *  - pending   -> borderMuted bg dot + textMuted label (not yet reached)
 *  - skipped   -> borderMuted bg dot + textMuted label, plus 0.5 opacity
 *                 on the entire row so it visually recedes
 */
type StatePalette = {
  dotBackground: string;
  dotBorder: string;
  labelColor: string;
  /**
   * Multiplier applied to the entire row. `1` for complete/current/pending,
   * `0.5` for skipped so the bypassed step visually recedes without losing
   * its layout slot.
   */
  rowOpacity: number;
};

function buildStatePalette(
  tokens: ThemeTokens,
): Record<StatusTimelineStepState, StatePalette> {
  return {
    complete: {
      dotBackground: tokens.color.success,
      dotBorder: tokens.color.success,
      labelColor: tokens.color.successFg,
      rowOpacity: 1,
    },
    current: {
      dotBackground: tokens.color.accent,
      dotBorder: tokens.color.accent,
      labelColor: tokens.color.accent,
      rowOpacity: 1,
    },
    pending: {
      dotBackground: tokens.color.borderMuted,
      dotBorder: tokens.color.border,
      labelColor: tokens.color.textMuted,
      rowOpacity: 1,
    },
    skipped: {
      dotBackground: tokens.color.borderMuted,
      dotBorder: tokens.color.border,
      labelColor: tokens.color.textMuted,
      rowOpacity: 0.5,
    },
  };
}

/**
 * Stylesheet factory — invoked through `useThemedStyles` so styles refresh
 * whenever the active tokens change (theme mode swap, density swap, etc.).
 * Keeps the component body focused on layout and lets the theme system
 * stay the single source of truth for visual values.
 */
export function buildStatusTimelineStyles(tokens: ThemeTokens) {
  return StyleSheet.create({
    containerVertical: {
      flexDirection: "column",
      alignItems: "flex-start",
    },
    containerHorizontal: {
      flexDirection: "row",
      alignItems: "flex-start",
    },
    stepRowVertical: {
      flexDirection: "row",
      alignItems: "flex-start",
    },
    stepRowHorizontal: {
      flexDirection: "column",
      alignItems: "center",
    },
    dot: {
      width: DOT_DIAMETER,
      height: DOT_DIAMETER,
      borderRadius: DOT_DIAMETER / 2,
      borderWidth: 1,
    },
    // Vertical mode: a small column owns the dot + the connector that
    // descends from the dot to the next step's dot. Centers the dot on
    // the label baseline using a top inset.
    dotColumnVertical: {
      flexDirection: "column",
      alignItems: "center",
      // Aligns the dot vertically with the first line of the label text.
      // Half the label fontSize.lg (16) minus half the dot diameter keeps
      // the dot centered on the cap-height of the label.
      paddingTop: 4,
      marginRight: tokens.spacing.md,
    },
    // Horizontal mode: dot sits on its own row, connector extends to the
    // right. Label stacks below.
    dotRowHorizontal: {
      flexDirection: "row",
      alignItems: "center",
    },
    connectorVertical: {
      width: CONNECTOR_THICKNESS,
      height: CONNECTOR_LENGTH,
      marginTop: tokens.spacing.xs,
    },
    connectorHorizontal: {
      width: CONNECTOR_LENGTH,
      height: CONNECTOR_THICKNESS,
      marginHorizontal: tokens.spacing.xs,
    },
    // Label container — vertical mode lets the label expand to fill the
    // remaining row width; horizontal mode constrains the column so a long
    // label wraps under its dot.
    labelColumnVertical: {
      flexDirection: "column",
      flexShrink: 1,
      // Pull labels up slightly so they sit on the dot's center line.
      paddingBottom: tokens.spacing.md,
    },
    labelColumnHorizontal: {
      flexDirection: "column",
      alignItems: "center",
      maxWidth: 96,
      paddingTop: tokens.spacing.xs,
    },
    label: {
      fontSize: tokens.font.scale.md,
      fontWeight: "600",
      letterSpacing: 0.2,
      fontFamily: tokens.font.sans,
    },
    timestamp: {
      fontSize: tokens.font.scale.xs,
      fontWeight: "400",
      color: tokens.color.metaFg,
      fontFamily: tokens.font.sans,
      marginTop: 2,
    },
    failureReason: {
      fontSize: tokens.font.scale.xs,
      fontWeight: "500",
      color: tokens.color.dangerFg,
      fontFamily: tokens.font.sans,
      marginTop: 2,
    },
  });
}

/**
 * Resolve the connector line color for the boundary between two steps.
 * The connector inherits the *upstream* (earlier) step's dot background
 * so a complete -> pending boundary shows a solid success line that
 * transitions visually into the pending dot. Skipped steps still get a
 * connector (the lifecycle line is unbroken) but the line uses the muted
 * border color so the skip is visually consistent with the dot.
 */
function resolveConnectorColor(
  upstreamPalette: StatePalette,
): string {
  return upstreamPalette.dotBackground;
}

/**
 * Compose the screen-reader label for a single step. Combines label +
 * state + (optional) timestamp + (optional) failure reason so VoiceOver /
 * TalkBack narration is self-contained per row.
 */
function buildStepAccessibilityLabel(step: StatusTimelineStep): string {
  const parts: string[] = [step.label, step.state];
  if (step.timestamp) parts.push(step.timestamp);
  if (step.failureReason) parts.push(step.failureReason);
  return parts.join(", ");
}

/**
 * StatusTimeline — the canonical primitive. See module header for invariants.
 */
export function StatusTimeline(props: StatusTimelineProps): React.JSX.Element {
  const {
    steps,
    orientation = "vertical",
    testID = "status-timeline",
  } = props;

  const styles = useThemedStyles(buildStatusTimelineStyles);
  const palettes = useThemedStyles(buildStatePalette);

  const isVertical = orientation === "vertical";

  return (
    <View
      testID={testID}
      accessibilityRole={"list" as any}
      style={isVertical ? styles.containerVertical : styles.containerHorizontal}
    >
      {steps.map((step, index) => {
        const palette = palettes[step.state] ?? palettes.pending;
        const isLast = index === steps.length - 1;
        const stepTestId = `${testID}-step-${step.key}`;
        const connectorColor = resolveConnectorColor(palette);

        if (isVertical) {
          return (
            <View
              key={step.key}
              testID={stepTestId}
              accessibilityRole={"listitem" as any}
              accessibilityLabel={buildStepAccessibilityLabel(step)}
              style={[styles.stepRowVertical, { opacity: palette.rowOpacity }]}
            >
              <View style={styles.dotColumnVertical}>
                <View
                  testID={`${stepTestId}-dot`}
                  style={[
                    styles.dot,
                    {
                      backgroundColor: palette.dotBackground,
                      borderColor: palette.dotBorder,
                    },
                  ]}
                />
                {isLast ? null : (
                  <View
                    testID={`${stepTestId}-connector`}
                    style={[
                      styles.connectorVertical,
                      { backgroundColor: connectorColor },
                    ]}
                  />
                )}
              </View>
              <View style={styles.labelColumnVertical}>
                <Text
                  testID={`${stepTestId}-label`}
                  style={[styles.label, { color: palette.labelColor }]}
                  numberOfLines={2}
                >
                  {step.label}
                </Text>
                {step.timestamp ? (
                  <Text
                    testID={`${stepTestId}-timestamp`}
                    style={styles.timestamp}
                    numberOfLines={1}
                  >
                    {step.timestamp}
                  </Text>
                ) : null}
                {step.failureReason ? (
                  <Text
                    testID={`${stepTestId}-failure-reason`}
                    style={styles.failureReason}
                    numberOfLines={2}
                  >
                    {step.failureReason}
                  </Text>
                ) : null}
              </View>
            </View>
          );
        }

        // Horizontal orientation
        return (
          <View
            key={step.key}
            testID={stepTestId}
            accessibilityRole={"listitem" as any}
            accessibilityLabel={buildStepAccessibilityLabel(step)}
            style={[styles.stepRowHorizontal, { opacity: palette.rowOpacity }]}
          >
            <View style={styles.dotRowHorizontal}>
              <View
                testID={`${stepTestId}-dot`}
                style={[
                  styles.dot,
                  {
                    backgroundColor: palette.dotBackground,
                    borderColor: palette.dotBorder,
                  },
                ]}
              />
              {isLast ? null : (
                <View
                  testID={`${stepTestId}-connector`}
                  style={[
                    styles.connectorHorizontal,
                    { backgroundColor: connectorColor },
                  ]}
                />
              )}
            </View>
            <View style={styles.labelColumnHorizontal}>
              <Text
                testID={`${stepTestId}-label`}
                style={[styles.label, { color: palette.labelColor }]}
                numberOfLines={2}
              >
                {step.label}
              </Text>
              {step.timestamp ? (
                <Text
                  testID={`${stepTestId}-timestamp`}
                  style={styles.timestamp}
                  numberOfLines={1}
                >
                  {step.timestamp}
                </Text>
              ) : null}
              {step.failureReason ? (
                <Text
                  testID={`${stepTestId}-failure-reason`}
                  style={styles.failureReason}
                  numberOfLines={2}
                >
                  {step.failureReason}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

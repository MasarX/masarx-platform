import * as React from "react";
import { StyleSheet, View } from "react-native";

import { useThemedStyles } from "../mobile-theme-context";
import type { ThemeTokens } from "../mobile-theme";

export type SparklineTone = "positive" | "neutral" | "negative";

export type SparklineProps = {
  /**
   * Series of numeric data points. Order is oldest -> newest (left ->
   * right in LTR layouts). Empty arrays render nothing.
   */
  points: number[];
  /**
   * Total component width in px. Defaults to 60px which fits inside the
   * 48%-wide counter cell on the FieldOps HomeScreen without crowding
   * the value / label stack.
   */
  width?: number;
  /**
   * Total component height in px. Defaults to 16px so the sparkline
   * occupies the same vertical real estate as a body-xs label below the
   * counter value.
   */
  height?: number;
  /**
   * Color family for the bars. Defaults to "neutral" (metaFg). Use
   * "positive" for series trending up (success green), "negative" for
   * series trending down (danger red).
   */
  tone?: SparklineTone;
  /**
   * Test selector hook. Defaults to `sparkline` so unit + E2E suites can
   * locate the component without a per-callsite override.
   */
  testID?: string;
};

/**
 * Maximum number of bars rendered. We clamp to the most recent N points
 * so the bar count stays visually stable across counters even when the
 * caller passes longer history (e.g. 14-day windows).
 */
const MAX_BARS = 7;

/**
 * Resolve the bar fill color for the requested tone alias. Centralised
 * here so the mapping table stays adjacent to the React component (the
 * only file that needs to import `useThemedStyles` for color lookup).
 */
function resolveBarColor(tone: SparklineTone, tokens: ThemeTokens): string {
  switch (tone) {
    case "positive":
      return tokens.color.success;
    case "negative":
      return tokens.color.danger;
    case "neutral":
      return tokens.color.metaFg;
    default: {
      // Exhaustive switch guard — TypeScript will complain if a new
      // SparklineTone is added but not handled here.
      const _exhaustive: never = tone;
      void _exhaustive;
      return tokens.color.metaFg;
    }
  }
}

/**
 * Normalize the input series to exactly `MAX_BARS` points. Longer arrays
 * are truncated to the most recent window; shorter arrays are
 * left-padded with zeros so the bar count stays predictable. Returning a
 * fixed-length array also lets the React render path use stable keys
 * without `Math.random()` or array-index pitfalls.
 */
function normalizeSeries(points: number[]): number[] {
  if (points.length === 0) {
    return [];
  }
  if (points.length >= MAX_BARS) {
    return points.slice(points.length - MAX_BARS);
  }
  const padded: number[] = [];
  for (let i = 0; i < MAX_BARS - points.length; i += 1) {
    padded.push(0);
  }
  return padded.concat(points);
}

export function Sparkline(props: SparklineProps): React.JSX.Element | null {
  const {
    points,
    width = 60,
    height = 16,
    tone = "neutral",
    testID = "sparkline",
  } = props;

  const styles = useThemedStyles(buildStyles);
  const barColor = useThemedStyles((tokens) => resolveBarColor(tone, tokens));

  // Empty series -> render nothing. Caller decides whether to show a
  // placeholder or simply omit the trend.
  if (!Array.isArray(points) || points.length === 0) {
    return null;
  }

  const series = normalizeSeries(points);
  // Use the maximum value in the series as the scale denominator so the
  // tallest bar fills the available height. A flat-zero series falls
  // back to `1` so we still render the minimum-height baseline.
  const maxValue = Math.max(1, ...series);
  // Reserve 1px between bars for visual separation. The bar width is
  // computed from the remaining horizontal space so the component fits
  // within the requested `width` regardless of bar count.
  const gapPx = 1;
  const totalGap = gapPx * (series.length - 1);
  const barWidth = Math.max(1, (width - totalGap) / series.length);

  return (
    <View
      testID={testID}
      accessible={false}
      accessibilityElementsHidden={true}
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.row,
        { width, height },
      ]}
    >
      {series.map((point, idx) => {
        // Each bar's height is proportional to its value relative to the
        // series max. Minimum 1px so a zero point still shows a visible
        // baseline (otherwise an empty View collapses to nothing).
        const ratio = maxValue > 0 ? point / maxValue : 0;
        const barHeight = Math.max(1, Math.round(ratio * height));
        return (
          <View
            // The series is fixed-length and order-stable (oldest ->
            // newest); using the index as the key is safe here.
            key={`${testID}-bar-${idx}`}
            testID={`${testID}-bar-${idx}`}
            style={[
              styles.bar,
              {
                width: barWidth,
                height: barHeight,
                backgroundColor: barColor,
                marginLeft: idx === 0 ? 0 : gapPx,
              },
            ]}
          />
        );
      })}
    </View>
  );
}

function buildStyles(_tokens: ThemeTokens) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "flex-end",
      // Explicit `overflow: hidden` so a stray oversized bar can never
      // bleed past the requested bounding box.
      overflow: "hidden",
    },
    bar: {
      // 1px corner radius keeps the bar tops looking deliberate without
      // turning short bars into circles.
      borderRadius: 1,
    },
  });
}

export default Sparkline;

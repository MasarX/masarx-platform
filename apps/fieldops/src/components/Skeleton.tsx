import * as React from "react";
import { Animated, StyleSheet, View } from "react-native";

import { useThemedStyles } from "../mobile-theme-context";
import type { ThemeTokens } from "../mobile-theme";

// Composite skeleton variants match the geometry of the content they replace to minimize layout shifts. Colors, radii and spacing come from the active theme.

/** Skeleton shapes for rows, cards, chips and banners. The default remains a single pill. */
export type SkeletonVariant =
  | "pill"
  | "task-card"
  | "outbox-row"
  | "stop-card"
  | "chip"
  | "banner";

export type SkeletonProps = {
  width?: number | string;
  height?: number;
  radius?: number;
  testID?: string;
  style?: any;
  /** Optional placeholder shape for matching the receiving row or card layout. */
  variant?: SkeletonVariant;
};

export function Skeleton(props: SkeletonProps): React.JSX.Element {
  const {
    width = "100%",
    height = 12,
    radius = 6,
    testID = "skeleton",
    style,
    variant = "pill",
  } = props;
  const styles = useThemedStyles(buildStyles);
  const opacity = React.useRef(new Animated.Value(0.55)).current;

  React.useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.55,
          duration: 700,
          useNativeDriver: true,
        }),
      ])
    );
    try {
      loop.start();
    } catch {
      // Swallow animation-start failures in environments (e.g., jsdom)
      // where Animated backing is not wired. Component still renders.
    }
    return () => {
      try {
        loop.stop();
      } catch {
        // noop
      }
    };
  }, [opacity]);

  // Render the placeholder shape requested by the caller.
  if (variant !== "pill") {
    return (
      <Animated.View
        testID={testID}
        accessibilityRole="progressbar"
        accessibilityLabel="Loading"
        style={[{ opacity }, style]}
      >
        <SkeletonShellShape variant={variant} testID={testID} styles={styles} />
      </Animated.View>
    );
  }

  return (
    <Animated.View
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
      style={[
        styles.block,
        {
          width: width as any,
          height,
          borderRadius: radius,
          opacity,
        },
        style,
      ]}
    />
  );
}

/**
 * SkeletonShellShape — internal helper that renders the inner geometry of a
 * composite variant. Kept as a sibling component (rather than inlined in
 * Skeleton) so the variant dispatch reads like a flat switch and so unit
 * tests can target nested testIDs deterministically.
 *
 * Layout invariants per variant (load-bearing for unit tests):
 *
 *   "task-card"  → flexDirection: row; container has 4 inner shimmer Views:
 *                  avatar circle + (text row 1 + text row 2 inside a column)
 *                  + right-aligned meta chip.
 *   "outbox-row" → flexDirection: row; 3 inner shimmer Views: leading icon
 *                  + text row + right-aligned status chip.
 *   "stop-card"  → flexDirection: row; left-side column has 3 inner Views
 *                  (title + 2 meta rows); right side has 1 action-button
 *                  placeholder. Total: 4 inner shimmer Views.
 *   "chip"       → single capsule shimmer with pill radius.
 *   "banner"     → single wide horizontal strip with md radius.
 */
type ShellShapeProps = {
  variant: Exclude<SkeletonVariant, "pill">;
  testID: string;
  styles: ReturnType<typeof buildStyles>;
};

function SkeletonShellShape(props: ShellShapeProps): React.JSX.Element {
  const { variant, testID, styles } = props;

  if (variant === "task-card") {
    return (
      <View testID={`${testID}-shape`} style={styles.taskCard}>
        <View testID={`${testID}-avatar`} style={styles.taskCardAvatar} />
        <View testID={`${testID}-rows`} style={styles.taskCardRowGroup}>
          <View testID={`${testID}-row-0`} style={styles.taskCardRowPrimary} />
          <View testID={`${testID}-row-1`} style={styles.taskCardRowSecondary} />
        </View>
        <View testID={`${testID}-meta`} style={styles.taskCardMetaChip} />
      </View>
    );
  }

  if (variant === "outbox-row") {
    return (
      <View testID={`${testID}-shape`} style={styles.outboxRow}>
        <View testID={`${testID}-icon`} style={styles.outboxRowIcon} />
        <View testID={`${testID}-row-0`} style={styles.outboxRowText} />
        <View testID={`${testID}-chip`} style={styles.outboxRowChip} />
      </View>
    );
  }

  if (variant === "stop-card") {
    return (
      <View testID={`${testID}-shape`} style={styles.stopCard}>
        <View testID={`${testID}-rows`} style={styles.stopCardRowGroup}>
          <View testID={`${testID}-row-0`} style={styles.stopCardTitle} />
          <View testID={`${testID}-row-1`} style={styles.stopCardMeta1} />
          <View testID={`${testID}-row-2`} style={styles.stopCardMeta2} />
        </View>
        <View testID={`${testID}-action`} style={styles.stopCardAction} />
      </View>
    );
  }

  if (variant === "chip") {
    return <View testID={`${testID}-shape`} style={styles.chipShape} />;
  }

  // variant === "banner"
  return <View testID={`${testID}-shape`} style={styles.bannerShape} />;
}

export type SkeletonLineProps = {
  lines?: number;
  height?: number;
  gap?: number;
  widths?: Array<number | string>;
  testID?: string;
};

const DEFAULT_LINE_WIDTHS: Array<number | string> = ["90%", "70%", "50%"];

export function SkeletonLines(props: SkeletonLineProps): React.JSX.Element {
  const {
    lines = 3,
    height = 12,
    gap = 8,
    widths,
    testID = "skeleton-line",
  } = props;
  const styles = useThemedStyles(buildStyles);
  const count = Math.max(0, Math.floor(lines));
  const effectiveWidths =
    Array.isArray(widths) && widths.length > 0 ? widths : DEFAULT_LINE_WIDTHS;
  const rows: React.JSX.Element[] = [];
  for (let index = 0; index < count; index += 1) {
    const widthAtIndex =
      effectiveWidths[index] ??
      effectiveWidths[effectiveWidths.length - 1] ??
      "100%";
    rows.push(
      <Skeleton
        key={`line-${index}`}
        width={widthAtIndex}
        height={height}
        testID={`${testID}-${index}`}
        style={index === 0 ? null : { marginTop: gap }}
      />
    );
  }
  return (
    <View testID={testID} style={styles.lineWrap}>
      {rows}
    </View>
  );
}

export type SkeletonCardProps = { testID?: string };

export function SkeletonCard(props: SkeletonCardProps): React.JSX.Element {
  const { testID = "skeleton-card" } = props;
  const styles = useThemedStyles(buildStyles);
  return (
    <View testID={testID} style={styles.card}>
      <Skeleton
        width="60%"
        height={14}
        radius={6}
        testID={`${testID}-title`}
      />
      <Skeleton
        width="92%"
        height={10}
        radius={6}
        testID={`${testID}-line-1`}
        style={{ marginTop: 10 }}
      />
      <Skeleton
        width="78%"
        height={10}
        radius={6}
        testID={`${testID}-line-2`}
        style={{ marginTop: 6 }}
      />
    </View>
  );
}

export type SkeletonListProps = { rows?: number; testID?: string };

export function SkeletonList(props: SkeletonListProps): React.JSX.Element {
  const { rows = 3, testID = "skeleton-list" } = props;
  const styles = useThemedStyles(buildStyles);
  const count = Math.max(0, Math.floor(rows));
  const items: React.JSX.Element[] = [];
  for (let index = 0; index < count; index += 1) {
    items.push(
      <View
        key={`row-${index}`}
        style={index === 0 ? null : { marginTop: 10 }}
      >
        <SkeletonCard testID={`${testID}-card-${index}`} />
      </View>
    );
  }
  return (
    <View testID={testID} style={styles.list}>
      {items}
    </View>
  );
}

// Resolve the skeleton palette and spacing together from the active theme.
function buildStyles(tokens: ThemeTokens) {
  // Common shimmer rectangle background — every nested rectangle reuses the
  // same `borderMuted` tone for visual consistency with the existing pill
  // default. Centralized here so a token change is single-touch.
  const blockBg = tokens.color.borderMuted;

  // Common small-block radius for inner text-row rectangles. `radius.sm / 2`
  // keeps the rectangles visually crisp without crossing into the pill range
  // that would suggest a tappable element.
  const innerRadius = Math.max(2, Math.round(tokens.radius.sm / 4));

  return StyleSheet.create({
    block: {
      backgroundColor: blockBg,
    },
    lineWrap: {
      flexDirection: "column",
    },
    card: {
      backgroundColor: tokens.color.cardBgSubtle,
      borderRadius: tokens.radius.md,
      padding: tokens.spacing.lg,
    },
    list: {
      flexDirection: "column",
    },
    // Task card placeholder with an avatar, two text rows and trailing metadata.
    taskCard: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: tokens.color.cardBg,
      borderRadius: tokens.radius.md,
      padding: tokens.spacing.sm,
      gap: tokens.spacing.sm,
    },
    taskCardAvatar: {
      width: tokens.spacing.xl + tokens.spacing.md,
      height: tokens.spacing.xl + tokens.spacing.md,
      borderRadius: tokens.radius.pill,
      backgroundColor: blockBg,
    },
    taskCardRowGroup: {
      flex: 1,
      flexDirection: "column",
      gap: tokens.spacing.xs,
    },
    taskCardRowPrimary: {
      height: tokens.font.scale.md,
      width: "70%",
      borderRadius: innerRadius,
      backgroundColor: blockBg,
    },
    taskCardRowSecondary: {
      height: tokens.font.scale.sm,
      width: "50%",
      borderRadius: innerRadius,
      backgroundColor: blockBg,
    },
    taskCardMetaChip: {
      width: tokens.spacing.xl + tokens.spacing.lg,
      height: tokens.spacing.lg,
      borderRadius: innerRadius,
      backgroundColor: blockBg,
    },
    // Outbox row placeholder with a leading glyph, a text row and a status chip.
    outboxRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: tokens.color.cardBg,
      borderRadius: tokens.radius.sm,
      padding: tokens.spacing.sm,
      gap: tokens.spacing.sm,
    },
    outboxRowIcon: {
      width: tokens.spacing.lg,
      height: tokens.spacing.lg,
      borderRadius: tokens.radius.sm,
      backgroundColor: blockBg,
    },
    outboxRowText: {
      flex: 1,
      height: tokens.font.scale.md,
      borderRadius: innerRadius,
      backgroundColor: blockBg,
    },
    outboxRowChip: {
      width: tokens.spacing.xl + tokens.spacing.md,
      height: tokens.spacing.lg,
      borderRadius: innerRadius,
      backgroundColor: blockBg,
    },
    // Stop card placeholder with a title, metadata and a trailing action.
    stopCard: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: tokens.color.cardBg,
      borderRadius: tokens.radius.md,
      padding: tokens.spacing.md,
      gap: tokens.spacing.md,
    },
    stopCardRowGroup: {
      flex: 1,
      flexDirection: "column",
      gap: tokens.spacing.xs,
    },
    stopCardTitle: {
      height: tokens.font.scale.lg,
      width: "60%",
      borderRadius: innerRadius,
      backgroundColor: blockBg,
    },
    stopCardMeta1: {
      height: tokens.font.scale.sm,
      width: "85%",
      borderRadius: innerRadius,
      backgroundColor: blockBg,
    },
    stopCardMeta2: {
      height: tokens.font.scale.sm,
      width: "45%",
      borderRadius: innerRadius,
      backgroundColor: blockBg,
    },
    stopCardAction: {
      width: tokens.spacing.xl + tokens.spacing.lg,
      height: tokens.spacing.xl + tokens.spacing.md,
      borderRadius: tokens.radius.sm,
      backgroundColor: blockBg,
    },
    // Small capsule placeholder for a status chip.
    chipShape: {
      width: tokens.spacing.xl + tokens.spacing.xl,
      height: tokens.spacing.lg + tokens.spacing.xs,
      borderRadius: tokens.radius.pill,
      backgroundColor: blockBg,
    },
    // Wide strip placeholder for an alert banner.
    bannerShape: {
      width: "100%",
      height: tokens.spacing.xl + tokens.spacing.lg,
      borderRadius: tokens.radius.md,
      backgroundColor: blockBg,
    },
  });
}

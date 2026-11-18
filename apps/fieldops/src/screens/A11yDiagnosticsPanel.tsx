import * as React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { A11yFinding, A11ySeverity } from "../mobile-a11y-audit";
import { useThemedStyles } from "../mobile-theme-context";
import type { ThemeTokens } from "../mobile-theme";

// Development builds can re-run the accessibility check from the diagnostics panel.

export type A11yDiagnosticsPanelProps = {
  /** Findings produced by `runA11yAudit(...)` in the parent screen. */
  findings: A11yFinding[];
  /** Re-runs the audit. Wired by the parent (e.g. MoreDashboardScreen). */
  onRefresh: () => void;
  /** Optional override for the root testID (defaults to `a11y-diagnostics-panel`). */
  testID?: string;
};

export type A11ySeverityCounts = {
  critical: number;
  major: number;
  minor: number;
  total: number;
};

const TOP_FINDING_LIMIT = 5;

/**
 * Pure helper: tally findings by severity. Exported so unit tests can verify
 * the count contract without rendering React (the panel itself is a dumb
 * renderer over this output).
 */
export function summarizeSeverityCounts(
  findings: A11yFinding[],
): A11ySeverityCounts {
  const counts: A11ySeverityCounts = {
    critical: 0,
    major: 0,
    minor: 0,
    total: 0,
  };
  if (!Array.isArray(findings)) return counts;
  for (const finding of findings) {
    if (!finding || typeof finding !== "object") continue;
    const severity = finding.severity;
    if (severity === "critical") counts.critical += 1;
    else if (severity === "major") counts.major += 1;
    else if (severity === "minor") counts.minor += 1;
    else continue;
    counts.total += 1;
  }
  return counts;
}

/**
 * Pure helper: returns the first N finding titles (criterion + message), in
 * the deterministic order produced by `runA11yAudit`. Exported so unit tests
 * can assert the contract without rendering React.
 */
export function topFindingTitles(
  findings: A11yFinding[],
  limit: number = TOP_FINDING_LIMIT,
): string[] {
  if (!Array.isArray(findings)) return [];
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (safeLimit === 0) return [];
  const out: string[] = [];
  for (const finding of findings) {
    if (out.length >= safeLimit) break;
    if (!finding || typeof finding !== "object") continue;
    const criterion = typeof finding.criterion === "string" ? finding.criterion : "";
    const message = typeof finding.message === "string" ? finding.message : "";
    const title = criterion && message ? `${criterion} — ${message}` : criterion || message;
    if (title) out.push(title);
  }
  return out;
}

function severityToneStyle(
  severity: A11ySeverity,
  styles: ReturnType<typeof buildPanelStyles>,
) {
  switch (severity) {
    case "critical":
      return { box: styles.severityBoxDanger, label: styles.severityLabelDanger };
    case "major":
      return { box: styles.severityBoxWarning, label: styles.severityLabelWarning };
    case "minor":
    default:
      return { box: styles.severityBoxInfo, label: styles.severityLabelInfo };
  }
}

export function A11yDiagnosticsPanel(
  props: A11yDiagnosticsPanelProps,
): React.JSX.Element {
  const { findings, onRefresh, testID } = props;
  const styles = useThemedStyles(buildPanelStyles);

  const counts = React.useMemo(() => summarizeSeverityCounts(findings), [findings]);
  const titles = React.useMemo(() => topFindingTitles(findings), [findings]);

  const criticalTone = severityToneStyle("critical", styles);
  const majorTone = severityToneStyle("major", styles);
  const minorTone = severityToneStyle("minor", styles);

  return (
    <View
      style={styles.card}
      testID={testID ?? "a11y-diagnostics-panel"}
      accessibilityLabel="Accessibility diagnostics panel"
    >
      <View style={styles.header}>
        <Text style={styles.title}>A11y diagnostics</Text>
        <Text
          style={styles.findingCount}
          testID="a11y-diagnostics-finding-count"
        >
          {`${counts.total} finding${counts.total === 1 ? "" : "s"}`}
        </Text>
      </View>

      <View style={styles.severityRow} testID="a11y-diagnostics-severity-row">
        <View
          style={[styles.severityBox, criticalTone.box]}
          testID="a11y-diagnostics-severity-critical"
        >
          <Text style={[styles.severityValue, criticalTone.label]}>
            {counts.critical}
          </Text>
          <Text style={[styles.severityLabel, criticalTone.label]}>Critical</Text>
        </View>
        <View
          style={[styles.severityBox, majorTone.box]}
          testID="a11y-diagnostics-severity-major"
        >
          <Text style={[styles.severityValue, majorTone.label]}>
            {counts.major}
          </Text>
          <Text style={[styles.severityLabel, majorTone.label]}>Major</Text>
        </View>
        <View
          style={[styles.severityBox, minorTone.box]}
          testID="a11y-diagnostics-severity-minor"
        >
          <Text style={[styles.severityValue, minorTone.label]}>
            {counts.minor}
          </Text>
          <Text style={[styles.severityLabel, minorTone.label]}>Minor</Text>
        </View>
      </View>

      {titles.length === 0 ? (
        <Text style={styles.emptyLabel} testID="a11y-diagnostics-empty">
          No findings — audit clean.
        </Text>
      ) : (
        <View style={styles.findingList} testID="a11y-diagnostics-finding-list">
          {titles.map((title, index) => (
            <Text
              key={`${index}-${title}`}
              style={styles.findingItem}
              testID={`a11y-diagnostics-finding-${index}`}
              numberOfLines={2}
            >
              {`${index + 1}. ${title}`}
            </Text>
          ))}
        </View>
      )}

      <Pressable
        style={styles.refreshButton}
        testID="a11y-diagnostics-refresh"
        accessibilityRole="button"
        accessibilityLabel="Refresh accessibility audit"
        onPress={onRefresh}
      >
        <Text style={styles.refreshLabel}>Refresh audit</Text>
      </Pressable>
    </View>
  );
}

function buildPanelStyles(tokens: ThemeTokens) {
  const { color, radius } = tokens;
  return StyleSheet.create({
    card: {
      backgroundColor: color.cardBg,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
      padding: 16,
      marginTop: 12,
      marginBottom: 12,
      gap: 12,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    title: {
      fontSize: 14,
      fontWeight: "700",
      color: color.text,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    findingCount: {
      fontSize: 12,
      fontWeight: "600",
      color: color.textMuted,
    },
    severityRow: {
      flexDirection: "row",
      gap: 8,
    },
    severityBox: {
      flex: 1,
      borderRadius: radius.sm,
      paddingVertical: 8,
      paddingHorizontal: 10,
      alignItems: "center",
    },
    severityBoxDanger: {
      backgroundColor: color.dangerSoft,
    },
    severityBoxWarning: {
      backgroundColor: color.warningSoft,
    },
    severityBoxInfo: {
      backgroundColor: color.infoSoft,
    },
    severityLabelDanger: {
      color: color.dangerFg,
    },
    severityLabelWarning: {
      color: color.warningFg,
    },
    severityLabelInfo: {
      color: color.infoFg,
    },
    severityValue: {
      fontSize: 18,
      fontWeight: "700",
    },
    severityLabel: {
      fontSize: 11,
      fontWeight: "600",
      marginTop: 2,
      textTransform: "uppercase",
      letterSpacing: 0.4,
    },
    findingList: {
      gap: 6,
    },
    findingItem: {
      fontSize: 12,
      color: color.text,
      lineHeight: 16,
    },
    emptyLabel: {
      fontSize: 12,
      color: color.textMuted,
      fontStyle: "italic",
    },
    refreshButton: {
      alignSelf: "flex-start",
      paddingHorizontal: 14,
      paddingVertical: 10,
      minHeight: 44,
      minWidth: 44,
      justifyContent: "center",
      borderRadius: radius.sm,
      backgroundColor: color.control,
    },
    refreshLabel: {
      color: color.controlText,
      fontSize: 13,
      fontWeight: "600",
    },
  });
}

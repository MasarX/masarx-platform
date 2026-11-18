import React from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { runA11yAudit, type A11yFinding } from "../mobile-a11y-audit";
import { A11yDiagnosticsPanel } from "./A11yDiagnosticsPanel";

export type MoreDashboardStats = {
  stopsCompletedToday: number;
  stopsTotalToday: number;
  codCollectedToday: number | null;
  currency: string | null;
  distanceKmToday: number | null;
  activeShiftMinutes: number | null;
  outboxPending: number;
  lastSyncedAt: string | null;
};

export type MoreDashboardStrings = {
  title: string;
  subtitle: string;
  stats_title: string;
  stat_stops_today: string;
  stat_cod_today: string;
  stat_distance_today: string;
  stat_shift_duration: string;
  stat_outbox_pending: string;
  stat_last_sync: string;
  section_preferences: string;
  section_help: string;
  shift_controls: string;
  account: string;
  sign_out: string;
  help_center: string;
  report_issue: string;
  app_version: (v: string) => string;
};

export type MoreDashboardProps = {
  stats: MoreDashboardStats;
  userEmail: string | null;
  roleLabel: string;
  tenantLabel: string | null;
  appVersion: string;
  shiftActive: boolean;
  onStartShift: () => void;
  onEndShift: () => void;
  onSignOut: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onReportIssue: () => void;
  strings: MoreDashboardStrings;
  testID?: string;
};

function formatStopsValue(stats: MoreDashboardStats): string {
  const completed = Math.max(0, Math.floor(stats.stopsCompletedToday));
  const total = Math.max(0, Math.floor(stats.stopsTotalToday));
  return `${completed}/${total}`;
}

function formatCodValue(stats: MoreDashboardStats): string {
  if (stats.codCollectedToday === null || stats.codCollectedToday === undefined) {
    return "-";
  }
  const amount = stats.codCollectedToday;
  const currency = stats.currency ?? "";
  return currency ? `${amount.toFixed(2)} ${currency}` : amount.toFixed(2);
}

function formatDistanceValue(stats: MoreDashboardStats): string {
  if (stats.distanceKmToday === null || stats.distanceKmToday === undefined) {
    return "-";
  }
  return `${stats.distanceKmToday.toFixed(1)} km`;
}

function formatShiftValue(stats: MoreDashboardStats): string {
  if (stats.activeShiftMinutes === null || stats.activeShiftMinutes === undefined) {
    return "-";
  }
  const mins = Math.max(0, Math.floor(stats.activeShiftMinutes));
  const hours = Math.floor(mins / 60);
  const remainder = mins % 60;
  if (hours === 0) return `${remainder}m`;
  return `${hours}h ${remainder}m`;
}

function formatOutboxValue(stats: MoreDashboardStats): string {
  return String(Math.max(0, Math.floor(stats.outboxPending)));
}

function formatLastSyncValue(stats: MoreDashboardStats): string {
  return stats.lastSyncedAt ?? "-";
}

export function MoreDashboardScreen(props: MoreDashboardProps): React.JSX.Element {
  const {
    stats,
    userEmail,
    roleLabel,
    tenantLabel,
    appVersion,
    shiftActive,
    onStartShift,
    onEndShift,
    onSignOut,
    onOpenSettings,
    onOpenHelp,
    onReportIssue,
    strings,
    testID,
  } = props;

  const shiftLabel = strings.shift_controls;
  const shiftButtonLabel = shiftActive ? "End shift" : "Start shift";

  // Development builds expose live accessibility check results without adding runtime checks to production.
  const [a11yFindings, setA11yFindings] = React.useState<A11yFinding[]>([]);
  const runAudit = React.useCallback(() => {
    if (!__DEV__) {
      setA11yFindings([]);
      return;
    }
    const findings = runA11yAudit({
      dom: {
        elements: [
          {
            tag: "Pressable",
            role: "button",
            accessibilityLabel: shiftLabel,
            accessibilityRole: "button",
            accessibilityState: null,
            text: shiftActive ? "End shift" : "Start shift",
            testID: "more-dashboard-action-shift",
            widthPx: 160,
            heightPx: 56,
            fontSize: 15,
            fgColor: "#ffffff",
            bgColor: "#1f2937",
          },
          {
            tag: "Pressable",
            role: "button",
            accessibilityLabel: strings.account,
            accessibilityRole: "button",
            accessibilityState: null,
            text: strings.account,
            testID: "more-dashboard-action-settings",
            widthPx: 160,
            heightPx: 56,
            fontSize: 15,
            fgColor: "#0b0f19",
            bgColor: "#ffffff",
          },
          {
            tag: "Pressable",
            role: "button",
            accessibilityLabel: strings.help_center,
            accessibilityRole: "button",
            accessibilityState: null,
            text: strings.help_center,
            testID: "more-dashboard-action-help",
            widthPx: 320,
            heightPx: 44,
            fontSize: 14,
            fgColor: "#111827",
            bgColor: "#ffffff",
          },
          {
            tag: "Pressable",
            role: "button",
            accessibilityLabel: strings.report_issue,
            accessibilityRole: "button",
            accessibilityState: null,
            text: strings.report_issue,
            testID: "more-dashboard-action-report",
            widthPx: 320,
            heightPx: 44,
            fontSize: 14,
            fgColor: "#111827",
            bgColor: "#ffffff",
          },
          {
            tag: "Pressable",
            role: "button",
            accessibilityLabel: strings.sign_out,
            accessibilityRole: "button",
            accessibilityState: null,
            text: strings.sign_out,
            testID: "more-dashboard-action-signout",
            widthPx: 320,
            heightPx: 44,
            fontSize: 14,
            fgColor: "#b91c1c",
            bgColor: "#ffffff",
          },
        ],
      },
    });
    setA11yFindings(findings);
  }, [shiftActive, shiftLabel, strings.account, strings.help_center, strings.report_issue, strings.sign_out]);

  React.useEffect(() => {
    if (!__DEV__) return;
    runAudit();
  }, [runAudit]);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      testID={testID ?? "more-dashboard-screen"}
    >
      <View style={styles.header} testID="more-dashboard-header">
        <Text style={styles.title} testID="more-dashboard-title">
          {strings.title}
        </Text>
        <Text style={styles.subtitle} testID="more-dashboard-subtitle">
          {strings.subtitle}
        </Text>
      </View>

      <View style={styles.card} testID="more-dashboard-hero-card">
        <Text style={styles.sectionTitle}>{strings.stats_title}</Text>
        <View style={styles.statsGrid}>
          <View style={styles.statCell} testID="more-dashboard-stat-stops">
            <Text style={styles.statLabel}>{strings.stat_stops_today}</Text>
            <Text style={styles.statValue}>{formatStopsValue(stats)}</Text>
          </View>
          <View style={styles.statCell} testID="more-dashboard-stat-cod">
            <Text style={styles.statLabel}>{strings.stat_cod_today}</Text>
            <Text style={styles.statValue}>{formatCodValue(stats)}</Text>
          </View>
          <View style={styles.statCell} testID="more-dashboard-stat-distance">
            <Text style={styles.statLabel}>{strings.stat_distance_today}</Text>
            <Text style={styles.statValue}>{formatDistanceValue(stats)}</Text>
          </View>
          <View style={styles.statCell} testID="more-dashboard-stat-shift">
            <Text style={styles.statLabel}>{strings.stat_shift_duration}</Text>
            <Text style={styles.statValue}>{formatShiftValue(stats)}</Text>
          </View>
        </View>
      </View>

      <View style={styles.card} testID="more-dashboard-secondary-card">
        <View style={styles.inlineRow} testID="more-dashboard-outbox">
          <Text style={styles.inlineLabel}>{strings.stat_outbox_pending}</Text>
          <Text style={styles.inlineValue}>{formatOutboxValue(stats)}</Text>
        </View>
        <View style={styles.inlineRow} testID="more-dashboard-last-sync">
          <Text style={styles.inlineLabel}>{strings.stat_last_sync}</Text>
          <Text style={styles.inlineValue}>{formatLastSyncValue(stats)}</Text>
        </View>
      </View>

      <View style={styles.card} testID="more-dashboard-identity-card">
        <Text style={styles.identityEmail} testID="more-dashboard-email">
          {userEmail ?? "-"}
        </Text>
        <View style={styles.identityChipRow}>
          <View style={styles.chip} testID="more-dashboard-role-chip">
            <Text style={styles.chipLabel}>{roleLabel}</Text>
          </View>
          {tenantLabel ? (
            <View style={styles.chip} testID="more-dashboard-tenant-chip">
              <Text style={styles.chipLabel}>{tenantLabel}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.identityVersion} testID="more-dashboard-version">
          {strings.app_version(appVersion)}
        </Text>
      </View>

      <View style={styles.actionsRow} testID="more-dashboard-actions">
        <Pressable
          style={[styles.buttonPrimary, styles.actionButton]}
          testID="more-dashboard-action-shift"
          accessibilityRole="button"
          accessibilityLabel={shiftLabel}
          onPress={shiftActive ? onEndShift : onStartShift}
        >
          <Text style={styles.buttonPrimaryLabel}>
            {shiftActive ? "End shift" : "Start shift"}
          </Text>
          <Text style={styles.buttonCaption}>{shiftButtonLabel}</Text>
        </Pressable>

        <Pressable
          style={[styles.buttonSecondary, styles.actionButton]}
          testID="more-dashboard-action-settings"
          accessibilityRole="button"
          accessibilityLabel={strings.account}
          onPress={onOpenSettings}
        >
          <Text style={styles.buttonSecondaryLabel}>{strings.account}</Text>
        </Pressable>
      </View>

      <View style={styles.card} testID="more-dashboard-help-card">
        <Text style={styles.sectionTitle}>{strings.section_help}</Text>
        <Pressable
          style={styles.linkRow}
          testID="more-dashboard-action-help"
          accessibilityRole="button"
          accessibilityLabel={strings.help_center}
          onPress={onOpenHelp}
        >
          <Text style={styles.linkLabel}>{strings.help_center}</Text>
        </Pressable>
        <Pressable
          style={styles.linkRow}
          testID="more-dashboard-action-report"
          accessibilityRole="button"
          accessibilityLabel={strings.report_issue}
          onPress={onReportIssue}
        >
          <Text style={styles.linkLabel}>{strings.report_issue}</Text>
        </Pressable>
        <Pressable
          style={styles.linkRow}
          testID="more-dashboard-action-signout"
          accessibilityRole="button"
          accessibilityLabel={strings.sign_out}
          onPress={onSignOut}
        >
          <Text style={[styles.linkLabel, styles.linkDanger]}>
            {strings.sign_out}
          </Text>
        </Pressable>
      </View>

      {__DEV__ ? (
        <A11yDiagnosticsPanel
          findings={a11yFindings}
          onRefresh={runAudit}
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#f5f6f8",
  },
  content: {
    padding: 16,
    paddingBottom: 32,
  },
  header: {
    marginBottom: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: "#0b0f19",
  },
  subtitle: {
    marginTop: 2,
    fontSize: 14,
    color: "#4b5563",
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#0b0f19",
    marginBottom: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  statCell: {
    width: "48%",
    paddingVertical: 8,
  },
  statLabel: {
    fontSize: 12,
    color: "#6b7280",
  },
  statValue: {
    marginTop: 2,
    fontSize: 20,
    fontWeight: "700",
    color: "#0b0f19",
  },
  inlineRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  inlineLabel: {
    fontSize: 13,
    color: "#6b7280",
  },
  inlineValue: {
    fontSize: 13,
    fontWeight: "600",
    color: "#0b0f19",
  },
  identityEmail: {
    fontSize: 15,
    fontWeight: "600",
    color: "#0b0f19",
  },
  identityChipRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
    flexWrap: "wrap",
  },
  chip: {
    backgroundColor: "#eef2ff",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipLabel: {
    fontSize: 12,
    color: "#3730a3",
    fontWeight: "600",
  },
  identityVersion: {
    marginTop: 12,
    fontSize: 12,
    color: "#6b7280",
  },
  actionsRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 12,
  },
  actionButton: {
    flex: 1,
    minHeight: 56,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    justifyContent: "center",
  },
  buttonPrimary: {
    backgroundColor: "#1f2937",
  },
  buttonPrimaryLabel: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "700",
  },
  buttonCaption: {
    color: "#d1d5db",
    fontSize: 11,
    marginTop: 2,
  },
  buttonSecondary: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#d1d5db",
    alignItems: "center",
  },
  buttonSecondaryLabel: {
    color: "#0b0f19",
    fontSize: 15,
    fontWeight: "600",
  },
  linkRow: {
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: "#f3f4f6",
  },
  linkLabel: {
    fontSize: 14,
    color: "#111827",
    fontWeight: "500",
  },
  linkDanger: {
    color: "#b91c1c",
  },
});

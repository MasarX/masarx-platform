// Mobile V2 More screen — driver "More" tab per AGENTS.md mobile policy
// contract. Surfaces: sync/outbox state, display preferences (theme +
// locale + density + direction), access context (role + capabilities),
// diagnostics entry, sign-out. All row-driven via props so the screen
// stays render-pure.

import * as React from "react";
import { Pressable, ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxButton, FxCard, FxChip, FxCol, FxRow, FxSectionHead, FxStatusDot } from "./mobile-v2-primitives";
import {
  MOBILE_V2_MORE_SUPPORT_ACTIONS,
  type MobileV2MoreSupportActionId,
} from "./mobile-v2-more-actions";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
  type MobileV2ThemeKey,
} from "./mobile-v2-themes";

export interface MobileV2MoreOutboxEntry {
  readonly id: string;
  readonly label: string;
  readonly status: "queued" | "in-flight" | "failed";
  readonly ageMin: number;
}

export interface MobileV2DriverShiftPanel {
  readonly activeOpsSessionId: string | null;
  readonly openedAt: string | null;
  readonly canStart: boolean;
  readonly isMutating: boolean;
  readonly readinessLabel: string;
  readonly onStartShift?: () => void;
  readonly onEndShift?: () => void;
}

export interface MobileV2LoaderSessionPanel {
  readonly activeOpsSessionId: string | null;
  readonly bay: string | null;
  readonly waveLabel: string | null;
  readonly routeLabel: string | null;
  readonly cutOff: string | null;
  readonly canStart: boolean;
  readonly isMutating: boolean;
  readonly readinessLabel: string;
  readonly onStartSession?: () => void;
}

export interface MobileV2MoreScreenProps {
  readonly theme: MobileV2Theme;
  readonly activeThemeKey: MobileV2ThemeKey;
  readonly availableThemeKeys: ReadonlyArray<MobileV2ThemeKey>;
  readonly onSelectTheme: (key: MobileV2ThemeKey) => void;
  readonly activeRole: string;
  readonly availableRoles: ReadonlyArray<string>;
  readonly onSelectRole: (role: string) => void;
  readonly capabilities: ReadonlyArray<string>;
  readonly online: boolean;
  readonly outbox: ReadonlyArray<MobileV2MoreOutboxEntry>;
  readonly onSyncNow?: () => void;
  readonly onOpenIncident?: () => void;
  readonly onOpenDiagnostics?: () => void;
  readonly onSignOut?: () => void;
  readonly driverShift?: MobileV2DriverShiftPanel;
  readonly loaderSession?: MobileV2LoaderSessionPanel;
  readonly userName: string;
  readonly userBadge: string;
  /** #600: set while the live profile read loads or has failed; the card shows it instead of an identity. */
  readonly identityState?: MobileV2MoreIdentityState;
  /** #600: set when the shell gave no device state; sync and outbox show it instead of values. */
  readonly deviceStateUnknownLabel?: string;
  readonly style?: StyleProp<ViewStyle>;
}

export type MobileV2MoreIdentityState =
  | { readonly kind: "loading"; readonly label: string }
  | { readonly kind: "error"; readonly message: string; readonly retryLabel: string; readonly onRetry: () => void };

/** #600: the drawer header shows the profile read's loading or error state, never a stale or demo name. */
export function resolveMobileV2DrawerIdentity(
  name: string,
  badge: string,
  state: MobileV2MoreIdentityState | undefined,
): { readonly name: string; readonly employeeId?: string } {
  if (state === undefined) return { name, employeeId: badge };
  return { name: state.kind === "loading" ? state.label : state.message };
}

const SECTION_HEAD_STYLE = {
  fontSize: 10,
  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
  letterSpacing: 0.8,
  textTransform: "uppercase" as const,
  fontFamily: MOBILE_V2_FONT_SANS,
  paddingHorizontal: MOBILE_V2_SPACING.xs,
};

export function MobileV2MoreScreen(props: MobileV2MoreScreenProps): React.ReactElement {
  const { theme } = props;
  const queuedCount = props.outbox.filter((o) => o.status === "queued").length;
  const inFlightCount = props.outbox.filter((o) => o.status === "in-flight").length;
  const failedCount = props.outbox.filter((o) => o.status === "failed").length;
  const outboxSegments = [
    queuedCount > 0 ? `${queuedCount} queued` : null,
    inFlightCount > 0 ? `${inFlightCount} in-flight` : null,
    failedCount > 0 ? `${failedCount} failed` : null,
  ].filter((segment): segment is string => segment !== null);
  const outboxLabel = props.deviceStateUnknownLabel
    ?? (outboxSegments.length > 0 ? outboxSegments.join(" · ") : "clear");
  const syncLabel = props.deviceStateUnknownLabel ?? (props.online ? "Online" : "Offline");
  const statusDot = props.deviceStateUnknownLabel !== undefined ? "pending" : props.online ? "current" : "failed";
  const supportActionHandlers: Readonly<Record<MobileV2MoreSupportActionId, (() => void) | undefined>> = {
    "report-incident": props.onOpenIncident,
    diagnostics: props.onOpenDiagnostics,
    "sign-out": props.onSignOut,
  };

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView
        contentContainerStyle={{
          padding: MOBILE_V2_SPACING["3xl"],
          rowGap: MOBILE_V2_SPACING["2xl"],
          paddingBottom: 96,
        }}
      >
        {/* Identity */}
        <FxCard theme={theme} padding={14}>
          <FxRow gap={MOBILE_V2_SPACING.md} align="center">
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                backgroundColor: theme.accentSoft,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text
                style={{
                  color: theme.accent,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  fontSize: 14,
                }}
              >
                {props.userName.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase()}
              </Text>
            </View>
            {props.identityState !== undefined ? (
              <FxCol gap={MOBILE_V2_SPACING.md} style={{ flex: 1, minWidth: 0, alignItems: "flex-start" }}>
                <Text
                  accessibilityLiveRegion="polite"
                  style={{ fontSize: 13, color: theme.muted, fontFamily: MOBILE_V2_FONT_SANS, textAlign: "auto" }}
                >
                  {props.identityState.kind === "loading" ? props.identityState.label : props.identityState.message}
                </Text>
                {props.identityState.kind === "error" ? (
                  <FxButton
                    theme={theme}
                    variant="soft"
                    size="sm"
                    onPress={props.identityState.onRetry}
                    accessibilityLabel={props.identityState.retryLabel}
                  >
                    {props.identityState.retryLabel}
                  </FxButton>
                ) : null}
              </FxCol>
            ) : (
            <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
                numberOfLines={1}
              >
                {props.userName}
              </Text>
              <Text
                style={{
                  fontSize: 11,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_MONO,
                }}
              >
                {props.userBadge} · {props.activeRole}
              </Text>
            </FxCol>
            )}
            <FxStatusDot theme={theme} kind={statusDot} size={10} />
          </FxRow>
        </FxCard>

        {/* Sync / outbox */}
        <FxCol gap={MOBILE_V2_SPACING.md}>
          <Text style={[SECTION_HEAD_STYLE, { color: theme.muted }]}>
            Sync · {syncLabel}
          </Text>
          <FxCard theme={theme} padding={14}>
            <FxRow justify="space-between" align="center" gap={MOBILE_V2_SPACING.md}>
              <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Outbox · {outboxLabel}
                </Text>
                <Text
                  style={{
                    fontSize: 11,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {props.outbox.length === 0
                    ? "All writes in sync with the cloud."
                    : inFlightCount > 0
                      ? "Writes are syncing now."
                      : "Queued writes will flush on next online window."}
                </Text>
              </FxCol>
              <FxButton
                theme={theme}
                variant="soft"
                size="sm"
                icon="cloud-up"
                onPress={props.onSyncNow}
                accessibilityLabel="Sync now"
              >
                Sync now
              </FxButton>
            </FxRow>
            {props.outbox.slice(0, 3).map((o) => (
              <FxRow
                key={o.id}
                justify="space-between"
                align="center"
                style={{
                  paddingTop: MOBILE_V2_SPACING.md,
                  borderTopColor: theme.border,
                  borderTopWidth: 1,
                  marginTop: MOBILE_V2_SPACING.md,
                }}
              >
                <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{
                      fontSize: 12,
                      color: theme.ink,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                    numberOfLines={1}
                  >
                    {o.label}
                  </Text>
                  <Text
                    style={{
                      fontSize: 10.5,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_MONO,
                    }}
                  >
                    {o.ageMin}m ago
                  </Text>
                </FxCol>
                <FxChip
                  theme={theme}
                  tone={o.status === "failed" ? "danger" : o.status === "in-flight" ? "info" : "neutral"}
                  dense
                >
                  {o.status}
                </FxChip>
              </FxRow>
            ))}
          </FxCard>
        </FxCol>

        {props.driverShift !== undefined ? (
          <FxCol gap={MOBILE_V2_SPACING.md}>
            <Text style={[SECTION_HEAD_STYLE, { color: theme.muted }]}>Driver shift</Text>
            <FxCard theme={theme} padding={14}>
              <FxCol gap={MOBILE_V2_SPACING.md}>
                <FxRow justify="space-between" align="center" gap={MOBILE_V2_SPACING.md}>
                  <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={{
                        fontSize: 13,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                        color: theme.ink,
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                    >
                      {props.driverShift.activeOpsSessionId !== null
                        ? `Shift active${props.driverShift.openedAt ? ` since ${props.driverShift.openedAt}` : ""}`
                        : "No active driver shift on this device."}
                    </Text>
                    <Text
                      style={{
                        fontSize: 11,
                        color: theme.muted,
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                    >
                      Readiness: {props.driverShift.readinessLabel}
                    </Text>
                  </FxCol>
                  <FxStatusDot
                    theme={theme}
                    kind={props.driverShift.activeOpsSessionId !== null ? "done" : props.driverShift.canStart ? "current" : "pending"}
                    size={10}
                  />
                </FxRow>
                {props.driverShift.activeOpsSessionId !== null ? (
                  <FxChip theme={theme} tone="success" dense mono>
                    {props.driverShift.activeOpsSessionId}
                  </FxChip>
                ) : null}
                <FxRow gap={MOBILE_V2_SPACING.sm} wrap>
                  <FxButton
                    theme={theme}
                    variant="primary"
                    size="sm"
                    icon="check"
                    onPress={props.driverShift.onStartShift}
                    disabled={
                      props.driverShift.activeOpsSessionId !== null ||
                      !props.driverShift.canStart ||
                      props.driverShift.isMutating
                    }
                    accessibilityLabel="Start shift"
                    testID="mobile-v2-start-driver-shift"
                  >
                    {props.driverShift.isMutating && props.driverShift.activeOpsSessionId === null
                      ? "Starting..."
                      : "Start shift"}
                  </FxButton>
                  <FxButton
                    theme={theme}
                    variant="soft"
                    size="sm"
                    icon="x"
                    onPress={props.driverShift.onEndShift}
                    disabled={
                      props.driverShift.activeOpsSessionId === null ||
                      props.driverShift.isMutating
                    }
                    accessibilityLabel="End shift"
                    testID="mobile-v2-end-driver-shift"
                  >
                    {props.driverShift.isMutating && props.driverShift.activeOpsSessionId !== null
                      ? "Ending..."
                      : "End shift"}
                  </FxButton>
                </FxRow>
              </FxCol>
            </FxCard>
          </FxCol>
        ) : null}

        {props.loaderSession !== undefined ? (
          <FxCol gap={MOBILE_V2_SPACING.md}>
            <Text style={[SECTION_HEAD_STYLE, { color: theme.muted }]}>Loader session</Text>
            <FxCard theme={theme} padding={14}>
              <FxCol gap={MOBILE_V2_SPACING.md}>
                <FxRow justify="space-between" align="center" gap={MOBILE_V2_SPACING.md}>
                  <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={{
                        fontSize: 13,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                        color: theme.ink,
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                    >
                      {props.loaderSession.activeOpsSessionId !== null
                        ? "Warehouse scan session active"
                        : "No active warehouse scan session on this device."}
                    </Text>
                    <Text
                      style={{
                        fontSize: 11,
                        color: theme.muted,
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                    >
                      Readiness: {props.loaderSession.readinessLabel}
                    </Text>
                  </FxCol>
                  <FxStatusDot
                    theme={theme}
                    kind={props.loaderSession.activeOpsSessionId !== null ? "done" : props.loaderSession.canStart ? "current" : "pending"}
                    size={10}
                  />
                </FxRow>
                <FxRow gap={MOBILE_V2_SPACING.sm} wrap>
                  {props.loaderSession.bay !== null ? (
                    <FxChip theme={theme} tone="info" dense mono>
                      Bay {props.loaderSession.bay}
                    </FxChip>
                  ) : null}
                  {props.loaderSession.waveLabel !== null ? (
                    <FxChip theme={theme} tone="neutral" dense mono>
                      {props.loaderSession.waveLabel}
                    </FxChip>
                  ) : null}
                  {props.loaderSession.routeLabel !== null ? (
                    <FxChip theme={theme} tone="neutral" dense mono>
                      {props.loaderSession.routeLabel}
                    </FxChip>
                  ) : null}
                  {props.loaderSession.cutOff !== null ? (
                    <FxChip theme={theme} tone="warning" dense mono>
                      Cut-off {props.loaderSession.cutOff}
                    </FxChip>
                  ) : null}
                </FxRow>
                {props.loaderSession.activeOpsSessionId !== null ? (
                  <FxChip theme={theme} tone="success" dense mono>
                    {props.loaderSession.activeOpsSessionId}
                  </FxChip>
                ) : null}
                <FxButton
                  theme={theme}
                  variant="primary"
                  size="sm"
                  icon="scan"
                  onPress={props.loaderSession.onStartSession}
                  disabled={
                    props.loaderSession.activeOpsSessionId !== null ||
                    !props.loaderSession.canStart ||
                    props.loaderSession.isMutating
                  }
                  accessibilityLabel="Start loader warehouse scan session"
                  testID="mobile-v2-start-loader-session"
                >
                  {props.loaderSession.isMutating && props.loaderSession.activeOpsSessionId === null
                    ? "Starting..."
                    : "Start loader session"}
                </FxButton>
              </FxCol>
            </FxCard>
          </FxCol>
        ) : null}

        {/* Display preferences */}
        <FxCol gap={MOBILE_V2_SPACING.md}>
          <Text style={[SECTION_HEAD_STYLE, { color: theme.muted }]}>Display</Text>
          <FxCard theme={theme} padding={14}>
            <FxCol gap={MOBILE_V2_SPACING.md}>
              <FxCol gap={MOBILE_V2_SPACING.xs}>
                <Text
                  style={{
                    fontSize: 11,
                    color: theme.muted,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    letterSpacing: 0.4,
                    textTransform: "uppercase",
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Theme
                </Text>
                <FxRow gap={MOBILE_V2_SPACING.sm} wrap>
                  {props.availableThemeKeys.map((key) => {
                    const on = props.activeThemeKey === key;
                    return (
                      <Pressable
                        key={key}
                        onPress={() => props.onSelectTheme(key)}
                        accessibilityRole="button"
                        accessibilityLabel={`Theme ${key}`}
                        style={{
                          backgroundColor: on ? theme.accentSoft : theme.surfaceAlt,
                          borderColor: on ? theme.accent : theme.border,
                          borderWidth: 1,
                          borderRadius: 999,
                          paddingHorizontal: 12,
                          paddingVertical: 6,
                        }}
                      >
                        <Text
                          style={{
                            fontSize: 12,
                            color: on ? theme.accent : theme.ink,
                            fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                            fontFamily: MOBILE_V2_FONT_SANS,
                            textTransform: "capitalize",
                          }}
                        >
                          {key}
                        </Text>
                      </Pressable>
                    );
                  })}
                </FxRow>
              </FxCol>
            </FxCol>
          </FxCard>
        </FxCol>

        {/* Role + access */}
        <FxCol gap={MOBILE_V2_SPACING.md}>
          <Text style={[SECTION_HEAD_STYLE, { color: theme.muted }]}>Active role</Text>
          <FxCard theme={theme} padding={14}>
            <FxCol gap={MOBILE_V2_SPACING.md}>
              <FxRow gap={MOBILE_V2_SPACING.sm} wrap>
                {props.availableRoles.map((r) => {
                  const on = props.activeRole === r;
                  return (
                    <Pressable
                      key={r}
                      onPress={() => props.onSelectRole(r)}
                      accessibilityRole="button"
                      accessibilityLabel={`Switch to ${r}`}
                      style={{
                        backgroundColor: on ? theme.accentSoft : theme.surfaceAlt,
                        borderColor: on ? theme.accent : theme.border,
                        borderWidth: 1,
                        borderRadius: 999,
                        paddingHorizontal: 12,
                        paddingVertical: 6,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 12,
                          color: on ? theme.accent : theme.ink,
                          fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                          fontFamily: MOBILE_V2_FONT_SANS,
                          textTransform: "capitalize",
                        }}
                      >
                        {r}
                      </Text>
                    </Pressable>
                  );
                })}
              </FxRow>
              <FxCol gap={MOBILE_V2_SPACING.xs}>
                <Text
                  style={{
                    fontSize: 11,
                    color: theme.muted,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    letterSpacing: 0.4,
                    textTransform: "uppercase",
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Capabilities · {props.capabilities.length}
                </Text>
                <FxRow gap={6} wrap>
                  {props.capabilities.map((c) => (
                    <FxChip key={c} theme={theme} tone="neutral" dense mono>
                      {c}
                    </FxChip>
                  ))}
                </FxRow>
              </FxCol>
            </FxCol>
          </FxCard>
        </FxCol>

        {/* Support actions */}
        <FxCol gap={MOBILE_V2_SPACING.md}>
          <Text style={[SECTION_HEAD_STYLE, { color: theme.muted }]}>Support</Text>
          {MOBILE_V2_MORE_SUPPORT_ACTIONS.map((action) => {
            const handler = supportActionHandlers[action.id];
            if (handler === undefined) {
              return null;
            }

            return (
              <FxButton
                key={action.id}
                theme={theme}
                variant="ghost"
                full
                icon={action.icon}
                onPress={handler}
                accessibilityLabel={action.accessibilityLabel}
              >
                {action.label}
              </FxButton>
            );
          })}
        </FxCol>
      </ScrollView>
    </View>
  );
}

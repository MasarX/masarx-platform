// Mobile V2 Profile screen — pixel-faithful port of design source
// flow-today.jsx ScrProfile. Driver "Me" hub: avatar + identity hero
// with KYC/rating/streak chips, today stats strip (Delivered/Failed/COD/
// On-time%), personal details rows, identity & document rows with
// status + expiry chips, vehicle section (driver/rider only), account &
// app rows, and a help/sign-out footer.

import * as React from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { FxAvatar, FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import { formatMobileV2CurrencyCompact } from "./mobile-v2-ops-helpers";
import type { FxChipTone } from "./mobile-v2-primitives-styles";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import {
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2ProfileRole = "driver" | "loader" | "rider" | "supervisor";

export type MobileV2ProfileDocStatus = "approved" | "uploaded" | "rejected" | "pending";

export interface MobileV2ProfileStats {
  readonly deliveredToday: number;
  readonly failedToday: number;
  readonly codToday: number;
  readonly onTimeRate: number;
  readonly rating: number;
  readonly streakDays: number;
}

export interface MobileV2ProfileIdentity {
  readonly employeeId: string;
  readonly name: string;
  readonly username: string;
  readonly phone: string;
  readonly email: string;
  readonly address: string;
  readonly dob: string;
  readonly vehicle?: string;
  readonly emergencyContactName?: string;
  readonly emergencyContactPhone?: string;
  readonly emergencyContactRelation?: string;
  readonly bankIban?: string;
  readonly bankName?: string;
}

export interface MobileV2ProfileDocument {
  readonly id: string;
  readonly icon: MobileV2IconName;
  readonly label: string;
  readonly sub: string;
  readonly status: MobileV2ProfileDocStatus;
  /** ISO date for the expiry chip; null when N/A (e.g. vehicle photos). */
  readonly expiryIso: string | null;
}

export interface MobileV2ProfileAppStatus {
  readonly languageLabel: string;
  readonly languageSub: string;
  readonly securityLabel: string;
  readonly securitySub: string;
  readonly notificationLabel: string;
  readonly appearanceLabel: string;
  readonly permissionsLabel: string;
}

export interface MobileV2ProfileScreenProps {
  readonly theme: MobileV2Theme;
  readonly role: MobileV2ProfileRole;
  readonly identity: MobileV2ProfileIdentity;
  readonly stats: MobileV2ProfileStats;
  readonly documents: ReadonlyArray<MobileV2ProfileDocument>;
  readonly appStatus: MobileV2ProfileAppStatus;
  readonly accountId: string;
  readonly appVersion: string;
  /** ISO currency code, defaults to "SAR". */
  readonly currency?: string;
  readonly onEditProfile?: () => void;
  readonly onOpenAvatar?: () => void;
  readonly onOpenQr?: () => void;
  readonly onOpenShift?: () => void;
  readonly onOpenEmergency?: () => void;
  readonly onOpenBank?: () => void;
  readonly onReuploadDocs?: () => void;
  readonly onSelectDocument?: (id: string) => void;
  readonly onOpenLanguage?: () => void;
  readonly onOpenSecurity?: () => void;
  readonly onOpenNotifications?: () => void;
  readonly onOpenAppearance?: () => void;
  readonly onOpenPermissions?: () => void;
  readonly onOpenHelp?: () => void;
  readonly onOpenAbout?: () => void;
  readonly onSignOut?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

const ROLE_LABEL: Readonly<Record<MobileV2ProfileRole, string>> = Object.freeze({
  driver: "Driver",
  loader: "Hub loader",
  rider: "Rider",
  supervisor: "Supervisor",
});

const DOC_STATUS_META: Readonly<
  Record<MobileV2ProfileDocStatus, { readonly label: string; readonly tone: FxChipTone; readonly icon: MobileV2IconName }>
> = Object.freeze({
  approved: Object.freeze({ label: "Approved", tone: "success", icon: "check" }),
  uploaded: Object.freeze({ label: "In review", tone: "info", icon: "clock" }),
  rejected: Object.freeze({ label: "Rejected", tone: "danger", icon: "alert" }),
  pending: Object.freeze({ label: "Required", tone: "warning", icon: "plus" }),
});

interface ExpiryChip {
  readonly label: string;
  readonly tone: FxChipTone;
}

function resolveExpiryChip(expiryIso: string | null): ExpiryChip | null {
  if (expiryIso === null) return null;
  const expiry = Date.parse(expiryIso);
  if (Number.isNaN(expiry)) return null;
  const days = Math.round((expiry - Date.now()) / 86_400_000);
  if (days < 0) return { label: "Expired · renew now", tone: "danger" };
  if (days <= 30) return { label: `Expires in ${days}d`, tone: "warning" };
  if (days <= 90) return { label: `Expires in ${Math.round(days / 30)}mo`, tone: "info" };
  return null;
}

function ProfStatCell(props: {
  readonly theme: MobileV2Theme;
  readonly value: string;
  readonly label: string;
  readonly tone: "default" | "danger" | "warning" | "success" | "accent";
  readonly first?: boolean;
}): React.ReactElement {
  const { theme: t } = props;
  const color =
    props.tone === "danger"
      ? t.danger
      : props.tone === "warning"
        ? t.warning
        : props.tone === "success"
          ? t.success
          : props.tone === "accent"
            ? t.accent
            : t.ink;
  return (
    <View
      style={{
        flex: 1,
        paddingVertical: 14,
        paddingHorizontal: 4,
        borderLeftWidth: props.first === true ? 0 : 1,
        borderLeftColor: t.border,
        alignItems: "center",
      }}
    >
      <Text
        style={{
          fontSize: 18,
          fontWeight: "800",
          color,
          lineHeight: 18,
          fontFamily: MOBILE_V2_FONT_SANS,
        }}
      >
        {props.value}
      </Text>
      <Text
        style={{
          fontSize: 10,
          color: t.muted,
          fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          marginTop: 4,
          fontFamily: MOBILE_V2_FONT_SANS,
        }}
      >
        {props.label}
      </Text>
    </View>
  );
}

function RowKV(props: {
  readonly theme: MobileV2Theme;
  readonly icon: MobileV2IconName;
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
  readonly tone?: "default" | "danger" | "warning" | "success";
  readonly onPress?: () => void;
  readonly accessibilityLabel: string;
}): React.ReactElement {
  const { theme: t } = props;
  const valueColor =
    props.tone === "danger"
      ? t.danger
      : props.tone === "warning"
        ? t.warning
        : props.tone === "success"
          ? t.success
          : t.ink;
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderTopColor: t.border,
        borderTopWidth: 1,
        flexDirection: "row",
        alignItems: "center",
        columnGap: MOBILE_V2_SPACING["2xl"],
      }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          backgroundColor: t.surfaceAlt,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <FxIcon name={props.icon} size={16} color={t.muted} />
      </View>
      <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={{
            fontSize: 11,
            color: t.muted,
            fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
            letterSpacing: 0.3,
            textTransform: "uppercase",
            fontFamily: MOBILE_V2_FONT_SANS,
          }}
        >
          {props.label}
        </Text>
        <Text
          style={{
            fontSize: 13,
            color: valueColor,
            fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
            fontFamily: MOBILE_V2_FONT_SANS,
          }}
          numberOfLines={1}
        >
          {props.value || "—"}
        </Text>
        {props.sub !== undefined ? (
          <Text
            style={{
              fontSize: 11,
              color: t.muted,
              fontFamily: MOBILE_V2_FONT_SANS,
            }}
            numberOfLines={1}
          >
            {props.sub}
          </Text>
        ) : null}
      </FxCol>
      <FxIcon name="chevron-right" size={16} color={t.muted} />
    </Pressable>
  );
}

function ProfSection(props: {
  readonly theme: MobileV2Theme;
  readonly label: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly children: React.ReactNode;
}): React.ReactElement {
  const { theme: t } = props;
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 18, rowGap: MOBILE_V2_SPACING.lg }}>
      <FxRow justify="space-between" align="center">
        <Text
          style={{
            fontSize: 11,
            color: t.muted,
            fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            fontFamily: MOBILE_V2_FONT_SANS,
          }}
        >
          {props.label}
        </Text>
        {props.actionLabel !== undefined && props.onAction !== undefined ? (
          <Pressable
            onPress={props.onAction}
            accessibilityRole="button"
            accessibilityLabel={`${props.actionLabel} for ${props.label}`}
          >
            <Text
              style={{
                fontSize: 11,
                color: t.accent,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              {props.actionLabel} →
            </Text>
          </Pressable>
        ) : null}
      </FxRow>
      <FxCard theme={t} padding={0}>
        {props.children}
      </FxCard>
    </View>
  );
}

export function MobileV2ProfileScreen(
  props: MobileV2ProfileScreenProps,
): React.ReactElement {
  const { theme, identity, stats, documents, appStatus, role } = props;
  // COD stat label uses the resolved currency symbol (SAR → ﷼) — the
  // canonical FieldOps Mobile V2 design symbol (`flow-today.jsx` ScrProfile
  // renders the stat label "COD ﷼"). Resolved via the centralized
  // formatter so no symbol literal is hardcoded.
  const currencySymbol =
    formatMobileV2CurrencyCompact(0, props.currency ?? "SAR").split(" ")[1] ?? "SAR";
  const initials = identity.name
    .split(" ")
    .map((p) => p.charAt(0))
    .join("")
    .slice(0, 2);
  const roleLabel = ROLE_LABEL[role];
  const showVehicle = role === "driver" || role === "rider";

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 96 }}>
        {/* In-body header block stripped — the gallery / host ScreenShell now
            renders the title ("Me") and subtitle (employeeId · role · vehicle)
            via FxAppBar. */}

        {/* Hero */}
        <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
          <FxCard theme={theme} padding={16}>
            <FxRow gap={MOBILE_V2_SPACING["3xl"]} align="flex-start">
              <Pressable
                onPress={props.onOpenAvatar}
                accessibilityRole="button"
                accessibilityLabel="Change profile photo"
                style={{ position: "relative" }}
              >
                <FxAvatar theme={theme} name={initials} size={64} />
                {/* Camera-icon edit overlay — design canvas ScrProfile renders
                    a 24px yellow disk anchored bottom-right of the avatar
                    (flow-today.jsx:193-195) so the affordance is visible at
                    a glance. */}
                <View
                  style={{
                    position: "absolute",
                    right: -2,
                    bottom: -2,
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    backgroundColor: theme.accent,
                    alignItems: "center",
                    justifyContent: "center",
                    borderWidth: 2,
                    borderColor: theme.surface,
                  }}
                >
                  <FxIcon name="camera" size={12} color={theme.accentInk} />
                </View>
              </Pressable>
              <FxCol gap={MOBILE_V2_SPACING.sm} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: 16,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                  numberOfLines={1}
                >
                  {identity.name}
                </Text>
                <Text
                  style={{
                    fontSize: 12,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                  numberOfLines={1}
                >
                  @{identity.username} · {identity.phone}
                </Text>
                <FxRow
                  gap={MOBILE_V2_SPACING.md}
                  wrap
                  style={{ marginTop: MOBILE_V2_SPACING.md, rowGap: MOBILE_V2_SPACING.md }}
                >
                  <FxChip theme={theme} tone="success" dense icon="check">
                    KYC verified
                  </FxChip>
                  <FxChip theme={theme} tone="info" dense icon="star">
                    {stats.rating.toFixed(1)}★
                  </FxChip>
                  <FxChip theme={theme} tone="accent" dense icon="flame">
                    {stats.streakDays}d streak
                  </FxChip>
                </FxRow>
              </FxCol>
            </FxRow>
            <FxRow gap={MOBILE_V2_SPACING.md} style={{ marginTop: MOBILE_V2_SPACING["3xl"] }}>
              {/* Design canvas ScrMe (flow-today.jsx:210-211) renders
                  "Edit profile" as a `soft` (neutral) button and "My ID"
                  as a `ghost` button. A prior workaround routed both
                  through `chrome` because the impl `soft` variant was
                  yellow-tinted; with `soft` restored to the design's
                  neutral tokens this matches the canvas directly. */}
              <FxButton
                theme={theme}
                variant="soft"
                size="sm"
                icon="user"
                onPress={props.onEditProfile}
                accessibilityLabel="Edit profile details"
                full
                style={{ flex: 1 }}
              >
                Edit profile
              </FxButton>
              <FxButton
                theme={theme}
                variant="ghost"
                size="sm"
                icon="qr"
                onPress={props.onOpenQr}
                accessibilityLabel="Show my QR code"
              >
                My ID
              </FxButton>
            </FxRow>
          </FxCard>
        </View>

        {/* Today stats */}
        <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
          <FxRow justify="space-between" style={{ marginBottom: 8 }}>
            <Text
              style={{
                fontSize: 11,
                color: theme.muted,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              Today
            </Text>
            <Pressable onPress={props.onOpenShift} accessibilityRole="button" accessibilityLabel="Open today shift">
              <Text
                style={{
                  fontSize: 11,
                  color: theme.accent,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                Open shift →
              </Text>
            </Pressable>
          </FxRow>
          <FxCard theme={theme} padding={0}>
            <FxRow align="stretch">
              <ProfStatCell theme={theme} value={String(stats.deliveredToday)} label="Delivered" tone="success" first />
              <ProfStatCell theme={theme} value={String(stats.failedToday)} label="Failed" tone="warning" />
              <ProfStatCell theme={theme} value={String(stats.codToday)} label={`COD ${currencySymbol}`} tone="accent" />
              <ProfStatCell theme={theme} value={`${stats.onTimeRate}%`} label="On-time" tone="default" />
            </FxRow>
          </FxCard>
        </View>

        {/* Personal details */}
        <ProfSection theme={theme} label="Personal details" actionLabel="Edit" onAction={props.onEditProfile}>
          <RowKV
            theme={theme}
            icon="phone"
            label="Mobile"
            value={identity.phone}
            onPress={props.onEditProfile}
            accessibilityLabel="Edit mobile number"
          />
          <RowKV
            theme={theme}
            icon="message"
            label="Email"
            value={identity.email}
            onPress={props.onEditProfile}
            accessibilityLabel="Edit email address"
          />
          <RowKV
            theme={theme}
            icon="pin"
            label="Address"
            value={identity.address}
            onPress={props.onEditProfile}
            accessibilityLabel="Edit home address"
          />
          <RowKV
            theme={theme}
            icon="user"
            label="Date of birth"
            value={identity.dob}
            onPress={props.onEditProfile}
            accessibilityLabel="Edit date of birth"
          />
          <RowKV
            theme={theme}
            icon="phone"
            label="Emergency contact"
            value={`${identity.emergencyContactName ?? "—"} · ${identity.emergencyContactPhone ?? "—"}`}
            sub={identity.emergencyContactRelation ?? undefined}
            onPress={props.onOpenEmergency}
            accessibilityLabel="Edit emergency contact"
          />
          <RowKV
            theme={theme}
            icon="cash"
            label="Bank for payouts"
            value={identity.bankIban ?? "—"}
            sub={identity.bankName ?? undefined}
            onPress={props.onOpenBank}
            accessibilityLabel="Edit bank for payouts"
          />
        </ProfSection>

        {/* Identity & documents */}
        <ProfSection
          theme={theme}
          label="Identity & documents"
          actionLabel="Re-upload all"
          onAction={props.onReuploadDocs}
        >
          {documents.map((d) => {
            const statusMeta = DOC_STATUS_META[d.status];
            const expiry = resolveExpiryChip(d.expiryIso);
            return (
              <Pressable
                key={d.id}
                onPress={() => props.onSelectDocument?.(d.id)}
                accessibilityRole="button"
                accessibilityLabel={`Document: ${d.label}, ${statusMeta.label}`}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  borderTopColor: theme.border,
                  borderTopWidth: 1,
                }}
              >
                <FxRow gap={MOBILE_V2_SPACING["2xl"]} align="flex-start">
                  <View
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 9,
                      backgroundColor: theme.surfaceAlt,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <FxIcon name={d.icon} size={18} color={theme.muted} />
                  </View>
                  <FxCol gap={3} style={{ flex: 1, minWidth: 0 }}>
                    <FxRow justify="space-between" align="center">
                      <Text
                        style={{
                          fontSize: 13,
                          fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                          color: theme.ink,
                          fontFamily: MOBILE_V2_FONT_SANS,
                          flex: 1,
                          minWidth: 0,
                        }}
                        numberOfLines={1}
                      >
                        {d.label}
                      </Text>
                      <FxChip
                        theme={theme}
                        dense
                        tone={statusMeta.tone}
                        icon={statusMeta.icon}
                      >
                        {statusMeta.label}
                      </FxChip>
                    </FxRow>
                    <Text
                      style={{
                        fontSize: 11.5,
                        color: theme.muted,
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                      numberOfLines={1}
                    >
                      {d.sub}
                    </Text>
                    {expiry !== null ? (
                      <FxChip theme={theme} dense tone={expiry.tone} icon="clock">
                        {expiry.label}
                      </FxChip>
                    ) : null}
                  </FxCol>
                  <View style={{ marginTop: 10 }}>
                    <FxIcon name="chevron-right" size={16} color={theme.muted} />
                  </View>
                </FxRow>
              </Pressable>
            );
          })}
        </ProfSection>

        {/* Vehicle */}
        {showVehicle ? (
          <ProfSection theme={theme} label="Vehicle">
            <RowKV
              theme={theme}
              icon="truck"
              label="Plate"
              value={identity.vehicle ?? "—"}
              onPress={props.onEditProfile}
              accessibilityLabel="Update vehicle"
            />
          </ProfSection>
        ) : null}

        {/* Account & app */}
        <ProfSection theme={theme} label="Account & app">
          <RowKV
            theme={theme}
            icon="globe"
            label="Language"
            value={appStatus.languageLabel}
            sub={appStatus.languageSub}
            onPress={props.onOpenLanguage}
            accessibilityLabel="Change language"
          />
          <RowKV
            theme={theme}
            icon="shield"
            label="Security"
            value={appStatus.securityLabel}
            sub={appStatus.securitySub}
            onPress={props.onOpenSecurity}
            accessibilityLabel="Open security settings"
          />
          <RowKV
            theme={theme}
            icon="info"
            label="Notifications"
            value={appStatus.notificationLabel}
            onPress={props.onOpenNotifications}
            accessibilityLabel="Change notification settings"
          />
          <RowKV
            theme={theme}
            icon="sun"
            label="Appearance"
            value={appStatus.appearanceLabel}
            onPress={props.onOpenAppearance}
            accessibilityLabel="Change appearance"
          />
          <RowKV
            theme={theme}
            icon="shield"
            label="Permissions"
            value={appStatus.permissionsLabel}
            onPress={props.onOpenPermissions}
            accessibilityLabel="Review permissions"
          />
        </ProfSection>

        {/* Help + sign-out */}
        <View style={{ paddingHorizontal: 16, paddingTop: 18, paddingBottom: 28 }}>
          <FxCard theme={theme} padding={0}>
            <Pressable
              onPress={props.onOpenHelp}
              accessibilityRole="button"
              accessibilityLabel="Open help and support"
              style={{
                paddingHorizontal: 16,
                paddingVertical: 14,
                flexDirection: "row",
                alignItems: "center",
                columnGap: MOBILE_V2_SPACING["2xl"],
                backgroundColor: theme.surface,
              }}
            >
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 9,
                  backgroundColor: theme.surfaceAlt,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <FxIcon name="message" size={16} color={theme.muted} />
              </View>
              <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Help & support
                </Text>
                <Text
                  style={{
                    fontSize: 11,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Chat dispatch · policies · escalations
                </Text>
              </FxCol>
              <FxIcon name="chevron-right" size={16} color={theme.muted} />
            </Pressable>
            <Pressable
              onPress={props.onOpenAbout}
              accessibilityRole="button"
              accessibilityLabel="About FieldOps"
              style={{
                paddingHorizontal: 16,
                paddingVertical: 14,
                flexDirection: "row",
                alignItems: "center",
                columnGap: MOBILE_V2_SPACING["2xl"],
                backgroundColor: theme.surface,
                borderTopColor: theme.border,
                borderTopWidth: 1,
              }}
            >
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 9,
                  backgroundColor: theme.surfaceAlt,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <FxIcon name="info" size={16} color={theme.muted} />
              </View>
              <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  About
                </Text>
                <Text
                  style={{
                    fontSize: 11,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {props.appVersion} · acc {props.accountId}
                </Text>
              </FxCol>
              <FxIcon name="chevron-right" size={16} color={theme.muted} />
            </Pressable>
          </FxCard>

          <FxButton
            theme={theme}
            variant="ghost"
            full
            icon="logout"
            onPress={props.onSignOut}
            accessibilityLabel="Sign out"
            style={{ marginTop: MOBILE_V2_SPACING["3xl"] }}
          >
            Sign out
          </FxButton>
        </View>
      </ScrollView>
    </View>
  );
}

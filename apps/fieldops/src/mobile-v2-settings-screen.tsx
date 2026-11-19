// Mobile V2 Settings screen — pixel-faithful port of design source
// flow-extras.jsx ScrSettings. Single screen organised into three
// sections (App / Shift / Help) with row-level actions; the design
// source presents granular changes (language, permissions, notifications,
// break, cash drop, incident, support) via bottom sheets — the screen
// itself emits row-callbacks so each can be wired to the host shell
// without nesting navigation.

import * as React from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { FxCol, FxRow, FxSectionHead } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import {
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2SettingsLanguage {
  /** Display label, e.g. "العربية" / "English". */
  readonly label: string;
  /** Canonical id, e.g. "ar-SA" / "en-US". */
  readonly id: string;
  /** Direction tag; informs the row sub. */
  readonly direction: "ltr" | "rtl";
}

export interface MobileV2SettingsNotificationPrefs {
  readonly onCount: number;
  readonly totalCount: number;
}

export interface MobileV2SettingsShiftStatus {
  readonly breakDurationMin: number;
  readonly cashCollectedDisplay: string;
}

export interface MobileV2SettingsAccount {
  readonly employeeId: string;
  readonly dispatchOnline: boolean;
}

export interface MobileV2SettingsScreenProps {
  readonly theme: MobileV2Theme;
  readonly language: MobileV2SettingsLanguage;
  readonly notifications: MobileV2SettingsNotificationPrefs;
  readonly shift: MobileV2SettingsShiftStatus;
  readonly account: MobileV2SettingsAccount;
  readonly onOpenLanguage?: () => void;
  readonly onOpenPermissions?: () => void;
  readonly onOpenNotifications?: () => void;
  readonly onOpenBreak?: () => void;
  readonly onOpenCashDrop?: () => void;
  readonly onOpenIncident?: () => void;
  readonly onOpenSupport?: () => void;
  readonly onOpenHelp?: () => void;
  readonly onSignOut?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

interface SettingsRowProps {
  readonly theme: MobileV2Theme;
  readonly icon: MobileV2IconName;
  readonly label: string;
  readonly sub?: string;
  readonly onPress?: () => void;
  readonly accessibilityLabel: string;
}

// Design ScrSettings (flow-extras.jsx:845-851) renders every row with the
// same `row()` helper — default ink label, no per-row tone. The standalone
// Settings screen has no destructive-styled row (the red Sign out treatment
// is exclusive to the side-menu/drawer surface).
function SettingsRow(props: SettingsRowProps): React.ReactElement {
  const { theme: t } = props;
  const labelColor = t.ink;
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      style={{
        flexDirection: "row",
        alignItems: "center",
        columnGap: MOBILE_V2_SPACING["2xl"],
        paddingHorizontal: 16,
        paddingVertical: 14,
        backgroundColor: t.surface,
      }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 9,
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
            fontSize: 13.5,
            fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
            color: labelColor,
            fontFamily: MOBILE_V2_FONT_SANS,
          }}
          numberOfLines={1}
        >
          {props.label}
        </Text>
        {props.sub !== undefined ? (
          // Pin the sub-line LTR so an embedded currency glyph (e.g. the
          // Cash drop row's "0 ﷼ collected today") cannot resolve the run
          // RTL and render the rial sign ﷼ (U+FDFC) symbol-first. Every
          // settings sub-line is short LTR content, so this is safe.
          // react-native-web forwards `dir` to the DOM node; RN's
          // TextProps omits it.
          <Text
            // @ts-expect-error — `dir` is a valid RN-Web Text prop.
            dir="ltr"
            style={{
              fontSize: 11,
              color: t.muted,
              fontFamily: MOBILE_V2_FONT_SANS,
              textAlign: "left",
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

// Design FxSectionHead (_kit.jsx) padding: 14px top / 16px horizontal /
// 6px bottom. The impl FxSectionHead primitive carries only a small
// vertical pad, so the Settings screen — now edge-to-edge — applies the
// full design inset locally.
const SECTION_HEAD_INSET = {
  paddingTop: MOBILE_V2_SPACING["3xl"],
  paddingHorizontal: MOBILE_V2_SPACING["4xl"],
  paddingBottom: MOBILE_V2_SPACING.md,
} as const;

// Design ScrSettings groups rows in a full-bleed `FxCol gap={1}` over a
// border-toned background — a flat edge-to-edge list with hairline
// dividers, not a rounded inset card.
function RowGroup(props: { readonly theme: MobileV2Theme; readonly children: React.ReactNode }): React.ReactElement {
  return (
    <View style={{ backgroundColor: props.theme.border, rowGap: 1 }}>
      {props.children}
    </View>
  );
}

export function MobileV2SettingsScreen(
  props: MobileV2SettingsScreenProps,
): React.ReactElement {
  const { theme, language, notifications, shift, account } = props;

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      {/* Design ScrSettings (flow-extras.jsx:854) is an edge-to-edge list:
          no outer horizontal padding — the FxSectionHead and each row own
          their own 16px inset, and the sections are full-bleed. The design
          ScreenShell content area opens with a 14px gap above the first
          section head. */}
      <ScrollView
        contentContainerStyle={{
          paddingTop: MOBILE_V2_SPACING["3xl"],
          paddingBottom: 96,
        }}
      >
        {/* In-body header stripped — the gallery / host ScreenShell now
            renders the title ("Settings") via FxAppBar. */}

        {/* App — design canvas s-settings artboard has 3 rows: Language /
            Permissions / Notifications. Units + Appearance are exposed
            through dedicated screens (display prefs) rather than as
            top-level settings rows. */}
        <FxSectionHead theme={theme} label="App" style={SECTION_HEAD_INSET} />
        <RowGroup theme={theme}>
          <SettingsRow
            theme={theme}
            // Design canvas ScrSettings (flow-extras.jsx:857) uses the
            // `globe` icon for the Language row in the standalone Settings
            // screen — the prior comment cited flow-today.jsx (ScrProfile)
            // which is a different screen with its own Account & app section
            // and a `lang` icon there. The `s-settings` route in the gallery
            // renders ScrSettings, so we follow that SSOT here.
            icon="globe"
            label="Language"
            sub={language.label}
            onPress={props.onOpenLanguage}
            accessibilityLabel="Change language"
          />
          <SettingsRow
            theme={theme}
            icon="shield"
            label="Permissions"
            sub="Camera · Location · Notifications"
            onPress={props.onOpenPermissions}
            accessibilityLabel="Review permissions"
          />
          <SettingsRow
            theme={theme}
            // Design canvas ScrSettings (flow-today.jsx:300) uses
            // dedicated `bell` icon for Notifications, not `info`.
            // Catalog entry added 2026-05-13 in
            // `mobile-v2-icon-specs.ts`.
            icon="bell"
            label="Notifications"
            sub={`${notifications.onCount}/${notifications.totalCount} on`}
            onPress={props.onOpenNotifications}
            accessibilityLabel="Notification preferences"
          />
        </RowGroup>

        {/* Shift */}
        <FxSectionHead theme={theme} label="Shift" style={SECTION_HEAD_INSET} />
        <RowGroup theme={theme}>
          <SettingsRow
            theme={theme}
            // Design SSOT flow-extras.jsx:863 uses `pause` for this row
            // (it's the affordance to enter the Take-a-break sheet whose
            // primary CTA is also `pause`). The canvas renders the pause
            // glyph as a circle at this small size; we follow SSOT.
            icon="pause"
            label="Take a break"
            sub={`${shift.breakDurationMin}-min mandatory`}
            onPress={props.onOpenBreak}
            accessibilityLabel="Start a break"
          />
          <SettingsRow
            theme={theme}
            icon="cash"
            label="Cash drop"
            sub={`${shift.cashCollectedDisplay} collected today`}
            onPress={props.onOpenCashDrop}
            accessibilityLabel="Hand over cash"
          />
          <SettingsRow
            theme={theme}
            icon="alert"
            label="Report incident"
            sub="Collision, theft, breakdown"
            onPress={props.onOpenIncident}
            accessibilityLabel="Report incident"
          />
        </RowGroup>

        {/* Help */}
        <FxSectionHead theme={theme} label="Help" style={SECTION_HEAD_INSET} />
        <RowGroup theme={theme}>
          <SettingsRow
            theme={theme}
            icon="message"
            label="Dispatch chat"
            sub={account.dispatchOnline ? "Online · usually replies in 1 min" : "Offline · queues messages"}
            onPress={props.onOpenSupport}
            accessibilityLabel="Open dispatch chat"
          />
          <SettingsRow
            theme={theme}
            icon="doc"
            label="Help articles"
            sub="POD · COD · escalation policies"
            onPress={props.onOpenHelp}
            accessibilityLabel="Open help articles"
          />
          <SettingsRow
            theme={theme}
            icon="logout"
            label="Sign out"
            sub={account.employeeId}
            onPress={props.onSignOut}
            // Design ScrSettings (flow-extras.jsx:871) renders Sign out with
            // the plain `row()` helper — default ink, no danger tint. The red
            // logout treatment lives only in the separate side-menu/drawer
            // surface (app-shell.jsx:277), not in standalone Settings.
            accessibilityLabel="Sign out"
          />
        </RowGroup>
      </ScrollView>
    </View>
  );
}

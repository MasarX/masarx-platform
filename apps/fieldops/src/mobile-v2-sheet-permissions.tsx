// Mobile V2 Permissions sheet — pixel-faithful port of design source
// flow-extras.jsx SheetPermissions. Lists OS permissions the FieldOps app
// needs, with current grant status and a Request CTA for the not-yet-
// granted ones. The list of permissions is policy-driven
// (`mobile_permissions_policy`); items can be marked required (cannot be
// dismissed) and the orchestrator surfaces the OS prompt via onRequest.

import * as React from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import type { FxChipTone } from "./mobile-v2-primitives-styles";
import { MobileV2BottomSheet } from "./mobile-v2-bottom-sheet";
import {
  MOBILE_V2_DIMENSIONS,
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2PermissionStatus = "granted" | "denied" | "pending";

export interface MobileV2PermissionItem {
  readonly id: string;
  readonly label: string;
  readonly status: MobileV2PermissionStatus;
  readonly required: boolean;
  /**
   * Descriptive sub-line shown under the label (e.g. "POD photos, parcel
   * scan, ID match"). When provided, it replaces the default
   * Required/Optional sub copy. Design canvas SheetPermissions artboard
   * renders descriptive subs only; production cutover resolves these via
   * `mobile_permissions_policy.<id>.description`.
   */
  readonly description?: string;
  /**
   * Per-item canonical icon for the leading disk. Design canvas
   * SheetPermissions artboard uses camera/pin/bell/mic/box per row
   * (flow-extras.jsx:763-769); when omitted the impl falls back to
   * the status-based generic icon (`check` granted, `shield` otherwise)
   * for back-compat. Production cutover resolves this via
   * `mobile_permissions_policy.<id>.icon`.
   */
  readonly icon?: MobileV2IconName;
}

export interface MobileV2PermissionsSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly items: ReadonlyArray<MobileV2PermissionItem>;
  readonly onRequest: (id: string) => void;
  /**
   * Whether to render the "Denied permissions can be re-enabled from
   * the device Settings app." helper row at the bottom of the sheet.
   * Defaults to `true` for production parity. Design canvas
   * SheetPermissions artboard omits the helper row, so the audit
   * gallery preview opts out via `helperEnabled={false}`. Production
   * cutover resolves this via `mobile_permissions_policy.show_helper`.
   */
  readonly helperEnabled?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}

function chipToneForStatus(s: MobileV2PermissionStatus): FxChipTone {
  return s === "granted" ? "success" : s === "pending" ? "warning" : "danger";
}

function chipLabelForStatus(s: MobileV2PermissionStatus): string {
  return s === "granted" ? "Granted" : s === "pending" ? "Tap to allow" : "Denied";
}

export function MobileV2PermissionsSheet(
  props: MobileV2PermissionsSheetProps,
): React.ReactElement {
  const { theme } = props;
  const helperEnabled = props.helperEnabled !== false;

  return (
    <MobileV2BottomSheet
      theme={theme}
      visible={props.visible}
      onClose={props.onClose}
      title="Permissions"
      subtitle="Required for field work · review or remediate"
      style={props.style}
    >
      <FxCol gap={MOBILE_V2_SPACING.md} style={{ paddingVertical: MOBILE_V2_SPACING.lg }}>
        {props.items.map((it) => {
          const interactive = it.status !== "granted";
          const tone = chipToneForStatus(it.status);
          const iconBg =
            it.status === "granted"
              ? theme.successSoft
              : it.status === "pending"
                ? theme.warningSoft
                : theme.dangerSoft;
          const iconFg =
            it.status === "granted"
              ? theme.success
              : it.status === "pending"
                ? theme.warning
                : theme.danger;

          return (
            <Pressable
              key={it.id}
              onPress={interactive ? () => props.onRequest(it.id) : undefined}
              accessibilityRole="button"
              accessibilityLabel={`${it.label} permission · ${chipLabelForStatus(it.status)}`}
              accessibilityState={{ disabled: !interactive }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                columnGap: MOBILE_V2_SPACING["2xl"],
                paddingVertical: MOBILE_V2_SPACING["2xl"],
                paddingHorizontal: MOBILE_V2_SPACING["3xl"],
                backgroundColor: theme.surface,
                borderColor: theme.border,
                borderWidth: 1,
                borderRadius: MOBILE_V2_RADII.button,
              }}
            >
              <View
                style={{
                  width: MOBILE_V2_DIMENSIONS.sheetTypeIcon,
                  height: MOBILE_V2_DIMENSIONS.sheetTypeIcon,
                  borderRadius: MOBILE_V2_RADII.iconDisk,
                  backgroundColor: iconBg,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <FxIcon
                  // Per-item canonical icon when fixture supplies one
                  // (matches design SSOT camera/pin/bell/mic/box rows);
                  // status-based fallback keeps legacy callers working
                  // and degrades cleanly when the policy doesn't carry
                  // an icon hint yet.
                  name={
                    it.icon ?? (it.status === "granted" ? "check" : "shield")
                  }
                  size={16}
                  color={iconFg}
                />
              </View>
              <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: MOBILE_V2_TYPE_SIZES.rowLabel,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {it.label}
                </Text>
                <Text
                  style={{
                    fontSize: MOBILE_V2_TYPE_SIZES.label,
                    color: theme.muted,
                    fontFamily: it.description ? MOBILE_V2_FONT_SANS : MOBILE_V2_FONT_MONO,
                  }}
                >
                  {it.description ?? (it.required ? "Required" : "Optional")}
                </Text>
              </FxCol>
              <FxChip theme={theme} tone={tone} dense>
                {chipLabelForStatus(it.status)}
              </FxChip>
            </Pressable>
          );
        })}

        {helperEnabled ? (
          <FxRow gap={MOBILE_V2_SPACING.md} align="center" style={{ marginTop: MOBILE_V2_SPACING.sm }}>
            <FxIcon name="info" size={12} color={theme.muted} />
            <Text
              style={{
                fontSize: MOBILE_V2_TYPE_SIZES.label,
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_SANS,
                flex: 1,
              }}
            >
              Denied permissions can be re-enabled from the device Settings app.
            </Text>
          </FxRow>
        ) : null}
      </FxCol>
    </MobileV2BottomSheet>
  );
}

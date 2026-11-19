// Mobile V2 Role Select screen — pixel-faithful port of design source
// flow-auth.jsx ScrRoleSelect. Driver/loader (or both) picker shown
// after login when the account has multiple roles available. Single-
// choice selection (radio behavior) — the chosen role becomes the
// active shift role.
//
// Stateless: parent owns the option list, current selection, and the
// signed-in summary (employee id + display name).

import * as React from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2RoleOption {
  readonly id: string;
  readonly icon: MobileV2IconName;
  readonly title: string;
  readonly sub: string;
}

export interface MobileV2RoleSelectScreenProps {
  readonly theme: MobileV2Theme;
  readonly availableRoles: ReadonlyArray<MobileV2RoleOption>;
  readonly selectedRoleId: string | null;
  /** Display name for "Start shift as <X>" CTA — typically the picked option's title. */
  readonly startCtaLabel?: string;
  /** Signed-in user summary rendered at the bottom: "<Employee ID> · <Name>". */
  readonly employeeId: string;
  readonly displayName: string;
  readonly onSelect: (id: string) => void;
  readonly onStart: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

export function MobileV2RoleSelectScreen(
  props: MobileV2RoleSelectScreenProps,
): React.ReactElement {
  const { theme, availableRoles, selectedRoleId } = props;
  const valid = selectedRoleId !== null && selectedRoleId.length > 0;
  const multiRole = availableRoles.length > 1;
  const headingText = `Pick your role${multiRole ? "s" : ""}`;
  const subtitleText = multiRole
    ? "Select one to start. Switch any time from the side menu."
    : "Confirm to begin your shift.";
  const selectedOption = availableRoles.find((r) => r.id === selectedRoleId) ?? null;
  const ctaLabel =
    props.startCtaLabel !== undefined && props.startCtaLabel.length > 0
      ? props.startCtaLabel
      : selectedOption?.title ?? availableRoles[0]?.title ?? "";

  return (
    <View
      style={[
        {
          flex: 1,
          backgroundColor: theme.bg,
          paddingHorizontal: MOBILE_V2_SPACING["6xl"],
          paddingTop: MOBILE_V2_SPACING["6xl"],
          paddingBottom: MOBILE_V2_SPACING["5xl"],
        },
        props.style,
      ]}
    >
      {/* In-body header — design ScrRoleSelect (flow-auth.jsx:165-167)
          renders the title + subtitle inside the screen body, not an
          app bar: 22px/700 heading, -0.4 tracking, 13px muted subtitle. */}
      <Text
        style={{
          fontSize: 22,
          fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
          letterSpacing: -0.4,
          color: theme.ink,
          fontFamily: MOBILE_V2_FONT_SANS,
        }}
      >
        {headingText}
      </Text>
      <Text
        style={{
          fontSize: 13,
          color: theme.muted,
          fontFamily: MOBILE_V2_FONT_SANS,
          marginTop: MOBILE_V2_SPACING.sm,
        }}
      >
        {subtitleText}
      </Text>
      <ScrollView
        style={{ flex: 1, marginTop: 20 }}
        contentContainerStyle={{ rowGap: MOBILE_V2_SPACING.xl, paddingBottom: MOBILE_V2_SPACING["4xl"] }}
        keyboardShouldPersistTaps="handled"
      >
        {availableRoles.map((r) => {
          const on = r.id === selectedRoleId;
          return (
            <Pressable
              key={r.id}
              onPress={() => props.onSelect(r.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${r.title} — ${r.sub}`}
            >
              <FxCard theme={theme} accent={on}>
                <FxRow gap={14}>
                  <View
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 12,
                      backgroundColor: on ? theme.accent : theme.accentSoft,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <FxIcon
                      name={r.icon}
                      size={22}
                      color={on ? theme.accentInk : theme.accent}
                    />
                  </View>
                  <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={{
                        fontSize: 15,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                        color: theme.ink,
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                    >
                      {r.title}
                    </Text>
                    <Text
                      style={{
                        fontSize: 12,
                        color: theme.muted,
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                    >
                      {r.sub}
                    </Text>
                  </FxCol>
                  {on ? (
                    <FxChip theme={theme} tone="accent" dense icon="check">
                      Selected
                    </FxChip>
                  ) : (
                    <FxIcon name="chevron-right" size={18} color={theme.muted} />
                  )}
                </FxRow>
              </FxCard>
            </Pressable>
          );
        })}
      </ScrollView>

      <FxButton
        theme={theme}
        variant={valid ? "chrome" : "soft"}
        full
        size="lg"
        iconRight="arrow-right"
        disabled={!valid}
        onPress={() => valid && props.onStart()}
        accessibilityLabel={`Start shift as ${ctaLabel}`}
      >
        Start shift as {ctaLabel}
      </FxButton>
      <Text
        style={{
          fontSize: 11,
          color: theme.muted,
          fontFamily: MOBILE_V2_FONT_SANS,
          textAlign: "center",
          marginTop: MOBILE_V2_SPACING.xl,
        }}
      >
        Signed in as{" "}
        <Text
          style={{
            color: theme.ink,
            fontFamily: MOBILE_V2_FONT_MONO,
            fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
          }}
        >
          {props.employeeId} · {props.displayName}
        </Text>
      </Text>
    </View>
  );
}

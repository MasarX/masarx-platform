// Mobile V2 Transfer sheet — pixel-faithful port of design source
// flow-extras.jsx SheetTransfer. Inter-bay/hub transfer scan: loader
// picks parcels from a source bay and selects a target bay; selected-
// count + target chip drive the primary CTA. Parcel and bay lists are
// resolved upstream (`mobile_loader_transfer_v1`).

import * as React from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import { MobileV2BottomSheet } from "./mobile-v2-bottom-sheet";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2TransferParcel {
  readonly id: string;
  readonly sku: string;
  readonly dest: string;
}

export interface MobileV2TransferBay {
  readonly id: string;
  readonly label: string;
}

/**
 * Inter-hub transfer destination. Used when the sheet is bound in
 * `inter-hub` mode (outbound to another hub) — design canvas surface.
 */
export interface MobileV2TransferHub {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly etaLabel: string;
}

export type MobileV2TransferMode = "inter-bay" | "inter-hub";

export interface MobileV2TransferSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly bayLabel: string;
  readonly parcels: ReadonlyArray<MobileV2TransferParcel>;
  readonly selectedIds: ReadonlyArray<string>;
  readonly targetBays: ReadonlyArray<MobileV2TransferBay>;
  readonly targetBayId: string | null;
  readonly onToggleParcel: (id: string) => void;
  readonly onSelectBay: (id: string) => void;
  readonly onConfirm: () => void;
  /**
   * `inter-bay` (default, legacy contract): loader picks parcels from
   * the current bay plus a target bay chip.
   * `inter-hub`: loader picks a destination hub from the resolved hub
   * list — no parcel selection in this view (parcels are reconciled
   * upstream of the sheet). Mirrors the design canvas
   * `s-sheet-transfer` artboard.
   */
  readonly mode?: MobileV2TransferMode;
  readonly hubDestinations?: ReadonlyArray<MobileV2TransferHub>;
  readonly selectedHubId?: string | null;
  readonly onSelectHub?: (id: string) => void;
  /** Optional title override (default per-mode). */
  readonly title?: string;
  /** Optional subtitle override (default per-mode). */
  readonly subtitle?: string;
  readonly style?: StyleProp<ViewStyle>;
}

export function MobileV2TransferSheet(
  props: MobileV2TransferSheetProps,
): React.ReactElement {
  const { theme } = props;
  const mode: MobileV2TransferMode = props.mode ?? "inter-bay";
  const isInterHub = mode === "inter-hub";
  const hubs = props.hubDestinations ?? [];
  const selectedHubId = props.selectedHubId ?? null;
  const ready = isInterHub
    ? selectedHubId !== null
    : props.selectedIds.length > 0 && props.targetBayId !== null;
  const title =
    props.title ?? (isInterHub ? "Inter-hub transfer" : "Inter-bay transfer");
  const subtitle =
    props.subtitle
    ?? (isInterHub
      ? "Outbound to another hub"
      : `From ${props.bayLabel} · select parcels + destination`);

  return (
    <MobileV2BottomSheet
      theme={theme}
      visible={props.visible}
      onClose={props.onClose}
      title={title}
      subtitle={subtitle}
      style={props.style}
      primary={
        <FxButton
          theme={theme}
          variant={ready ? "primary" : "soft"}
          full
          size="lg"
          icon="truck"
          disabled={!ready}
          onPress={props.onConfirm}
          accessibilityLabel={
            isInterHub ? "Open transfer manifest" : "Confirm transfer"
          }
        >
          {isInterHub
            ? "Open transfer manifest"
            : ready
              ? `Transfer ${props.selectedIds.length} parcel${props.selectedIds.length === 1 ? "" : "s"}`
              : "Pick parcels + destination bay"}
        </FxButton>
      }
    >
      <FxCol gap={MOBILE_V2_SPACING.md} style={{ paddingVertical: MOBILE_V2_SPACING.lg }}>
        {isInterHub ? (
          <FxCol gap={MOBILE_V2_SPACING.md}>
            {hubs.map((h) => {
              const on = selectedHubId === h.id;
              return (
                <Pressable
                  key={h.id}
                  onPress={() => props.onSelectHub?.(h.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Select destination hub ${h.name}`}
                  accessibilityState={{ selected: on }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    columnGap: MOBILE_V2_SPACING["2xl"],
                    paddingVertical: MOBILE_V2_SPACING["2xl"],
                    paddingHorizontal: MOBILE_V2_SPACING["3xl"],
                    backgroundColor: on ? theme.accentSoft : theme.surface,
                    borderColor: on ? theme.accent : theme.border,
                    borderWidth: 1,
                    borderRadius: MOBILE_V2_RADII.card,
                  }}
                >
                  <FxIcon
                    name="truck"
                    size={18}
                    color={on ? theme.accent : theme.muted}
                  />
                  <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={{
                        fontSize: MOBILE_V2_TYPE_SIZES.body,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                        color: theme.ink,
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                    >
                      {h.name}
                    </Text>
                    <Text
                      style={{
                        fontSize: MOBILE_V2_TYPE_SIZES.label,
                        color: theme.muted,
                        fontFamily: MOBILE_V2_FONT_MONO,
                      }}
                    >
                      {h.code} · {h.etaLabel}
                    </Text>
                  </FxCol>
                </Pressable>
              );
            })}

          </FxCol>
        ) : null}

        {/* Parcel selector */}
        {!isInterHub ? (
        <>
        <FxCol gap={MOBILE_V2_SPACING.md}>
          <FxRow justify="space-between" align="center">
            <Text
              style={{
                fontSize: MOBILE_V2_TYPE_SIZES.label,
                color: theme.muted,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                letterSpacing: 0.4,
                textTransform: "uppercase",
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              Parcels · {props.selectedIds.length}/{props.parcels.length} selected
            </Text>
          </FxRow>
          <FxCol gap={MOBILE_V2_SPACING.sm}>
            {props.parcels.map((p) => {
              const on = props.selectedIds.includes(p.id);
              return (
                <Pressable
                  key={p.id}
                  onPress={() => props.onToggleParcel(p.id)}
                  accessibilityRole="checkbox"
                  accessibilityLabel={`Toggle parcel ${p.sku}`}
                  accessibilityState={{ checked: on }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    columnGap: MOBILE_V2_SPACING["2xl"],
                    paddingVertical: MOBILE_V2_SPACING.xl,
                    paddingHorizontal: MOBILE_V2_SPACING["3xl"],
                    backgroundColor: on ? theme.accentSoft : theme.surface,
                    borderColor: on ? theme.accent : theme.border,
                    borderWidth: 1,
                    borderRadius: MOBILE_V2_RADII.card,
                  }}
                >
                  <View
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 5,
                      borderWidth: 2,
                      borderColor: on ? theme.accent : theme.border,
                      backgroundColor: on ? theme.accent : "transparent",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {on ? <FxIcon name="check" size={12} color={theme.accentInk} /> : null}
                  </View>
                  <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={{
                        fontSize: MOBILE_V2_TYPE_SIZES.body,
                        fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                        color: theme.ink,
                        fontFamily: MOBILE_V2_FONT_SANS,
                      }}
                    >
                      {p.sku}
                    </Text>
                    <Text
                      style={{
                        fontSize: MOBILE_V2_TYPE_SIZES.label,
                        color: theme.muted,
                        fontFamily: MOBILE_V2_FONT_MONO,
                      }}
                    >
                      {p.id} → {p.dest}
                    </Text>
                  </FxCol>
                </Pressable>
              );
            })}
          </FxCol>
        </FxCol>

        {/* Target bay */}
        <FxCol gap={MOBILE_V2_SPACING.md}>
          <Text
            style={{
              fontSize: MOBILE_V2_TYPE_SIZES.label,
              color: theme.muted,
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              fontFamily: MOBILE_V2_FONT_SANS,
            }}
          >
            Target bay
          </Text>
          <FxRow gap={MOBILE_V2_SPACING.sm} wrap>
            {props.targetBays.map((b) => {
              const on = props.targetBayId === b.id;
              return (
                <Pressable
                  key={b.id}
                  onPress={() => props.onSelectBay(b.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Select target bay ${b.label}`}
                  accessibilityState={{ selected: on }}
                >
                  <FxChip theme={theme} tone={on ? "accent" : "neutral"} icon="layers">
                    {b.label}
                  </FxChip>
                </Pressable>
              );
            })}
          </FxRow>
        </FxCol>

        <FxCard theme={theme} soft>
          <FxRow gap={MOBILE_V2_SPACING.md} align="center">
            <FxIcon name="info" size={14} color={theme.info} />
            <Text
              style={{
                fontSize: MOBILE_V2_TYPE_SIZES.caption,
                color: theme.ink,
                fontFamily: MOBILE_V2_FONT_SANS,
                flex: 1,
              }}
            >
              Transfer event is logged per parcel and reconciles in EOD report.
            </Text>
          </FxRow>
        </FxCard>

        </>
        ) : null}
      </FxCol>
    </MobileV2BottomSheet>
  );
}

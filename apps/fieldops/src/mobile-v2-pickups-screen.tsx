// Mobile V2 Pickups list screen — pixel-faithful port of design source
// flow-network.jsx ScrPickups + PickupRow. Match against reference
// docs/ops/evidence/2026-05-10/mobile-v2/reference/06-pickups.png.

import * as React from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { FxIcon } from "./mobile-v2-icon";
import { FxCard, FxChip, FxChipButton, FxCol, FxRow } from "./mobile-v2-primitives";
import type { FxChipTone } from "./mobile-v2-primitives-styles";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_LETTER_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2PickupStatus = "pending" | "completed" | "failed";
export type MobileV2PickupPriority = "normal" | "high";

export interface MobileV2Pickup {
  readonly id: string;
  readonly routeStopId?: string | null;
  readonly routeStopTaskId?: string | null;
  readonly shipmentId?: string | null;
  readonly routeRunId?: string | null;
  readonly workflowRunId?: string | null;
  readonly failureReason?: string | null;
  readonly failureNote?: string | null;
  readonly wb: string;
  readonly merchant: string;
  readonly address: string;
  readonly area: string;
  readonly window: string;
  readonly instructions?: string;
  readonly expectedQty: number;
  readonly picked: number;
  readonly status: MobileV2PickupStatus;
  readonly priority: MobileV2PickupPriority;
  readonly sealRequired: boolean;
}

export type MobileV2PickupsTab = "pending" | "done" | "priority";

export interface MobileV2PickupsScreenProps {
  readonly theme: MobileV2Theme;
  readonly pickups: ReadonlyArray<MobileV2Pickup>;
  readonly query: string;
  readonly onQueryChange: (next: string) => void;
  readonly tab: MobileV2PickupsTab;
  readonly onTabChange: (tab: MobileV2PickupsTab) => void;
  readonly onScanPress?: () => void;
  readonly onOpenPickup: (pickup: MobileV2Pickup) => void;
  readonly onOpenMap?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

function rowTone(p: MobileV2Pickup): FxChipTone {
  if (p.status === "completed") return "success";
  if (p.status === "failed") return "danger";
  if (p.priority === "high") return "warning";
  return "neutral";
}

function PickupRow({
  theme,
  pickup,
  onOpen,
}: {
  readonly theme: MobileV2Theme;
  readonly pickup: MobileV2Pickup;
  readonly onOpen: () => void;
}): React.ReactElement {
  const tone = rowTone(pickup);
  const pct = pickup.expectedQty > 0 ? Math.round((pickup.picked / pickup.expectedQty) * 100) : 0;
  const dim = pickup.status !== "pending";
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`Open pickup ${pickup.id} ${pickup.merchant}`}
    >
      <View
        style={{
          backgroundColor: theme.surface,
          borderColor: theme.border,
          borderWidth: 1,
          borderRadius: MOBILE_V2_RADII.card,
          overflow: "hidden",
          opacity: dim ? 0.7 : 1,
        }}
      >
        {/* Upper block */}
        <View
          style={{
            paddingHorizontal: MOBILE_V2_SPACING["3xl"],
            paddingVertical: MOBILE_V2_SPACING["2xl"],
          }}
        >
          <FxRow justify="space-between" align="flex-start">
            <FxCol gap={MOBILE_V2_SPACING.xs} style={{ flex: 1, minWidth: 0 }}>
              <FxRow gap={MOBILE_V2_SPACING.md}>
                <Text
                  style={{
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_MONO,
                    fontSize: 10.5,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    letterSpacing: MOBILE_V2_TYPE_LETTER_SPACING.chip,
                  }}
                >
                  {pickup.id}
                </Text>
                {pickup.priority === "high" ? (
                  <FxChip theme={theme} tone="warning" icon="flame" dense>
                    Priority
                  </FxChip>
                ) : null}
                {pickup.sealRequired ? (
                  <FxChip theme={theme} tone="neutral" icon="shield" dense>
                    Seal
                  </FxChip>
                ) : null}
              </FxRow>
              <Text
                style={{
                  color: theme.ink,
                  fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  marginTop: 2,
                }}
              >
                {pickup.merchant}
              </Text>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  columnGap: MOBILE_V2_SPACING.md,
                }}
              >
                <FxIcon name="pin" size={11} color={theme.muted} />
                <Text
                  style={{
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    fontSize: 11.5,
                  }}
                  numberOfLines={1}
                >
                  {pickup.address} · {pickup.area}
                </Text>
              </View>
            </FxCol>
            <FxChip theme={theme} tone={tone} dense mono>
              {pickup.picked}/{pickup.expectedQty}
            </FxChip>
          </FxRow>
        </View>

        {/* Lower strip on surfaceAlt */}
        <View
          style={{
            paddingHorizontal: MOBILE_V2_SPACING["3xl"],
            paddingVertical: MOBILE_V2_SPACING.lg,
            backgroundColor: theme.surfaceAlt,
            borderTopColor: theme.border,
            borderTopWidth: StyleSheet.hairlineWidth,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            columnGap: MOBILE_V2_SPACING["2xl"],
          }}
        >
          <FxRow gap={MOBILE_V2_SPACING.xl}>
            <FxRow gap={MOBILE_V2_SPACING.sm} align="center">
              <FxIcon name="clock" size={12} color={theme.muted} />
              <Text
                style={{
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  fontSize: 11,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                }}
              >
                {pickup.window}
              </Text>
            </FxRow>
            {pickup.instructions !== undefined ? (
              <Text
                style={{
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  fontSize: 11,
                }}
                numberOfLines={1}
              >
                {pickup.instructions}
              </Text>
            ) : null}
          </FxRow>
          {pickup.status === "completed" ? (
            <FxChip theme={theme} tone="success" icon="check" dense>
              Picked up
            </FxChip>
          ) : pickup.status === "failed" ? (
            <FxChip theme={theme} tone="danger" icon="alert" dense>
              Failed
            </FxChip>
          ) : (
            <Text
              style={{
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_SANS,
                fontSize: 11,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
              }}
            >
              Tap to start →
            </Text>
          )}
        </View>

        {/* Progress bar (3px) */}
        {pickup.status === "pending" && pct > 0 ? (
          <View style={{ height: 3, backgroundColor: theme.border }}>
            <View style={{ height: "100%", width: `${pct}%`, backgroundColor: theme.accent }} />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export function MobileV2PickupsScreen(props: MobileV2PickupsScreenProps): React.ReactElement {
  const { theme } = props;
  const trimmed = props.query.trim().toLowerCase();

  const base = React.useMemo(
    () =>
      props.pickups.filter((p) => {
        if (trimmed.length === 0) return true;
        const hay = `${p.merchant} ${p.id} ${p.area} ${p.wb} ${p.address}`.toLowerCase();
        return hay.includes(trimmed);
      }),
    [props.pickups, trimmed],
  );
  const pending = base.filter((p) => p.status === "pending");
  const done = base.filter((p) => p.status !== "pending");
  const priority = base.filter((p) => p.priority === "high");
  const visible = props.tab === "done" ? done : props.tab === "priority" ? priority : pending;

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      {/* Sticky filter header */}
      <View
        style={{
          backgroundColor: theme.bg,
          paddingHorizontal: MOBILE_V2_SPACING["4xl"],
          paddingTop: MOBILE_V2_SPACING.xl,
          paddingBottom: MOBILE_V2_SPACING.lg,
          borderBottomColor: theme.border,
          borderBottomWidth: StyleSheet.hairlineWidth,
          rowGap: MOBILE_V2_SPACING.lg,
        }}
      >
        {/* Search bar with scan affordance.
            Height 42 = the design FxSearchBar's rendered box: the design
            canvas uses content-box, so its `height:40` div + 1px borders
            occupies 42px. RN borders are inside the box, so the impl needs
            height:42 to occupy the same vertical space (geometry parity). */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            height: 42,
            backgroundColor: theme.surfaceAlt,
            borderColor: theme.border,
            borderWidth: 1,
            borderRadius: 11,
            paddingLeft: MOBILE_V2_SPACING["2xl"],
            paddingRight: MOBILE_V2_SPACING.sm,
            columnGap: MOBILE_V2_SPACING.lg,
            overflow: "hidden",
          }}
        >
          <FxIcon name="search" size={16} color={theme.muted} />
          <TextInput
            value={props.query}
            onChangeText={props.onQueryChange}
            placeholder="Search merchant, waybill, area…"
            placeholderTextColor={theme.muted}
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            accessibilityLabel="Search pickups"
            style={{
              flex: 1,
              paddingVertical: 0,
              color: theme.ink,
              fontFamily: MOBILE_V2_FONT_SANS,
              fontSize: MOBILE_V2_TYPE_SIZES.body,
            }}
          />
          <Pressable
            onPress={props.onScanPress}
            accessibilityRole="button"
            accessibilityLabel="Scan a waybill"
            style={{
              backgroundColor: theme.accent,
              height: 32,
              borderRadius: 8,
              paddingHorizontal: MOBILE_V2_SPACING.xl,
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "row",
              columnGap: MOBILE_V2_SPACING.md,
            }}
          >
            <FxIcon name="scan" size={14} color={theme.accentInk} stroke={2.4} />
            <Text
              style={{
                color: theme.accentInk,
                fontFamily: MOBILE_V2_FONT_SANS,
                fontSize: 11.5,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
              }}
            >
              Scan
            </Text>
          </Pressable>
        </View>

        {/* Filter pills (scrollable horizontally) */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{
            columnGap: MOBILE_V2_SPACING.md,
            paddingRight: MOBILE_V2_SPACING.lg,
            paddingBottom: MOBILE_V2_SPACING.px,
          }}
        >
          <FxChipButton
            theme={theme}
            icon="clock"
            label={`Pending · ${pending.length}`}
            active={props.tab === "pending"}
            onPress={() => props.onTabChange("pending")}
            accessibilityLabel="Show pending pickups"
          />
          <FxChipButton
            theme={theme}
            icon="check"
            label={`Done · ${done.length}`}
            active={props.tab === "done"}
            onPress={() => props.onTabChange("done")}
            accessibilityLabel="Show completed pickups"
          />
          <FxChipButton
            theme={theme}
            icon="flame"
            label={`Priority · ${priority.length}`}
            active={props.tab === "priority"}
            onPress={() => props.onTabChange("priority")}
            accessibilityLabel="Show priority pickups"
          />
          {props.onOpenMap !== undefined ? (
            <FxChipButton
              theme={theme}
              icon="map"
              label="Map view"
              active={false}
              onPress={props.onOpenMap}
              accessibilityLabel="Open pickups map view"
            />
          ) : null}
        </ScrollView>
      </View>

      {/* List */}
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: MOBILE_V2_SPACING["4xl"],
          paddingTop: MOBILE_V2_SPACING["2xl"],
          rowGap: MOBILE_V2_SPACING.xl,
          paddingBottom: 90,
        }}
      >
        {visible.length === 0 ? (
          <FxCard theme={theme} padding={20} style={{ alignItems: "center" }}>
            <View
              style={{
                width: 48,
                height: 48,
                borderRadius: 14,
                backgroundColor: theme.successSoft,
                alignItems: "center",
                justifyContent: "center",
                marginBottom: MOBILE_V2_SPACING.xl,
              }}
            >
              <FxIcon
                name={props.tab === "done" ? "check" : "package"}
                size={22}
                color={theme.success}
                stroke={2.4}
              />
            </View>
            <Text
              style={{
                color: theme.ink,
                fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
                fontFamily: MOBILE_V2_FONT_SANS,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
              }}
            >
              {props.tab === "done"
                ? "No completed pickups yet"
                : props.tab === "priority"
                  ? "No priority pickups"
                  : "All pickups complete"}
            </Text>
            <Text
              style={{
                color: theme.muted,
                fontSize: MOBILE_V2_TYPE_SIZES.caption,
                fontFamily: MOBILE_V2_FONT_SANS,
                marginTop: MOBILE_V2_SPACING.sm,
                textAlign: "center",
              }}
            >
              {props.tab === "pending"
                ? `${done.length} pickups · ${props.pickups.reduce((n, p) => n + p.picked, 0)} parcels collected`
                : "Switch tabs to see other pickups."}
            </Text>
          </FxCard>
        ) : (
          visible.map((p) => (
            <PickupRow key={p.id} theme={theme} pickup={p} onOpen={() => props.onOpenPickup(p)} />
          ))
        )}
      </ScrollView>
    </View>
  );
}

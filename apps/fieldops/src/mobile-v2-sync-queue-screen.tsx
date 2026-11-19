// Mobile V2 Sync Queue screen — pixel-faithful port of design source
// flow-system.jsx ScrSync. Driver inspects pending writes: connectivity
// strip (online/offline toggle + Flush now), empty-state callout ("All
// caught up") when queue is empty, or a stacked row list keyed by kind
// (stop.update / pod.commit / stop.failed / generic) with mono stop id +
// time and a tone-coded status chip (queued / retrying / sent / failed).

import * as React from "react";
import { ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import type { FxChipTone } from "./mobile-v2-primitives-styles";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import {
  MOBILE_V2_DIMENSIONS,
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2SyncEntryKind =
  | "stop.update"
  | "pod.commit"
  | "stop.failed"
  | "cash.drop"
  | "comm.send"
  | "other";

export type MobileV2SyncEntryStatus = "queued" | "retrying" | "sent" | "failed";

export type MobileV2SyncConnectivity = "online" | "offline" | "syncing";

export interface MobileV2SyncEntry {
  readonly id: string;
  readonly kind: MobileV2SyncEntryKind;
  readonly stopId: string;
  /** Epoch ms — formatted to local time string at render. */
  readonly atMs: number;
  readonly status: MobileV2SyncEntryStatus;
  readonly retryCount: number;
}

export interface MobileV2SyncQueueScreenProps {
  readonly theme: MobileV2Theme;
  readonly queue: ReadonlyArray<MobileV2SyncEntry>;
  readonly connectivity: MobileV2SyncConnectivity;
  /** Optional epoch ms of the last successful sync; rendered into the subtitle. */
  readonly lastSyncMs: number | null;
  readonly onToggleConnectivity?: () => void;
  readonly onFlushNow?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

interface KindMeta {
  readonly icon: MobileV2IconName;
  readonly label: string;
}

const KIND_META: Readonly<Record<MobileV2SyncEntryKind, KindMeta>> = Object.freeze({
  "stop.update": Object.freeze({ icon: "pin", label: "Stop update" }),
  "pod.commit": Object.freeze({ icon: "check", label: "POD commit" }),
  "stop.failed": Object.freeze({ icon: "flag", label: "Failed delivery" }),
  "cash.drop": Object.freeze({ icon: "cash", label: "Cash drop" }),
  "comm.send": Object.freeze({ icon: "message", label: "Customer message" }),
  other: Object.freeze({ icon: "doc", label: "Pending write" }),
});

const STATUS_TONE: Readonly<Record<MobileV2SyncEntryStatus, FxChipTone>> = Object.freeze({
  queued: "warning",
  retrying: "info",
  sent: "success",
  failed: "danger",
});

function resolveTimeLabel(atMs: number): string {
  if (!Number.isFinite(atMs)) return "—";
  try {
    return new Date(atMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

function resolveKindMeta(kind: MobileV2SyncEntryKind): KindMeta {
  return KIND_META[kind] ?? KIND_META.other;
}

export function MobileV2SyncQueueScreen(
  props: MobileV2SyncQueueScreenProps,
): React.ReactElement {
  const { theme, queue, connectivity } = props;
  const isOnline = connectivity === "online";

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      <ScrollView
        contentContainerStyle={{
          padding: MOBILE_V2_SPACING["4xl"],
          rowGap: MOBILE_V2_SPACING["3xl"],
          paddingBottom: 96,
        }}
      >
        {/* In-body header stripped — the gallery / host ScreenShell now
            renders the title ("Sync queue") and subtitle (pending + last
            synced) via FxAppBar. */}

        {/* Connectivity controls */}
        <FxRow gap={MOBILE_V2_SPACING.lg} align="center">
          <FxButton
            theme={theme}
            variant={isOnline ? "success" : "ghost"}
            size="sm"
            icon={isOnline ? "cloud-check" : "wifi-off"}
            onPress={props.onToggleConnectivity}
            accessibilityLabel={`Toggle connectivity — currently ${connectivity}`}
          >
            {connectivity}
          </FxButton>
          <FxButton
            theme={theme}
            variant="primary"
            size="sm"
            icon="sync"
            onPress={props.onFlushNow}
            accessibilityLabel="Flush sync queue now"
          >
            Flush now
          </FxButton>
        </FxRow>

        {/* Empty state or stacked list */}
        {queue.length === 0 ? (
          <FxCard theme={theme} padding={20}>
            <FxCol gap={MOBILE_V2_SPACING.lg} style={{ alignItems: "center" }}>
              <View
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 14,
                  backgroundColor: theme.successSoft,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <FxIcon name="cloud-check" size={28} color={theme.success} />
              </View>
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                All caught up
              </Text>
              <Text
                style={{
                  fontSize: 12,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  textAlign: "center",
                }}
              >
                No pending writes. Local cache and server are in sync.
              </Text>
            </FxCol>
          </FxCard>
        ) : (
          <View
            style={{
              backgroundColor: theme.border,
              borderRadius: 14,
              overflow: "hidden",
              rowGap: 1,
            }}
          >
            {queue.map((entry) => {
              const meta = resolveKindMeta(entry.kind);
              const tone = STATUS_TONE[entry.status];
              return (
                <View
                  key={entry.id}
                  style={{
                    backgroundColor: theme.surface,
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    flexDirection: "row",
                    alignItems: "center",
                    columnGap: MOBILE_V2_SPACING.xl,
                  }}
                >
                  <View
                    style={{
                      width: MOBILE_V2_DIMENSIONS.iconDisk,
                      height: MOBILE_V2_DIMENSIONS.iconDisk,
                      borderRadius: 9,
                      backgroundColor: theme.accentSoft,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <FxIcon name={meta.icon} size={16} color={theme.accent} />
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
                      {meta.label}
                    </Text>
                    <Text
                      style={{
                        fontSize: 11,
                        color: theme.muted,
                        fontFamily: MOBILE_V2_FONT_MONO,
                      }}
                    >
                      {entry.stopId} · {resolveTimeLabel(entry.atMs)}
                      {entry.retryCount > 0 ? ` · retry ${entry.retryCount}` : ""}
                    </Text>
                  </FxCol>
                  <FxChip theme={theme} tone={tone} dense>
                    {entry.status}
                  </FxChip>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

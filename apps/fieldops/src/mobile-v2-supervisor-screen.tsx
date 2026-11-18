// Mobile V2 Supervisor screen — pixel-faithful port of design source
// flow-extras.jsx ScrSupervisor. Approvals queue at hub level: left
// column lists pending approvals (cod_variance / route_change /
// fail_reattempt / incident), right column shows the selected detail
// (accent card with driver + ref + body) and the stacked action stack
// (Approve / Ask for clarification / Reject).
//
// The source allocates an extra-wide artboard (PHONE_W+40) because it
// renders as a two-column split. On a real device the same content
// stacks vertically; we keep the two-column proportions when the host
// supplies width >= 720 (tablet/hub kiosk) and stack otherwise. The
// layout decision is computed inline from `useWindowDimensions`.

import * as React from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import type { FxChipTone } from "./mobile-v2-primitives-styles";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2SupervisorKind =
  | "cod_variance"
  | "route_change"
  | "fail_reattempt"
  | "incident"
  | "void_pod"
  | "edit_cod";

export interface MobileV2SupervisorItem {
  readonly id: string;
  readonly kind: MobileV2SupervisorKind;
  readonly driver: string;
  readonly ref: string;
  /** Epoch ms; rendered as age-in-minutes for the chip + list. */
  readonly atMs: number;
  readonly detail: string;
}

export interface MobileV2SupervisorScreenProps {
  readonly theme: MobileV2Theme;
  readonly supervisorName: string;
  readonly queue: ReadonlyArray<MobileV2SupervisorItem>;
  readonly activeId: string | null;
  readonly onSelectItem?: (id: string) => void;
  readonly onApprove?: (id: string) => void;
  readonly onClarify?: (id: string) => void;
  readonly onReject?: (id: string) => void;
  /**
   * Optional explicit two-column layout override; when omitted the
   * component picks the split when width >= 720. Tests pass this
   * explicitly to avoid relying on the runtime window.
   */
  readonly forceLayout?: "stack" | "split";
  readonly style?: StyleProp<ViewStyle>;
}

interface KindMeta {
  readonly label: string;
  readonly icon: MobileV2IconName;
  readonly tone: FxChipTone;
}

const KIND_META: Readonly<Record<MobileV2SupervisorKind, KindMeta>> = Object.freeze({
  cod_variance: Object.freeze({ label: "COD variance", icon: "cash", tone: "warning" }),
  route_change: Object.freeze({ label: "Route change", icon: "route", tone: "info" }),
  fail_reattempt: Object.freeze({ label: "Fail re-attempt", icon: "refresh", tone: "warning" }),
  incident: Object.freeze({ label: "Incident review", icon: "alert", tone: "danger" }),
  void_pod: Object.freeze({ label: "Void POD", icon: "x", tone: "danger" }),
  edit_cod: Object.freeze({ label: "Edit COD", icon: "cash", tone: "warning" }),
});

function resolveSoftColors(theme: MobileV2Theme, tone: FxChipTone): { bg: string; fg: string } {
  switch (tone) {
    case "warning":
      return { bg: theme.warningSoft, fg: theme.warning };
    case "info":
      return { bg: theme.infoSoft, fg: theme.info };
    case "danger":
      return { bg: theme.dangerSoft, fg: theme.danger };
    case "success":
      return { bg: theme.successSoft, fg: theme.success };
    case "accent":
      return { bg: theme.accentSoft, fg: theme.accent };
    default:
      return { bg: theme.surfaceAlt, fg: theme.muted };
  }
}

function formatAgeMin(atMs: number): string {
  if (!Number.isFinite(atMs)) return "—";
  const delta = Date.now() - atMs;
  if (delta < 60_000) return "now";
  return `${Math.floor(delta / 60_000)}m`;
}

function QueueRow(props: {
  readonly theme: MobileV2Theme;
  readonly item: MobileV2SupervisorItem;
  readonly selected: boolean;
  readonly onPress?: () => void;
}): React.ReactElement {
  const { theme: t, item, selected } = props;
  const meta = KIND_META[item.kind];
  const colors = resolveSoftColors(t, meta.tone);
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={`${meta.label} from ${item.driver}`}
      accessibilityState={{ selected }}
      style={{
        backgroundColor: selected ? t.accentSoft : t.surface,
        paddingHorizontal: 12,
        paddingVertical: 12,
        flexDirection: "row",
        alignItems: "flex-start",
        columnGap: MOBILE_V2_SPACING.lg,
        borderLeftWidth: 3,
        borderLeftColor: selected ? t.accent : "transparent",
      }}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          backgroundColor: colors.bg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <FxIcon name={meta.icon} size={13} color={colors.fg} />
      </View>
      <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={{
            fontSize: 12,
            fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
            color: t.ink,
            fontFamily: MOBILE_V2_FONT_SANS,
          }}
          numberOfLines={1}
        >
          {meta.label}
        </Text>
        <Text
          style={{
            fontSize: 10.5,
            color: t.muted,
            fontFamily: MOBILE_V2_FONT_SANS,
          }}
          numberOfLines={1}
        >
          {item.driver}
        </Text>
        <Text
          style={{
            fontSize: 10,
            color: t.muted,
            fontFamily: MOBILE_V2_FONT_MONO,
          }}
        >
          {formatAgeMin(item.atMs)}
        </Text>
      </FxCol>
    </Pressable>
  );
}

function DetailColumn(props: {
  readonly theme: MobileV2Theme;
  readonly item: MobileV2SupervisorItem | null;
  readonly onApprove?: (id: string) => void;
  readonly onClarify?: (id: string) => void;
  readonly onReject?: (id: string) => void;
}): React.ReactElement {
  const { theme: t, item } = props;
  if (item === null) {
    return (
      <FxCard theme={t} padding={20}>
        <Text
          style={{
            fontSize: 13,
            color: t.muted,
            fontFamily: MOBILE_V2_FONT_SANS,
            textAlign: "center",
          }}
        >
          Pick an item from the queue to review.
        </Text>
      </FxCard>
    );
  }
  const meta = KIND_META[item.kind];
  return (
    <FxCol gap={MOBILE_V2_SPACING["2xl"]}>
      <FxCard theme={t} accent>
        <FxRow justify="space-between" align="flex-start">
          <FxCol gap={MOBILE_V2_SPACING.xs} style={{ flex: 1, minWidth: 0 }}>
            <Text
              style={{
                fontSize: 9,
                color: t.accent,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              {meta.label}
            </Text>
            <Text
              style={{
                fontSize: 14,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                color: t.ink,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              {item.driver}
            </Text>
            <Text
              style={{
                fontSize: 10.5,
                color: t.muted,
                fontFamily: MOBILE_V2_FONT_MONO,
              }}
            >
              {item.ref}
            </Text>
          </FxCol>
          <FxChip theme={t} tone={meta.tone} dense>
            {formatAgeMin(item.atMs)}
          </FxChip>
        </FxRow>
        <Text
          style={{
            fontSize: 12,
            color: t.ink,
            lineHeight: 18,
            fontFamily: MOBILE_V2_FONT_SANS,
            marginTop: MOBILE_V2_SPACING.xl,
          }}
        >
          {item.detail}
        </Text>
      </FxCard>
      <FxCol gap={MOBILE_V2_SPACING.md}>
        <FxButton
          theme={t}
          variant="success"
          full
          icon="check"
          onPress={() => props.onApprove?.(item.id)}
          accessibilityLabel={`Approve ${meta.label} from ${item.driver}`}
        >
          Approve
        </FxButton>
        <FxButton
          theme={t}
          variant="ghost"
          full
          icon="message"
          onPress={() => props.onClarify?.(item.id)}
          accessibilityLabel={`Ask for clarification from ${item.driver}`}
        >
          Ask for clarification
        </FxButton>
        <FxButton
          theme={t}
          variant="danger"
          full
          icon="x"
          onPress={() => props.onReject?.(item.id)}
          accessibilityLabel={`Reject ${meta.label} from ${item.driver}`}
        >
          Reject
        </FxButton>
      </FxCol>
    </FxCol>
  );
}

export function MobileV2SupervisorScreen(
  props: MobileV2SupervisorScreenProps,
): React.ReactElement {
  const { theme, queue } = props;
  const { width } = useWindowDimensions();
  const layout: "stack" | "split" =
    props.forceLayout !== undefined ? props.forceLayout : width >= 720 ? "split" : "stack";

  const activeItem = React.useMemo(() => {
    if (props.activeId === null) return queue.length > 0 ? queue[0]! : null;
    return queue.find((q) => q.id === props.activeId) ?? (queue.length > 0 ? queue[0]! : null);
  }, [props.activeId, queue]);

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      {/* In-body header block stripped — the gallery / host ScreenShell now
          renders the title ("Approvals") and subtitle (pending count +
          supervisor name) via FxAppBar. The right-rail warning chip used to
          live here:

            <FxChip theme={theme} tone="warning" icon="alert" dense>
              {queue.length}
            </FxChip>

          The host should re-surface that via the AppBar `right` prop. */}

      {layout === "split" ? (
        // Use explicit flex ratios (2 + 3 = 5 → left 40% / right 60%)
        // instead of `width: "40%"` on the left ScrollView. In React
        // Native Web a percentage width on ScrollView doesn't always
        // bound the inner contentContainer: a wider QueueRow can
        // push the visible scroll area past 40%, leaving the right
        // column too narrow to fit a word — the symptom was text
        // wrapping one character per line ("C / O / D / V / A / R /
        // I / A / N / C / E"). flex ratios with explicit `flexShrink:
        // 1` + `minWidth: 0` guarantee both columns shrink to share
        // the parent row equally.
        <View style={{ flex: 1, flexDirection: "row" }}>
          <ScrollView
            style={{ flex: 2, flexShrink: 1, minWidth: 0, backgroundColor: theme.border }}
            contentContainerStyle={{ rowGap: 1 }}
          >
            {queue.map((q) => (
              <QueueRow
                key={q.id}
                theme={theme}
                item={q}
                selected={activeItem !== null && activeItem.id === q.id}
                onPress={() => props.onSelectItem?.(q.id)}
              />
            ))}
          </ScrollView>
          <ScrollView
            style={{ flex: 3, flexShrink: 1, minWidth: 0, backgroundColor: theme.bg }}
            contentContainerStyle={{ padding: 14 }}
          >
            <DetailColumn
              theme={theme}
              item={activeItem}
              onApprove={props.onApprove}
              onClarify={props.onClarify}
              onReject={props.onReject}
            />
          </ScrollView>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 96 }}>
          {/* Queue strip */}
          <View
            style={{
              backgroundColor: theme.border,
              rowGap: 1,
            }}
          >
            {queue.map((q) => (
              <QueueRow
                key={q.id}
                theme={theme}
                item={q}
                selected={activeItem !== null && activeItem.id === q.id}
                onPress={() => props.onSelectItem?.(q.id)}
              />
            ))}
          </View>
          {/* Detail */}
          <View style={{ padding: 14, rowGap: MOBILE_V2_SPACING["2xl"] }}>
            <DetailColumn
              theme={theme}
              item={activeItem}
              onApprove={props.onApprove}
              onClarify={props.onClarify}
              onReject={props.onReject}
            />
          </View>
        </ScrollView>
      )}
    </View>
  );
}

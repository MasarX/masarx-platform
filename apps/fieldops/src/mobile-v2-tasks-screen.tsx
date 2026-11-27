// Mobile V2 Tasks unified home — pure list/group renderer over the typed
// task envelope. Connects to public.resolve_fieldops_tasks_v1 in production
// (via @tanstack/react-query) but accepts pre-loaded tasks via props for
// preview / Storybook / offline cache replay.
//
// AGENTS.md Mobile Field Ops Policy Contract: "/mobile/tasks is the post-
// login default for every role. Tasks is a server-aggregated view from
// resolve_fieldops_tasks_v1(active_role, ctx) with optimistic outbox
// overlay on the client. Offline mode reads from the same shape via
// cached react-query data."

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
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import { MobileV2FxMap } from "./mobile-v2-fx-map";
import {
  FxButton,
  FxCard,
  FxChip,
  FxChipButton,
  FxCol,
  FxRow,
} from "./mobile-v2-primitives";
import {
  type FxChipTone,
} from "./mobile-v2-primitives-styles";
import {
  computeMobileV2TaskKpiCounts,
  deriveMobileV2TaskMetaLabel,
  filterMobileV2TasksByQuery,
  groupMobileV2TasksByUrgency,
  isMobileV2TaskHighPriority,
  sortMobileV2TasksBy,
  type MobileV2Task,
  type MobileV2TaskSortMode,
  type MobileV2TaskTone,
  type MobileV2TaskUrgency,
} from "./mobile-v2-tasks-types";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";
import { getStrings, resolveLocaleCode, type FieldOpsStrings } from "./i18n";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toneToChipTone(tone: MobileV2TaskTone): FxChipTone {
  switch (tone) {
    case "danger":
      return "danger";
    case "warning":
      return "warning";
    case "accent":
      return "accent";
    case "success":
      return "success";
    case "info":
      return "info";
    case "neutral":
    default:
      return "neutral";
  }
}

/**
 * Urgency-bucket presentation metadata — leading glyph + chip tone for a
 * grouped Tasks section header. Mirrors the design ScrTasks `URGENCY_META`
 * (flow-tasks.jsx:300-304): `now → alert/danger`, `today → clock/warning`,
 * `later → check/neutral`. Keyed strictly by the three urgency buckets;
 * any non-urgency group key (e.g. the synthetic single "All" group) has
 * no entry, so the header renders without an urgency glyph — consistent
 * with the design conditionally rendering `{URGENCY_META[k] && …}`.
 */
const TASK_URGENCY_META: Readonly<
  Record<string, { readonly icon: MobileV2IconName; readonly tone: FxChipTone }>
> = Object.freeze({
  now: { icon: "alert", tone: "danger" },
  today: { icon: "clock", tone: "warning" },
  later: { icon: "check", tone: "neutral" },
});

/**
 * Leading icon-disk colours for a task row — mirrors the design ScrTasks
 * `TaskRow` icon disk (flow-tasks.jsx): a toned soft fill + saturated glyph
 * per tone, with the accent pair as the default for untoned tasks.
 */
function resolveTaskIconDisk(
  theme: MobileV2Theme,
  tone: MobileV2TaskTone,
): { readonly bg: string; readonly fg: string } {
  switch (tone) {
    case "danger":
      return { bg: theme.dangerSoft, fg: theme.danger };
    case "warning":
      return { bg: theme.warningSoft, fg: theme.warning };
    case "success":
      return { bg: theme.successSoft, fg: theme.success };
    case "info":
      return { bg: theme.infoSoft, fg: theme.info };
    case "accent":
    case "neutral":
    default:
      return { bg: theme.accentSoft, fg: theme.accent };
  }
}

// `computeMobileV2TaskKpiCounts` is re-exported from this file as a convenience
// for screen code; the pure implementation lives in mobile-v2-tasks-types.ts so
// Jest unit tests can import it without pulling in JSX.
export { computeMobileV2TaskKpiCounts, type MobileV2TaskKpiCounts } from "./mobile-v2-tasks-types";

const TYPE_ICON: Readonly<Record<string, "package" | "box" | "truck" | "split" | "navigate" | "check-double" | "shield">> = Object.freeze({
  delivery: "package",
  pickup: "box",
  load: "box",
  transfer: "truck",
  rto: "package",
  sortation: "split",
  trip: "truck",
  route_review: "shield",
  default: "navigate",
} as const);

function resolveTypeIcon(type: string): "package" | "box" | "truck" | "split" | "navigate" | "check-double" | "shield" {
  return TYPE_ICON[type] ?? TYPE_ICON.default ?? "navigate";
}

// ---------------------------------------------------------------------------
// MobileV2TaskRow
// ---------------------------------------------------------------------------

interface TaskRowProps {
  readonly theme: MobileV2Theme;
  readonly strings: FieldOpsStrings;
  readonly task: MobileV2Task;
  readonly onPress: (task: MobileV2Task) => void;
}

// Pixel-faithful port of the design ScrTasks `TaskRow` (flow-tasks.jsx:
// 723-764): toned icon disk | [title + `code` mono at the title baseline]
// / [`sub`] / [chip row: Priority chip + meta chip] | trailing
// `chevron-right`. Priority/meta inputs are derived from the typed task
// envelope (priority INT band + structured `meta`); there is no ETA
// timestamp or CTA-text chip — those are not in the design.
function TaskRow({ theme, strings, task, onPress }: TaskRowProps): React.ReactElement {
  const chipTone = toneToChipTone(task.tone);
  const icon = resolveTypeIcon(task.type);
  const disk = resolveTaskIconDisk(theme, task.tone);
  const highPriority = isMobileV2TaskHighPriority(task);
  const metaLabel = deriveMobileV2TaskMetaLabel(task);
  const showChipRow = highPriority || metaLabel !== null;
  // Urgent rows ("now" urgency + danger tone) get a danger-tinted full-row
  // fill and a 3px danger left border — design ScrTasks TaskRow.
  const urgent = task.urgency === "now" && task.tone === "danger";

  const containerStyle: ViewStyle = {
    backgroundColor: urgent ? theme.dangerSoft : theme.surface,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderLeftWidth: 3,
    borderLeftColor: urgent ? theme.danger : "transparent",
    flexDirection: "row",
    alignItems: "flex-start",
    columnGap: 12,
  };

  const titleStyle = {
    color: theme.ink,
    fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
    fontFamily: MOBILE_V2_FONT_SANS,
  } as const;

  const subStyle = {
    color: theme.muted,
    fontSize: MOBILE_V2_TYPE_SIZES.body,
    fontFamily: MOBILE_V2_FONT_SANS,
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.medium,
  } as const;

  const codeStyle = {
    color: theme.muted,
    fontSize: MOBILE_V2_TYPE_SIZES.chip,
    fontFamily: MOBILE_V2_FONT_MONO,
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
  } as const;

  return (
    <Pressable
      onPress={() => onPress(task)}
      accessibilityRole="button"
      accessibilityLabel={`${task.title} · ${task.cta} · ${task.urgency}`}
      style={containerStyle}
    >
      {/* Toned icon disk — design ScrTasks TaskRow leading element. */}
      <View
        style={{
          width: 38,
          height: 38,
          borderRadius: 10,
          backgroundColor: disk.bg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <FxIcon name={icon} size={18} color={disk.fg} />
      </View>

      {/* Title (+ inline code) / sub / chip-row stack */}
      <View style={{ flex: 1, minWidth: 0, rowGap: 3 }}>
        {/* Title row — `code` sits mono at the title baseline, right-aligned,
            matching the design's `FxRow justify="space-between" align="baseline"`. */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "baseline",
            justifyContent: "space-between",
            columnGap: MOBILE_V2_SPACING.lg,
          }}
        >
          <Text style={[titleStyle, { flex: 1, minWidth: 0 }]} numberOfLines={1}>
            {task.title}
          </Text>
          {task.code !== null ? (
            <Text style={codeStyle} numberOfLines={1}>
              {task.code}
            </Text>
          ) : null}
        </View>
        {task.sub !== null ? (
          <Text style={subStyle} numberOfLines={1}>
            {task.sub}
          </Text>
        ) : null}
        {/* Chip row — Priority chip (high-priority band) + meta chip. Design
            ScrTasks TaskRow renders this only when there is something to show. */}
        {showChipRow ? (
          <FxRow gap={MOBILE_V2_SPACING.sm} wrap style={{ marginTop: MOBILE_V2_SPACING.xs }}>
            {highPriority ? (
              <FxChip theme={theme} tone="danger" icon="alert" dense>
                {strings.taskControls.priority}
              </FxChip>
            ) : null}
            {metaLabel !== null ? (
              <FxChip theme={theme} tone={chipTone} dense>
                {metaLabel}
              </FxChip>
            ) : null}
          </FxRow>
        ) : null}
      </View>

      {/* Trailing chevron — design ScrTasks TaskRow affordance. The 10px
          top offset aligns the glyph with the title baseline (the row is
          flex-start, mirroring the design's `marginTop:10`). */}
      <View style={{ marginTop: 10 }}>
        <FxIcon name="chevron-right" size={16} color={theme.muted} />
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// MobileV2TasksScreen
// ---------------------------------------------------------------------------

export type MobileV2TasksDataState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string; readonly onRetry?: () => void }
  | { readonly kind: "ready"; readonly tasks: ReadonlyArray<MobileV2Task> };

/** Tasks view mode — mirrors design ScrTasks segmented control (list / board / map). */
export type MobileV2TasksViewMode = "list" | "board" | "map";

export interface MobileV2TasksScreenProps {
  readonly theme: MobileV2Theme;
  readonly state: MobileV2TasksDataState;
  readonly query: string;
  readonly onQueryChange: (next: string) => void;
  readonly onScanPress?: () => void;
  readonly onTaskPress: (task: MobileV2Task) => void;
  readonly onFilterPress?: () => void;
  readonly onSortPress?: () => void;
  readonly onGroupPress?: () => void;
  /** Active sort mode (defaults to "smart"). */
  readonly sortMode?: import("./mobile-v2-tasks-types").MobileV2TaskSortMode;
  /** When false, render a flat sorted list with no urgency groupings. */
  readonly grouped?: boolean;
  /**
   * Optional chip-label overrides. When the host drives the
   * filters/group/sort sheets (design ScrTasks) it owns the live
   * label + active state; the screen falls back to its `sortMode` /
   * `grouped` props when these are omitted (gallery / Storybook).
   */
  readonly filterLabel?: string;
  readonly filterActive?: boolean;
  readonly groupLabel?: string;
  readonly sortLabel?: string;
  /** Active view mode (defaults to "list"). The list / board / map view
   * bodies all render real content; the host wires `onViewModeChange`. */
  readonly viewMode?: MobileV2TasksViewMode;
  readonly onViewModeChange?: (next: MobileV2TasksViewMode) => void;
  /**
   * Optional host-computed task groups — when provided the screen renders
   * these directly instead of running its own query-filter / sort / group.
   * The host (`PreviewBody`) uses this to drive the full design saved-view
   * filter/sort/group surface (audit F7/F8/F9). Each group is
   * `{ key, label, count, tasks }`. Omitted by the gallery, which keeps
   * the screen's built-in `sortMode` / `grouped` path.
   */
  readonly precomputedGroups?: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly count: number;
    readonly tasks: ReadonlyArray<MobileV2Task>;
  }>;
  /** Host-computed flat task list feeding the Map view (paired with precomputedGroups). */
  readonly precomputedTasks?: ReadonlyArray<MobileV2Task>;
  /**
   * Clear-filters action for the empty-state (design ScrTasks
   * flow-tasks.jsx:580-585). Surfaced only when the empty list is the
   * result of an active search query or filter; the host resets the
   * search + filter state.
   */
  readonly onClearFilters?: () => void;
  /** Active UI locale ("en" | "ar"); defaults to English. */
  readonly locale?: string;
  readonly style?: StyleProp<ViewStyle>;
}

// ---------------------------------------------------------------------------
// ViewModeSegmented — pixel-faithful port of the design's segmented control
// (flow-tasks.jsx:534-555). Three pill cells: List / Board / Map. Active cell
// gets surface bg + ink text + subtle shadow; inactive cells stay transparent
// with muted text. Cells flex equal-width; gap=0 so the divider is implicit.
// ---------------------------------------------------------------------------

const VIEW_MODE_CELLS: ReadonlyArray<{
  readonly k: MobileV2TasksViewMode;
  readonly icon: "list" | "split" | "pin";
}> = Object.freeze([
  Object.freeze({ k: "list", icon: "list" }),
  Object.freeze({ k: "board", icon: "split" }),
  Object.freeze({ k: "map", icon: "pin" }),
]);

function viewModeLabel(mode: MobileV2TasksViewMode, strings: FieldOpsStrings): string {
  if (mode === "board") return strings.taskControls.board;
  if (mode === "map") return strings.tasksScreen.map;
  return strings.taskControls.list;
}

interface ViewModeSegmentedProps {
  readonly theme: MobileV2Theme;
  readonly strings: FieldOpsStrings;
  readonly active: MobileV2TasksViewMode;
  readonly onChange?: (next: MobileV2TasksViewMode) => void;
}

function ViewModeSegmented({ theme, strings, active, onChange }: ViewModeSegmentedProps): React.ReactElement {
  return (
    <View
      style={{
        flexDirection: "row",
        columnGap: 0,
        backgroundColor: theme.surfaceAlt,
        borderColor: theme.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 2,
      }}
    >
      {VIEW_MODE_CELLS.map((v) => {
        const on = v.k === active;
        const label = viewModeLabel(v.k, strings);
        return (
          <Pressable
            key={v.k}
            onPress={() => onChange?.(v.k)}
            accessibilityRole="button"
            accessibilityLabel={strings.tasksScreen.showView.replace("{view}", () => label.toLowerCase())}
            style={{
              flex: 1,
              height: 30,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              columnGap: 5,
              borderRadius: 8,
              backgroundColor: on ? theme.surface : "transparent",
            }}
          >
            <FxIcon name={v.icon} size={13} color={on ? theme.ink : theme.muted} />
            <Text
              style={{
                color: on ? theme.ink : theme.muted,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                fontSize: 12,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// KpiStat — single cell of the Now/Today/Later/Total hero strip. Pixel-faithful
// port of the design's `Stat` (flow-tasks.jsx:898). Cells are equal-width,
// centered, with a divider on every non-first cell.
// ---------------------------------------------------------------------------

interface KpiStatProps {
  readonly theme: MobileV2Theme;
  readonly value: number;
  readonly label: string;
  readonly tone: "danger" | "warning" | "muted" | "accent";
  readonly first?: boolean;
  readonly last?: boolean;
}

function KpiStat({ theme, value, label, tone, first }: KpiStatProps): React.ReactElement {
  const color =
    tone === "danger"
      ? theme.danger
      : tone === "warning"
        ? theme.warning
        : tone === "accent"
          ? theme.accent
          : theme.ink;
  return (
    <View
      style={{
        flex: 1,
        paddingVertical: 4,
        alignItems: "center",
        borderLeftWidth: first === true ? 0 : 1,
        borderLeftColor: theme.border,
      }}
    >
      <Text
        style={{
          fontSize: 22,
          fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
          color,
          lineHeight: 22,
          fontFamily: MOBILE_V2_FONT_MONO,
        }}
      >
        {value}
      </Text>
      <Text
        style={{
          fontSize: 10,
          color: theme.muted,
          fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          marginTop: 4,
          fontFamily: MOBILE_V2_FONT_SANS,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// TaskCard — compact card used inside the Board columns. Pixel-faithful
// port of the design's `TaskCard` (flow-tasks.jsx:803-832): toned icon
// disk + 2-line title + sub + meta chip + code.
// ---------------------------------------------------------------------------

interface TaskCardProps {
  readonly theme: MobileV2Theme;
  readonly task: MobileV2Task;
  readonly onPress: (task: MobileV2Task) => void;
}

function TaskCard({ theme, task, onPress }: TaskCardProps): React.ReactElement {
  const disk = resolveTaskIconDisk(theme, task.tone);
  const icon = resolveTypeIcon(task.type);
  const chipTone = toneToChipTone(task.tone);
  const metaLabel = deriveMobileV2TaskMetaLabel(task);
  const showFooter = metaLabel !== null || task.code !== null;
  return (
    <Pressable
      onPress={() => onPress(task)}
      accessibilityRole="button"
      accessibilityLabel={`${task.title} · ${task.cta}`}
      style={{
        backgroundColor: theme.surface,
        borderColor: theme.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 10,
      }}
    >
      <FxRow gap={MOBILE_V2_SPACING.md} align="flex-start">
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            backgroundColor: disk.bg,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <FxIcon name={icon} size={14} color={disk.fg} />
        </View>
        <View style={{ flex: 1, minWidth: 0, rowGap: 2 }}>
          <Text
            style={{
              fontSize: 12.5,
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
              color: theme.ink,
              fontFamily: MOBILE_V2_FONT_SANS,
            }}
            numberOfLines={2}
          >
            {task.title}
          </Text>
          {task.sub !== null ? (
            <Text
              style={{
                fontSize: 10.5,
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
              numberOfLines={1}
            >
              {task.sub}
            </Text>
          ) : null}
        </View>
      </FxRow>
      {/* Footer chip row — meta chip + `code` mono. Design ScrTasks
          TaskCard (flow-tasks.jsx:824-829) renders this only when there
          is a meta label or a code to show. */}
      {showFooter ? (
        <FxRow gap={MOBILE_V2_SPACING.sm} wrap align="center" style={{ marginTop: MOBILE_V2_SPACING.md }}>
          {metaLabel !== null ? (
            <FxChip theme={theme} tone={chipTone} dense>
              {metaLabel}
            </FxChip>
          ) : null}
          {task.code !== null ? (
            <Text
              style={{
                fontSize: 10,
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_MONO,
              }}
            >
              {task.code}
            </Text>
          ) : null}
        </FxRow>
      ) : null}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// TaskBoard — kanban-style horizontal column scroll, one column per
// urgency group. Pixel-faithful port of the design's `TaskBoard`
// (flow-tasks.jsx:769-801): 240px columns, surface header + dot + count.
// ---------------------------------------------------------------------------

interface TaskBoardProps {
  readonly theme: MobileV2Theme;
  readonly groups: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly count: number;
    readonly tasks: ReadonlyArray<MobileV2Task>;
  }>;
  readonly onTaskPress: (task: MobileV2Task) => void;
}

function TaskBoard({ theme, groups, onTaskPress }: TaskBoardProps): React.ReactElement {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        columnGap: MOBILE_V2_SPACING.xl,
        padding: MOBILE_V2_SPACING["3xl"],
      }}
    >
      {groups.map((group) => {
        const dot =
          group.key === "now"
            ? theme.danger
            : group.key === "today"
              ? theme.warning
              : theme.muted;
        return (
          <View
            key={group.key}
            style={{
              width: 240,
              backgroundColor: theme.surfaceAlt,
              borderColor: theme.border,
              borderWidth: 1,
              borderRadius: 14,
              overflow: "hidden",
            }}
          >
            <FxRow
              justify="space-between"
              align="center"
              style={{
                paddingVertical: MOBILE_V2_SPACING.lg,
                paddingHorizontal: MOBILE_V2_SPACING["2xl"],
                backgroundColor: theme.surface,
                borderBottomColor: theme.border,
                borderBottomWidth: 1,
              }}
            >
              <FxRow gap={MOBILE_V2_SPACING.md} align="center">
                <View
                  style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dot }}
                />
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {group.label}
                </Text>
              </FxRow>
              <FxChip theme={theme} dense mono>
                {String(group.count)}
              </FxChip>
            </FxRow>
            <View style={{ padding: MOBILE_V2_SPACING.md, rowGap: MOBILE_V2_SPACING.md }}>
              {group.tasks.map((task) => (
                <TaskCard key={task.task_id} theme={theme} task={task} onPress={onTaskPress} />
              ))}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// TaskMap — faux map background + area swimlanes. Pixel-faithful port of
// the design's `TaskMap` (flow-tasks.jsx:837-892): tasks grouped by
// `area`, a 200px synthetic map header, then per-area row groups.
// ---------------------------------------------------------------------------

interface TaskMapProps {
  readonly theme: MobileV2Theme;
  readonly strings: FieldOpsStrings;
  readonly tasks: ReadonlyArray<MobileV2Task>;
  readonly onTaskPress: (task: MobileV2Task) => void;
}

/**
 * Deterministic 0..1 position from an area name + salt — mirrors the
 * design `TaskMap` `pos()` hash (flow-tasks.jsx:844-847) so each area
 * pin lands in a stable spot on the faux-map header.
 */
function taskMapPinPos(s: string, salt: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs((h + salt) % 1000) / 1000;
}

function TaskMap({ theme, strings, tasks, onTaskPress }: TaskMapProps): React.ReactElement {
  const byArea = React.useMemo(() => {
    const buckets = new Map<string, MobileV2Task[]>();
    for (const t of tasks) {
      const key = t.area !== null && t.area.length > 0 ? t.area : "—";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(t);
    }
    return [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [tasks]);

  return (
    <View style={{ flex: 1 }}>
      {/* Faux map header */}
      <View
        style={{
          height: 200,
          backgroundColor: theme.surfaceAlt,
          borderBottomColor: theme.border,
          borderBottomWidth: 1,
        }}
      >
        <MobileV2FxMap theme={theme} mini />
        {/* Per-area map pins — design TaskMap (flow-tasks.jsx:853-865):
            one pin per area, hash-positioned, with an area-name label
            chip above a count circle (danger when the area has a "now"
            task, accent otherwise). U3 fix: the pin loop was absent. */}
        {byArea.map(([area, areaTasks]) => {
          const x = 8 + taskMapPinPos(area, 1) * 84;
          const y = 12 + taskMapPinPos(area, 7) * 72;
          const hot = areaTasks.some((tk) => tk.urgency === "now");
          return (
            <View
              key={area}
              pointerEvents="none"
              style={{
                position: "absolute",
                left: `${x}%`,
                top: `${y}%`,
                alignItems: "center",
                rowGap: 2,
                // translate(-50%,-100%): anchor the pin tip at (x,y).
                transform: [{ translateX: -22 }, { translateY: -44 }],
              }}
            >
              <View
                style={{
                  backgroundColor: theme.surface,
                  borderColor: theme.border,
                  borderWidth: 1,
                  borderRadius: 8,
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                }}
              >
                <Text
                  style={{
                    fontSize: 10,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                  numberOfLines={1}
                >
                  {area}
                </Text>
              </View>
              <View
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 13,
                  backgroundColor: hot ? theme.danger : theme.accent,
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: 2,
                  borderColor: theme.surface,
                }}
              >
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                    // White on a saturated danger fill — same precedent
                    // as the FxButton "danger" variant (#FFFFFF on
                    // theme.danger); accentInk on the accent fill.
                    color: hot ? "#FFFFFF" : theme.accentInk,
                    fontFamily: MOBILE_V2_FONT_MONO,
                  }}
                >
                  {String(areaTasks.length)}
                </Text>
              </View>
            </View>
          );
        })}
        <View
          style={{
            position: "absolute",
            bottom: 8,
            right: 8,
            backgroundColor: theme.surface,
            borderColor: theme.border,
            borderWidth: 1,
            borderRadius: 8,
            paddingHorizontal: 8,
            paddingVertical: 4,
          }}
        >
          <Text
            style={{
              fontSize: 10,
              color: theme.muted,
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
              fontFamily: MOBILE_V2_FONT_SANS,
            }}
          >
            {strings.tasksScreen.mapSummary
              .replace("{areas}", () => String(byArea.length))
              .replace("{tasks}", () => String(tasks.length))}
          </Text>
        </View>
      </View>
      {/* Area swimlanes */}
      <ScrollView contentContainerStyle={{ paddingBottom: 96 }}>
        {byArea.map(([area, areaTasks]) => {
          const hot = areaTasks.filter((t) => t.urgency === "now").length;
          return (
            <View key={area}>
              <FxRow
                justify="space-between"
                align="center"
                style={{
                  paddingTop: MOBILE_V2_SPACING["2xl"],
                  paddingBottom: MOBILE_V2_SPACING.md,
                  paddingHorizontal: MOBILE_V2_SPACING["4xl"],
                }}
              >
                <FxRow gap={MOBILE_V2_SPACING.md} align="center">
                  <FxIcon name="pin" size={13} color={theme.muted} />
                  <Text
                    style={{
                      fontSize: 11,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                      letterSpacing: 0.6,
                      textTransform: "uppercase",
                      color: theme.ink,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {area}
                  </Text>
                  <FxChip theme={theme} dense mono>
                    {String(areaTasks.length)}
                  </FxChip>
                  {hot > 0 ? (
                    <FxChip theme={theme} dense tone="danger" icon="alert">
                      {strings.tasksScreen.hotCount.replace("{count}", () => String(hot))}
                    </FxChip>
                  ) : null}
                </FxRow>
              </FxRow>
              <View
                style={{
                  backgroundColor: theme.border,
                  rowGap: 1,
                }}
              >
                {areaTasks.map((task) => (
                  <TaskRow key={task.task_id} theme={theme} strings={strings} task={task} onPress={onTaskPress} />
                ))}
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

export function MobileV2TasksScreen(props: MobileV2TasksScreenProps): React.ReactElement {
  const theme = props.theme;
  const strings = getStrings(resolveLocaleCode(props.locale));
  const sortMode = props.sortMode ?? "smart";
  const grouped = props.grouped ?? true;
  const viewMode = props.viewMode ?? "list";
  const hostDriven = props.precomputedGroups !== undefined;
  // The query-filtered + sorted task list shared by all three view modes.
  // When the host pre-computes groups (saved-view path) the screen uses
  // the host's flat list / groups verbatim instead of its own pipeline.
  const visibleTasks = React.useMemo(() => {
    if (hostDriven) {
      return props.precomputedTasks ?? [];
    }
    if (props.state.kind !== "ready") return [] as ReadonlyArray<MobileV2Task>;
    const filtered = filterMobileV2TasksByQuery(props.state.tasks, props.query);
    return sortMobileV2TasksBy(filtered, sortMode);
  }, [hostDriven, props.precomputedTasks, props.state, props.query, sortMode]);
  const groups = React.useMemo(() => {
    if (hostDriven) {
      return props.precomputedGroups ?? [];
    }
    if (props.state.kind !== "ready") return [];
    // Board view always groups by urgency (its columns); the list view
    // honors the grouped toggle.
    if (viewMode === "board" || grouped) {
      const urgencyLabels: Readonly<Record<MobileV2TaskUrgency, string>> = {
        now: strings.taskControls.now,
        today: strings.taskControls.today,
        later: strings.taskControls.later,
      };
      return groupMobileV2TasksByUrgency(visibleTasks).map((g) => ({
        ...g,
        label: urgencyLabels[g.key],
      }));
    }
    if (visibleTasks.length === 0) return [];
    // Ungrouped list view — one synthetic "All" section. Its key is the
    // non-urgency sentinel `all` (NOT a urgency bucket) so the group
    // header renders without an urgency glyph / tone, matching the
    // design's headerless `group.key==='none'` ungrouped path.
    return [
      Object.freeze({
        key: "all" as const,
        label: strings.taskViews.all,
        count: visibleTasks.length,
        tasks: visibleTasks,
      }),
    ];
  }, [hostDriven, props.precomputedGroups, props.state, visibleTasks, grouped, viewMode, strings]);

  const sortModeLabels: Readonly<Record<MobileV2TaskSortMode, string>> = {
    smart: strings.taskViews.sortSmartShort,
    eta: strings.taskControls.eta,
    priority: strings.taskControls.priority,
    area: strings.taskControls.area,
  };

  // Live KPI counts for the hero strip (Now / Today / Later / Total).
  // Mirrors flow-tasks.jsx ScrTasks counts that drive the Stat row above
  // the search bar. Counts come from the full task list (pre-filter), so
  // the strip reflects the whole queue, not the search subset.
  const kpiCounts = React.useMemo(
    () =>
      props.state.kind === "ready"
        ? computeMobileV2TaskKpiCounts(props.state.tasks)
        : ({ now: 0, today: 0, later: 0, all: 0 } as const),
    [props.state],
  );

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      {/* Hero KPI strip — Now / Today / Later / Total per design ScrTasks. */}
      {props.state.kind === "ready" ? (
        <View
          style={{
            paddingHorizontal: MOBILE_V2_SPACING["4xl"],
            paddingTop: MOBILE_V2_SPACING["2xl"],
          }}
        >
          <FxCard theme={theme} padding={14}>
            <FxRow gap={0} align="center">
              <KpiStat theme={theme} value={kpiCounts.now} label={strings.taskControls.now} tone="danger" first />
              <KpiStat theme={theme} value={kpiCounts.today} label={strings.taskControls.today} tone="warning" />
              <KpiStat theme={theme} value={kpiCounts.later} label={strings.taskControls.later} tone="muted" />
              <KpiStat theme={theme} value={kpiCounts.all} label={strings.taskControls.total} tone="accent" last />
            </FxRow>
          </FxCard>
        </View>
      ) : null}

      {/* Search bar */}
      <View
        style={{
          padding: MOBILE_V2_SPACING["4xl"],
          rowGap: MOBILE_V2_SPACING.lg,
          backgroundColor: theme.surface,
          borderBottomColor: theme.border,
          borderBottomWidth: StyleSheet.hairlineWidth,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: theme.surfaceAlt,
            borderRadius: MOBILE_V2_RADII.button,
            borderColor: theme.border,
            borderWidth: 1,
            paddingLeft: MOBILE_V2_SPACING["2xl"],
            columnGap: MOBILE_V2_SPACING.lg,
            overflow: "hidden",
          }}
        >
          <FxIcon name="search" size={16} color={theme.muted} />
          {/* U2 fix: a real editable TextInput bound to the query state
              (design FxSearchBar flow-network.jsx:16-27) — was a static
              Text placeholder with no input. The TextInput keeps the
              prior 2xl vertical padding so the search-bar height (and
              visual baseline) is unchanged. */}
          <TextInput
            value={props.query}
            onChangeText={props.onQueryChange}
            placeholder={strings.tasksScreen.searchPlaceholder}
            placeholderTextColor={theme.muted}
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            accessibilityLabel={strings.tasksScreen.searchLabel}
            style={{
              flex: 1,
              color: theme.ink,
              paddingVertical: MOBILE_V2_SPACING["2xl"],
              fontFamily: MOBILE_V2_FONT_SANS,
              fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
            }}
          />
          {/* Design FxSearchBar (flow-network.jsx:16-25) renders the scan
              affordance as a solid accent-filled pill: theme.accent
              background, accentInk text, borderRadius 8, padded. */}
          <Pressable
            onPress={props.onScanPress}
            accessibilityRole="button"
            accessibilityLabel={strings.tasksScreen.scanBarcode}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              columnGap: MOBILE_V2_SPACING.md,
              backgroundColor: theme.accent,
              height: 32,
              borderRadius: 8,
              paddingHorizontal: MOBILE_V2_SPACING.xl,
            }}
          >
            <FxIcon name="scan" size={14} color={theme.accentInk} stroke={2.4} />
            <Text
              style={{
                fontSize: 11.5,
                color: theme.accentInk,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              {strings.tasksScreen.scan}
            </Text>
          </Pressable>
        </View>

        {/* View-mode segmented (list / board / map) — pixel-faithful port of
            design ScrTasks segmented control (flow-tasks.jsx:534-555). The
            list pane is always rendered below; board / map surfaces are wired
            into the production preview shell. */}
        <ViewModeSegmented
          theme={theme}
          strings={strings}
          active={props.viewMode ?? "list"}
          onChange={props.onViewModeChange}
        />

        {/* Filter / Group / Sort toolbar — design ScrTasks ChipBtn pill row
            (flow-tasks.jsx:555-560): rounded-999 pills. The Group chip is
            list-mode only (the Board/Map views own their own grouping),
            matching the design's `{viewMode==='list' && ...}` guard. */}
        <FxRow gap={MOBILE_V2_SPACING.md} wrap>
          <FxChipButton
            theme={theme}
            icon="filter"
            label={props.filterLabel ?? strings.tasksScreen.filters}
            active={props.filterActive === true}
            onPress={props.onFilterPress}
            accessibilityLabel={strings.tasksScreen.openFilters}
          />
          {viewMode === "list" ? (
            <FxChipButton
              theme={theme}
              icon="list"
              label={props.groupLabel ?? (grouped ? strings.tasksScreen.grouped : strings.taskControls.group)}
              active={grouped}
              onPress={props.onGroupPress}
              accessibilityLabel={strings.tasksScreen.changeGrouping}
            />
          ) : null}
          <FxChipButton
            theme={theme}
            icon="chevron-down"
            label={strings.tasksScreen.sortChip.replace("{label}", () => props.sortLabel ?? sortModeLabels[sortMode])}
            onPress={props.onSortPress}
            accessibilityLabel={strings.tasksScreen.changeSort}
          />
        </FxRow>
      </View>

      {/* Body — non-ready / empty states render in a padded card; the
          ready state branches on view mode (list / board / map). */}
      {props.state.kind === "loading" ? (
        <ScrollView contentContainerStyle={{ padding: MOBILE_V2_SPACING["4xl"] }}>
          <FxCard theme={theme} soft>
            <FxRow gap={MOBILE_V2_SPACING.lg} align="center">
              <FxIcon name="sync" size={18} color={theme.muted} />
              <Text style={{ color: theme.muted, fontFamily: MOBILE_V2_FONT_SANS }}>
                {strings.tasksScreen.loading}
              </Text>
            </FxRow>
          </FxCard>
        </ScrollView>
      ) : props.state.kind === "error" ? (
        <ScrollView contentContainerStyle={{ padding: MOBILE_V2_SPACING["4xl"] }}>
          <FxCard theme={theme} soft>
            <FxCol gap={MOBILE_V2_SPACING.lg}>
              <FxRow gap={MOBILE_V2_SPACING.lg}>
                <FxIcon name="alert" size={20} color={theme.warning} />
                <Text
                  style={{
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  }}
                >
                  {strings.tasksScreen.loadError}
                </Text>
              </FxRow>
              <Text style={{ color: theme.muted, fontFamily: MOBILE_V2_FONT_SANS }}>
                {props.state.message}
              </Text>
              {props.state.onRetry !== undefined ? (
                <FxButton theme={theme} variant="soft" icon="refresh" size="sm" onPress={props.state.onRetry}>
                  {strings.tasksScreen.retry}
                </FxButton>
              ) : null}
            </FxCol>
          </FxCard>
        </ScrollView>
      ) : groups.length === 0 ? (
        // U6 fix: empty-state matches design ScrTasks (flow-tasks.jsx:
        // 571-586) — a green successSoft 56×56 disk + check icon, an
        // "All clear" headline, and "Nothing on the list right now."
        // copy. When a search query or filter is active the copy flips
        // to the "no match" variant + a Clear-filters action.
        (() => {
          const narrowed = props.query.length > 0 || props.filterActive === true;
          return (
            <ScrollView
              contentContainerStyle={{
                paddingHorizontal: 24,
                paddingVertical: 48,
                alignItems: "center",
              }}
            >
              <View
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 14,
                  backgroundColor: theme.successSoft,
                  alignItems: "center",
                  justifyContent: "center",
                  marginBottom: MOBILE_V2_SPACING.xl,
                }}
              >
                <FxIcon name="check" size={26} color={theme.success} />
              </View>
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                {narrowed ? strings.tasksScreen.noMatchTitle : strings.tasksScreen.allClearTitle}
              </Text>
              <Text
                style={{
                  fontSize: 12,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  textAlign: "center",
                  marginTop: MOBILE_V2_SPACING.sm,
                }}
              >
                {narrowed
                  ? strings.tasksScreen.noMatchBody
                  : strings.tasksScreen.allClearBody}
              </Text>
              {narrowed && props.onClearFilters !== undefined ? (
                <FxButton
                  theme={theme}
                  variant="soft"
                  size="sm"
                  icon="x"
                  onPress={props.onClearFilters}
                  accessibilityLabel={strings.tasksScreen.clearFilters}
                  style={{ marginTop: MOBILE_V2_SPACING["3xl"] }}
                >
                  {strings.tasksScreen.clearFilters}
                </FxButton>
              ) : null}
            </ScrollView>
          );
        })()
      ) : viewMode === "board" ? (
        <TaskBoard theme={theme} groups={groups} onTaskPress={props.onTaskPress} />
      ) : viewMode === "map" ? (
        <TaskMap theme={theme} strings={strings} tasks={visibleTasks} onTaskPress={props.onTaskPress} />
      ) : (
        <ScrollView
          contentContainerStyle={{
            padding: MOBILE_V2_SPACING["4xl"],
            rowGap: MOBILE_V2_SPACING["3xl"],
            paddingBottom: 96,
          }}
        >
          {groups.map((group) => {
            // Group header — design ScrTasks (flow-tasks.jsx:603-610):
            // [leading urgency icon] [uppercase label] [count FxChip
            // dense/mono, urgency-toned] on the left + trailing
            // `chevron-down`. Structurally consistent with the already-
            // correct Route screen group header. The urgency glyph/tone
            // come from `TASK_URGENCY_META` and are absent for any
            // non-urgency key (the design renders the icon conditionally).
            const urgencyMeta = TASK_URGENCY_META[group.key];
            return (
            <View key={group.key} style={{ rowGap: MOBILE_V2_SPACING["2xl"] }}>
              <FxRow
                justify="space-between"
                align="center"
                style={{
                  paddingTop: 14,
                  paddingBottom: MOBILE_V2_SPACING.md,
                  paddingHorizontal: 16,
                }}
              >
                <FxRow gap={MOBILE_V2_SPACING.lg} align="center">
                  {urgencyMeta !== undefined ? (
                    <FxIcon
                      name={urgencyMeta.icon}
                      size={12}
                      color={
                        urgencyMeta.tone === "danger"
                          ? theme.danger
                          : urgencyMeta.tone === "warning"
                            ? theme.warning
                            : theme.muted
                      }
                    />
                  ) : null}
                  <Text
                    style={{
                      fontSize: 10,
                      color: theme.muted,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                      letterSpacing: 0.8,
                      textTransform: "uppercase",
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {group.label}
                  </Text>
                  <FxChip
                    theme={theme}
                    dense
                    mono
                    tone={urgencyMeta?.tone ?? undefined}
                  >
                    {String(group.count)}
                  </FxChip>
                </FxRow>
                <FxIcon name="chevron-down" size={16} color={theme.muted} />
              </FxRow>
              {/* Edge-to-edge stacked rows over a 1px border divider —
                  design ScrTasks `TaskRows` (FxCol gap=1, bg=border). The
                  negative margin cancels the ScrollView gutter so rows run
                  full-bleed to the screen edges. */}
              <View
                style={{
                  backgroundColor: theme.border,
                  rowGap: 1,
                  marginHorizontal: -MOBILE_V2_SPACING["4xl"],
                }}
              >
                {group.tasks.map((task) => (
                  <TaskRow key={task.task_id} theme={theme} strings={strings} task={task} onPress={props.onTaskPress} />
                ))}
              </View>
            </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

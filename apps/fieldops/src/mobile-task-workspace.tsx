import * as React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { isRetriableNetworkError, isRetriableSupabaseError, type UiResourceList, type UiSort } from "@masarx/api";
import type { createMobileUiClient } from "@masarx/api/mobile";
import { createCacheKey, stableStringify, type KeyValueStore } from "@masarx/mobile-core";
import { MobileTaskControls } from "./mobile-task-controls";
import type { FieldOpsThemeTokens } from "./mobile-theme";
import type { FieldOpsStrings } from "./i18n";

type Client = ReturnType<typeof createMobileUiClient>;
type Filters = Record<string, unknown>;
type TaskConfig = {
  query_filter: string;
  urgency_filter: string;
  group_columns: string[];
  sort_options: Array<{ key: string; label_key: string; direction: string }>;
  metric_columns: { now: string; today: string; later: string };
};
const LANES = ["now", "today", "later"] as const;
const PAGE_SIZE = 50;

export function combineTaskFilters(base: Filters, additions: Filters[]): Filters {
  const rules = Array.isArray(base.rules)
    ? [base]
    : Object.entries(base).map(([key, value]) => ({ key, value }));
  return { op: "and", rules: [...rules, ...additions] };
}

function taskConfig(value: unknown): TaskConfig | null {
  if (!value || typeof value !== "object") return null;
  const config = value as TaskConfig;
  const nonemptyString = (input: unknown): input is string => typeof input === "string" && input.trim().length > 0;
  if (!nonemptyString(config.query_filter) || !nonemptyString(config.urgency_filter) || !Array.isArray(config.group_columns)
    || !config.group_columns.every(nonemptyString)
    || !Array.isArray(config.sort_options) || !config.sort_options.length
    || !config.sort_options.every(option => option && nonemptyString(option.key) && nonemptyString(option.label_key) && option.direction === "asc")
    || !LANES.every(key => nonemptyString(config.metric_columns?.[key]))) return null;
  return config;
}

type RenderPage = (input: {
  list: UiResourceList; source: "network" | "cache"; refreshing: boolean; onRefresh: () => void;
}) => React.ReactNode;
type Props = {
  client: Client; actorId: string; scope: unknown; baseFilters: Filters; baseSort: UiSort | null;
  theme: FieldOpsThemeTokens; strings: FieldOpsStrings; interactionLocked: boolean;
  cache: KeyValueStore | null; renderPage: RenderPage;
};

export function MobileTaskWorkspace(props: Props) {
  const { client, actorId, scope, strings, theme, baseFilters, baseSort } = props;
  const labels = strings.taskControls;
  const [query, setQuery] = React.useState("");
  const [filterKey, setFilterKey] = React.useState("");
  const [filterValue, setFilterValue] = React.useState("");
  const [applied, setApplied] = React.useState<Filters[]>([]);
  const [mode, setMode] = React.useState("list");
  const [group, setGroup] = React.useState("");
  const [sortKey, setSortKey] = React.useState("");
  const [page, setPage] = React.useState(0);
  const registry = useQuery({
    queryKey: ["ui", "task-controls-registry", actorId, scope],
    queryFn: () => client.readRegistry(), enabled: Boolean(actorId),
  });
  const resource = registry.data?.resources?.find(row => row.key === "tasks");
  const config = registry.isError ? null : taskConfig((resource as unknown as { task_controls?: unknown })?.task_controls);
  const filters = combineTaskFilters(baseFilters, applied);
  const selectedSort = config?.sort_options.find(option => option.key === sortKey);
  const inheritedSort = baseSort ?? config?.sort_options[0] ?? null;
  const effectiveSort = selectedSort ?? inheritedSort;
  const sort: UiSort | null = effectiveSort
    ? { key: effectiveSort.key, direction: effectiveSort.direction,
      ...((group || (!selectedSort && baseSort?.group_key)) ? { group_key: group || baseSort?.group_key } : {}) }
    : null;
  const identity = stableStringify({ actorId, scope, filters, sort });
  const metricColumns = config ? LANES.map(key => config.metric_columns[key]) : [];
  const metrics = useQuery({
    queryKey: ["ui", "list", "tasks-metrics", actorId, scope, filters, metricColumns],
    queryFn: () => client.resourceMetrics("tasks", filters, metricColumns),
    enabled: Boolean(actorId && config),
  });
  const pageQuery = useTaskPage(props, filters, sort, page, mode === "list" && Boolean(config));
  const resetPage = (change: () => void) => { setPage(0); change(); };
  const optionLabels: Record<string, string> = { smart: labels.smart, priority: labels.priority, eta: labels.eta,
    area: labels.area, urgency: labels.urgency, task_type_key: labels.task_type_key, queue_key: labels.queue_key };
  const label = (key: string) => optionLabels[key] ?? resource?.column_labels?.[key] ?? key;
  const filterOptions = (resource?.filters ?? []).filter(filter => filter.key !== config?.query_filter);
  const summary = metrics.data && !metrics.isFetching && !metrics.isError && config
    && Number.isFinite(metrics.data.total)
    && LANES.every(key => metrics.data.total === 0 || Number.isFinite(metrics.data.columns[config.metric_columns[key]]?.sum))
    ? { status: "ready" as const, counts: {
      total: metrics.data.total,
      now: metrics.data.total === 0 ? 0 : metrics.data.columns[config.metric_columns.now].sum!,
      today: metrics.data.total === 0 ? 0 : metrics.data.columns[config.metric_columns.today].sum!,
      later: metrics.data.total === 0 ? 0 : metrics.data.columns[config.metric_columns.later].sum!,
    } }
    : { status: metrics.isFetching ? "loading" as const : "error" as const };
  if (!config) return <Text accessibilityRole={registry.isError || !registry.isLoading ? "alert" : undefined}>
    {registry.isLoading ? labels.loading : labels.registryUnavailable}
  </Text>;
  return <View style={{ flex: 1, gap: 12 }}>
    <MobileTaskControls
      theme={theme} labels={labels} query={query} onQueryChange={setQuery}
      onSearch={() => resetPage(() => setApplied([
        ...(query.trim() ? [{ key: config.query_filter, value: query.trim() }] : []),
        ...(filterKey && filterValue.trim() ? [{ key: filterKey, value: filterValue.trim() }] : []),
      ]))}
      onClear={() => resetPage(() => { setQuery(""); setFilterKey(""); setFilterValue(""); setApplied([]); setGroup(""); setSortKey(""); })}
      view={mode} viewOptions={[{ value: "list", label: labels.list }, { value: "board", label: labels.board }]}
      onViewChange={value => resetPage(() => setMode(value))}
      filterOptions={[{ value: "", label: labels.none }, ...filterOptions.map(filter => ({ value: filter.key, label: filter.label ?? label(filter.key) }))]}
      filterKey={filterKey} onFilterKeyChange={setFilterKey} filterValue={filterValue} onFilterValueChange={setFilterValue}
      group={group} groupOptions={[{ value: "", label: labels.none }, ...config.group_columns.map(value => ({ value, label: label(value) }))]}
      onGroupChange={value => resetPage(() => setGroup(value))}
      sort={sortKey} sortOptions={[{ value: "", label: labels.savedSort }, ...config.sort_options.map(option => ({ value: option.key, label: label(option.label_key) }))]}
      onSortChange={value => resetPage(() => setSortKey(value))}
      page={{ label: mode === "board" ? labels.boardPaging : labels.page(page + 1),
        canPrevious: mode === "list" && page > 0,
        canNext: mode === "list" && canNext(pageQuery.data?.list),
        onPrevious: () => setPage(current => Math.max(0, current - 1)), onNext: () => setPage(current => current + 1),
        total: summary.status === "ready" ? summary.counts.total : null, estimated: false }}
      summary={summary} busy={registry.isFetching || metrics.isFetching || (mode === "list" && pageQuery.isFetching)}
      interactionLocked={props.interactionLocked}
    />
    {group ? <Text>{labels.groupPageNotice}</Text> : null}
    {mode === "board" ? <ScrollView horizontal>
      {LANES.map(lane => <TaskLane key={identity + lane} {...props} config={config} filters={filters} sort={sort} group={group} lane={lane} />)}
    </ScrollView> : <PageResult {...props} query={pageQuery} group={group} />}
  </View>;
}

function canNext(list?: UiResourceList) {
  if (!list) return false;
  return list.total != null && !list.total_is_estimate
    ? list.offset + list.items.length < list.total : list.items.length === list.limit;
}

function useTaskPage(props: Props, filters: Filters, sort: UiSort | null, page: number, enabled: boolean) {
  const key = createCacheKey({ v: 2, type: "ui_list_resource_v1", actor: props.actorId, scope: props.scope,
    resource: "tasks", filters, sort, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  return useQuery({
    queryKey: ["ui", "list", "tasks", key], enabled: enabled && Boolean(props.actorId),
    queryFn: async () => {
      try {
        const list = await props.client.listResource("tasks", filters, PAGE_SIZE, page * PAGE_SIZE, sort);
        await props.cache?.set(key, { list });
        return { list, source: "network" as const };
      } catch (error) {
        if (!isRetriableNetworkError(error) && !isRetriableSupabaseError(error)) throw error;
        const cached = await props.cache?.get(key) as { list?: UiResourceList } | null;
        if (!cached?.list || cached.list.resource !== "tasks" || !Array.isArray(cached.list.items)) throw error;
        return { list: cached.list, source: "cache" as const };
      }
    },
  });
}

function PageResult(props: Props & { query: ReturnType<typeof useTaskPage>; group: string }) {
  const { query, strings, renderPage, group } = props;
  if (query.isLoading) return <Text>{strings.taskControls.loading}</Text>;
  if (query.isError || !query.data) return <Text accessibilityRole="alert">{strings.taskControls.listError}</Text>;
  const { list, source } = query.data;
  const render = (subset: UiResourceList) => renderPage({ list: subset, source,
    refreshing: query.isFetching, onRefresh: () => { if (!props.interactionLocked) void query.refetch(); } });
  if (!group || !list.items.length) return <>{render(list)}</>;
  const groups: Array<{ value: unknown; items: Record<string, unknown>[] }> = [];
  for (const item of list.items) {
    const prior = groups[groups.length - 1];
    if (prior && prior.value === item[group]) prior.items.push(item);
    else groups.push({ value: item[group], items: [item] });
  }
  return <ScrollView>{groups.map((entry, index) => <View key={index}>
    <Text>{entry.value == null ? strings.taskControls.none : String(entry.value)}</Text>
    {render({ ...list, items: entry.items, total: null, total_is_estimate: false })}
  </View>)}</ScrollView>;
}

function TaskLane(props: Props & { config: TaskConfig; filters: Filters; sort: UiSort | null; group: string; lane: typeof LANES[number] }) {
  const [page, setPage] = React.useState(0);
  const filters = combineTaskFilters(props.filters, [{ key: props.config.urgency_filter, value: props.lane }]);
  const query = useTaskPage(props, filters, props.sort, page, true);
  const labels = props.strings.taskControls;
  const disabled = props.interactionLocked || query.isFetching;
  return <View style={{ width: 320, padding: 8 }}>
    <Text>{labels[props.lane]}</Text>
    <Text>{labels.page(page + 1)}</Text>
    <View style={{ flexDirection: "row", gap: 12 }}>
      {[{ name: labels.previous, change: -1, blocked: page === 0 }, { name: labels.next, change: 1, blocked: !canNext(query.data?.list) }].map(button =>
        <Pressable key={button.name} accessibilityRole="button" accessibilityLabel={`${labels[props.lane]}: ${button.name}`}
          accessibilityState={{ disabled: disabled || button.blocked }} disabled={disabled || button.blocked}
          style={{ minHeight: 48, justifyContent: "center" }}
          onPress={() => { if (!disabled && !button.blocked) setPage(current => current + button.change); }}>
          <Text>{button.name}</Text>
        </Pressable>)}
    </View>
    <PageResult {...props} query={query} />
  </View>;
}

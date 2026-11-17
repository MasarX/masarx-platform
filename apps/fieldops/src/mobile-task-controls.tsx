import * as React from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { FieldOpsThemeTokens } from "./mobile-theme";

export type MobileTaskControlOption = { value: string; label: string };
export type MobileTaskControlsProps = {
  theme: FieldOpsThemeTokens;
  labels: {
    query: string; search: string; clear: string; view: string; group: string; sort: string;
    filter: string; filterValue: string;
    previous: string; next: string; loading: string; summaryError: string;
    totalUnavailable: string; estimatedWarning: string;
    now: string; today: string; later: string; total: string;
    totalCount: (count: number) => string;
    formatCount: (count: number) => string;
  };
  query: string;
  onQueryChange: (query: string) => void;
  onSearch: () => void;
  onClear: () => void;
  view: string;
  viewOptions: readonly MobileTaskControlOption[];
  onViewChange: (value: string) => void;
  filterOptions: readonly MobileTaskControlOption[];
  filterKey: string;
  onFilterKeyChange: (value: string) => void;
  filterValue: string;
  onFilterValueChange: (value: string) => void;
  group: string;
  groupOptions: readonly MobileTaskControlOption[];
  onGroupChange: (value: string) => void;
  sort: string;
  sortOptions: readonly MobileTaskControlOption[];
  onSortChange: (value: string) => void;
  page: {
    label: string; canPrevious: boolean; canNext: boolean;
    onPrevious: () => void; onNext: () => void;
    total: number | null; estimated: boolean;
  };
  summary:
    | { status: "ready"; counts: { now: number; today: number; later: number; total: number } }
    | { status: "loading" | "error"; counts?: never };
  busy: boolean;
  interactionLocked: boolean;
};

export function MobileTaskControls(props: MobileTaskControlsProps) {
  const { theme, labels, busy, interactionLocked, page, summary } = props;
  const disabled = busy || interactionLocked;
  const text = { color: theme.color.text, fontFamily: theme.font.sans };
  const button = (label: string, onPress: () => void, blocked = disabled, selected?: boolean) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: blocked, busy, selected }}
      disabled={blocked}
      onPress={() => { if (!blocked) onPress(); }}
      style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 8,
        borderWidth: selected ? 2 : 1, borderColor: selected ? theme.color.accent : theme.color.border,
        borderRadius: theme.radius.sm, backgroundColor: selected ? theme.color.accentSoft : theme.color.cardBg }}
    >
      <Text style={[text, { fontWeight: selected ? "700" : "400", color: blocked ? theme.color.textMuted : theme.color.text }]}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ gap: 12 }}>
      <View>
        <Text style={text}>{labels.query}</Text>
        <TextInput
          accessibilityLabel={labels.query}
          accessibilityState={{ disabled: interactionLocked }}
          value={props.query}
          editable={!interactionLocked}
          onChangeText={(value) => { if (!interactionLocked) props.onQueryChange(value); }}
          onSubmitEditing={() => { if (!disabled) props.onSearch(); }}
          returnKeyType="search"
          style={[text, { minHeight: 48, borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.sm, padding: 12 }]}
        />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {button(labels.search, props.onSearch)}
        {button(labels.clear, props.onClear, interactionLocked)}
      </View>
      {([
        [labels.view, props.view, props.viewOptions, props.onViewChange],
        [labels.filter, props.filterKey, props.filterOptions, props.onFilterKeyChange],
        [labels.group, props.group, props.groupOptions, props.onGroupChange],
        [labels.sort, props.sort, props.sortOptions, props.onSortChange],
      ] as const).map(([label, selected, options, onChange]) => (
        <View key={label} style={{ gap: 4 }}>
          <Text style={text}>{label}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {options.map(option => <React.Fragment key={option.value}>{button(option.label, () => onChange(option.value), disabled, option.value === selected)}</React.Fragment>)}
          </View>
        </View>
      ))}
      <View>
        <Text style={text}>{labels.filterValue}</Text>
        <TextInput
          accessibilityLabel={labels.filterValue}
          accessibilityState={{ disabled: interactionLocked }}
          value={props.filterValue}
          editable={!interactionLocked}
          onChangeText={(value) => { if (!interactionLocked) props.onFilterValueChange(value); }}
          onSubmitEditing={() => { if (!disabled) props.onSearch(); }}
          returnKeyType="search"
          style={[text, { minHeight: 48, borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.sm, padding: 12 }]}
        />
      </View>
      <View testID="mobile-task-summary" accessibilityState={{ busy: summary.status === "loading" }} style={{ gap: 4 }}>
        {summary.status === "ready" ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
            {(["now", "today", "later", "total"] as const).map(key => (
              <Text key={key} style={text}>{labels[key]}: {labels.formatCount(summary.counts[key])}</Text>
            ))}
          </View>
        ) : <Text accessibilityRole={summary.status === "error" ? "alert" : undefined} style={text}>{summary.status === "loading" ? labels.loading : labels.summaryError}</Text>}
      </View>
      <Text style={text}>{page.total === null ? labels.totalUnavailable : labels.totalCount(page.total)}</Text>
      {page.estimated ? <Text style={text}>{labels.estimatedWarning}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        {button(labels.previous, page.onPrevious, disabled || !page.canPrevious)}
        <Text style={text}>{page.label}</Text>
        {button(labels.next, page.onNext, disabled || !page.canNext)}
      </View>
    </View>
  );
}

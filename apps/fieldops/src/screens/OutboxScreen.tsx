import * as React from "react";
import { Pressable, Text, type PressableProps, type StyleProp, type TextStyle } from "react-native";
import { EmptyState } from "../components/EmptyState";
import { IllustrationOutboxClear } from "../illustrations";
import { hasDeadEntries, OUTBOX_EMPTY_STATE_DESCRIPTION, OUTBOX_EMPTY_STATE_TITLE } from "./outbox-screen-helpers";

export function OutboxEmptyState({
  title = OUTBOX_EMPTY_STATE_TITLE,
  description = OUTBOX_EMPTY_STATE_DESCRIPTION,
}: { title?: string; description?: string }) {
  return (
    <EmptyState
      title={title}
      description={description}
      icon={<IllustrationOutboxClear size={96} />}
      testID="mobile-outbox-empty-state"
    />
  );
}

export function OutboxClearDeadButton({
  entries,
  onPress,
  label,
  accessibility,
  style,
  textStyle,
}: {
  entries: Parameters<typeof hasDeadEntries>[0];
  onPress: () => void;
  label?: string;
  accessibility: Pick<PressableProps, "accessibilityHint" | "accessibilityRole" | "accessibilityState">;
  style: PressableProps["style"];
  textStyle: StyleProp<TextStyle>;
}) {
  const showClearDead = hasDeadEntries(entries);
  return (
    <>{showClearDead ? (
      <Pressable onPress={onPress} {...accessibility} disabled={accessibility.accessibilityState?.disabled} style={style}>
        <Text style={textStyle}>{label ?? "Clear dead"}</Text>
      </Pressable>
    ) : null}</>
  );
}

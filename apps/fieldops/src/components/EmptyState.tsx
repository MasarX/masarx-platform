import * as React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useThemedStyles } from "../mobile-theme-context";
import type { ThemeTokens } from "../mobile-theme";

// Resolve empty-state colors from the active theme for both light and dark modes.

export type EmptyStateAction = {
  label: string;
  onPress: () => void;
  testID?: string;
};

export type EmptyStateProps = {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: EmptyStateAction;
  testID?: string;
};

export function EmptyState(props: EmptyStateProps): React.JSX.Element {
  const { title, description, icon, action, testID = "empty-state" } = props;
  const styles = useThemedStyles(buildStyles);
  return (
    <View
      testID={testID}
      accessibilityRole="summary"
      style={styles.container}
    >
      {icon ? (
        <View testID={`${testID}-icon`} style={styles.icon}>
          {icon}
        </View>
      ) : null}
      <Text
        testID={`${testID}-title`}
        style={styles.title}
        numberOfLines={2}
      >
        {title}
      </Text>
      {description ? (
        <Text
          testID={`${testID}-description`}
          style={styles.description}
        >
          {description}
        </Text>
      ) : null}
      {action ? (
        <Pressable
          testID={action.testID ?? `${testID}-action`}
          accessibilityRole="button"
          onPress={action.onPress}
          style={({ pressed }) => [
            styles.action,
            pressed ? styles.actionPressed : null,
          ]}
        >
          <Text style={styles.actionLabel}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function buildStyles(tokens: ThemeTokens) {
  return StyleSheet.create({
    container: {
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: tokens.spacing.xl,
      paddingHorizontal: tokens.spacing.lg,
    },
    icon: {
      marginBottom: tokens.spacing.sm,
    },
    title: {
      fontSize: tokens.font.scale.md,
      fontWeight: "700",
      color: tokens.color.text,
      textAlign: "center",
      fontFamily: tokens.font.sans,
    },
    description: {
      marginTop: tokens.spacing.xs,
      fontSize: tokens.font.scale.sm,
      color: tokens.color.textMuted,
      textAlign: "center",
      lineHeight: 18,
      fontFamily: tokens.font.sans,
    },
    action: {
      marginTop: tokens.spacing.md,
      paddingHorizontal: tokens.spacing.md,
      paddingVertical: tokens.spacing.sm,
      borderRadius: tokens.radius.sm,
      backgroundColor: tokens.color.accent,
    },
    actionPressed: {
      opacity: 0.85,
    },
    actionLabel: {
      color: tokens.color.accentText,
      fontSize: tokens.font.scale.sm,
      fontWeight: "700",
      fontFamily: tokens.font.sans,
    },
  });
}

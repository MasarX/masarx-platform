import React from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import {
  resolveMobileV2RuntimeBlockerCopy,
  type MobileV2RuntimeBlockerKind,
} from "./mobile-v2-runtime-blocker-copy";

export function MobileV2RuntimeBlockerScreen(props: {
  readonly kind: MobileV2RuntimeBlockerKind;
  readonly appName?: string | null;
  readonly retrying?: boolean;
  readonly onRetry?: () => void;
  readonly testID?: string;
}): React.ReactElement {
  const copy = resolveMobileV2RuntimeBlockerCopy({
    kind: props.kind,
    appName: props.appName,
  });
  const canRetry = typeof props.onRetry === "function";

  return (
    <View
      accessibilityRole="alert"
      style={blockerStyles.container}
      testID={props.testID ?? "mobile-v2-runtime-blocker"}
    >
      <Text style={blockerStyles.appName}>{copy.title}</Text>
      <Text style={blockerStyles.heading}>{copy.heading}</Text>
      <Text style={blockerStyles.message}>{copy.message}</Text>
      {canRetry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.actionLabel}
          disabled={props.retrying}
          onPress={props.onRetry}
          style={({ pressed }) => [
            blockerStyles.button,
            pressed ? blockerStyles.buttonPressed : null,
            props.retrying ? blockerStyles.buttonDisabled : null,
          ]}
        >
          {props.retrying ? <ActivityIndicator color="#ffffff" size="small" /> : null}
          <Text style={blockerStyles.buttonText}>
            {props.retrying ? "Checking..." : copy.actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const blockerStyles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#eef2f7",
  },
  appName: {
    fontSize: 16,
    fontWeight: "800",
    color: "#0f172a",
    marginBottom: 10,
    fontFamily: Platform.select({
      web: '"IBM Plex Sans", "Segoe UI", sans-serif',
      default: undefined,
    }),
  },
  heading: {
    fontSize: 20,
    fontWeight: "800",
    color: "#0f172a",
    textAlign: "center",
    marginBottom: 8,
    fontFamily: Platform.select({
      web: '"IBM Plex Sans", "Segoe UI", sans-serif',
      default: undefined,
    }),
  },
  message: {
    maxWidth: 360,
    fontSize: 14,
    lineHeight: 20,
    color: "#4b5563",
    textAlign: "center",
    marginBottom: 16,
    fontFamily: Platform.select({
      web: '"IBM Plex Sans", "Segoe UI", sans-serif',
      default: undefined,
    }),
  },
  button: {
    minHeight: 44,
    minWidth: 140,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "#0e7490",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  buttonPressed: {
    opacity: 0.86,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  buttonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "800",
    textAlign: "center",
    fontFamily: Platform.select({
      web: '"IBM Plex Sans", "Segoe UI", sans-serif',
      default: undefined,
    }),
  },
});

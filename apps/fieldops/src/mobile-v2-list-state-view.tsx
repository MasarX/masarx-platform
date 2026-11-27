// Mobile V2 list state wrapper — loading skeleton + error+retry card +
// transparent pass-through for ready state. Closes UI/UX audit P1:
// every list surface needs the discriminated trio Tasks already has
// (`MobileV2TasksDataState`). The wrapper lets the 9 other list
// surfaces stay as pure render-of-data components while the shell
// handles loading/error chrome.

import * as React from "react";
import { ActivityIndicator, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxButton, FxCard, FxCol } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import {
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2ListStateViewProps {
  readonly theme: MobileV2Theme;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly errorMessage?: string;
  readonly errorTitle?: string;
  readonly retryLabel?: string;
  readonly onRetry?: () => void;
  /**
   * When the RPC is loading and there is no fresh data, render the
   * skeleton chrome instead of the children. When the underlying hook
   * has `placeholderData` / `keepPreviousData` semantics, callers may
   * pass `isLoading={isLoading && !hasData}` to keep the previous
   * snapshot visible during background refetches.
   */
  readonly children: React.ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}

/**
 * Wraps any list/dashboard screen with loading + error UI. Designed to
 * mirror the Tasks discriminated-trio pattern at the screen level,
 * keeping list-screen render functions pure.
 */
export function MobileV2ListStateView(
  props: MobileV2ListStateViewProps,
): React.ReactElement {
  const { theme } = props;
  if (props.isLoading) {
    return (
      <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
        <View style={{ padding: MOBILE_V2_SPACING["3xl"], rowGap: MOBILE_V2_SPACING["2xl"] }}>
          <FxCard theme={theme} padding={MOBILE_V2_SPACING["2xl"]}>
            <FxCol gap={MOBILE_V2_SPACING.lg} style={{ alignItems: "center" }}>
              <ActivityIndicator color={theme.accent} size="small" />
              <Text
                style={{
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                }}
              >
                Loading…
              </Text>
              <Text
                style={{
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  fontSize: MOBILE_V2_TYPE_SIZES.body,
                  textAlign: "center",
                }}
              >
                Fetching from cloud · falls back to last-known state if offline.
              </Text>
            </FxCol>
          </FxCard>
          {/* Three skeleton rows — generic shape that matches both list
              and dashboard chrome. Themed via surfaceAlt to avoid
              flashing pure-white on light mode. */}
          {[0, 1, 2].map((i) => (
            <View
              key={i}
              style={{
                height: 72,
                backgroundColor: theme.surfaceAlt,
                borderRadius: 14,
                opacity: 1 - i * 0.12,
              }}
            />
          ))}
        </View>
      </View>
    );
  }

  if (props.isError) {
    return (
      <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
        <View style={{ padding: MOBILE_V2_SPACING["3xl"] }}>
          <FxCard theme={theme} padding={MOBILE_V2_SPACING["3xl"]}>
            <FxCol gap={MOBILE_V2_SPACING.lg} style={{ alignItems: "center" }}>
              <View
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 14,
                  backgroundColor: theme.dangerSoft,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <FxIcon name="alert" size={22} color={theme.danger} />
              </View>
              <Text
                style={{
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                }}
              >
                {props.errorTitle ?? "Couldn’t reach the server"}
              </Text>
              <Text
                style={{
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  fontSize: MOBILE_V2_TYPE_SIZES.body,
                  textAlign: "center",
                }}
                numberOfLines={3}
              >
                {props.errorMessage ?? "The data resolver failed. Check your connection or retry."}
              </Text>
              {props.onRetry !== undefined ? (
                <FxButton
                  theme={theme}
                  variant="soft"
                  icon="cloud-up"
                  onPress={props.onRetry}
                  accessibilityLabel={props.retryLabel ?? "Retry loading"}
                >
                  {props.retryLabel ?? "Retry"}
                </FxButton>
              ) : null}
            </FxCol>
          </FxCard>
        </View>
      </View>
    );
  }

  return <>{props.children}</>;
}

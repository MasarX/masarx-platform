// Mobile V2 Break sheet — pixel-faithful port of design source
// flow-extras.jsx SheetBreak. KSA labour-policy break timer with two
// modes: idle (start a 15/30/45 min break) + ongoing (countdown +
// resume CTA). All thresholds + texts come from props so production
// resolves them via `mobile_break_policy` ladder.

import * as React from "react";
import { Pressable, Text, View } from "react-native";

import { FxButton, FxCard, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import { MobileV2BottomSheet } from "./mobile-v2-bottom-sheet";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2BreakSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  /** Configured break duration in minutes (policy). */
  readonly durationMin: number;
  /** Mandatory-break threshold in minutes of driving (e.g. 360 = 6h). */
  readonly mandatoryAfterMin: number;
  /**
   * When set, the sheet shows the ongoing-break countdown mode. When
   * undefined, the sheet shows the idle (start) mode.
   */
  readonly ongoingStartedAt?: number;
  /** Caller passes Date.now() each second to drive the countdown. */
  readonly nowMs: number;
  readonly onStart: () => void;
  readonly onEnd: () => void;
}

export function MobileV2BreakSheet(
  props: MobileV2BreakSheetProps,
): React.ReactElement {
  const { theme } = props;
  const isOngoing = props.ongoingStartedAt !== undefined;

  if (isOngoing && props.ongoingStartedAt !== undefined) {
    const elapsedMin = Math.floor((props.nowMs - props.ongoingStartedAt) / 60000);
    const leftMin = Math.max(0, props.durationMin - elapsedMin);
    const lowTime = leftMin <= 5;
    return (
      <MobileV2BottomSheet
        theme={theme}
        visible={props.visible}
        onClose={props.onClose}
        title="Break in progress"
        subtitle={`Started at ${new Date(props.ongoingStartedAt).toLocaleTimeString()}`}
        primary={
          <FxButton
            theme={theme}
            variant="primary"
            full
            size="lg"
            icon="play"
            onPress={props.onEnd}
            accessibilityLabel="Resume route"
          >
            Resume route
          </FxButton>
        }
      >
        <FxCol
          gap={MOBILE_V2_SPACING["3xl"]}
          style={{
            alignItems: "center",
            paddingTop: MOBILE_V2_SPACING.lg,
            paddingBottom: MOBILE_V2_SPACING.sm,
          }}
        >
          <Text
            style={{
              fontSize: MOBILE_V2_TYPE_SIZES.metricDisplay,
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
              fontFamily: MOBILE_V2_FONT_MONO,
              color: lowTime ? theme.warning : theme.success,
              letterSpacing: -1,
            }}
          >
            {String(Math.floor(leftMin / 60)).padStart(2, "0")}:
            {String(leftMin % 60).padStart(2, "0")}
          </Text>
          <Text
            style={{
              fontSize: MOBILE_V2_TYPE_SIZES.caption,
              color: theme.muted,
              fontFamily: MOBILE_V2_FONT_SANS,
            }}
          >
            Time remaining · {props.durationMin}m policy break
          </Text>
          <FxCard theme={theme} soft style={{ width: "100%" }}>
            <FxRow gap={MOBILE_V2_SPACING.xl} align="center">
              <FxIcon name="info" size={16} color={theme.info} />
              <Text
                style={{
                  fontSize: MOBILE_V2_TYPE_SIZES.caption,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  flex: 1,
                }}
              >
                Dispatch has paused SLA timers and re-routed urgent stops automatically.
              </Text>
            </FxRow>
          </FxCard>
        </FxCol>
      </MobileV2BottomSheet>
    );
  }

  // Idle mode — choose duration + start
  const hoursMandatory = Math.floor(props.mandatoryAfterMin / 60);
  return (
    <MobileV2BottomSheet
      theme={theme}
      visible={props.visible}
      onClose={props.onClose}
      title="Take a break"
      subtitle={`KSA labour policy · ${props.durationMin} min after ${hoursMandatory}h driving`}
      primary={
        <FxButton
          theme={theme}
          variant="primary"
          full
          size="lg"
          icon="pause"
          onPress={props.onStart}
          accessibilityLabel={`Start ${props.durationMin} minute break`}
        >
          Start {props.durationMin}-min break
        </FxButton>
      }
    >
      <FxCol
        gap={MOBILE_V2_SPACING["2xl"]}
        style={{ paddingTop: MOBILE_V2_SPACING.lg, paddingBottom: MOBILE_V2_SPACING.sm }}
      >
        <FxCard theme={theme} soft>
          <FxCol gap={MOBILE_V2_SPACING.sm}>
            <Text
              style={{
                fontSize: MOBILE_V2_TYPE_SIZES.body,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                color: theme.ink,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              While you&apos;re on break
            </Text>
            <Text
              style={{
                fontSize: MOBILE_V2_TYPE_SIZES.caption,
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_SANS,
                lineHeight: 18,
              }}
            >
              SLA timers pause · urgent stops re-route to nearby drivers · you&apos;ll
              get a &quot;Resume&quot; reminder 5 min before the break ends.
            </Text>
          </FxCol>
        </FxCard>
        <View
          style={{
            flexDirection: "row",
            columnGap: MOBILE_V2_SPACING.lg,
          }}
        >
          {[15, 30, 45].map((m) => (
            <Pressable
              key={m}
              accessibilityRole="button"
              accessibilityLabel={`${m} minute break`}
              style={{
                flex: 1,
                alignItems: "center",
                paddingVertical: MOBILE_V2_SPACING["2xl"],
                paddingHorizontal: MOBILE_V2_SPACING.lg,
                backgroundColor: theme.surface,
                borderColor: theme.border,
                borderWidth: 1,
                borderRadius: MOBILE_V2_RADII.button,
              }}
            >
              <Text
                style={{
                  fontSize: 18,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                  fontFamily: MOBILE_V2_FONT_MONO,
                  color: theme.ink,
                }}
              >
                {m}
              </Text>
              <Text
                style={{
                  fontSize: MOBILE_V2_TYPE_SIZES.label,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                min
              </Text>
            </Pressable>
          ))}
        </View>
      </FxCol>
    </MobileV2BottomSheet>
  );
}

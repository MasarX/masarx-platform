// Mobile V2 Support sheet — pixel-faithful port of design source
// flow-extras.jsx SheetSupport. Driver↔dispatch escalation with a topic
// picker + free-text message + Call CTA. Offline drafting is preserved
// because submit/call callbacks live in the orchestrator (the orchestrator
// queues the request when `communication_policy.offline_mode_v1` rules say
// so). The topic registry and severities come from
// `mobile_support_topics_policy`.

import * as React from "react";
import {
  Pressable,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { FxButton, FxCard, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import type { FxChipTone } from "./mobile-v2-primitives-styles";
import { MobileV2BottomSheet } from "./mobile-v2-bottom-sheet";
import {
  MOBILE_V2_DIMENSIONS,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2SupportSeverity = "high" | "med" | "low";

export type MobileV2SupportMode = "topic-picker" | "chat";

export interface MobileV2SupportTopic {
  readonly id: string;
  readonly label: string;
  readonly icon: MobileV2IconName;
  readonly severity: MobileV2SupportSeverity;
}

export type MobileV2SupportChatAuthor = "driver" | "dispatch";

export interface MobileV2SupportChatMessage {
  readonly id: string;
  readonly author: MobileV2SupportChatAuthor;
  readonly text: string;
  readonly timeLabel: string;
}

export interface MobileV2SupportSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly topics: ReadonlyArray<MobileV2SupportTopic>;
  readonly selectedTopicId: string | null;
  readonly message: string;
  readonly onSelectTopic: (id: string) => void;
  readonly onMessageChange: (next: string) => void;
  readonly onSubmit: () => void;
  readonly onCallSupport: () => void;
  /**
   * `topic-picker` (default, legacy contract): renders the topic
   * severity-rows + free-text describe-the-issue composer.
   * `chat`: renders the post-handoff dispatch chat thread with
   * quick-reply chips and inline composer. Mirrors the design canvas
   * `s-sheet-support` artboard.
   */
  readonly mode?: MobileV2SupportMode;
  /** Chat-mode title override (default "Dispatch chat"). */
  readonly title?: string;
  /** Chat-mode subtitle override (default presence string). */
  readonly subtitle?: string;
  /** Chat-mode message thread (default empty). */
  readonly chatMessages?: ReadonlyArray<MobileV2SupportChatMessage>;
  /** Chat-mode quick-reply chips (default empty — no chip row rendered). */
  readonly quickReplies?: ReadonlyArray<string>;
  /** Called when the driver taps a quick-reply chip. Defaults to `onMessageChange` so the chip text appears in the composer. */
  readonly onQuickReply?: (text: string) => void;
  readonly style?: StyleProp<ViewStyle>;
}

function chipToneForSeverity(s: MobileV2SupportSeverity): FxChipTone {
  return s === "high" ? "danger" : s === "med" ? "warning" : "info";
}

export function MobileV2SupportSheet(
  props: MobileV2SupportSheetProps,
): React.ReactElement {
  const { theme, topics } = props;
  const mode: MobileV2SupportMode = props.mode ?? "topic-picker";
  const isChat = mode === "chat";
  const picked = topics.find((x) => x.id === props.selectedTopicId);
  const ready = isChat
    ? props.message.trim().length > 0
    : picked !== undefined && props.message.trim().length > 2;
  const title =
    props.title ?? (isChat ? "Dispatch chat" : "Contact support");
  const subtitle =
    props.subtitle
    ?? (isChat
      ? "Online · usually replies in 1 min"
      : "Dispatch + supervisor get notified · queued when offline");

  if (isChat) {
    const messages = props.chatMessages ?? [];
    const replies = props.quickReplies ?? [];
    // The chat composer is pinned in the sheet's footer slot — the design
    // SheetSupport renders it in a separate border-topped band — so it
    // stays above the scrolling message thread.
    const composer = (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          columnGap: MOBILE_V2_SPACING.lg,
        }}
      >
        <TextInput
          value={props.message}
          onChangeText={props.onMessageChange}
          placeholder="Type a message…"
          placeholderTextColor={theme.muted}
          style={{
            flex: 1,
            borderColor: theme.border,
            borderWidth: 1,
            borderRadius: 24,
            backgroundColor: theme.surfaceAlt,
            color: theme.ink,
            fontFamily: MOBILE_V2_FONT_SANS,
            fontSize: MOBILE_V2_TYPE_SIZES.body,
            paddingHorizontal: MOBILE_V2_SPACING["2xl"],
            paddingVertical: MOBILE_V2_SPACING.xl,
          }}
        />
        <Pressable
          onPress={props.onSubmit}
          disabled={!ready}
          accessibilityRole="button"
          accessibilityLabel="Send message"
          style={{
            width: 44,
            height: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: MOBILE_V2_RADII.button,
            backgroundColor: ready ? theme.accent : theme.surfaceAlt,
          }}
        >
          <FxIcon
            name="arrow-right"
            size={18}
            color={ready ? theme.accentInk : theme.muted}
          />
        </Pressable>
      </View>
    );
    return (
      <MobileV2BottomSheet
        theme={theme}
        visible={props.visible}
        onClose={props.onClose}
        title={title}
        subtitle={subtitle}
        style={props.style}
        primary={composer}
      >
        <FxCol gap={MOBILE_V2_SPACING.lg} style={{ paddingTop: MOBILE_V2_SPACING.sm }}>
          {messages.map((m) => {
            const incoming = m.author === "dispatch";
            return (
              <View
                key={m.id}
                style={{
                  alignSelf: incoming ? "flex-start" : "flex-end",
                  maxWidth: "78%",
                  paddingVertical: MOBILE_V2_SPACING.lg,
                  paddingHorizontal: MOBILE_V2_SPACING["2xl"],
                  backgroundColor: incoming ? theme.surfaceAlt : theme.accentSoft,
                  borderRadius: MOBILE_V2_RADII.card,
                }}
              >
                <Text
                  style={{
                    fontSize: MOBILE_V2_TYPE_SIZES.body,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {m.text}
                </Text>
                <Text
                  style={{
                    fontSize: 9,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    marginTop: 3,
                  }}
                >
                  {m.timeLabel}
                </Text>
              </View>
            );
          })}
          {replies.length > 0 ? (
            <FxRow gap={MOBILE_V2_SPACING.md} wrap style={{ marginTop: MOBILE_V2_SPACING.lg }}>
              {replies.map((r) => (
                <Pressable
                  key={r}
                  onPress={() => {
                    if (props.onQuickReply !== undefined) {
                      props.onQuickReply(r);
                    } else {
                      props.onMessageChange(r);
                    }
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Quick reply ${r}`}
                >
                  <FxChip theme={theme} tone="neutral">
                    {r}
                  </FxChip>
                </Pressable>
              ))}
            </FxRow>
          ) : null}
        </FxCol>
      </MobileV2BottomSheet>
    );
  }

  return (
    <MobileV2BottomSheet
      theme={theme}
      visible={props.visible}
      onClose={props.onClose}
      title={title}
      subtitle={subtitle}
      style={props.style}
    >
      {/* Topic picker rows separated by 1px borders */}
      <View
        style={{
          backgroundColor: theme.border,
          borderTopWidth: 1,
          borderBottomWidth: 1,
          borderColor: theme.border,
          rowGap: 1,
        }}
      >
        {topics.map((tp) => {
          const on = props.selectedTopicId === tp.id;
          const iconBg =
            tp.severity === "high"
              ? theme.dangerSoft
              : tp.severity === "med"
                ? theme.warningSoft
                : theme.surfaceAlt;
          const iconFg =
            tp.severity === "high"
              ? theme.danger
              : tp.severity === "med"
                ? theme.warning
                : theme.muted;
          return (
            <Pressable
              key={tp.id}
              onPress={() => props.onSelectTopic(tp.id)}
              accessibilityRole="button"
              accessibilityLabel={`Select ${tp.label} support topic`}
              accessibilityState={{ selected: on }}
              style={{
                backgroundColor: theme.surface,
                paddingVertical: MOBILE_V2_SPACING["3xl"],
                paddingHorizontal: MOBILE_V2_SPACING["3xl"],
                flexDirection: "row",
                alignItems: "center",
                columnGap: MOBILE_V2_SPACING.md,
              }}
            >
              <View
                style={{
                  width: MOBILE_V2_DIMENSIONS.sheetTypeIcon,
                  height: MOBILE_V2_DIMENSIONS.sheetTypeIcon,
                  borderRadius: MOBILE_V2_RADII.iconDisk,
                  backgroundColor: iconBg,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <FxIcon name={tp.icon} size={16} color={iconFg} />
              </View>
              <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: MOBILE_V2_TYPE_SIZES.rowLabel,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {tp.label}
                </Text>
                <FxChip theme={theme} tone={chipToneForSeverity(tp.severity)} dense>
                  {tp.severity}
                </FxChip>
              </FxCol>
              {on ? <FxIcon name="check" size={18} color={theme.accent} /> : null}
            </Pressable>
          );
        })}
      </View>

      {picked !== undefined ? (
        <FxCol gap={MOBILE_V2_SPACING.md} style={{ paddingTop: MOBILE_V2_SPACING.md }}>
          <FxCol gap={MOBILE_V2_SPACING.md}>
            <Text
              style={{
                fontSize: MOBILE_V2_TYPE_SIZES.label,
                color: theme.muted,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                letterSpacing: 0.4,
                textTransform: "uppercase",
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              Describe the issue
            </Text>
            <TextInput
              value={props.message}
              onChangeText={props.onMessageChange}
              placeholder="Brief context · what / where / who"
              placeholderTextColor={theme.muted}
              multiline
              numberOfLines={4}
              style={{
                borderColor: theme.border,
                borderWidth: 1,
                borderRadius: MOBILE_V2_RADII.button,
                backgroundColor: theme.surface,
                color: theme.ink,
                fontFamily: MOBILE_V2_FONT_SANS,
                fontSize: MOBILE_V2_TYPE_SIZES.body,
                padding: MOBILE_V2_SPACING["2xl"],
                minHeight: 88,
                textAlignVertical: "top",
              }}
            />
          </FxCol>
          <FxCard theme={theme} soft>
            <FxRow gap={MOBILE_V2_SPACING.md} align="center">
              <FxIcon name="info" size={14} color={theme.info} />
              <Text
                style={{
                  fontSize: MOBILE_V2_TYPE_SIZES.caption,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                  flex: 1,
                }}
              >
                Replies usually arrive within 1 min when online. Offline messages queue.
              </Text>
            </FxRow>
          </FxCard>
        </FxCol>
      ) : null}

      <FxRow gap={MOBILE_V2_SPACING.md}>
        <View style={{ flex: 1 }}>
          <FxButton
            theme={theme}
            variant="ghost"
            full
            icon="phone"
            onPress={props.onCallSupport}
            accessibilityLabel="Call support"
          >
            Call
          </FxButton>
        </View>
        <View style={{ flex: 2 }}>
          <FxButton
            theme={theme}
            variant={ready ? "primary" : "soft"}
            full
            size="lg"
            icon="message"
            disabled={!ready}
            onPress={props.onSubmit}
            accessibilityLabel="Submit support request"
          >
            {ready ? "Send to dispatch" : "Pick topic + message"}
          </FxButton>
        </View>
      </FxRow>
    </MobileV2BottomSheet>
  );
}

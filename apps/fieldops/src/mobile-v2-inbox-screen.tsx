// Mobile V2 Inbox screen — pixel-faithful port of design source
// flow-extras.jsx ScrInbox. Single screen with three tabs (Notifications,
// Dispatch chat, Broadcasts). Rows are tone-coded by category (sla =>
// warning, route => accent, broadcast => info, other => neutral) and
// show an unread dot, age in minutes, title + body.
//
// The chat tab renders an inline dispatch thread (left/right bubbles, a
// pending-while-offline footnote, and quick-reply chips) — the design
// source presents it as a sheet but on the production V2 surface we
// stack it inline so the screen is one canvas and AGENTS.md mobile shell
// policy (no nested navigation for tasks) is preserved.

import * as React from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
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

export type MobileV2InboxCategory = "sla" | "route" | "broadcast" | "other";

export type MobileV2InboxTab = "notif" | "chat" | "broadcast";

export interface MobileV2InboxNotification {
  readonly id: string;
  readonly category: MobileV2InboxCategory;
  readonly title: string;
  readonly body: string;
  /** Epoch ms — age formatted as "Xm" relative to now. */
  readonly atMs: number;
  readonly read: boolean;
}

export type MobileV2ChatAuthor = "me" | "dispatch";

export interface MobileV2InboxChatMessage {
  readonly id: string;
  readonly who: MobileV2ChatAuthor;
  /** Epoch ms — formatted as HH:MM for compact bubbles. */
  readonly atMs: number;
  readonly body: string;
  readonly pending: boolean;
}

export interface MobileV2InboxChatQuickReply {
  readonly id: string;
  readonly label: string;
}

export interface MobileV2InboxScreenProps {
  readonly theme: MobileV2Theme;
  readonly activeTab: MobileV2InboxTab;
  readonly notifications: ReadonlyArray<MobileV2InboxNotification>;
  readonly chat: ReadonlyArray<MobileV2InboxChatMessage>;
  readonly chatOnline: boolean;
  readonly chatQuickReplies: ReadonlyArray<MobileV2InboxChatQuickReply>;
  readonly onSelectTab?: (tab: MobileV2InboxTab) => void;
  readonly onSelectNotification?: (id: string) => void;
  readonly onSelectQuickReply?: (id: string) => void;
  readonly style?: StyleProp<ViewStyle>;
}

interface CategoryMeta {
  readonly tone: FxChipTone;
  readonly icon: MobileV2IconName;
}

const CATEGORY_META: Readonly<Record<MobileV2InboxCategory, CategoryMeta>> = Object.freeze({
  sla: Object.freeze({ tone: "warning", icon: "alert" }),
  route: Object.freeze({ tone: "accent", icon: "route" }),
  // Design canvas s-inbox (flow-extras.jsx:817) uses `megaphone` for
  // info-tone broadcast notifications; impl previously fell back to
  // `info` until the catalog grew. Catalog entry added 2026-05-13 in
  // `mobile-v2-icon-specs.ts`.
  broadcast: Object.freeze({ tone: "info", icon: "megaphone" }),
  other: Object.freeze({ tone: "neutral", icon: "message" }),
});

function resolveCategorySoft(theme: MobileV2Theme, tone: FxChipTone): { bg: string; fg: string } {
  switch (tone) {
    case "warning":
      return { bg: theme.warningSoft, fg: theme.warning };
    case "accent":
      return { bg: theme.accentSoft, fg: theme.accent };
    case "info":
      return { bg: theme.infoSoft, fg: theme.info };
    case "success":
      return { bg: theme.successSoft, fg: theme.success };
    case "danger":
      return { bg: theme.dangerSoft, fg: theme.danger };
    default:
      return { bg: theme.surfaceAlt, fg: theme.muted };
  }
}

function formatAge(atMs: number): string {
  if (!Number.isFinite(atMs)) return "—";
  const delta = Date.now() - atMs;
  if (delta < 60_000) return "now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatChatTime(atMs: number): string {
  if (!Number.isFinite(atMs)) return "—";
  try {
    return new Date(atMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

const TABS: ReadonlyArray<{ readonly id: MobileV2InboxTab; readonly label: string }> = [
  { id: "notif", label: "Notifications" },
  { id: "chat", label: "Dispatch" },
  { id: "broadcast", label: "Broadcasts" },
];

function NotificationRow(props: {
  readonly theme: MobileV2Theme;
  readonly notif: MobileV2InboxNotification;
  readonly onPress?: () => void;
}): React.ReactElement {
  const { theme: t, notif } = props;
  const meta = CATEGORY_META[notif.category];
  const colors = resolveCategorySoft(t, meta.tone);
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={`${notif.title}${notif.read ? "" : ", unread"}`}
      style={{
        backgroundColor: t.surface,
        paddingHorizontal: 16,
        paddingVertical: 14,
        flexDirection: "row",
        alignItems: "flex-start",
        columnGap: MOBILE_V2_SPACING["2xl"],
      }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 9,
          backgroundColor: colors.bg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <FxIcon name={meta.icon} size={15} color={colors.fg} />
      </View>
      <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
        <FxRow justify="space-between" align="center">
          <Text
            style={{
              fontSize: 13,
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
              color: t.ink,
              fontFamily: MOBILE_V2_FONT_SANS,
              flex: 1,
              minWidth: 0,
            }}
            numberOfLines={1}
          >
            {notif.title}
          </Text>
          <Text
            style={{
              fontSize: 10.5,
              color: t.muted,
              fontFamily: MOBILE_V2_FONT_MONO,
            }}
          >
            {formatAge(notif.atMs)}
          </Text>
        </FxRow>
        <Text
          style={{
            fontSize: 12,
            color: t.muted,
            fontFamily: MOBILE_V2_FONT_SANS,
            lineHeight: 17,
          }}
        >
          {notif.body}
        </Text>
      </FxCol>
      {!notif.read ? (
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: t.accent,
            marginTop: 6,
          }}
        />
      ) : null}
    </Pressable>
  );
}

function ChatThread(props: {
  readonly theme: MobileV2Theme;
  readonly chat: ReadonlyArray<MobileV2InboxChatMessage>;
  readonly online: boolean;
  readonly quickReplies: ReadonlyArray<MobileV2InboxChatQuickReply>;
  readonly onSelectQuickReply?: (id: string) => void;
}): React.ReactElement {
  const { theme: t, chat, online, quickReplies } = props;
  return (
    <FxCol gap={MOBILE_V2_SPACING["2xl"]} style={{ padding: 16 }}>
      <FxCard theme={t} soft>
        <FxRow gap={MOBILE_V2_SPACING.lg} align="center">
          <FxIcon name={online ? "cloud-check" : "wifi-off"} size={16} color={online ? t.success : t.warning} />
          <Text
            style={{
              fontSize: 12,
              color: t.muted,
              fontFamily: MOBILE_V2_FONT_SANS,
              flex: 1,
            }}
          >
            {online
              ? "Online · usually replies in 1 min"
              : "Offline · messages queue and send when back"}
          </Text>
        </FxRow>
      </FxCard>

      {chat.length === 0 ? (
        <FxCard theme={t} padding={20}>
          <Text
            style={{
              fontSize: 12,
              color: t.muted,
              fontFamily: MOBILE_V2_FONT_SANS,
              textAlign: "center",
            }}
          >
            Send a quick message to the hub.
          </Text>
        </FxCard>
      ) : (
        <FxCol gap={MOBILE_V2_SPACING.lg}>
          {chat.map((m) => {
            const me = m.who === "me";
            return (
              <View
                key={m.id}
                style={{
                  flexDirection: "row",
                  justifyContent: me ? "flex-end" : "flex-start",
                }}
              >
                <View
                  style={{
                    maxWidth: "78%",
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    backgroundColor: me ? t.accent : t.surfaceAlt,
                    borderRadius: 14,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 13,
                      color: me ? t.accentInk : t.ink,
                      lineHeight: 18,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {m.body}
                  </Text>
                  <Text
                    style={{
                      fontSize: 9,
                      color: me ? t.accentInk : t.muted,
                      opacity: 0.7,
                      marginTop: 3,
                      fontFamily: MOBILE_V2_FONT_MONO,
                    }}
                  >
                    {formatChatTime(m.atMs)}
                    {m.pending ? " · queued" : ""}
                  </Text>
                </View>
              </View>
            );
          })}
        </FxCol>
      )}

      <FxRow gap={MOBILE_V2_SPACING.md} wrap>
        {quickReplies.map((q) => (
          <Pressable
            key={q.id}
            onPress={() => props.onSelectQuickReply?.(q.id)}
            accessibilityRole="button"
            accessibilityLabel={`Quick reply: ${q.label}`}
          >
            <FxChip theme={t} dense>
              {q.label}
            </FxChip>
          </Pressable>
        ))}
      </FxRow>
    </FxCol>
  );
}

export function MobileV2InboxScreen(props: MobileV2InboxScreenProps): React.ReactElement {
  const { theme, activeTab, notifications } = props;

  // Filter notif list by tab (notif tab => non-broadcast, broadcast tab => broadcast)
  const filteredNotifs = activeTab === "broadcast"
    ? notifications.filter((n) => n.category === "broadcast")
    : notifications.filter((n) => n.category !== "broadcast");

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      {/* In-body header strip stripped — the gallery / host ScreenShell now
          renders the title ("Inbox") and subtitle (unread count) via
          FxAppBar. */}

      {/* Tab strip */}
      <View
        style={{
          flexDirection: "row",
          backgroundColor: theme.surface,
          borderTopColor: theme.border,
          borderTopWidth: 1,
          borderBottomColor: theme.border,
          borderBottomWidth: 1,
          paddingHorizontal: 16,
          paddingVertical: MOBILE_V2_SPACING.sm,
          columnGap: MOBILE_V2_SPACING.lg,
        }}
      >
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <Pressable
              key={tab.id}
              onPress={() => props.onSelectTab?.(tab.id)}
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected: isActive }}
              style={{
                paddingVertical: 10,
                marginRight: 18,
                borderBottomWidth: 2,
                borderBottomColor: isActive ? theme.accent : "transparent",
              }}
            >
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  color: isActive ? theme.accent : theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 96 }}>
        {activeTab === "chat" ? (
          <ChatThread
            theme={theme}
            chat={props.chat}
            online={props.chatOnline}
            quickReplies={props.chatQuickReplies}
            onSelectQuickReply={props.onSelectQuickReply}
          />
        ) : (
          <View style={{ backgroundColor: theme.border, rowGap: 1 }}>
            {filteredNotifs.map((n) => (
              <NotificationRow
                key={n.id}
                theme={theme}
                notif={n}
                onPress={() => props.onSelectNotification?.(n.id)}
              />
            ))}
            {filteredNotifs.length === 0 ? (
              <View style={{ backgroundColor: theme.surface, paddingHorizontal: 16, paddingVertical: 28 }}>
                <Text
                  style={{
                    fontSize: 12,
                    color: theme.muted,
                    textAlign: "center",
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {activeTab === "broadcast" ? "No broadcasts." : "No notifications."}
                </Text>
              </View>
            ) : null}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

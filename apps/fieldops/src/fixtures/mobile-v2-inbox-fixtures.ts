// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type {
  MobileV2InboxChatMessage,
  MobileV2InboxChatQuickReply,
  MobileV2InboxNotification,
  MobileV2InboxTab,
} from "../mobile-v2-inbox-screen";

// Notifications mirror design SSOT app-store.jsx:273-276 (state.inbox seed):
//   n1 · route     · 7m  · unread · "Route updated"  / "STP-008 inserted …"
//   n2 · sla       · 22m · unread · "SLA risk"       / "STP-004 Tahani Pharmacy …"
//   n3 · comms     · 48m · read   · "Customer reply" / Hessa Al-Saud
//   n4 · broadcast · 90m · read   · "Hub broadcast"  / "Heavy rain after 16:00 …"
const NOTIFICATIONS: ReadonlyArray<MobileV2InboxNotification> = Object.freeze([
  Object.freeze({
    id: "n-1",
    category: "route" as const,
    title: "Route updated",
    body: "STP-008 inserted at sequence 8 — Noura Hospital · cold chain",
    atMs: Date.now() - 7 * 60_000,
    read: false,
  }),
  Object.freeze({
    id: "n-2",
    category: "sla" as const,
    title: "SLA risk",
    body: "STP-004 Tahani Pharmacy is 25m past window. Customer notified.",
    atMs: Date.now() - 22 * 60_000,
    read: false,
  }),
  Object.freeze({
    id: "n-3",
    category: "other" as const,
    title: "Customer reply",
    body: 'Hessa Al-Saud: "Please call when downstairs"',
    atMs: Date.now() - 48 * 60_000,
    read: true,
  }),
  Object.freeze({
    id: "n-4",
    category: "broadcast" as const,
    title: "Hub broadcast",
    body: "Heavy rain after 16:00 — drive defensively.",
    atMs: Date.now() - 90 * 60_000,
    read: true,
  }),
]);

const CHAT: ReadonlyArray<MobileV2InboxChatMessage> = Object.freeze([
  Object.freeze({
    id: "c-1",
    who: "dispatch" as const,
    atMs: Date.now() - 24 * 60_000,
    body: "How are you doing on the south loop? Two SLA risks showing.",
    pending: false,
  }),
  Object.freeze({
    id: "c-2",
    who: "me" as const,
    atMs: Date.now() - 21 * 60_000,
    body: "Stop 21 customer just confirmed — heading there now.",
    pending: false,
  }),
  Object.freeze({
    id: "c-3",
    who: "dispatch" as const,
    atMs: Date.now() - 18 * 60_000,
    body: "Got it — checking with the hub now.",
    pending: false,
  }),
  Object.freeze({
    id: "c-4",
    who: "me" as const,
    atMs: Date.now() - 1 * 60_000,
    body: "Running 5 min late from 17 → 21 due to gate access.",
    pending: true,
  }),
]);

const QUICK_REPLIES: ReadonlyArray<MobileV2InboxChatQuickReply> = Object.freeze([
  Object.freeze({ id: "q-1", label: "Running 5 min late" }),
  Object.freeze({ id: "q-2", label: "Customer not reachable" }),
  Object.freeze({ id: "q-3", label: "Need address help" }),
  Object.freeze({ id: "q-4", label: "Vehicle issue" }),
]);

export const MOBILE_V2_PREVIEW_INBOX: {
  readonly activeTab: MobileV2InboxTab;
  readonly notifications: ReadonlyArray<MobileV2InboxNotification>;
  readonly chat: ReadonlyArray<MobileV2InboxChatMessage>;
  readonly chatOnline: boolean;
  readonly chatQuickReplies: ReadonlyArray<MobileV2InboxChatQuickReply>;
} = {
  activeTab: "notif",
  notifications: NOTIFICATIONS,
  chat: CHAT,
  chatOnline: true,
  chatQuickReplies: QUICK_REPLIES,
};

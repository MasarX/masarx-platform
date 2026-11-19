// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.
//
// Aligned to design canvas s-sheet-support artboard. Design shows the
// post-topic chat state (Dispatch chat title, online presence sub-line,
// one incoming message bubble, four quick-reply chips, message
// composer). Production cutover replaces the chat fixture with live
// thread reads from `support_thread_messages_v1` and quick-replies from
// `mobile_support_topics_policy.quick_replies`.

import type {
  MobileV2SupportChatMessage,
  MobileV2SupportTopic,
} from "../mobile-v2-sheet-support";

// Topic picker (legacy contract, still resolved upstream of the chat).
export const MOBILE_V2_PREVIEW_SUPPORT_TOPICS: ReadonlyArray<MobileV2SupportTopic> =
  Object.freeze([
    Object.freeze({ id: "app", label: "App crash / freeze", icon: "alert" as const, severity: "high" as const }),
    Object.freeze({ id: "scan", label: "Scanner not working", icon: "scan" as const, severity: "med" as const }),
    Object.freeze({ id: "wallet", label: "Wallet question", icon: "cash" as const, severity: "low" as const }),
    Object.freeze({ id: "other", label: "Other", icon: "message" as const, severity: "low" as const }),
  ]);

// Chat state (design canvas)
export const MOBILE_V2_PREVIEW_SUPPORT_CHAT_TITLE = "Dispatch chat";
export const MOBILE_V2_PREVIEW_SUPPORT_CHAT_SUBTITLE =
  "Online · usually replies in 1 min";

export const MOBILE_V2_PREVIEW_SUPPORT_CHAT_MESSAGES: ReadonlyArray<MobileV2SupportChatMessage> =
  Object.freeze([
    Object.freeze({
      id: "m-1",
      author: "dispatch" as const,
      text: "Hi Omar — hospital stop is priority, do it after lunch.",
      timeLabel: "9:07",
    }),
  ]);

export const MOBILE_V2_PREVIEW_SUPPORT_QUICK_REPLIES: ReadonlyArray<string> =
  Object.freeze([
    "Running 5 min late",
    "Customer not reachable",
    "Need address help",
    "Vehicle issue",
  ]);

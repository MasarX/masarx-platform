// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.
//
// Aligned to design canvas s-settings artboard: APP section shows
// Language (English (SA)), Permissions (Camera · Location · Notifications),
// Notifications (5/5 on); SHIFT section shows 0 SAR cash collected
// (start-of-shift snapshot); employee id resolved through profile fixture
// (DRV-2041) so identity stays internally consistent across screens.

import type {
  MobileV2SettingsAccount,
  MobileV2SettingsLanguage,
  MobileV2SettingsNotificationPrefs,
  MobileV2SettingsShiftStatus,
} from "../mobile-v2-settings-screen";

export const MOBILE_V2_PREVIEW_SETTINGS: {
  readonly language: MobileV2SettingsLanguage;
  readonly notifications: MobileV2SettingsNotificationPrefs;
  readonly shift: MobileV2SettingsShiftStatus;
  readonly account: MobileV2SettingsAccount;
} = Object.freeze({
  language: Object.freeze({
    label: "English (SA)",
    id: "en-SA",
    direction: "ltr" as const,
  }),
  notifications: Object.freeze({
    onCount: 5,
    totalCount: 5,
  }),
  shift: Object.freeze({
    breakDurationMin: 30,
    // Design SSOT ScrSettings (flow-extras.jsx:864) renders the Cash
    // drop sub-line as `${cod.collected} ﷼ collected today` — the
    // single-glyph Arabic Riyal codepoint U+FDFC. The 3-glyph "ر.س"
    // shorthand previously used here triggered RTL bidi reordering on
    // RN-Web (the Arabic letters flipped the surrounding Latin run, so
    // the row mis-rendered as "collected today ر.س 0" right-aligned).
    // U+FDFC is a single isolated glyph that does not reorder adjacent
    // Latin text, so the row reads left-to-right "0 ﷼ collected today".
    cashCollectedDisplay: "0 ﷼",
  }),
  account: Object.freeze({
    employeeId: "DRV-2041",
    dispatchOnline: true,
  }),
});

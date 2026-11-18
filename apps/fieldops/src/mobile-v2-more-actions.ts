import type { MobileV2IconName } from "./mobile-v2-icon-specs";

export type MobileV2MoreSupportActionId = "report-incident" | "diagnostics" | "sign-out";

export interface MobileV2MoreSupportAction {
  readonly id: MobileV2MoreSupportActionId;
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly icon: MobileV2IconName;
}

export const MOBILE_V2_MORE_SUPPORT_ACTIONS = Object.freeze<ReadonlyArray<MobileV2MoreSupportAction>>([
  Object.freeze({
    id: "report-incident",
    label: "Report incident",
    accessibilityLabel: "Report incident",
    icon: "alert",
  }),
  Object.freeze({
    id: "diagnostics",
    label: "Support tools",
    accessibilityLabel: "Open support tools",
    icon: "settings",
  }),
  Object.freeze({
    id: "sign-out",
    label: "Sign out",
    accessibilityLabel: "Sign out",
    icon: "logout",
  }),
]);

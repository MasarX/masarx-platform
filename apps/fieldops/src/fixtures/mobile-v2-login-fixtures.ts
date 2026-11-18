// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type { MobileV2LoginStep } from "../mobile-v2-login-screen";

export const MOBILE_V2_PREVIEW_LOGIN: {
  readonly brandGlyph: string;
  readonly step: MobileV2LoginStep;
  readonly employeeId: string;
  readonly otp: string;
  readonly otpMaskedPhone: string;
  readonly errorMessage: string | null;
  readonly autoFillHint: string;
  readonly versionLabel: string;
} = Object.freeze({
  brandGlyph: "M",
  step: "emp",
  employeeId: "DRV-2041",
  otp: "",
  otpMaskedPhone: "•••• 4128",
  errorMessage: null,
  autoFillHint: "Auto-fill in 1.2s",
  versionLabel: "v3.4.1 · build 2026.05 · MasarX FieldOps",
});

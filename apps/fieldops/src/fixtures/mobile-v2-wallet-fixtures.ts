// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type {
  MobileV2WalletBalance,
  MobileV2WalletBreakdownRow,
  MobileV2WalletWithdrawal,
  MobileV2WalletWeekBar,
} from "../mobile-v2-wallet-screen";

export const MOBILE_V2_PREVIEW_WALLET: {
  readonly wallet: MobileV2WalletBalance;
  readonly week: ReadonlyArray<MobileV2WalletWeekBar>;
  readonly breakdown: ReadonlyArray<MobileV2WalletBreakdownRow>;
  readonly latestWithdrawal: MobileV2WalletWithdrawal | null;
} = Object.freeze({
  // Aligned to design canvas s-wallet artboard: today balance 184 SAR,
  // week-to-date 412 SAR (Sat 142 + Sun 110 + Mon 76 = matches today's
  // chart bars; balance unchanged so today total still reads 184 SAR).
  wallet: Object.freeze({
    balanceSar: 184,
    weekToDateSar: 412,
    postsToBankLabel: "Posts to bank Monday",
  }),
  week: Object.freeze([
    Object.freeze({ day: "Sat", weekdayIndex: 6, sar: 142 }),
    Object.freeze({ day: "Sun", weekdayIndex: 0, sar: 110 }),
    Object.freeze({ day: "Mon", weekdayIndex: 1, sar: 76 }),
    Object.freeze({ day: "Tue", weekdayIndex: 2, sar: 0 }),
    Object.freeze({ day: "Wed", weekdayIndex: 3, sar: 0 }),
    Object.freeze({ day: "Thu", weekdayIndex: 4, sar: 0 }),
    Object.freeze({ day: "Fri", weekdayIndex: 5, sar: 0 }),
  ]),
  breakdown: Object.freeze([
    Object.freeze({ id: "w-stops", label: "Stops delivered today", meta: "9 stops", sar: 135 }),
    Object.freeze({ id: "w-pickups", label: "Pickups completed", meta: "2 pickups", sar: 24 }),
    Object.freeze({ id: "w-cod-bonus", label: "COD bonus", meta: "1240 SAR", sar: 8 }),
    Object.freeze({ id: "w-fuel", label: "Fuel allowance", meta: "Day shift", sar: 17 }),
  ]),
  latestWithdrawal: null,
});

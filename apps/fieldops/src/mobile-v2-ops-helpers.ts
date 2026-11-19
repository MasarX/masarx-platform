// Pure helpers for the Phase 6.F mobile ops surfaces (trip-nav, cash-drop,
// hold-queue, wallet, hub-pickup, today). Extracted from their screen
// files so unit tests can import them without pulling react-native into
// the jest unit runner.

/**
 * Format an amount + currency code into a locale-aware string. Per the
 * MasarX AGENTS.md zero-hardcoding rule, screens must never embed the
 * `SAR`/`﷼` symbol as a string literal — they call this helper with the
 * resolved currency code from policy/profile. Falls back to the raw ISO
 * code when an unknown currency is supplied.
 *
 * Supported by default: SAR (﷼), USD ($), AED (د.إ), EUR (€), GBP (£).
 * Extend the symbol table here when a new market goes live.
 *
 * SAR resolves to the canonical Unicode rial sign U+FDFC (﷼) — this is
 * the single source of truth used by the FieldOps Mobile V2 design
 * (`docs/design/fieldops-mobile-v2/screens/flow-*.jsx` all render
 * `{amount} ﷼`). Production cutover keeps the symbol row-driven via
 * `mobile_wallet_locale_policy`.
 */
const CURRENCY_SYMBOL_TABLE: Readonly<Record<string, string>> = Object.freeze({
  SAR: "﷼",
  AED: "د.إ",
  USD: "$",
  EUR: "€",
  GBP: "£",
  KWD: "د.ك",
  BHD: "د.ب",
  QAR: "ر.ق",
  OMR: "ر.ع.",
});

export function formatMobileV2Currency(
  amount: number,
  currency: string,
  options?: { readonly localized?: boolean },
): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  const code = (currency ?? "").trim().toUpperCase();
  const useLocale = options?.localized !== false;
  if (useLocale && typeof Intl !== "undefined" && typeof Intl.NumberFormat === "function") {
    try {
      return new Intl.NumberFormat("ar-SA", {
        style: "currency",
        currency: code || "SAR",
        maximumFractionDigits: 0,
      }).format(safe);
    } catch {
      // fall through to manual formatting
    }
  }
  const sym = CURRENCY_SYMBOL_TABLE[code] ?? code;
  return `${safe.toLocaleString()} ${sym}`;
}

/**
 * Plain compact form used by chips / inline contexts where a full
 * Intl.NumberFormat string is too long (e.g. "12,345 ﷼"). The symbol
 * sits AFTER the value, matching the FieldOps Mobile V2 design.
 *
 * `options.grouped` controls the thousands separator. The design is not
 * uniform: COD-ledger amounts use a grouped value (`flow-pod.jsx` ScrCOD
 * `{s.cod.toLocaleString()} ﷼`) while route / map stop-row COD chips use
 * the raw value (`flow-route.jsx` `{s.cod} ﷼`). Defaults to `true`
 * (grouped) for backward compatibility; pass `grouped: false` for the
 * route/map raw-value chips.
 */
export function formatMobileV2CurrencyCompact(
  amount: number,
  currency: string,
  options?: { readonly grouped?: boolean },
): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  const code = (currency ?? "").trim().toUpperCase();
  const sym = CURRENCY_SYMBOL_TABLE[code] ?? code;
  const value = options?.grouped === false ? String(safe) : safe.toLocaleString();
  return `${value} ${sym}`;
}

/**
 * Unit-system aware short formatting for distance/speed values.
 * Centralizes the kph/km/mph/mi suffix so screens never embed unit
 * literals — per AGENTS.md zero-hardcoding rule. Production callers
 * pass `unitSystem` resolved via `localization_policy.unit_system`.
 */
export type MobileV2UnitSystem = "metric" | "imperial";

export interface MobileV2UnitLabels {
  readonly distance: string;
  readonly speed: string;
}

const UNIT_LABEL_TABLE: Readonly<Record<MobileV2UnitSystem, MobileV2UnitLabels>> = Object.freeze({
  metric: Object.freeze({ distance: "km", speed: "kph" }),
  imperial: Object.freeze({ distance: "mi", speed: "mph" }),
});

export function resolveMobileV2UnitLabels(
  unitSystem: MobileV2UnitSystem | undefined,
): MobileV2UnitLabels {
  return UNIT_LABEL_TABLE[unitSystem ?? "metric"] ?? UNIT_LABEL_TABLE.metric;
}

export function formatMobileV2Distance(
  value: number,
  unitSystem?: MobileV2UnitSystem,
  decimals: number = 0,
): string {
  const safe = Number.isFinite(value) ? value : 0;
  const labels = resolveMobileV2UnitLabels(unitSystem);
  const display = decimals > 0 ? safe.toFixed(decimals) : Math.round(safe).toString();
  return `${display} ${labels.distance}`;
}

export function formatMobileV2Speed(
  value: number,
  unitSystem?: MobileV2UnitSystem,
): string {
  const safe = Number.isFinite(value) ? value : 0;
  const labels = resolveMobileV2UnitLabels(unitSystem);
  return `${Math.round(safe)} ${labels.speed}`;
}


/**
 * Format an integer minute count as "Xh Ym" / "Ym" / "Now".
 * Used by mobile-v2-trip-nav-screen for the ETA hero label.
 */
export function formatMobileV2Eta(etaMin: number): string {
  if (!Number.isFinite(etaMin) || etaMin <= 0) return "Now";
  const total = Math.max(0, Math.floor(etaMin));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/**
 * Cash drop variance state. `countedSar - expectedSar` with a boolean
 * gate that flips success/primary on the submit CTA and toggles the
 * supervisor-approval card visibility.
 */
export interface MobileV2CashVariance {
  readonly variance: number;
  readonly hasVariance: boolean;
}

export function computeMobileV2CashVariance(
  countedSar: number,
  expectedSar: number,
): MobileV2CashVariance {
  const safeCounted = Number.isFinite(countedSar) ? countedSar : 0;
  const safeExpected = Number.isFinite(expectedSar) ? expectedSar : 0;
  const variance = safeCounted - safeExpected;
  return Object.freeze({ variance, hasVariance: variance !== 0 });
}

/**
 * Clamp a "Counted SAR" nudger so the value never dips below zero.
 * Used by the cash-drop adjust nudger row (-100/-10/-1/+1/+10/+100).
 */
export function applyMobileV2CashAdjust(currentSar: number, deltaSar: number): number {
  const cur = Number.isFinite(currentSar) ? currentSar : 0;
  const d = Number.isFinite(deltaSar) ? deltaSar : 0;
  return Math.max(0, cur + d);
}

/**
 * Compute minutes elapsed since an epoch ms timestamp, floored at 0.
 * Used by mobile-v2-hold-queue-screen for the "Nm on hold" ribbon.
 */
export function minutesSinceMs(atMs: number, nowMs: number = Date.now()): number {
  if (!Number.isFinite(atMs) || !Number.isFinite(nowMs)) return 0;
  const delta = nowMs - atMs;
  if (delta <= 0) return 0;
  return Math.round(delta / 60_000);
}

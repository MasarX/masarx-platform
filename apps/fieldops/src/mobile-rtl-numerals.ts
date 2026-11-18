import { useMemo } from "react";
import { resolveLocaleCode } from "./i18n";
import {
  STATIC_NUMERAL_SYSTEM,
  formatNumber,
  type NumeralSystemPolicyValue,
} from "./numeral-system-policy";

export function resolveFormattedNumber(
  value: number,
  locale: string,
  policy: NumeralSystemPolicyValue = STATIC_NUMERAL_SYSTEM,
  options?: Intl.NumberFormatOptions,
): string {
  return formatNumber(policy, value, locale, options);
}

export function useFormattedNumber(
  rawLocale: unknown,
  value: number,
  policy?: NumeralSystemPolicyValue,
  options?: Intl.NumberFormatOptions,
): string {
  const locale = typeof rawLocale === "string" && rawLocale.trim()
    ? rawLocale.trim()
    : resolveLocaleCode(rawLocale);
  return useMemo(
    () => resolveFormattedNumber(value, locale, policy, options),
    [value, locale, policy, options],
  );
}

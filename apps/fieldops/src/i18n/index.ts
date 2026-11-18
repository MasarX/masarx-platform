import type { MobileLocaleMode } from "../mobile-shell-display";
import { AR_STRINGS } from "./strings-ar";
import { EN_STRINGS, type FieldOpsStrings } from "./strings-en";

export function getFieldOpsStrings(locale: MobileLocaleMode): FieldOpsStrings {
  return locale === "ar" ? AR_STRINGS : EN_STRINGS;
}

export type LocaleCode = "en" | "ar";
export type StringsSchema = FieldOpsStrings;

export const LOCALE_BUNDLES = { en: EN_STRINGS, ar: AR_STRINGS };
export const SUPPORTED_LOCALES: LocaleCode[] = ["en", "ar"];

export function resolveLocaleCode(value: unknown): LocaleCode {
  if (typeof value !== "string") return "en";
  return value.trim().toLowerCase().split(/[-_]/, 1)[0] === "ar" ? "ar" : "en";
}

export function getStrings(locale: LocaleCode): StringsSchema {
  return getFieldOpsStrings(locale);
}

export function resolveDirectionForLocale(locale: LocaleCode): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}

export { EN_STRINGS, AR_STRINGS };
export type { FieldOpsStrings };

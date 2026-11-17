import type { AbstractIntlMessages } from "next-intl";
import uiEn from "@masarx/config/messages/en.json";
import uiAr from "@masarx/config/messages/ar.json";
import {
  mergeIntlMessages,
  unwrapMessages,
  type MessagesImport,
} from "./messages";

export type SupportedLocale = "en" | "ar";

const UI_MESSAGES: Record<SupportedLocale, AbstractIntlMessages> = {
  en: unwrapMessages(uiEn as MessagesImport),
  ar: unwrapMessages(uiAr as MessagesImport),
};

export function createLoadMessages(appMessages: Record<SupportedLocale, MessagesImport>) {
  const merged: Record<SupportedLocale, AbstractIntlMessages> = {
    en: mergeIntlMessages(
      UI_MESSAGES.en,
      unwrapMessages(appMessages.en as MessagesImport)
    ),
    ar: mergeIntlMessages(
      UI_MESSAGES.ar,
      unwrapMessages(appMessages.ar as MessagesImport)
    ),
  };

  return async function loadMessages(locale: string): Promise<AbstractIntlMessages> {
    const normalized = String(locale || "en").toLowerCase();
    const localeKey = (normalized.split("-")[0] || "en") as SupportedLocale;
    return merged[localeKey] ?? merged.en;
  };
}

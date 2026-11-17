import appEn from "../messages/en.json";
import appAr from "../messages/ar.json";
import { createLoadMessages, type SupportedLocale } from "../../shared/i18n/load-messages";
import type { MessagesImport } from "../../shared/i18n/messages";

export type AppLocale = SupportedLocale;

export const loadMessages = createLoadMessages({
  en: appEn as MessagesImport,
  ar: appAr as MessagesImport,
});

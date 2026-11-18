import { createTranslator, type AbstractIntlMessages } from "next-intl";
import { getPublicConfig, resolveUiMessages } from "@masarx/config";
import type { UiNavigation, UiNavigationItem } from "@masarx/api";

type UiTranslatorOptions = {
  locale?: string;
  messages?: AbstractIntlMessages;
};

const hasMessages = (messages: AbstractIntlMessages | undefined) =>
  !!messages && Object.keys(messages).length > 0;

export function resolveRowDisplayText(english: string, arabic: unknown, locale?: string | null) {
  const localeKey = typeof locale === "string" ? locale.toLowerCase().split("-")[0] : "";
  const translated = localeKey === "ar" && typeof arabic === "string" ? arabic.trim() : "";
  return translated || english;
}

export function localizeNavigation(input: UiNavigation, locale?: string | null): UiNavigation {
  const localizeItems = (items: UiNavigationItem[]): UiNavigationItem[] =>
    items.map((item) => ({
      ...item,
      label: resolveRowDisplayText(item.label, item.label_ar, locale),
      ...(Array.isArray(item.items) ? { items: localizeItems(item.items) } : {}),
    }));
  return {
    ...input,
    sections: input.sections.map((section) => ({
      ...section,
      label: resolveRowDisplayText(section.label, section.label_ar, locale),
      items: localizeItems(section.items),
    })),
  };
}

export function createUiTranslator(
  namespace?: string,
  options: UiTranslatorOptions = {}
) {
  let locale = options.locale ?? "en";
  try {
    if (!options.locale) {
      locale = getPublicConfig().locale || "en";
    }
  } catch {
    locale = "en";
  }
  const localeKey = locale.toLowerCase().split("-")[0] ?? locale.toLowerCase();
  const resolvedMessages = hasMessages(options.messages)
    ? options.messages
    : (resolveUiMessages(localeKey) as AbstractIntlMessages);
  return createTranslator<any>({
    locale,
    messages: resolvedMessages as any,
    namespace: namespace as any,
  });
}

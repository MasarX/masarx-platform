import { createTranslator, type AbstractIntlMessages } from "next-intl";
import { getPublicConfig, resolveUiMessages } from "@masarx/config";

type UiTranslatorOptions = {
  locale?: string;
  messages?: AbstractIntlMessages;
};

const hasMessages = (messages: AbstractIntlMessages | undefined) =>
  !!messages && Object.keys(messages).length > 0;

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

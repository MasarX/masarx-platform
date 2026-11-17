import enMessages from "../messages/en.json";
import arMessages from "../messages/ar.json";

export type IntlMessages = Record<string, unknown>;

type MessagesImport = IntlMessages | { default: IntlMessages };

export function unwrapMessagesImport(messages: MessagesImport | undefined): IntlMessages {
  if (!messages) return {};
  if (typeof messages !== "object") return {};

  if (Object.prototype.hasOwnProperty.call(messages, "default")) {
    const candidate = (messages as { default?: unknown }).default;
    if (candidate && typeof candidate === "object") {
      return candidate as IntlMessages;
    }
  }

  return messages as IntlMessages;
}

const DEFAULT_LOCALE = "en";
const DEFAULT_MESSAGES = unwrapMessagesImport(enMessages as MessagesImport);

const MESSAGE_MAP: Record<string, IntlMessages> = {
  [DEFAULT_LOCALE]: DEFAULT_MESSAGES,
  ar: unwrapMessagesImport(arMessages as MessagesImport),
};

const hasMessages = (messages: IntlMessages | undefined): messages is IntlMessages =>
  !!messages && Object.keys(messages).length > 0;

export function resolveUiMessages(locale: string): IntlMessages {
  const normalized = String(locale || DEFAULT_LOCALE).toLowerCase();
  const localeKey = normalized.split("-")[0] || DEFAULT_LOCALE;
  const resolved = MESSAGE_MAP[localeKey] ?? DEFAULT_MESSAGES;
  if (hasMessages(resolved)) return resolved;

  return DEFAULT_MESSAGES;
}

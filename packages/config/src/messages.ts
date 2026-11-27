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

// An app that uses a subset of shared UI can supply its catalogs at build time.
declare const __UI_MESSAGE_CATALOGS__: string | undefined;
const MESSAGE_MAP: Record<string, IntlMessages> =
  typeof __UI_MESSAGE_CATALOGS__ === "string"
    ? JSON.parse(__UI_MESSAGE_CATALOGS__)
    : {
        en: unwrapMessagesImport(enMessages as MessagesImport),
        ar: unwrapMessagesImport(arMessages as MessagesImport),
      };
const DEFAULT_MESSAGES = MESSAGE_MAP[DEFAULT_LOCALE]!;

const hasMessages = (messages: IntlMessages | undefined): messages is IntlMessages =>
  !!messages && Object.keys(messages).length > 0;

export function resolveUiMessages(locale: string): IntlMessages {
  const normalized = String(locale || DEFAULT_LOCALE).toLowerCase();
  const localeKey = normalized.split("-")[0] || DEFAULT_LOCALE;
  const resolved = MESSAGE_MAP[localeKey] ?? DEFAULT_MESSAGES;
  if (hasMessages(resolved)) return resolved;

  return DEFAULT_MESSAGES;
}

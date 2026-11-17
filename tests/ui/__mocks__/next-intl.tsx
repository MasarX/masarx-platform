import * as React from "react";

type Messages = Record<string, unknown>;
type TranslationValues = Record<string, unknown> | undefined;

type IntlContextValue = {
  locale: string;
  messages: Messages;
};

const IntlContext = React.createContext<IntlContextValue | null>(null);

function resolveMessageValue(
  messages: Messages,
  path: string
): string | undefined {
  const parts = path
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  let current: unknown = messages;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

function interpolate(template: string, values: TranslationValues) {
  if (!values) return template;
  const pluralPattern =
    /\{(\w+)\s*,\s*plural\s*,\s*one\s*\{([^}]*)\}\s*other\s*\{([^}]*)\}\s*\}/g;
  const withPlurals = template.replaceAll(
    pluralPattern,
    (_match, key: string, oneBody: string, otherBody: string) => {
      const raw = (values as Record<string, unknown>)[key];
      const count = typeof raw === "number" ? raw : Number(raw);
      const resolvedCount = Number.isFinite(count) ? count : 0;
      const body = resolvedCount === 1 ? oneBody : otherBody;
      return body.replaceAll("#", String(resolvedCount));
    }
  );
  return Object.entries(values).reduce((acc, [key, value]) => {
    return acc.replaceAll(`{${key}}`, String(value));
  }, withPlurals);
}

export function NextIntlClientProvider({
  children,
  locale,
  messages,
}: {
  children: React.ReactNode;
  locale: string;
  messages: Messages;
}) {
  return (
    <IntlContext.Provider value={{ locale, messages }}>
      {children}
    </IntlContext.Provider>
  );
}

export function useLocale() {
  const ctx = React.useContext(IntlContext);
  return ctx?.locale ?? "en";
}

export function useTranslations(namespace?: string) {
  const ctx = React.useContext(IntlContext);
  return (key: string, values?: TranslationValues) => {
    const fullPath = namespace ? `${namespace}.${key}` : key;
    const value = ctx ? resolveMessageValue(ctx.messages, fullPath) : undefined;
    if (!value) return fullPath;
    return interpolate(value, values);
  };
}

export function createTranslator({
  namespace,
  messages,
}: {
  namespace?: string;
  messages: Messages;
}) {
  return (key: string, values?: TranslationValues) => {
    const fullPath = namespace ? `${namespace}.${key}` : key;
    const value = resolveMessageValue(messages, fullPath);
    if (!value) return fullPath;
    return interpolate(value, values);
  };
}

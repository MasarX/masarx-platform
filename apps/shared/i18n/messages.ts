import type { AbstractIntlMessages } from "next-intl";

export type MessagesImport =
  | AbstractIntlMessages
  | { default: AbstractIntlMessages };

export function unwrapMessages(messages: MessagesImport): AbstractIntlMessages {
  let current: unknown = messages;
  while (current && typeof current === "object" && "default" in current) {
    const next = (current as { default?: unknown }).default;
    if (!next || typeof next !== "object") break;
    current = next;
  }
  return (current && typeof current === "object"
    ? (current as AbstractIntlMessages)
    : {}) as AbstractIntlMessages;
}

type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function mergeIntlMessages(
  base: AbstractIntlMessages,
  overrides: AbstractIntlMessages
): AbstractIntlMessages {
  const output: PlainObject = { ...(base as PlainObject) };
  for (const [key, value] of Object.entries(overrides as PlainObject)) {
    const existing = output[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      output[key] = mergeIntlMessages(
        existing as AbstractIntlMessages,
        value as AbstractIntlMessages
      );
      continue;
    }
    output[key] = value;
  }
  return output as AbstractIntlMessages;
}


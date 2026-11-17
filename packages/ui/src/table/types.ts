import type { TranslationValues } from "next-intl";

export type TranslateFn = (key: string, values?: TranslationValues) => string;

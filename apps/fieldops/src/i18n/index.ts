import type { MobileLocaleMode } from "../mobile-shell-display";
import { AR_STRINGS } from "./strings-ar";
import { EN_STRINGS, type FieldOpsStrings } from "./strings-en";

export function getFieldOpsStrings(locale: MobileLocaleMode): FieldOpsStrings {
  return locale === "ar" ? AR_STRINGS : EN_STRINGS;
}

export { EN_STRINGS, AR_STRINGS };
export type { FieldOpsStrings };

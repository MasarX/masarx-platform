import { getStrings, resolveLocaleCode } from "./index";

export function useStrings(rawLocale: unknown) {
  const locale = resolveLocaleCode(rawLocale);
  return { strings: getStrings(locale), locale };
}

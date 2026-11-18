import { createUiTranslator } from "./i18n";

const accessReasons = new Set([
  "missing_capability",
  "no_capabilities",
  "no_policy",
  "no_roles",
  "explicit_deny",
]);

/** Convert access-evaluation codes to copy suitable for navigation and search. */
export function resolveNavigationDisabledReason(
  reason: string | null | undefined,
  t?: ReturnType<typeof createUiTranslator>
): string | null {
  if (!reason) return null;
  const translate = t ?? createUiTranslator("ui.navigation");
  const trimmed = reason.trim();
  if (accessReasons.has(trimmed) || /^Requires .+ capability\.$/i.test(trimmed)) {
    return translate("disabled.missingCapability");
  }
  if (trimmed === "no_route") return translate("disabled.noRoute");
  if (!trimmed || !/\s/.test(trimmed)) {
    return translate("disabled.unavailable");
  }
  return trimmed;
}

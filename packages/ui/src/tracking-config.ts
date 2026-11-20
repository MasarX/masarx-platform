import type { UiTrackingRegistry } from "@masarx/api";
import { createUiTranslator, resolveRowDisplayText } from "./i18n";
import { trimTrailingSlashes } from "./trim-trailing-slashes";
import { isLoopbackHostname } from "./url-guard";

export type TrackingOperatorHandoff = {
  label: string | null;
  labelAr: string | null;
  description: string | null;
  descriptionAr: string | null;
  path: string;
  identifierParam: string;
  identifierSource: string;
  tabParam: string | null;
  tab: "timeline" | null;
};

export type ResolvedTrackingConfig = {
  resourceKey: string;
  filterKey: string;
  paramKey: string;
  title: string;
  description: string;
  resultsDescription: string;
  empty: string;
  operatorHandoff: TrackingOperatorHandoff | null;
  form: {
    label: string;
    placeholder: string;
    searchLabel: string;
    clearLabel: string;
  };
};

type TrackingConfigResult = {
  config: ResolvedTrackingConfig | null;
  error: string | null;
};

function normalizeText(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isSafeHandoffPath(path: string) {
  return path.startsWith("/") && !path.startsWith("//") &&
    !/[\\\s?#%\u0000-\u001f\u007f]/.test(path) &&
    !path.split("/").some((part) => part === "." || part === "..");
}

export function resolveTrackingOperatorHandoff(
  input: UiTrackingRegistry["operator_handoff"]
): TrackingOperatorHandoff | null {
  if (!input || typeof input !== "object" || input.enabled === false) return null;
  const path = normalizeText(input.route_targets?.console?.path);
  if (path !== "/operate/shipments") return null;
  const identifierParam = normalizeText(input.identifier_param) ?? "focus";
  const identifierSource = normalizeText(input.identifier_source) ?? "tracking_number";
  const tabParam = normalizeText(input.tab_param);
  const tab = normalizeText(input.tab);
  const keys = [identifierParam, identifierSource, ...(tabParam ? [tabParam] : [])];
  if (!keys.every((key) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) ||
      Boolean(tabParam) !== Boolean(tab) || (tab && tab !== "timeline") ||
      tabParam === identifierParam) return null;
  return {
    path, identifierParam, identifierSource, tabParam, tab: tab as "timeline" | null,
    label: normalizeText(input.label),
    labelAr: normalizeText(input.label_ar),
    description: normalizeText(input.description),
    descriptionAr: normalizeText(input.description_ar),
  };
}

export function resolveShipmentOperatorHandoffHref(
  handoff: TrackingOperatorHandoff,
  detail: Record<string, unknown>,
  rawBase: string | undefined
): string | null {
  const value = detail[handoff.identifierSource];
  const identifier = typeof value === "string" ? value.trim() : "";
  if (!identifier || !rawBase || handoff.path !== "/operate/shipments" || /[\\\u0000-\u001f\u007f]/.test(rawBase)) return null;
  const rawPath = rawBase.trim().match(/^https?:\/\/[^/?#]+(\/[^?#]*)?(?:[?#]|$)/i);
  if (!rawPath || !isSafeHandoffPath(rawPath[1] ?? "/")) return null;
  try {
    const base = new URL(rawBase.trim());
    if (base.username || base.password || base.search || base.hash || !isSafeHandoffPath(base.pathname) ||
        (base.protocol !== "https:" && !(base.protocol === "http:" && isLoopbackHostname(base.hostname)))) return null;
    const target = new URL(`${trimTrailingSlashes(base.pathname)}${handoff.path}`, base.origin);
    if (target.origin !== base.origin) return null;
    target.searchParams.set(handoff.identifierParam, identifier);
    if (handoff.tabParam && handoff.tab) target.searchParams.set(handoff.tabParam, handoff.tab);
    return target.toString();
  } catch {
    return null;
  }
}

export function resolveTrackingConfig(
  input: UiTrackingRegistry | null | undefined,
  locale?: string | null
): TrackingConfigResult {
  const t = createUiTranslator("ui.tracking", { locale: locale ?? undefined });
  if (!input || typeof input !== "object") {
    return { config: null, error: t("errors.missingConfig") };
  }

  const resourceKey = normalizeText(input.resource_key);
  if (!resourceKey) {
    return { config: null, error: t("errors.missingResource") };
  }

  const filterKey =
    normalizeText(input.filter_key) ?? normalizeText(input.param_key);
  if (!filterKey) {
    return { config: null, error: t("errors.missingFilter") };
  }

  const paramKey = normalizeText(input.param_key) ?? filterKey;
  const form = input.form && typeof input.form === "object" ? input.form : null;
  const resolved: ResolvedTrackingConfig = {
    resourceKey,
    filterKey,
    paramKey,
    title: resolveRowDisplayText(normalizeText(input.title) ?? t("title"), input.title_ar, locale),
    description: resolveRowDisplayText(normalizeText(input.description) ?? t("description"), input.description_ar, locale),
    resultsDescription:
      resolveRowDisplayText(normalizeText(input.results_description) ?? t("resultsDescription"), input.results_description_ar, locale),
    empty: resolveRowDisplayText(normalizeText(input.empty) ?? t("empty"), input.empty_ar, locale),
    operatorHandoff: resolveTrackingOperatorHandoff(input.operator_handoff),
    form: {
      label: resolveRowDisplayText(normalizeText(form?.label) ?? t("form.label"), form?.label_ar, locale),
      placeholder: resolveRowDisplayText(normalizeText(form?.placeholder) ?? t("form.placeholder"), form?.placeholder_ar, locale),
      searchLabel: resolveRowDisplayText(normalizeText(form?.search_label) ?? t("form.search"), form?.search_label_ar, locale),
      clearLabel: resolveRowDisplayText(normalizeText(form?.clear_label) ?? t("form.clear"), form?.clear_label_ar, locale),
    },
  };

  return { config: resolved, error: null };
}

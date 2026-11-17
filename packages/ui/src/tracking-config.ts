import type { UiTrackingRegistry } from "@masarx/api";
import { createUiTranslator } from "./i18n";

export type ResolvedTrackingConfig = {
  resourceKey: string;
  filterKey: string;
  paramKey: string;
  title: string;
  description: string;
  resultsDescription: string;
  empty: string;
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

const t = createUiTranslator("ui.tracking");

function normalizeText(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function resolveTrackingConfig(
  input: UiTrackingRegistry | null | undefined
): TrackingConfigResult {
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
    title: normalizeText(input.title) ?? t("title"),
    description: normalizeText(input.description) ?? t("description"),
    resultsDescription:
      normalizeText(input.results_description) ?? t("resultsDescription"),
    empty: normalizeText(input.empty) ?? t("empty"),
    form: {
      label: normalizeText(form?.label) ?? t("form.label"),
      placeholder: normalizeText(form?.placeholder) ?? t("form.placeholder"),
      searchLabel: normalizeText(form?.search_label) ?? t("form.search"),
      clearLabel: normalizeText(form?.clear_label) ?? t("form.clear"),
    },
  };

  return { config: resolved, error: null };
}

"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { createUiTranslator } from "./i18n";
import { Input } from "./input";
import { stripBasePath } from "./navigation-paths";
import { Select } from "./select";
import { resolveSafeAppBasePath } from "./url-guard";

export type CommandCatalogFiltersProps = {
  query: string;
  category: string;
  capability: string;
  access: string;
  categories: Array<{ value: string; label: string }>;
  capabilities: Array<{ value: string; label: string }>;
  appBasePath?: string;
  testIdPrefix?: string | null;
};

export function CommandCatalogFilters({
  query,
  category,
  capability,
  access,
  categories,
  capabilities,
  appBasePath,
  testIdPrefix,
}: CommandCatalogFiltersProps) {
  const t = createUiTranslator("ui.commandCatalog");
  const pathname = usePathname();
  const safeBasePath = React.useMemo(
    () => resolveSafeAppBasePath(appBasePath ?? ""),
    [appBasePath]
  );
  const resolvedPathname = pathname
    ? stripBasePath(pathname, safeBasePath ?? undefined)
    : "/";
  const searchParams = useSearchParams();
  const [searchValue, setSearchValue] = React.useState(query);
  const [categoryValue, setCategoryValue] = React.useState(category);
  const [capabilityValue, setCapabilityValue] = React.useState(capability);
  const [accessValue, setAccessValue] = React.useState(access);
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";

  React.useEffect(() => {
    setSearchValue(query);
  }, [query]);

  React.useEffect(() => {
    setCategoryValue(category);
  }, [category]);

  React.useEffect(() => {
    setCapabilityValue(capability);
  }, [capability]);

  React.useEffect(() => {
    setAccessValue(access);
  }, [access]);

  const updateParam = React.useCallback(
    (key: string, value: string) => {
      const normalized = value.trim();
      const currentQuery = searchParams?.toString() ?? "";
      const params = new URLSearchParams(currentQuery);
      const currentValue = params.get(key) ?? "";
      if (normalized === currentValue) return;
      if (normalized) {
        params.set(key, normalized);
      } else {
        params.delete(key);
      }
      const nextQuery = params.toString();
      const nextUrl = nextQuery
        ? `${resolvedPathname}?${nextQuery}`
        : resolvedPathname;
      const currentUrl = currentQuery
        ? `${resolvedPathname}?${currentQuery}`
        : resolvedPathname;
      if (nextUrl === currentUrl) return;
      window.history.replaceState(window.history.state, "", nextUrl);
    },
    [resolvedPathname, searchParams]
  );

  React.useEffect(() => {
    if (searchValue.trim() === query) return;
    const handle = setTimeout(() => {
      updateParam("q", searchValue.trim());
    }, 200);
    return () => clearTimeout(handle);
  }, [query, searchValue, updateParam]);

  return (
    <div className="grid gap-3 md:grid-cols-4">
      <div className="space-y-1">
        <label className="text-xs font-medium text-ui-muted">
          {t("filters.searchLabel")}
        </label>
        <Input
          value={searchValue}
          onChange={(event) => setSearchValue(event.target.value)}
          placeholder={t("filters.searchPlaceholder")}
          aria-label={t("filters.searchLabel")}
          data-testid={
            resolvedTestIdPrefix
              ? `${resolvedTestIdPrefix}-filter-search`
              : undefined
          }
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-ui-muted">
          {t("filters.categoryLabel")}
        </label>
        <Select
          value={categoryValue}
          onChange={(event) => {
            setCategoryValue(event.target.value);
            updateParam("category", event.target.value);
          }}
          aria-label={t("filters.categoryLabel")}
          data-testid={
            resolvedTestIdPrefix
              ? `${resolvedTestIdPrefix}-filter-category`
              : undefined
          }
        >
          <option value="">{t("filters.categoryAll")}</option>
          {categories.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-ui-muted">
          {t("filters.capabilityLabel")}
        </label>
        <Select
          value={capabilityValue}
          onChange={(event) => {
            setCapabilityValue(event.target.value);
            updateParam("capability", event.target.value);
          }}
          aria-label={t("filters.capabilityLabel")}
          data-testid={
            resolvedTestIdPrefix
              ? `${resolvedTestIdPrefix}-filter-capability`
              : undefined
          }
        >
          <option value="">{t("filters.capabilityAll")}</option>
          <option value="__none__">{t("filters.capabilityNone")}</option>
          {capabilities.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-ui-muted">
          {t("filters.accessLabel")}
        </label>
        <Select
          value={accessValue}
          onChange={(event) => {
            setAccessValue(event.target.value);
            updateParam("access", event.target.value);
          }}
          aria-label={t("filters.accessLabel")}
          data-testid={
            resolvedTestIdPrefix
              ? `${resolvedTestIdPrefix}-filter-access`
              : undefined
          }
        >
          <option value="">{t("filters.accessAll")}</option>
          <option value="allowed">{t("filters.accessAllowed")}</option>
          <option value="missing">{t("filters.accessMissing")}</option>
          <option value="none">{t("filters.accessNone")}</option>
        </Select>
      </div>
    </div>
  );
}

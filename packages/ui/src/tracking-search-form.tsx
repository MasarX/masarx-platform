"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "./button";
import { Input } from "./input";
import { createUiTranslator } from "./i18n";

type TrackingSearchFormProps = {
  actionHref: string;
  defaultValue?: string | null;
  paramKey: string;
  label?: string | null;
  placeholder?: string | null;
  searchLabel?: string | null;
  clearLabel?: string | null;
  emptySearchMessage?: string | null;
  resourceKey?: string | null;
  filterKey?: string | null;
  testIdPrefix?: string;
};

const t = createUiTranslator("ui.tracking");

/**
 * Tracking search form with reference input and submit action.
 */
export function TrackingSearchForm({
  actionHref,
  defaultValue,
  paramKey,
  label,
  placeholder,
  searchLabel,
  clearLabel,
  emptySearchMessage,
  resourceKey,
  filterKey,
  testIdPrefix,
}: TrackingSearchFormProps) {
  const router = useRouter();
  const [value, setValue] = React.useState(defaultValue ?? "");
  const [emptySearch, setEmptySearch] = React.useState(false);
  const errorId = React.useId();
  const resolvedEmptySearchMessage = emptySearchMessage ?? t("form.emptySearch");
  const testId = testIdPrefix ? `${testIdPrefix}-form` : undefined;
  const resolvedLabel = label ?? t("form.label");
  const resolvedPlaceholder = placeholder ?? t("form.placeholder");
  const resolvedSearchLabel = searchLabel ?? t("form.search");
  const resolvedClearLabel = clearLabel ?? t("form.clear");
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";

  const handleSubmit = React.useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = value.trim();
      if (!trimmed) {
        setEmptySearch(true);
        return;
      }
      setEmptySearch(false);
      const separator = actionHref.includes("?") ? "&" : "?";
      const nextUrl = `${actionHref}${separator}${encodeURIComponent(paramKey)}=${encodeURIComponent(trimmed)}`;
      router.push(nextUrl);
    },
    [actionHref, paramKey, router, value]
  );

  const handleClear = React.useCallback(() => {
    setValue("");
    setEmptySearch(false);
    router.push(actionHref);
  }, [actionHref, router]);

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-wrap items-end gap-4 rounded-2xl border border-ui-border bg-ui-surface/70 p-4"
      data-testid={testId}
      data-tracking-resource={resourceKey ?? undefined}
      data-tracking-filter={filterKey ?? undefined}
      data-tracking-param={paramKey}
    >
      <label className="flex min-w-[220px] flex-1 flex-col gap-2 text-sm text-ui-ink">
        <span className="text-xs uppercase tracking-wide text-ui-muted">
          {resolvedLabel}
        </span>
        <Input
          type="search"
          name={paramKey}
          value={value}
          onChange={(event) => { setValue(event.target.value); setEmptySearch(false); }}
          aria-invalid={emptySearch || undefined}
          aria-describedby={emptySearch ? errorId : undefined}
          placeholder={resolvedPlaceholder}
          data-testid={
            resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-input` : undefined
          }
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          data-testid={
            resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-submit` : undefined
          }
        >
          {resolvedSearchLabel}
        </Button>
        {defaultValue ? (
          <button
            type="button"
            className="text-xs text-ui-muted hover:text-ui-ink"
            onClick={handleClear}
            data-testid={
              resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-clear` : undefined
            }
          >
            {resolvedClearLabel}
          </button>
        ) : null}
      </div>
      {emptySearch ? <p id={errorId} role="alert" className="text-sm text-ui-danger">{resolvedEmptySearchMessage}</p> : null}
    </form>
  );
}

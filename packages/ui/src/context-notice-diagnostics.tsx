"use client";

import * as React from "react";
import { copyTextToClipboard } from "./clipboard";
import { createUiTranslator } from "./i18n";
import { cn } from "./utils";

export type ContextNoticeDiagnosticsEntry = {
  label: string;
  value: string;
  copyValue?: string | null;
  monospace?: boolean;
};

type ContextNoticeDiagnosticsProps = {
  entries: ContextNoticeDiagnosticsEntry[];
  className?: string;
  testId?: string;
};

function normalizeEntries(entries: ContextNoticeDiagnosticsEntry[]) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => ({
      ...entry,
      label: String(entry.label ?? "").trim(),
      value: String(entry.value ?? "").trim(),
      copyValue: entry.copyValue ? String(entry.copyValue).trim() : null,
    }))
    .filter((entry) => entry.label && entry.value);
}

export function ContextNoticeDiagnostics({
  entries,
  className,
  testId,
}: ContextNoticeDiagnosticsProps) {
  const t = createUiTranslator("ui.context.diagnostics");
  const normalizedEntries = React.useMemo(() => normalizeEntries(entries), [entries]);
  const [copiedLabel, setCopiedLabel] = React.useState<string | null>(null);
  const copyResetTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = null;
      }
    };
  }, []);

  const onCopy = React.useCallback(async (value: string, label: string) => {
    const success = await copyTextToClipboard(value);
    if (!success) return;

    setCopiedLabel(label);
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopiedLabel(null);
      copyResetTimerRef.current = null;
    }, 1400);
  }, []);

  if (normalizedEntries.length === 0) return null;

  return (
    <details
      className={cn(
        "rounded-xl border border-ui-border bg-ui-surface/60 p-3 text-xs text-ui-muted",
        className
      )}
      data-testid={testId}
    >
      <summary className="cursor-pointer select-none text-[11px] font-medium text-ui-ink">
        {t("title")}
      </summary>
      <dl className="mt-3 space-y-2">
        {normalizedEntries.map((entry) => {
          const copyValue = entry.copyValue ?? null;
          const copyLabel = copiedLabel === entry.label ? t("copied") : t("copy");
          return (
            <div
              key={`${entry.label}:${entry.value}`}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-start gap-3"
            >
              <dt className="text-[10px] uppercase tracking-wide text-ui-muted">
                {entry.label}
              </dt>
              <dd
                className={cn(
                  "break-all text-ui-ink",
                  entry.monospace ? "font-mono" : ""
                )}
                title={entry.value}
              >
                {entry.value}
              </dd>
              {copyValue ? (
                <button
                  type="button"
                  className="text-[11px] font-medium text-ui-ink underline underline-offset-4"
                  onClick={() => onCopy(copyValue, entry.label)}
                  aria-label={t("copyAria", { label: entry.label })}
                >
                  {copyLabel}
                </button>
              ) : (
                <span />
              )}
            </div>
          );
        })}
      </dl>
    </details>
  );
}


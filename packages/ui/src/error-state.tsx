"use client";

import * as React from "react";
import { Button } from "./button";
import { copyTextToClipboard } from "./clipboard";
import { EmptyState } from "./empty-state";
import { createUiTranslator } from "./i18n";
import { cn, formatUiError } from "./utils";

type ErrorStateVariant = "page" | "inline" | "card";

type ErrorStateProps = {
  title?: string;
  description?: string;
  error?: unknown;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
  variant?: ErrorStateVariant;
  testId?: string;
};

/**
 * Error state wrapper that formats errors and renders a recovery action.
 */
export function ErrorState({
  title,
  description,
  error,
  actionLabel,
  onAction,
  className,
  variant = "page",
  testId,
}: ErrorStateProps) {
  const t = createUiTranslator("ui.feedback.error");
  const detail = error
    ? formatUiError(error, t("detailsFallback"))
    : null;
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const copyResetTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = null;
      }
    };
  }, []);

  const onCopyDetails = React.useCallback(async () => {
    if (!detail) return;
    try {
      const success = await copyTextToClipboard(detail);
      if (!success) return;
      setCopied(true);
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyResetTimerRef.current = null;
      }, 1600);
    } catch {
      // Ignore clipboard errors.
    }
  }, [detail]);
  const action = onAction ? (
    <Button size="sm" onClick={onAction}>
      {actionLabel ?? t("action")}
    </Button>
  ) : null;

  return (
    <div className={cn("space-y-3", className)} data-testid={testId}>
      <EmptyState
        title={title ?? t("title")}
        description={description ?? t("description")}
        variant={variant}
        action={action}
      />
      {detail ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setDetailsOpen((prev) => !prev)}
              data-testid={testId ? `${testId}-details-toggle` : undefined}
            >
              {detailsOpen ? t("detailsHide") : t("detailsShow")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onCopyDetails}
              data-testid={testId ? `${testId}-details-copy` : undefined}
            >
              {copied ? t("detailsCopied") : t("detailsCopy")}
            </Button>
          </div>
          {detailsOpen ? (
            <pre
              className="max-h-64 overflow-auto rounded-md border border-ui-border bg-ui-surface p-3 text-xs text-ui-ink"
              data-testid={testId ? `${testId}-details-body` : undefined}
            >
              {detail}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

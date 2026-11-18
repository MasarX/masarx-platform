"use client";

import * as React from "react";
import { Badge } from "./badge";
import { cn } from "./utils";

export type MobileCardField = {
  key: string;
  label: string;
  value: string | number | null | undefined;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
  isBadge?: boolean;
};

type MobileCardViewProps = {
  items: {
    id: string;
    title: string;
    subtitle?: string | null;
    fields: MobileCardField[];
    onClick?: () => void;
  }[];
  emptyMessage?: string;
  className?: string;
};

/**
 * Mobile-optimized card-based view for resource lists.
 * Replaces tables at narrow viewports (< 640px).
 * Each card shows key fields as pills with expand on tap.
 */
export function MobileCardView({
  items,
  emptyMessage = "No items found",
  className,
}: MobileCardViewProps) {
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  if (items.length === 0) {
    return (
      <div className={cn("py-12 text-center text-sm text-ui-muted", className)}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      {items.map((item) => {
        const isExpanded = expandedId === item.id;
        const previewFields = item.fields.slice(0, 3);
        const extraFields = item.fields.slice(3);

        return (
          <div
            key={item.id}
            className="rounded-lg border border-ui-border/40 bg-ui-surface p-3 transition active:scale-[0.99]"
          >
            <button
              type="button"
              className="flex w-full min-h-[44px] items-start justify-between gap-2 text-left"
              onClick={() => {
                setExpandedId(isExpanded ? null : item.id);
                item.onClick?.();
              }}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-ui-ink">{item.title}</p>
                {item.subtitle ? (
                  <p className="mt-0.5 text-xs text-ui-muted truncate">{item.subtitle}</p>
                ) : null}
              </div>
              <svg
                viewBox="0 0 20 20"
                fill="currentColor"
                className={cn(
                  "h-4 w-4 shrink-0 text-ui-muted transition",
                  isExpanded && "rotate-180"
                )}
              >
                <path
                  fillRule="evenodd"
                  d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
                  clipRule="evenodd"
                />
              </svg>
            </button>

            {/* Preview fields (always visible) */}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {previewFields.map((field) =>
                field.isBadge ? (
                  <Badge
                    key={field.key}
                    tone={field.tone ?? "neutral"}
                    size="sm"
                    dot
                  >
                    {String(field.value ?? "-")}
                  </Badge>
                ) : (
                  <span
                    key={field.key}
                    className="inline-flex items-center gap-1 rounded-md bg-ui-highlight/50 px-2 py-0.5 text-[10px] text-ui-muted"
                    title={field.label}
                  >
                    <span className="font-medium">{field.label}:</span>
                    <span className="text-ui-ink">{String(field.value ?? "-")}</span>
                  </span>
                )
              )}
            </div>

            {/* Expanded detail */}
            {isExpanded && extraFields.length > 0 ? (
              <div className="mt-3 space-y-1.5 border-t border-ui-border/20 pt-3">
                {extraFields.map((field) => (
                  <div
                    key={field.key}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="text-ui-muted">{field.label}</span>
                    {field.isBadge ? (
                      <Badge tone={field.tone ?? "neutral"} size="sm">
                        {String(field.value ?? "-")}
                      </Badge>
                    ) : (
                      <span className="font-medium text-ui-ink">
                        {String(field.value ?? "-")}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

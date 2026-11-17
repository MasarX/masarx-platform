import * as React from "react";
import { cn } from "./utils";

type EmptyStateVariant = "page" | "inline" | "card";

type EmptyStateProps = {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
  variant?: EmptyStateVariant;
  testId?: string;
};

const variantClasses: Record<EmptyStateVariant, string> = {
  page: "rounded-2xl border border-ui-accent/15 bg-ui-accent-soft/10 p-8 shadow-soft",
  inline: "rounded-xl border border-ui-border/60 bg-ui-paper/40 p-4",
  card: "rounded-xl border border-ui-border bg-ui-paper/70 p-5",
};

const titleClasses: Record<EmptyStateVariant, string> = {
  page: "text-base font-semibold text-ui-ink",
  inline: "text-sm font-semibold text-ui-ink",
  card: "text-sm font-semibold text-ui-ink",
};

const descriptionClasses: Record<EmptyStateVariant, string> = {
  page: "text-sm text-ui-muted",
  inline: "text-xs text-ui-muted",
  card: "text-xs text-ui-muted",
};

/**
 * Empty state component with optional action and icon.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
  variant = "page",
  testId,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={testId}
      className={cn(
        "flex flex-col items-center gap-3 text-center",
        variantClasses[variant],
        className
      )}
    >
      {icon ? <div className="text-ui-accent/40">{icon}</div> : null}
      <div className="space-y-1">
        <div className={titleClasses[variant]}>{title}</div>
        {description ? (
          <div className={descriptionClasses[variant]}>{description}</div>
        ) : null}
      </div>
      {action ? <div className="pt-2">{action}</div> : null}
    </div>
  );
}

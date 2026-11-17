import * as React from "react";
import { cn } from "./utils";

type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  tone?: "neutral" | "accent" | "success" | "warning" | "danger" | "info";
};

/**
 * Small status badge with neutral or accent tone.
 */
export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  const toneClass = (() => {
    if (tone === "accent") return "bg-ui-accent-soft text-ui-ink";
    if (tone === "success")
      return "border border-[rgb(var(--ui-success)/0.35)] bg-[rgb(var(--ui-success)/0.12)] text-[rgb(var(--ui-success))]";
    if (tone === "warning")
      return "border border-[rgb(var(--ui-warning)/0.35)] bg-[rgb(var(--ui-warning)/0.12)] text-[rgb(var(--ui-warning))]";
    if (tone === "danger")
      return "border border-[rgb(var(--ui-danger)/0.35)] bg-[rgb(var(--ui-danger)/0.12)] text-[rgb(var(--ui-danger))]";
    if (tone === "info")
      return "border border-[rgb(var(--ui-info)/0.35)] bg-[rgb(var(--ui-info)/0.12)] text-[rgb(var(--ui-info))]";
    return "bg-ui-surface text-ui-muted border border-ui-border";
  })();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-3 py-1 text-xs font-medium",
        toneClass,
        className
      )}
      {...props}
    />
  );
}

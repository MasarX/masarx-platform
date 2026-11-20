import * as React from "react";
import { cn } from "./utils";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  size?: "sm" | "md" | "lg";
  dot?: boolean;
  /** Optional icon rendered before the text for accessibility (avoids color-only status). */
  icon?: React.ReactNode;
};

/**
 * Small status badge with neutral or accent tone.
 */
export function Badge({ tone = "neutral", size = "md", dot, icon, className, children, ...props }: BadgeProps) {
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
  const sizeClass =
    size === "sm" ? "px-2 py-0.5 text-[10px]" :
    size === "lg" ? "px-4 py-1.5 text-sm" :
    "px-3 py-1 text-xs";
  const dotColor =
    tone === "success" ? "bg-[rgb(var(--ui-success))]" :
    tone === "warning" ? "bg-[rgb(var(--ui-warning))]" :
    tone === "danger" ? "bg-[rgb(var(--ui-danger))]" :
    tone === "info" ? "bg-[rgb(var(--ui-info))]" :
    tone === "accent" ? "bg-ui-accent" :
    "bg-ui-muted";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-medium",
        sizeClass,
        toneClass,
        className
      )}
      {...props}
    >
      {props.dangerouslySetInnerHTML ? undefined : (
        <>
          {dot ? <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotColor)} /> : null}
          {icon ? <span className="shrink-0 [&>svg]:h-3 [&>svg]:w-3" aria-hidden>{icon}</span> : null}
          {children}
        </>
      )}
    </span>
  );
}

"use client";

import * as React from "react";
import { cn } from "../utils";
import { Badge } from "../badge";

export type TimelineEntry = {
  id: string;
  timestamp: string;
  type: string;
  label?: string | null;
  description?: string | null;
  actor?: string | null;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
  metadata?: Record<string, unknown> | null;
  traceId?: string | null;
};

type ActivityTimelineProps = {
  entries: TimelineEntry[];
  emptyMessage?: string;
  className?: string;
};

const toneIcons: Record<string, string> = {
  success: "\u2713",
  warning: "\u26A0",
  danger: "\u2717",
  info: "\u2139",
  neutral: "\u2022",
};

function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Generic activity timeline for displaying chronological events.
 * Reusable across shipments, exceptions, workflows, etc.
 */
export function ActivityTimeline({
  entries,
  emptyMessage = "No activity recorded.",
  className,
}: ActivityTimelineProps) {
  if (entries.length === 0) {
    return (
      <div className={cn("py-8 text-center text-sm text-ui-muted", className)}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={cn("relative space-y-0", className)}>
      {/* Vertical connector line */}
      <div className="absolute left-3.5 top-2 bottom-2 w-px bg-ui-border/40" />

      {entries.map((entry, index) => {
        const tone = entry.tone ?? "neutral";
        const icon = toneIcons[tone] ?? toneIcons.neutral;
        const isLast = index === entries.length - 1;

        return (
          <div
            key={entry.id}
            className={cn(
              "relative flex gap-3 py-3 ps-1",
              !isLast && "border-b border-ui-border/10"
            )}
          >
            {/* Dot indicator */}
            <div
              className={cn(
                "relative z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                tone === "success" && "bg-[rgb(var(--ui-success)/0.15)] text-[rgb(var(--ui-success))]",
                tone === "warning" && "bg-[rgb(var(--ui-warning)/0.15)] text-[rgb(var(--ui-warning))]",
                tone === "danger" && "bg-[rgb(var(--ui-danger)/0.15)] text-[rgb(var(--ui-danger))]",
                tone === "info" && "bg-[rgb(var(--ui-info)/0.15)] text-[rgb(var(--ui-info))]",
                tone === "neutral" && "bg-ui-highlight text-ui-muted"
              )}
            >
              {icon}
            </div>

            {/* Content */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-ui-ink">
                  {entry.label ?? entry.type.replace(/_/g, " ")}
                </span>
                <Badge tone={tone} size="sm">
                  {entry.type}
                </Badge>
              </div>

              {entry.description ? (
                <p className="mt-0.5 text-xs text-ui-muted">{entry.description}</p>
              ) : null}

              <div className="mt-1 flex items-center gap-3 text-[11px] text-ui-muted">
                <time dateTime={entry.timestamp} title={new Date(entry.timestamp).toLocaleString()}>
                  {formatRelativeTime(entry.timestamp)}
                </time>
                {entry.actor ? (
                  <span className="truncate">{entry.actor}</span>
                ) : null}
                {entry.traceId ? (
                  <span className="font-mono text-ui-accent/60 truncate" title={entry.traceId}>
                    {entry.traceId.slice(0, 8)}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

"use client";

import * as React from "react";

type NodeStatusBadgeProps = {
  status: string | null;
  durationMs: number | null;
  className?: string;
};

function resolveRunStepTone(status: string | null) {
  if (!status) return "neutral";
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "skipped") return "neutral";
  if (status === "in_progress") return "warning";
  if (status === "pending") return "info";
  return "neutral";
}

function formatDurationMs(durationMs: number | null) {
  if (durationMs === null) return null;
  const rounded = Math.max(0, Math.round(durationMs));
  if (rounded < 1000) return `${rounded}ms`;
  const seconds = rounded / 1000;
  const display = seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1);
  return `${display}s`;
}

const STATUS_ICON: Record<string, string> = {
  completed: "\u2713",   // ✓
  failed: "\u2717",      // ✗
  in_progress: "\u25CF", // ●
  pending: "\u25CB",     // ○
  skipped: "\u2014",     // —
};

const toneClasses: Record<string, string> = {
  success: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
  danger: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  warning: "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  info: "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
  neutral: "bg-gray-50 text-gray-500 dark:bg-gray-800/50 dark:text-gray-400",
};

export const NodeStatusBadge = React.memo(function NodeStatusBadge({
  status,
  durationMs,
  className,
}: NodeStatusBadgeProps) {
  if (!status) return null;

  const tone = resolveRunStepTone(status);
  const duration = formatDurationMs(durationMs);
  const toneClass = toneClasses[tone] ?? toneClasses.neutral;
  const icon = STATUS_ICON[status] || "";

  const isInProgress = status === "in_progress";

  return (
    <div
      className={[
        "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-medium leading-none",
        toneClass,
        isInProgress ? "ring-1 ring-amber-400/40" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {icon ? (
        <span className={["text-[9px]", isInProgress ? "animate-pulse-dot" : ""].filter(Boolean).join(" ")}>
          {icon}
        </span>
      ) : null}
      <span className="capitalize">{status.replace(/_/g, " ")}</span>
      {duration ? (
        <span className="ms-0.5 opacity-60">{duration}</span>
      ) : null}
    </div>
  );
});

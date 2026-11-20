"use client";

import * as React from "react";
import type { NodeProps } from "@xyflow/react";
import type { WorkflowStepData } from "../workflow-canvas-types";
import { NodeHandle } from "./node-handle";
import { NodeStatusBadge } from "./node-status-badge";

/* ---------------------------------------------------------------------------
 * Helpers.
 * -------------------------------------------------------------------------*/

/** Convert snake_case handler key to a readable label. */
function humanizeKey(key: string): string {
  return key
    .replace(/_v\d+$/i, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Derive a two-letter initial from the operation name. */
function initials(name: string): string {
  const clean = name.replace(/_v\d+$/i, "");
  const parts = clean.split(/[_\-\s]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return (clean.slice(0, 2) || "ST").toUpperCase();
}

/** Pick an accent color from a stable hash of the operation name. */
const NODE_COLORS = [
  { bg: "bg-violet-100 dark:bg-violet-950/40", text: "text-violet-600 dark:text-violet-400", border: "border-violet-200 dark:border-violet-800/60", accent: "#8b5cf6", ring: "ring-violet-500/20" },
  { bg: "bg-sky-100 dark:bg-sky-950/40", text: "text-sky-600 dark:text-sky-400", border: "border-sky-200 dark:border-sky-800/60", accent: "#0ea5e9", ring: "ring-sky-500/20" },
  { bg: "bg-emerald-100 dark:bg-emerald-950/40", text: "text-emerald-600 dark:text-emerald-400", border: "border-emerald-200 dark:border-emerald-800/60", accent: "#10b981", ring: "ring-emerald-500/20" },
  { bg: "bg-amber-100 dark:bg-amber-950/40", text: "text-amber-600 dark:text-amber-400", border: "border-amber-200 dark:border-amber-800/60", accent: "#f59e0b", ring: "ring-amber-500/20" },
  { bg: "bg-rose-100 dark:bg-rose-950/40", text: "text-rose-600 dark:text-rose-400", border: "border-rose-200 dark:border-rose-800/60", accent: "#f43f5e", ring: "ring-rose-500/20" },
  { bg: "bg-indigo-100 dark:bg-indigo-950/40", text: "text-indigo-600 dark:text-indigo-400", border: "border-indigo-200 dark:border-indigo-800/60", accent: "#6366f1", ring: "ring-indigo-500/20" },
  { bg: "bg-teal-100 dark:bg-teal-950/40", text: "text-teal-600 dark:text-teal-400", border: "border-teal-200 dark:border-teal-800/60", accent: "#14b8a6", ring: "ring-teal-500/20" },
  { bg: "bg-orange-100 dark:bg-orange-950/40", text: "text-orange-600 dark:text-orange-400", border: "border-orange-200 dark:border-orange-800/60", accent: "#f97316", ring: "ring-orange-500/20" },
] as const;

function colorForKey(key: string | null, index?: number): (typeof NODE_COLORS)[number] {
  if (!key) return NODE_COLORS[(index ?? 0) % NODE_COLORS.length]!;
  // Use operation name (without version suffix) for better distribution
  const clean = key.replace(/_v\d+$/i, "");
  let hash = 0;
  for (let i = 0; i < clean.length; i++) {
    hash = ((hash << 7) - hash + clean.charCodeAt(i) * 31) | 0;
  }
  return NODE_COLORS[Math.abs(hash) % NODE_COLORS.length]!;
}

/* ---------------------------------------------------------------------------
 * Component.
 * -------------------------------------------------------------------------*/

type WorkflowStepNodeProps = NodeProps & {
  data: WorkflowStepData;
};

export const WorkflowStepNode = React.memo(function WorkflowStepNode({
  data,
  selected,
}: WorkflowStepNodeProps) {
  const {
    stepId,
    operationName,
    handlerKey,
    enabled,
    runStatus,
    runDurationMs,
    stepIndex,
  } = data;

  const title = operationName ? humanizeKey(operationName) : handlerKey ? humanizeKey(handlerKey) : "Step";
  const subtitle = handlerKey ? humanizeKey(handlerKey) : null;
  const color = colorForKey(operationName || handlerKey);

  return (
    <div
      data-testid="workflow-step-node"
      data-flow-node
      data-flow-node-id={stepId}
      className={[
        "group relative w-[240px] rounded-2xl border bg-white transition-all duration-200 dark:bg-gray-900",
        selected
          ? `border-transparent ring-2 ${color.ring}`
          : `${color.border} hover:-translate-y-0.5`,
        !enabled ? "opacity-45 grayscale-[40%]" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Left accent stripe */}
      <div
        className="absolute start-0 top-0 h-full w-1 rounded-s-2xl"
        style={{ backgroundColor: color.accent }}
      />

      {/* Step number badge */}
      {stepIndex > 0 ? (
        <div className="absolute -right-2 -top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-gray-100 text-[10px] font-bold text-gray-500 ring-2 ring-white dark:bg-gray-800 dark:text-gray-400 dark:ring-gray-900">
          {stepIndex}
        </div>
      ) : null}

      <NodeHandle type="target" visible={selected} />

      <div className="py-3.5 ps-5 pe-3.5">
        <div className="flex items-center gap-3">
          {/* Icon circle */}
          <div
            className={[
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xs font-bold tracking-wide",
              color.bg,
              color.text,
            ].join(" ")}
          >
            {initials(operationName || handlerKey || "ST")}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold leading-snug text-gray-800 dark:text-gray-100">
                {title}
              </span>
              {!enabled ? (
                <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-gray-400 dark:bg-gray-800 dark:text-gray-500">
                  off
                </span>
              ) : null}
            </div>
            {subtitle ? (
              <div className="mt-0.5 truncate text-[11px] leading-snug text-gray-400 dark:text-gray-500">
                {subtitle}
              </div>
            ) : null}
          </div>
        </div>

        <NodeStatusBadge status={runStatus} durationMs={runDurationMs} className="mt-2.5 ml-[52px]" />
      </div>

      <NodeHandle type="source" visible={selected} />
    </div>
  );
});

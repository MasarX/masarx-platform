"use client";

import { cn } from "../utils";
import type { CellDisplay } from "./cell-display";
import type { ResourceColumn } from "./columns";
import {
  CellBooleanDisplay,
  CellMultiSelect,
  CellSelectTag,
  resolveRenderType,
} from "./cell-renderers";

/* ── Typed cell display components ── */

function CellDateDisplay({ value }: { value: string }) {
  if (!value) return <span className="text-ui-muted">&mdash;</span>;
  const date = new Date(value);
  if (isNaN(date.getTime())) return <span title={value}>{value}</span>;
  const formatted = date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const now = Date.now();
  const diff = now - date.getTime();
  const days = Math.round(diff / 86_400_000);
  const relative =
    days === 0
      ? "Today"
      : days === 1
        ? "Yesterday"
        : days > 0 && days < 30
          ? `${days}d ago`
          : null;
  return (
    <span className="whitespace-nowrap" title={relative ?? value}>
      {formatted}
    </span>
  );
}

function CellNumberDisplay({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "")
    return <span className="text-ui-muted">&mdash;</span>;
  const num = typeof value === "number" ? value : Number(value);
  if (isNaN(num)) return <span>{String(value)}</span>;
  const formatted = num.toLocaleString(undefined, {
    maximumFractionDigits: 4,
  });
  return (
    <span className="tabular-nums text-right">{formatted}</span>
  );
}

function CellIdDisplay({ value }: { value: string }) {
  if (!value) return <span className="text-ui-muted">&mdash;</span>;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(value);
  const display = isUuid ? `${value.slice(0, 8)}…` : value;
  return (
    <span
      className="inline-flex items-center gap-1 font-mono text-[11px] text-ui-muted"
      title={value}
    >
      <span className="truncate max-w-[100px]">{display}</span>
    </span>
  );
}

function CellUrlDisplay({ value }: { value: string }) {
  if (!value) return <span className="text-ui-muted">&mdash;</span>;
  let display: string;
  try {
    const url = new URL(value);
    display = url.hostname + (url.pathname !== "/" ? url.pathname : "");
  } catch {
    display = value;
  }
  return (
    <span className="inline-flex items-center gap-1 text-ui-accent" title={value}>
      <span className="max-w-[180px] truncate">{display}</span>
      <svg
        aria-hidden
        viewBox="0 0 12 12"
        className="h-3 w-3 flex-none opacity-60"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 1h6v6" />
        <path d="M11 1L4.5 7.5" />
      </svg>
    </span>
  );
}

function CellEmailDisplay({ value }: { value: string }) {
  if (!value) return <span className="text-ui-muted">&mdash;</span>;
  return (
    <span className="inline-flex items-center gap-1" title={value}>
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5 flex-none text-ui-muted"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
        <path d="M1.5 5l6.5 4 6.5-4" />
      </svg>
      <span className="max-w-[180px] truncate">{value}</span>
    </span>
  );
}

function CellProgressDisplay({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  const barColor =
    clamped >= 80
      ? "bg-[rgb(var(--ui-success))]"
      : clamped >= 40
        ? "bg-[rgb(var(--ui-info))]"
        : "bg-[rgb(var(--ui-warning))]";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-ui-highlight">
        <div
          className={cn("h-full rounded-full transition-all", barColor)}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="tabular-nums text-xs text-ui-muted">{clamped}%</span>
    </div>
  );
}

/* ── Dispatcher ── */

export function renderTypedCell(
  column: ResourceColumn,
  rawValue: unknown,
  cellDisplay: CellDisplay,
  isPrimary: boolean,
  textColor?: React.CSSProperties["color"],
): React.ReactNode {
  const renderType = resolveRenderType(column);

  if (renderType === "boolean") {
    return <CellBooleanDisplay value={Boolean(rawValue)} />;
  }

  if (renderType === "select") {
    if (Array.isArray(rawValue)) {
      return <CellMultiSelect values={rawValue.map(String)} />;
    }
    if (rawValue != null && String(rawValue) !== "") {
      return <CellSelectTag value={String(rawValue)} />;
    }
  }

  if (renderType === "date" || renderType === "datetime") {
    if (rawValue != null && String(rawValue) !== "") {
      return <CellDateDisplay value={String(rawValue)} />;
    }
  }

  if (renderType === "number") {
    return <CellNumberDisplay value={rawValue} />;
  }

  if (renderType === "id") {
    if (rawValue != null && String(rawValue) !== "") {
      return <CellIdDisplay value={String(rawValue)} />;
    }
  }

  // Detect URL/email by content pattern for text columns
  if (renderType === "text" && typeof rawValue === "string") {
    if (/^https?:\/\//i.test(rawValue)) {
      return <CellUrlDisplay value={rawValue} />;
    }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawValue)) {
      return <CellEmailDisplay value={rawValue} />;
    }
    // Detect progress-like numbers 0-100
    if (
      column.key.toLowerCase().includes("progress") &&
      typeof rawValue === "string"
    ) {
      const num = Number(rawValue);
      if (!isNaN(num) && num >= 0 && num <= 100) {
        return <CellProgressDisplay value={num} />;
      }
    }
  }

  // Fallback: default text display
  return (
    <span className={cn("block max-w-xs", !isPrimary && "text-ui-muted")}>
      <span
        className="block truncate"
        style={textColor ? { color: textColor } : undefined}
        title={cellDisplay.primaryTitle}
      >
        {cellDisplay.primary}
      </span>
      {cellDisplay.secondary ? (
        <span
          className="block truncate text-[10px] text-ui-muted"
          style={textColor ? { color: textColor } : undefined}
          title={cellDisplay.secondaryTitle}
        >
          {cellDisplay.secondary}
        </span>
      ) : null}
    </span>
  );
}

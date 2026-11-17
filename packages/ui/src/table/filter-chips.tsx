"use client";

import { cn } from "../utils";
import type { TranslateFn } from "./types";

export type ChipItem = {
  id: string;
  label: string;
  detail?: string;
  type: "filter" | "sort" | "group";
};

type FilterChipsProps = {
  t: TranslateFn;
  chips: ChipItem[];
  onRemove: (chip: ChipItem) => void;
  onClearAll?: () => void;
};

const chipTypeColor: Record<ChipItem["type"], string> = {
  filter:
    "bg-ui-accent-soft/30 text-ui-accent hover:bg-ui-accent-soft/50",
  sort:
    "bg-[rgb(var(--ui-info)/0.10)] text-ui-ink hover:bg-[rgb(var(--ui-info)/0.18)]",
  group:
    "bg-[rgb(var(--ui-success)/0.10)] text-[rgb(var(--ui-success))] hover:bg-[rgb(var(--ui-success)/0.18)]",
};

export function FilterChips({ t, chips, onRemove, onClearAll }: FilterChipsProps) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 motion-safe:table-animate-fade-in">
      {chips.map((chip) => (
        <span
          key={`${chip.type}-${chip.id}`}
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
            chipTypeColor[chip.type]
          )}
        >
          <span className="max-w-[160px] truncate">
            {chip.label}
            {chip.detail ? (
              <span> {chip.detail}</span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={() => onRemove(chip)}
            className="ml-0.5 inline-flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full transition-colors hover:bg-black/10"
            aria-label={t("viewBar.removeChipAria")}
          >
            <svg
              aria-hidden
              viewBox="0 0 12 12"
              className="h-2.5 w-2.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
            >
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </span>
      ))}
      {onClearAll && chips.length > 1 ? (
        <button
          type="button"
          onClick={onClearAll}
          className="text-xs text-ui-muted transition-colors hover:text-ui-ink"
        >
          {t("viewBar.clearAll")}
        </button>
      ) : null}
    </div>
  );
}

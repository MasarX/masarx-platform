"use client";

import * as React from "react";
import { createUiTranslator } from "../i18n";
import type { DraftRow } from "./types";

const t = createUiTranslator("ui.labelDesigner.timeline");

type DraftTimelineProps = {
  drafts: DraftRow[];
  selectedDraftId: string;
  onSelect: (draftId: string) => void;
  testIdPrefix?: string;
};

function formatDate(value: string | null): string {
  if (!value) return "";
  try {
    const date = new Date(value);
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-[rgb(var(--ui-warning))]",
  published: "bg-[rgb(var(--ui-success))]",
  validated: "bg-[rgb(var(--ui-info))]",
};

export function DraftTimeline({
  drafts,
  selectedDraftId,
  onSelect,
  testIdPrefix,
}: DraftTimelineProps) {
  const prefix = testIdPrefix || "draft-timeline";

  if (drafts.length === 0) {
    return (
      <p className="text-xs text-ui-muted" data-testid={`${prefix}-empty`}>
        {t("noDrafts")}
      </p>
    );
  }

  const sorted = [...drafts].sort((a, b) => {
    const aDate = a.updated_at || a.published_at || "";
    const bDate = b.updated_at || b.published_at || "";
    return bDate.localeCompare(aDate);
  });

  return (
    <div className="space-y-0" data-testid={`${prefix}-list`}>
      {sorted.map((draft, i) => {
        const isSelected = draft.id === selectedDraftId;
        const date = draft.updated_at || draft.published_at;
        const dotColor = STATUS_COLORS[draft.status.toLowerCase()] || "bg-ui-muted";

        return (
          <button
            key={draft.id}
            type="button"
            className={`group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
              isSelected ? "bg-ui-accent-soft" : "hover:bg-ui-highlight"
            }`}
            onClick={() => onSelect(draft.id)}
            data-testid={`${prefix}-item-${i}`}
          >
            {/* Timeline dot + line */}
            <div className="relative flex flex-col items-center pt-1.5">
              <div className={`h-2 w-2 rounded-full ${dotColor}`} />
              {i < sorted.length - 1 ? (
                <div className="mt-0.5 h-full w-px bg-ui-border/50" style={{ minHeight: 20 }} />
              ) : null}
            </div>

            {/* Content */}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-1">
                <span className="truncate text-xs font-medium text-ui-ink">
                  {draft.draft_name || draft.label_type || draft.id.slice(0, 8)}
                </span>
                <span className="shrink-0 text-[10px] text-ui-muted capitalize">
                  {draft.status}
                </span>
              </div>
              {date ? (
                <p className="text-[10px] text-ui-muted">{formatDate(date)}</p>
              ) : null}
            </div>
          </button>
        );
      })}
    </div>
  );
}

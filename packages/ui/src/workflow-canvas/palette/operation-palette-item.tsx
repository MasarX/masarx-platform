"use client";

import * as React from "react";
import type { OperationMatch } from "./group-operation-matches";
import { resolveOperationLabel, resolveOperationDescription } from "./group-operation-matches";

const notesStyle: React.CSSProperties = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};

type OperationPaletteItemProps = {
  match: OperationMatch;
  index: number;
  canAdd: boolean;
  testIdPrefix?: string;
  docsLabel?: string;
  quickAddLabel?: string;
  onQuickAdd: (handlerKey: string) => void;
  onDragStart: (handlerKey: string, event: React.DragEvent) => void;
  onDragEnd: () => void;
};

export const OperationPaletteItem = React.memo(function OperationPaletteItem({
  match,
  index,
  canAdd,
  testIdPrefix,
  docsLabel,
  quickAddLabel,
  onQuickAdd,
  onDragStart,
  onDragEnd,
}: OperationPaletteItemProps) {
  const description = resolveOperationDescription(match);

  return (
    <div
      className="group flex w-full items-start justify-between gap-3 rounded-lg px-2 py-2 text-xs text-ui-ink transition hover:bg-ui-highlight/60"
      data-testid={testIdPrefix ? `${testIdPrefix}-item-${index}` : undefined}
    >
      <button
        type="button"
        className="min-w-0 flex-1 space-y-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper"
        onClick={() => onQuickAdd(match.handlerKey)}
        draggable={canAdd}
        onDragStart={(event) => onDragStart(match.handlerKey, event)}
        onDragEnd={onDragEnd}
      >
        <span className="block truncate font-medium">
          {resolveOperationLabel(match)}
        </span>
        <span className="block truncate font-mono text-[11px] text-ui-muted">
          {match.handlerKey}
        </span>
        {description ? (
          <span
            className="block text-[11px] leading-4 text-ui-muted/80"
            style={notesStyle}
          >
            {description}
          </span>
        ) : null}
      </button>
      <div className="shrink-0 space-y-2 pt-0.5 text-right">
        {match.docUrl ? (
          <a
            className="inline-flex items-center justify-center gap-1 rounded-full border border-ui-border bg-ui-paper px-2 py-0.5 text-[10px] text-ui-muted transition hover:bg-ui-highlight/70 hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper"
            href={match.docUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            {docsLabel ?? "Docs"}
          </a>
        ) : null}
        <span className="inline-flex rounded-full border border-ui-border bg-ui-paper px-2 py-0.5 text-[10px] text-ui-muted">
          {quickAddLabel ?? "Quick add"}
        </span>
      </div>
    </div>
  );
});

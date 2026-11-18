"use client";

import * as React from "react";
import { Input } from "../../input";
import { Button } from "../../button";
import { useOperationMatches } from "./use-operation-matches";
import {
  groupOperationMatches,
  type OperationMatch,
} from "./group-operation-matches";
import { OperationPaletteItem } from "./operation-palette-item";

/* ---------------------------------------------------------------------------
 * DnD type constant (shared with canvas for drag-to-add).
 * -------------------------------------------------------------------------*/

export const OPERATION_DND_TYPE = "application/x-masarx-operation";

/* ---------------------------------------------------------------------------
 * Props.
 * -------------------------------------------------------------------------*/

type OperationPaletteProps = {
  enabled: boolean;
  canAdd: boolean;
  writeAllowed: boolean;
  pluginsHref?: string | null;
  className?: string;
  testIdPrefix?: string;
  labels: {
    title: string;
    hint: string;
    searchPlaceholder: string;
    loading: string;
    unavailable: string;
    matches: string;
    suggestions: string;
    noMatches: string;
    docs: string;
    quickAdd: string;
    managePlugins: string;
  };
  onQuickAdd: (handlerKey: string) => void;
  onDragStart?: (operationName: string) => void;
  onDragEnd?: () => void;
};

/* ---------------------------------------------------------------------------
 * Component.
 * -------------------------------------------------------------------------*/

export function OperationPalette({
  enabled,
  canAdd,
  writeAllowed,
  pluginsHref,
  className,
  testIdPrefix,
  labels,
  onQuickAdd,
  onDragStart,
  onDragEnd,
}: OperationPaletteProps) {
  const [query, setQuery] = React.useState("");
  const paletteMatches = useOperationMatches(enabled, query);

  const handleDragStart = React.useCallback(
    (handlerKey: string, event: React.DragEvent) => {
      if (!canAdd) return;
      const op = handlerKey.trim();
      if (!op) return;
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData(OPERATION_DND_TYPE, op);
      event.dataTransfer.setData("text/plain", op);
      onDragStart?.(op);
    },
    [canAdd, onDragStart]
  );

  const handleDragEnd = React.useCallback(() => {
    onDragEnd?.();
  }, [onDragEnd]);

  return (
    <div className={["w-full space-y-3 lg:w-72 lg:shrink-0", className].filter(Boolean).join(" ")}>
      <div className="rounded-2xl border border-ui-border bg-ui-paper/60 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="text-xs font-semibold text-ui-ink">{labels.title}</div>
          <div className="text-[10px] text-ui-muted">{labels.hint}</div>
        </div>
        <div className="mt-3 space-y-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={labels.searchPlaceholder}
            disabled={!writeAllowed}
            data-testid={testIdPrefix ? `${testIdPrefix}-search` : undefined}
          />
          <div
            className="max-h-72 space-y-1 overflow-y-auto rounded-xl border border-ui-border bg-ui-paper p-2"
            data-testid={testIdPrefix ? `${testIdPrefix}-list` : undefined}
          >
            {paletteMatches.error ? (
              <div className="px-3 py-4 text-xs text-ui-muted">
                <div className="font-medium text-ui-ink">{labels.unavailable}</div>
                <div className="mt-1 text-[11px] text-ui-muted/80">
                  {paletteMatches.error}
                </div>
              </div>
            ) : paletteMatches.loading ? (
              <div className="px-3 py-4 text-xs text-ui-muted">
                {labels.loading}
              </div>
            ) : paletteMatches.matches.length > 0 ? (
              <>
                <div className="px-2 py-1 text-[10px] font-medium tracking-wide text-ui-muted">
                  {query.trim() ? labels.matches : labels.suggestions}
                </div>
                {renderGrouped(
                  paletteMatches.matches,
                  canAdd,
                  testIdPrefix,
                  labels,
                  onQuickAdd,
                  handleDragStart,
                  handleDragEnd
                )}
              </>
            ) : (
              <div className="px-3 py-4 text-xs text-ui-muted">
                {labels.noMatches}
              </div>
            )}
          </div>
          {pluginsHref ? (
            <div className="flex items-center justify-end">
              <Button asChild type="button" size="sm" variant="ghost">
                <a
                  href={pluginsHref}
                  data-testid={testIdPrefix ? `${testIdPrefix}-manage-plugins` : undefined}
                >
                  {labels.managePlugins}
                </a>
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Render grouped palette items.
 * -------------------------------------------------------------------------*/

function renderGrouped(
  matches: OperationMatch[],
  canAdd: boolean,
  testIdPrefix: string | undefined,
  labels: { docs: string; quickAdd: string },
  onQuickAdd: (handlerKey: string) => void,
  onDragStart: (handlerKey: string, event: React.DragEvent) => void,
  onDragEnd: () => void
) {
  const grouped = groupOperationMatches(matches);

  const renderRow = (match: OperationMatch, index: number) => (
    <OperationPaletteItem
      key={match.handlerKey}
      match={match}
      index={index}
      canAdd={canAdd}
      testIdPrefix={testIdPrefix}
      docsLabel={labels.docs}
      quickAddLabel={labels.quickAdd}
      onQuickAdd={onQuickAdd}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    />
  );

  if (!grouped.showGroups) {
    return matches.map(renderRow);
  }

  let rowIndex = 0;
  return (
    <div className="space-y-2">
      {grouped.groups.map((group) => (
        <div key={group.id} className="space-y-1">
          <div className="px-2 py-1 text-[10px] font-semibold tracking-wide text-ui-muted">
            {group.label}
          </div>
          <div className="space-y-1">
            {group.matches.map((match) => {
              const rendered = renderRow(match, rowIndex);
              rowIndex += 1;
              return rendered;
            })}
          </div>
        </div>
      ))}
      {grouped.ungrouped.length > 0 ? (
        <div className="space-y-1">
          {grouped.ungrouped.map((match) => {
            const rendered = renderRow(match, rowIndex);
            rowIndex += 1;
            return rendered;
          })}
        </div>
      ) : null}
    </div>
  );
}

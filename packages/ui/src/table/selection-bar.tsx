import type { ReactNode } from "react";
import { Badge } from "../badge";
import { Button } from "../button";
import type { TranslateFn } from "./types";

type TableSelectionBarProps = {
  t: TranslateFn;
  selectedCount: number;
  selectedIds: string[];
  renderBulkActions?: (selectedIds: string[]) => ReactNode;
  onClear: () => void;
  testIdPrefix?: string;
};

export function TableSelectionBar({
  t,
  selectedCount,
  selectedIds,
  renderBulkActions,
  onClear,
  testIdPrefix,
}: TableSelectionBarProps) {
  const selectionTestId = testIdPrefix
    ? `${testIdPrefix}-selection-bar`
    : undefined;
  const clearTestId = testIdPrefix
    ? `${testIdPrefix}-selection-clear`
    : undefined;
  return (
    <div
      className="pointer-events-none fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-wrap items-center gap-3 rounded-xl border border-ui-border/20 bg-ui-surface px-4 py-2.5 text-xs text-ui-muted shadow-lg motion-safe:table-animate-slide-up"
      data-testid={selectionTestId}
    >
      <div className="pointer-events-auto flex flex-wrap items-center gap-3">
        <Badge tone={selectedCount > 0 ? "accent" : "neutral"}>
          {t("selection.count", { count: selectedCount })}
        </Badge>
        {selectedCount === 0 ? (
          <span>{t("selection.empty")}</span>
        ) : null}
      </div>
      <div className="pointer-events-auto flex flex-wrap items-center gap-2">
        {renderBulkActions ? (
          <div className="flex flex-wrap items-center gap-2">
            {renderBulkActions(selectedIds)}
          </div>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          onClick={onClear}
          disabled={selectedCount === 0}
          data-testid={clearTestId}
        >
          {t("selection.clear")}
        </Button>
      </div>
    </div>
  );
}

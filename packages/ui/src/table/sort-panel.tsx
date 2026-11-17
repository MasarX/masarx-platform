"use client";
import { Button } from "../button";
import { Select } from "../select";
import { resolveColumnLabelByKey, type ResourceColumn } from "./columns";
import type { SortState } from "./sorting";
import type { TranslateFn } from "./types";
import { TablePanelHeader } from "./panel-header";

type TableSortPanelProps = {
  t: TranslateFn;
  sortState: SortState[];
  columnsByKey: Map<string, ResourceColumn>;
  onAddSort: (key: string) => void;
  onRemoveSort: (key: string) => void;
  onToggleDirection: (key: string) => void;
  onMoveSort: (fromIndex: number, toIndex: number) => void;
  onClearSorts: () => void;
  testIdPrefix?: string | null;
};

export function TableSortPanel({
  t,
  sortState,
  columnsByKey,
  onAddSort,
  onRemoveSort,
  onToggleDirection,
  onMoveSort,
  onClearSorts,
  testIdPrefix,
}: TableSortPanelProps) {
  const sortedKeys = sortState.map((entry) => entry.key);
  const availableKeys = Array.from(columnsByKey.keys()).filter(
    (key) => !sortedKeys.includes(key)
  );
  const canAdd = availableKeys.length > 0;
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";
  const panelTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-sort-panel`
    : undefined;
  const clearTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-sort-clear`
    : undefined;
  const addTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-sort-add`
    : undefined;

  return (
    <div className="space-y-3" data-testid={panelTestId}>
      <TablePanelHeader
        label={t("viewBar.sort")}
        count={sortState.length}
        actions={
          <Button
            type="button"
            variant="ghost"
            onClick={onClearSorts}
            disabled={sortState.length === 0}
            data-testid={clearTestId}
          >
            {t("viewBar.clearSort")}
          </Button>
        }
      />
      <div className="space-y-2">
        {sortState.length === 0 ? (
          <div className="text-xs text-ui-muted">{t("viewBar.noSorts")}</div>
        ) : (
          sortState.map((entry, index) => (
            <div
              key={entry.key}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-ui-border/40 bg-transparent px-3 py-2 text-xs"
            >
              <span className="font-medium text-ui-ink">
                {resolveColumnLabelByKey(columnsByKey, entry.key)}
              </span>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onToggleDirection(entry.key)}
              >
                {entry.direction === "asc"
                  ? t("viewBar.directionAsc")
                  : t("viewBar.directionDesc")}
              </Button>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onMoveSort(index, index - 1)}
                  disabled={index === 0}
                >
                  {t("viewBar.moveUp")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onMoveSort(index, index + 1)}
                  disabled={index === sortState.length - 1}
                >
                  {t("viewBar.moveDown")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onRemoveSort(entry.key)}
                >
                  {t("viewBar.remove")}
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
      <label className="flex flex-wrap items-center gap-2 text-xs text-ui-muted">
        <span className="text-[10px] text-ui-muted">
          {t("viewBar.addSort")}
        </span>
        <Select
          value=""
          onChange={(event) => {
            const value = event.target.value;
            if (!value) return;
            onAddSort(value);
          }}
          disabled={!canAdd}
          className="min-w-[200px]"
          data-testid={addTestId}
        >
          <option value="">{t("viewBar.addSortPlaceholder")}</option>
          {availableKeys.map((key) => (
            <option key={key} value={key}>
              {resolveColumnLabelByKey(columnsByKey, key)}
            </option>
          ))}
        </Select>
      </label>
    </div>
  );
}

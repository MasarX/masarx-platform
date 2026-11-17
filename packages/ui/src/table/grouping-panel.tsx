import type { ResourceColumn } from "./columns";
import { resolveColumnLabelByKey } from "./columns";
import type { TranslateFn } from "./types";
import { Button } from "../button";
import { Select } from "../select";
import { TablePanelHeader } from "./panel-header";

type TableGroupingPanelProps = {
  t: TranslateFn;
  availableGroupKeys: string[];
  resolvedGroupBy: string[];
  columnsByKey: Map<string, ResourceColumn>;
  groupIds: string[];
  collapsedGroups: Set<string>;
  onAddGroupKey: (key: string) => void;
  onMoveGroupKey: (key: string, delta: number) => void;
  onRemoveGroupKey: (key: string) => void;
  onClearGroupBy: () => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  testIdPrefix?: string | null;
};

export function TableGroupingPanel({
  t,
  availableGroupKeys,
  resolvedGroupBy,
  columnsByKey,
  groupIds,
  collapsedGroups,
  onAddGroupKey,
  onMoveGroupKey,
  onRemoveGroupKey,
  onClearGroupBy,
  onCollapseAll,
  onExpandAll,
  testIdPrefix,
}: TableGroupingPanelProps) {
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";
  const panelTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-group-panel`
    : undefined;
  const addTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-group-add`
    : undefined;
  const clearTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-group-clear`
    : undefined;
  const collapseAllTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-group-collapse-all`
    : undefined;
  const expandAllTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-group-expand-all`
    : undefined;
  return (
    <div className="space-y-3" data-testid={panelTestId}>
      <TablePanelHeader
        label={t("grouping.title")}
        count={resolvedGroupBy.length}
        actions={
          <Button
            type="button"
            variant="ghost"
            disabled={resolvedGroupBy.length === 0}
            onClick={onClearGroupBy}
            data-testid={clearTestId}
          >
            {t("grouping.clearAll")}
          </Button>
        }
      />
      <div className="space-y-3">
        <label className="flex min-w-[240px] flex-1 flex-col gap-2">
          <span className="text-xs text-ui-muted">
            {t("grouping.addLabel")}
          </span>
          <Select
            value=""
            onChange={(event) => {
              const next = event.target.value.trim();
              if (!next) return;
              onAddGroupKey(next);
            }}
            className="w-full"
            data-testid={addTestId}
          >
            <option value="">{t("grouping.selectPlaceholder")}</option>
            {availableGroupKeys.map((key) => (
              <option key={key} value={key}>
                {resolveColumnLabelByKey(columnsByKey, key)}
              </option>
            ))}
          </Select>
        </label>
        {resolvedGroupBy.length === 0 ? (
          <div className="text-sm text-ui-muted">{t("grouping.empty")}</div>
        ) : (
          <div className="space-y-2">
            {resolvedGroupBy.map((key, index) => (
              <div key={key} className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-ui-ink">
                  {resolveColumnLabelByKey(columnsByKey, key)}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={index === 0}
                    onClick={() => onMoveGroupKey(key, -1)}
                  >
                    {t("grouping.moveUp")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={index === resolvedGroupBy.length - 1}
                    onClick={() => onMoveGroupKey(key, 1)}
                  >
                    {t("grouping.moveDown")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => onRemoveGroupKey(key)}
                  >
                    {t("grouping.remove")}
                  </Button>
                </div>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Button
                type="button"
                variant="ghost"
                disabled={groupIds.length === 0}
                onClick={onCollapseAll}
                data-testid={collapseAllTestId}
              >
                {t("grouping.collapseAll")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={collapsedGroups.size === 0}
                onClick={onExpandAll}
                data-testid={expandAllTestId}
              >
                {t("grouping.expandAll")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

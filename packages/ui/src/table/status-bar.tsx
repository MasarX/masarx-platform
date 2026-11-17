import type { TranslateFn } from "./types";
import { Button } from "../button";

type TableStatusBarProps = {
  t: TranslateFn;
  viewOpen: boolean;
  onToggleView: () => void;
  onResetView: () => void;
  sortingLabel: string;
  groupingLabel: string;
  filtersLabel: string;
};

export function TableStatusBar({
  t,
  viewOpen,
  onToggleView,
  onResetView,
  sortingLabel,
  groupingLabel,
  filtersLabel,
}: TableStatusBarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-ui-muted">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" onClick={onToggleView}>
          {viewOpen ? t("toolbar.hideView") : t("toolbar.customizeView")}
        </Button>
        <Button type="button" variant="ghost" onClick={onResetView}>
          {t("toolbar.resetView")}
        </Button>
      </div>
      <span>{sortingLabel}</span>
      <span>{groupingLabel}</span>
      <span>{filtersLabel}</span>
    </div>
  );
}

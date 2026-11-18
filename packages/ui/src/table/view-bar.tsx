"use client";
import * as React from "react";
import { Badge } from "../badge";
import { Button } from "../button";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  DropdownTrigger,
} from "../dropdown";
import { Select } from "../select";
import { Tabs, TabsList, TabsTrigger } from "../tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../tooltip";
import { cn } from "../utils";
import { FilterChips, type ChipItem } from "./filter-chips";
import type { TranslateFn } from "./types";
import type { ResourceViewEntry } from "./view-types";

export type TablePanelKey =
  | "filters"
  | "sort"
  | "group"
  | "properties"
  | "views"
  | "export"
  | "formatting";

export type ViewMenuAction = "rename" | "duplicate" | "delete" | "setDefault";

type ViewMenuProps = {
  activeView: ResourceViewEntry | null;
  onAction: (action: ViewMenuAction) => void;
};

type TableViewBarProps = {
  t: TranslateFn;
  views: ResourceViewEntry[];
  activeViewId: string;
  onViewChange: (value: string) => void;
  viewTabsMax: number;
  viewDirty: boolean;
  hasBaseHref: boolean;
  canManageViews: boolean;
  activePanel: TablePanelKey | null;
  onPanelToggle: (panel: TablePanelKey) => void;
  panelIdPrefix?: string | null;
  testIdPrefix?: string | null;
  onResetView: () => void;
  sortingLabel: string;
  groupingLabel: string;
  filtersLabel: string;
  filtersCount: number;
  sortCount: number;
  groupCount: number;
  visibleColumnsCount: number;
  totalColumnsCount: number;
  viewScopeValue?: string | null;
  settingsResolutionValue?: string | null;
  viewError?: string | null;
  viewMenu?: ViewMenuProps;
  toolbar?: React.ReactNode;
  onClearFilters?: () => void;
  onClearSorts?: () => void;
  onClearGroups?: () => void;
  filterChips?: ChipItem[];
  onRemoveChip?: (chip: ChipItem) => void;
  onClearAllChips?: () => void;
  onSaveFiltersAsView?: () => void;
};

function ControlIcon({ name }: { name: TablePanelKey | "menu" }) {
  const shared = "h-4 w-4 text-ui-muted";
  switch (name) {
    case "filters":
      return (
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className={shared}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 4h14l-5.5 6.5v4.5l-3 1.8v-6.3L3 4z" />
        </svg>
      );
    case "sort":
      return (
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className={shared}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M7 4v12m0 0l-3-3m3 3l3-3" />
          <path d="M13 16V4m0 0l-3 3m3-3l3 3" />
        </svg>
      );
    case "group":
      return (
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className={shared}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3.5" y="4" width="5.5" height="5.5" rx="1.2" />
          <rect x="11" y="4" width="5.5" height="5.5" rx="1.2" />
          <rect x="3.5" y="11" width="13" height="5.5" rx="1.2" />
        </svg>
      );
    case "properties":
      return (
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className={shared}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 6h12" />
          <path d="M4 14h12" />
          <path d="M8 4v4" />
          <path d="M12 12v4" />
        </svg>
      );
    case "views":
      return (
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className={shared}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3.5" y="4" width="13" height="12" rx="2" />
          <path d="M3.5 9h13" />
        </svg>
      );
    case "export":
      return (
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className={shared}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10 4v8" />
          <path d="M7 7l3-3 3 3" />
          <path d="M4 14h12" />
        </svg>
      );
    case "formatting":
      return (
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className={shared}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 4h12v2H4z" />
          <path d="M6 8h8v8H6z" />
          <path d="M10 8v8" />
        </svg>
      );
    case "menu":
      return (
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className={shared}
          fill="currentColor"
        >
          <circle cx="5" cy="10" r="1.2" />
          <circle cx="10" cy="10" r="1.2" />
          <circle cx="15" cy="10" r="1.2" />
        </svg>
      );
    default:
      return null;
  }
}

export function TableViewBar({
  t,
  views,
  activeViewId,
  onViewChange,
  viewTabsMax,
  viewDirty,
  hasBaseHref,
  canManageViews,
  activePanel,
  onPanelToggle,
  panelIdPrefix,
  testIdPrefix,
  onResetView,
  sortingLabel,
  groupingLabel,
  filtersLabel,
  filtersCount,
  sortCount,
  groupCount,
  visibleColumnsCount,
  totalColumnsCount,
  viewScopeValue,
  settingsResolutionValue,
  viewError,
  viewMenu,
  toolbar,
  onClearFilters,
  onClearSorts,
  onClearGroups,
  filterChips,
  onRemoveChip,
  onClearAllChips,
  onSaveFiltersAsView,
}: TableViewBarProps) {
  const viewSelectId = React.useId();
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";
  const viewBarTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-view-bar`
    : undefined;
  const viewSelectTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-view-select`
    : undefined;
  const viewMenuTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-view-menu`
    : undefined;
  const viewResetTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-view-reset`
    : undefined;
  const hasViews = views.length > 0;
  const showTabs = hasViews && views.length <= viewTabsMax;
  const viewMenuDisabled = !viewMenu?.activeView;
  const propertiesCountLabel =
    totalColumnsCount > 0 && visibleColumnsCount !== totalColumnsCount
      ? `${visibleColumnsCount}/${totalColumnsCount}`
      : null;
  const controls: Array<{
    key: TablePanelKey;
    label: string;
    countLabel?: string | null;
    isActive?: boolean;
  }> = [
    {
      key: "filters",
      label: t("viewBar.filters"),
      countLabel: filtersCount > 0 ? String(filtersCount) : null,
      isActive: activePanel === "filters" || filtersCount > 0,
    },
    {
      key: "sort",
      label: t("viewBar.sort"),
      countLabel: sortCount > 0 ? String(sortCount) : null,
      isActive: activePanel === "sort" || sortCount > 0,
    },
    {
      key: "group",
      label: t("viewBar.group"),
      countLabel: groupCount > 0 ? String(groupCount) : null,
      isActive: activePanel === "group" || groupCount > 0,
    },
    {
      key: "properties",
      label: t("viewBar.properties"),
      countLabel: propertiesCountLabel,
      isActive: activePanel === "properties",
    },
    {
      key: "views",
      label: t("viewBar.views"),
      countLabel: views.length > 1 ? String(views.length) : null,
      isActive: activePanel === "views",
    },
    {
      key: "formatting",
      label: t("viewBar.formatting"),
      isActive: activePanel === "formatting",
    },
    {
      key: "export",
      label: t("viewBar.export"),
      isActive: activePanel === "export",
    },
  ];
  const resolvePanelId = React.useCallback(
    (key: TablePanelKey, isActive?: boolean) =>
      panelIdPrefix && isActive ? `${panelIdPrefix}-${key}` : undefined,
    [panelIdPrefix]
  );

  return (
    <div
      className="rounded-lg border border-ui-border/15 bg-transparent px-3 py-2 text-sm"
      data-testid={viewBarTestId}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {showTabs ? (
            <Tabs value={activeViewId}>
              <TabsList aria-label={t("views.label")}>
                {views.map((view) => (
                  <TabsTrigger
                    key={view.id}
                    value={view.id}
                    disabled={!hasBaseHref}
                    data-testid={
                      resolvedTestIdPrefix
                        ? `${resolvedTestIdPrefix}-view-tab-${view.id}`
                        : undefined
                    }
                    onClick={() => {
                      if (!hasBaseHref) return;
                      onViewChange(view.id);
                    }}
                  >
                    {view.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          ) : (
            <label
              className="space-y-1 text-xs text-ui-muted"
              htmlFor={viewSelectId}
            >
              <span className="text-[10px] text-ui-muted">
                {t("views.label")}
              </span>
              <Select
                id={viewSelectId}
                value={hasViews ? activeViewId : ""}
                onChange={(event) => onViewChange(event.target.value)}
                className="min-w-[220px]"
                disabled={!hasViews || !hasBaseHref}
                data-testid={viewSelectTestId}
              >
                {hasViews ? null : (
                  <option value="">{t("views.empty")}</option>
                )}
                {views.map((view) => (
                  <option key={view.id} value={view.id}>
                    {view.label}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {viewMenu && canManageViews ? (
            <Dropdown>
              <DropdownTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={viewMenuDisabled}
                  aria-label={t("views.menuAria")}
                  data-testid={viewMenuTestId}
                >
                  <span className="inline-flex items-center gap-2">
                    <ControlIcon name="menu" />
                    <span className="hidden sm:inline" aria-hidden="true">
                      {t("views.menuLabel")}
                    </span>
                    <span className="sr-only sm:hidden">{t("views.menuLabel")}</span>
                  </span>
                </Button>
              </DropdownTrigger>
              <DropdownContent align="start">
                <DropdownItem
                  disabled={viewMenuDisabled}
                  onSelect={() => viewMenu.onAction("rename")}
                  data-testid={
                    resolvedTestIdPrefix
                      ? `${resolvedTestIdPrefix}-view-menu-rename`
                      : undefined
                  }
                >
                  {t("views.menuRename")}
                </DropdownItem>
                <DropdownItem
                  disabled={viewMenuDisabled}
                  onSelect={() => viewMenu.onAction("duplicate")}
                  data-testid={
                    resolvedTestIdPrefix
                      ? `${resolvedTestIdPrefix}-view-menu-duplicate`
                      : undefined
                  }
                >
                  {t("views.menuDuplicate")}
                </DropdownItem>
                <DropdownItem
                  disabled={viewMenuDisabled}
                  onSelect={() => viewMenu.onAction("setDefault")}
                  data-testid={
                    resolvedTestIdPrefix
                      ? `${resolvedTestIdPrefix}-view-menu-set-default`
                      : undefined
                  }
                >
                  {t("views.menuSetDefault")}
                </DropdownItem>
                <DropdownSeparator />
                <DropdownItem
                  disabled={viewMenuDisabled}
                  onSelect={() => viewMenu.onAction("delete")}
                  data-testid={
                    resolvedTestIdPrefix
                      ? `${resolvedTestIdPrefix}-view-menu-delete`
                      : undefined
                  }
                >
                  {t("views.menuDelete")}
                </DropdownItem>
              </DropdownContent>
            </Dropdown>
          ) : null}
          {viewDirty ? (
            <span
              className="inline-block h-2 w-2 rounded-full bg-ui-accent"
              title={t("viewBar.unsaved")}
              aria-label={t("viewBar.unsaved")}
            />
          ) : null}
          <Button
            type="button"
            variant="ghost"
            onClick={onResetView}
            disabled={!hasViews}
            data-testid={viewResetTestId}
          >
            {t("toolbar.resetView")}
          </Button>
        </div>
        {toolbar ? <div className="flex-1 min-w-[180px]">{toolbar}</div> : null}
        <div className="flex flex-wrap items-center gap-2">
          <TooltipProvider>
            {controls.map((control) => {
              const panelOpen = activePanel === control.key;
              return (
                <Tooltip key={control.key}>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => onPanelToggle(control.key)}
                      aria-expanded={panelOpen}
                      aria-controls={resolvePanelId(control.key, panelOpen)}
                      aria-pressed={panelOpen}
                      aria-label={control.label}
                      data-testid={
                        resolvedTestIdPrefix
                          ? `${resolvedTestIdPrefix}-view-control-${control.key}`
                          : undefined
                      }
                      className={cn(
                        "gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-ui-highlight/50",
                        control.isActive
                          ? "bg-ui-accent-soft/30 text-ui-accent font-medium"
                          : "text-ui-muted"
                      )}
                    >
                      <span className="inline-flex items-center gap-2">
                        <ControlIcon name={control.key} />
                        <span className="hidden sm:inline" aria-hidden="true">
                          {control.label}
                        </span>
                        <span className="sr-only sm:hidden">
                          {control.label}
                        </span>
                        {control.countLabel ? (
                          <Badge tone={control.isActive ? "accent" : "neutral"}>
                            {control.countLabel}
                          </Badge>
                        ) : null}
                      </span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="sm:hidden">
                    {control.label}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </TooltipProvider>
          {!canManageViews ? (
            <span className="text-xs text-ui-muted">
              {t("views.disabled")}
            </span>
          ) : null}
        </div>
      </div>
      {filterChips && filterChips.length > 0 && onRemoveChip ? (
        <div className="mt-2 flex items-start gap-2 border-t border-ui-border/10 pt-2">
          <FilterChips
            t={t}
            chips={filterChips}
            onRemove={onRemoveChip}
            onClearAll={onClearAllChips}
          />
          {onSaveFiltersAsView && canManageViews ? (
            <button
              type="button"
              className="mt-0.5 shrink-0 rounded-md border border-ui-accent/30 bg-ui-accent/5 px-2 py-0.5 text-[10px] font-medium text-ui-accent transition hover:bg-ui-accent/10"
              onClick={onSaveFiltersAsView}
              title="Save current filters as a new view"
            >
              {"Save filters as view"}
            </button>
          ) : null}
        </div>
      ) : null}
      {viewError ? <span className="text-xs text-ui-ink">{viewError}</span> : null}
    </div>
  );
}

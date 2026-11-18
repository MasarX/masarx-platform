"use client";

import * as React from "react";
import { Button } from "./button";
import { ResourceDetailNavigation } from "./resource-detail-navigation";
import { ResourceDetailPanel } from "./resource-detail-panel";
import { ResourcePageSplitLayout } from "./resource-page-split-layout";
import { persistDetailOpenMode } from "./detail/detail-preferences";
import { createUiTranslator } from "./i18n";

const t = createUiTranslator("ui.resourcePage");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DetailNavigation = {
  prevHref: string | null;
  nextHref: string | null;
  currentIndex: number | null;
  totalCount: number | null;
};

export type ResourceDetailClientProps = {
  /** The detail record ID (null when no detail is selected). */
  detailId: string | null;
  /** Initial open/closed state from URL. */
  initialOpen: boolean;
  /** Initial layout mode from URL. */
  initialLayout: "full" | "peek";
  /** Title for the detail panel header. */
  detailTitle: string;
  /** The detail panel body content (fields, tabs, actions) rendered by the server. */
  detailBody: React.ReactNode;
  /** Prev/next navigation info. */
  navigation: DetailNavigation;
  /** Href to return to the list (removes detail_id from URL). */
  listHref: string;
  /** Table component to render alongside the detail. */
  table: React.ReactNode;
  /** Storage key for split layout width persistence. */
  splitLayoutStorageKey: string;
  /** App base path for ResourceDetailPanel. */
  appBasePath: string;
  /** Resource key used for persisted open-mode preference sync. */
  detailPreferenceResourceKey?: string | null;
  /** Test ID prefix. */
  testIdPrefix?: string | null;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ResourceDetailClient({
  detailId,
  initialOpen,
  initialLayout,
  detailTitle,
  detailBody,
  navigation,
  listHref,
  table,
  splitLayoutStorageKey,
  appBasePath,
  detailPreferenceResourceKey,
  testIdPrefix,
}: ResourceDetailClientProps) {
  const [detailOpen, setDetailOpen] = React.useState(initialOpen);
  const [detailLayout, setDetailLayout] = React.useState<"full" | "peek">(
    initialLayout
  );
  const previousInitialLayoutRef = React.useRef(initialLayout);

  // Sync from server props when they change (e.g. browser back/forward + RSC)
  React.useEffect(() => {
    setDetailOpen(initialOpen);
  }, [detailId, initialOpen]);

  React.useEffect(() => {
    if (previousInitialLayoutRef.current === initialLayout) return;
    previousInitialLayoutRef.current = initialLayout;
    setDetailLayout(initialLayout);
  }, [initialLayout]);

  const detailToggleTestId = testIdPrefix
    ? `${testIdPrefix}-detail-toggle`
    : undefined;
  const detailHiddenTestId = testIdPrefix
    ? `${testIdPrefix}-detail-hidden`
    : undefined;
  const detailHiddenToggleTestId = testIdPrefix
    ? `${testIdPrefix}-detail-hidden-toggle`
    : undefined;

  // ---------------------------------------------------------------------------
  // URL sync helper
  // ---------------------------------------------------------------------------

  const syncUrl = React.useCallback(
    (updates: Record<string, string | null>) => {
      if (typeof window === "undefined") return;
      const url = new URL(window.location.href);
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) {
          url.searchParams.delete(key);
        } else {
          url.searchParams.set(key, value);
        }
      }
      window.history.replaceState(
        window.history.state,
        "",
        url.pathname + url.search
      );
    },
    []
  );

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleToggleOpen = React.useCallback(() => {
    const next = !detailOpen;
    setDetailOpen(next);
    syncUrl({ detail_open: next ? "1" : "0" });
  }, [detailOpen, syncUrl]);

  const handleToggleLayout = React.useCallback(() => {
    const next = detailLayout === "full" ? "peek" : "full";
    setDetailLayout(next);
    if (detailPreferenceResourceKey) {
      persistDetailOpenMode(detailPreferenceResourceKey, next);
    }
    if (next === "full") {
      syncUrl({ detail_layout: "full" });
    } else {
      syncUrl({ detail_layout: null });
    }
  }, [detailLayout, detailPreferenceResourceKey, syncUrl]);

  const handleBackToList = React.useCallback(() => {
    if (typeof window === "undefined") return;
    setDetailOpen(false);
    window.history.replaceState(window.history.state, "", listHref);
  }, [listHref]);

  // ---------------------------------------------------------------------------
  // No detail selected — just render the table
  // ---------------------------------------------------------------------------

  if (!detailId) {
    return table;
  }

  // ---------------------------------------------------------------------------
  // Detail panel header controls
  // ---------------------------------------------------------------------------

  const headerControls = (
    <div className="sticky top-0 z-20 -mx-1 flex items-center justify-between gap-2 border-b border-ui-border/30 bg-ui-paper/95 px-1 pb-3 pt-1 text-xs backdrop-blur supports-[backdrop-filter]:bg-ui-paper/85">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-2 text-ui-muted hover:text-ui-ink"
          onClick={handleBackToList}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12.5 4L7 10l5.5 6" />
          </svg>
          <span className="whitespace-nowrap">{t("detail.backToList")}</span>
        </button>
        <span className="hidden max-w-[14rem] truncate text-[11px] text-ui-muted sm:inline">
          {detailTitle}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <ResourceDetailNavigation
          prevHref={navigation.prevHref}
          nextHref={navigation.nextHref}
          currentIndex={navigation.currentIndex}
          totalCount={navigation.totalCount}
          appBasePath={appBasePath}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 min-h-0 border border-ui-border/40 bg-ui-paper/80 px-2.5 py-1 text-[11px]"
          onClick={handleToggleLayout}
        >
          {detailLayout === "full"
            ? t("detail.openPeek")
            : t("detail.openFull")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 min-h-0 border border-ui-border/40 bg-ui-paper/80 px-2.5 py-1 text-[11px]"
          onClick={handleToggleOpen}
          data-testid={detailToggleTestId}
        >
          {t("detail.toggleHide")}
        </Button>
      </div>
    </div>
  );

  // ---------------------------------------------------------------------------
  // Combined detail panel body (header + server-rendered content)
  // ---------------------------------------------------------------------------

  const detailPanelBody = detailOpen ? (
    <div className="space-y-3">
      {headerControls}
      {detailBody}
    </div>
  ) : null;

  // ---------------------------------------------------------------------------
  // Collapsed bar (shown when detail is selected but hidden)
  // ---------------------------------------------------------------------------

  const collapsedBar =
    detailId && !detailOpen ? (
      <div
        className="flex items-center justify-between gap-3 rounded-md border border-ui-border/20 px-3 py-2 text-xs text-ui-muted"
        data-testid={detailHiddenTestId}
      >
        <button
          type="button"
          className="text-ui-muted transition hover:text-ui-ink"
          onClick={handleToggleOpen}
          data-testid={detailHiddenToggleTestId}
        >
          {t("detail.toggleShow")}
        </button>
      </div>
    ) : null;

  // ---------------------------------------------------------------------------
  // Full layout mode — detail above table
  // ---------------------------------------------------------------------------

  const showFullDetail = detailOpen && detailLayout === "full";

  if (showFullDetail) {
    return (
      <div className="space-y-4">
        <div className="overflow-auto rounded-md border border-ui-border/20 p-4">
          {detailPanelBody}
        </div>
        {table}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Peek layout mode — side-by-side split layout
  // ---------------------------------------------------------------------------

  return (
    <ResourcePageSplitLayout
      enabled={Boolean(detailOpen && detailPanelBody)}
      storageKey={splitLayoutStorageKey}
      testIdPrefix={testIdPrefix}
      table={
        <div className="space-y-4">
          {collapsedBar}
          {table}
        </div>
      }
      detail={
        detailPanelBody ? (
          <ResourceDetailPanel
            open={detailOpen}
            title={detailTitle}
            onClose={handleToggleOpen}
            appBasePath={appBasePath}
          >
            {detailPanelBody}
          </ResourceDetailPanel>
        ) : null
      }
    />
  );
}

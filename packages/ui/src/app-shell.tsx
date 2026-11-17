"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { getUiDefaults } from "@masarx/config";
import { Drawer, DrawerClose, DrawerContent } from "./drawer";
import { createUiTranslator } from "./i18n";
import {
  buildLegacyNavigationStorageKey,
  buildNavigationStorageKey,
  NavigationStateProvider,
  useNavigationState,
} from "./navigation-preferences";
import { isActivePath, type NavigationItem, type NavigationSection } from "./navigation";
import { useUiNavigation } from "./ui-navigation-context";
import { normalizePath } from "./navigation-paths";
import { reportUiEvent } from "./reporting";
import { cn } from "./utils";
import { resolveSafeAppBasePath } from "./url-guard";

const uiDefaults = getUiDefaults();

type AppShellLayout = "full" | "contained";

type AppShellProps = {
  appName: string;
  children: React.ReactNode;
  sidebar?: React.ReactNode;
  layout?: AppShellLayout;
  layoutMaxWidth?: string;
  appKey?: string;
  userId?: string | null;
};

type AppShellLayoutProps = Omit<
  AppShellProps,
  "userId" | "layout" | "layoutMaxWidth"
> & {
  layout: AppShellLayout;
  layoutMaxWidth: string;
};

type BreadcrumbMatch = {
  section: NavigationSection;
  trail: NavigationItem[];
} | null;

function buildBreadcrumbTrail({
  sections,
  pathname,
  basePath,
}: {
  sections: NavigationSection[];
  pathname: string;
  basePath?: string;
}): BreadcrumbMatch {
  const safeBasePath = resolveSafeAppBasePath(basePath ?? "");
  let best: { score: number; section: NavigationSection; trail: NavigationItem[] } | null = null;
  const normalizedBasePath = safeBasePath ?? undefined;
  const normalizedPathname = normalizePath(pathname, normalizedBasePath);

  const walk = ({
    section,
    items,
    trail,
  }: {
    section: NavigationSection;
    items: NavigationItem[];
    trail: NavigationItem[];
  }) => {
    for (const item of items) {
      const hasLabel = Boolean(item.label?.trim());
      const nextTrail = hasLabel ? [...trail, item] : trail;
      if (
        item.href &&
        isActivePath(normalizedPathname, item.href, normalizedBasePath)
      ) {
        const score = normalizePath(item.href, normalizedBasePath).length;
        if (!best || score > best.score) {
          best = { score, section, trail: nextTrail };
        }
      }
      if (Array.isArray(item.items) && item.items.length > 0) {
        walk({ section, items: item.items, trail: nextTrail });
      }
    }
  };

  for (const section of sections) {
    walk({ section, items: section.items, trail: [] });
  }

  return best;
}

function AppShellBreadcrumbs() {
  const navigation = useUiNavigation();
  const pathname = usePathname();

  const sections = navigation?.sections ?? [];
  const basePath = navigation?.basePath;
  const match = React.useMemo<BreadcrumbMatch>(() => {
    if (!pathname || sections.length === 0) return null;
    return buildBreadcrumbTrail({ sections, pathname, basePath });
  }, [basePath, pathname, sections]);

  if (!match) return null;
  if (match.trail.length === 0) return null;

  const crumbs = match.trail.filter((item) => item.label?.trim());
  if (crumbs.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" data-testid="app-shell-breadcrumbs">
      <ol className="flex flex-wrap items-center gap-1 text-[11px] font-medium text-ui-muted">
        <li className="truncate">{match.section.label}</li>
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          const separator = (
            <span className="px-1 text-ui-muted/60" aria-hidden>
              /
            </span>
          );
          const content = isLast ? (
            <span className="truncate text-ui-ink">{crumb.label}</span>
          ) : crumb.href ? (
            <a
              href={crumb.href}
              className="truncate transition hover:text-ui-ink"
            >
              {crumb.label}
            </a>
          ) : (
            <span className="truncate">{crumb.label}</span>
          );

          return (
            <React.Fragment key={crumb.id}>
              <li aria-hidden>{separator}</li>
              <li className="max-w-[220px]">{content}</li>
            </React.Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

function AppShellLayout({
  appName,
  children,
  sidebar,
  layout,
  layoutMaxWidth,
  appKey,
}: AppShellLayoutProps) {
  const t = createUiTranslator("ui.appShell");
  const navT = createUiTranslator("ui.navigation");
  const {
    sidebarCollapsed,
    toggleSidebarCollapsed,
    hydrated,
    layoutMode,
    toggleLayoutMode,
  } =
    useNavigationState();
  const layoutModeOptions = Array.isArray(uiDefaults.layout.modeOptions)
    ? uiDefaults.layout.modeOptions
    : [];
  const resolvedLayoutOptions =
    layoutModeOptions.length > 0 ? layoutModeOptions : ["full", "contained"];
  const activeLayout = resolvedLayoutOptions.includes(layoutMode ?? layout)
    ? (layoutMode ?? layout)
    : resolvedLayoutOptions[0] ?? layout;
  const canToggleLayout = resolvedLayoutOptions.length > 1;
  const telemetryContext = appKey ?? appName;
  const testIdPrefix = appKey ?? "app";
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const layoutStyle = {
    "--ui-layout-max-width":
      activeLayout === "contained" ? layoutMaxWidth : "100%",
  } as React.CSSProperties;
  const navToggleLabel = sidebarCollapsed
    ? navT("expandLabel")
    : navT("collapseLabel");
  const navToggleAria = sidebarCollapsed
    ? navT("expandAria")
    : navT("collapseAria");
  const layoutToggleLabel =
    activeLayout === "contained"
      ? t("layoutFullLabel")
      : t("layoutContainedLabel");
  const layoutToggleAria =
    activeLayout === "contained"
      ? t("layoutFullAria")
      : t("layoutContainedAria");
  const handleSidebarToggle = React.useCallback(() => {
    const nextState = sidebarCollapsed ? "expanded" : "collapsed";
    toggleSidebarCollapsed();
    reportUiEvent({
      type: "ui.navigation.sidebar.toggle",
      timestamp: new Date().toISOString(),
      context: telemetryContext,
      name: nextState,
    });
  }, [sidebarCollapsed, telemetryContext, toggleSidebarCollapsed]);
  const handleLayoutToggle = React.useCallback(() => {
    if (!canToggleLayout) return;
    const nextLayout = activeLayout === "contained" ? "full" : "contained";
    toggleLayoutMode();
    reportUiEvent({
      type: "ui.layout.mode.toggle",
      timestamp: new Date().toISOString(),
      context: telemetryContext,
      name: nextLayout,
    });
  }, [activeLayout, canToggleLayout, telemetryContext, toggleLayoutMode]);
  const sidebarContent = sidebar ? (
    sidebar
  ) : (
    <>
      <div className="text-lg font-semibold">{appName}</div>
      <div className="mt-3 text-sm text-ui-muted">{t("sidebarHint")}</div>
    </>
  );

  const showMainToggles = canToggleLayout || Boolean(sidebarContent);

  return (
    <div
      className="relative h-screen overflow-hidden bg-ui-paper text-ui-ink"
      style={layoutStyle}
    >
      <nav aria-label={t("skipToContent")}>
        <a
          href="#main-content"
          className="sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-ui-surface focus:px-3 focus:py-2 focus:text-sm focus:text-ui-ink focus:shadow-soft focus:outline-none"
        >
          {t("skipToContent")}
        </a>
      </nav>
      <Drawer open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <DrawerContent side="left" className="max-w-xs">
          <div className="flex items-center justify-between gap-3">
            <div className="text-base font-semibold text-ui-ink">{appName}</div>
            <DrawerClose asChild>
              <button
                type="button"
                className="rounded-md border border-ui-border px-3 py-1.5 text-xs font-medium text-ui-muted transition hover:text-ui-ink"
                aria-label={navT("closeMobileAria")}
                data-testid={`${testIdPrefix}-app-shell-mobile-close`}
              >
                {navT("closeMobileLabel")}
              </button>
            </DrawerClose>
          </div>
          <div className="mt-4 space-y-4">{sidebarContent}</div>
        </DrawerContent>
      </Drawer>
      <div
        className={cn(
          "relative mx-auto flex h-full w-full flex-col gap-6 px-4 py-6 lg:flex-row lg:gap-0 lg:px-0 lg:py-0",
          activeLayout === "contained"
            ? "max-w-[var(--ui-layout-max-width)]"
            : "max-w-none"
        )}
      >
        <div className="flex items-center justify-between gap-3 lg:hidden">
          <div className="text-sm font-semibold text-ui-ink">{appName}</div>
          <button
            type="button"
            className="min-h-[44px] rounded-lg border border-ui-border/60 bg-ui-highlight/50 px-3 text-xs font-medium text-ui-muted transition hover:bg-ui-highlight hover:text-ui-ink"
            onClick={() => setMobileNavOpen(true)}
            aria-label={navT("openMobileAria")}
            data-testid={`${testIdPrefix}-app-shell-mobile-open`}
          >
            {navT("openMobileLabel")}
          </button>
        </div>
        <aside
          className={cn(
            "hidden shrink-0 bg-ui-paper lg:block lg:transition-all",
            sidebarCollapsed
              ? "lg:w-0 lg:overflow-hidden lg:opacity-0 lg:pointer-events-none"
              : "lg:w-72 lg:border-r lg:border-ui-border/70"
          )}
          aria-hidden={sidebarCollapsed || undefined}
          data-testid={`${testIdPrefix}-app-shell-sidebar`}
        >
          <div
            className={cn(
              "lg:h-full lg:overflow-y-auto motion-safe:animate-fade-in",
              !hydrated && "opacity-0"
            )}
          >
            <div className="flex items-center justify-between gap-3 border-b border-ui-accent/20 bg-ui-highlight/30 px-4 py-4">
              <div className="text-sm font-semibold text-ui-ink">{appName}</div>
              <div className="flex items-center gap-2">
                {canToggleLayout ? (
                  <button
                    type="button"
                    className="rounded-md border border-ui-border/60 bg-ui-highlight/40 px-2 py-1 text-[11px] font-medium text-ui-muted transition hover:bg-ui-highlight hover:text-ui-ink"
                    onClick={handleLayoutToggle}
                    aria-label={layoutToggleAria}
                    data-testid={`${testIdPrefix}-app-shell-layout-toggle`}
                  >
                    {layoutToggleLabel}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="rounded-md border border-ui-border px-2 py-1 text-[11px] font-medium text-ui-muted transition hover:text-ui-ink"
                  onClick={handleSidebarToggle}
                  aria-label={navToggleAria}
                  data-testid={`${testIdPrefix}-app-shell-sidebar-toggle`}
                >
                  {navToggleLabel}
                </button>
              </div>
            </div>
            <div className="space-y-4 px-4 py-4">{sidebarContent}</div>
          </div>
        </aside>
        <main
          id="main-content"
          tabIndex={-1}
          className={cn(
            "flex-1 min-w-0 min-h-0 flex flex-col rounded-xl bg-ui-surface p-6 shadow-soft motion-safe:animate-fade-up lg:rounded-none lg:shadow-none lg:p-10"
          )}
        >
          <div className="mb-4 shrink-0 flex items-center justify-between gap-3 rounded-lg bg-ui-highlight/30 border-b border-b-ui-accent/20 px-3 pb-3 pt-2">
            <AppShellBreadcrumbs />
            {showMainToggles ? (
              <div className="hidden items-center gap-2 lg:flex">
                <button
                  type="button"
                  className="rounded-lg border border-ui-border/60 bg-ui-highlight/50 px-3 py-1.5 text-xs font-medium text-ui-muted transition hover:bg-ui-highlight hover:text-ui-ink"
                  onClick={handleSidebarToggle}
                  aria-label={navToggleAria}
                  data-testid={`${testIdPrefix}-app-shell-sidebar-toggle-main`}
                >
                  {navToggleLabel}
                </button>
                {canToggleLayout ? (
                  <button
                    type="button"
                    className="rounded-lg border border-ui-border/60 bg-ui-highlight/50 px-3 py-1.5 text-xs font-medium text-ui-muted transition hover:bg-ui-highlight hover:text-ui-ink"
                    onClick={handleLayoutToggle}
                    aria-label={layoutToggleAria}
                    data-testid={`${testIdPrefix}-app-shell-layout-toggle-main`}
                  >
                    {layoutToggleLabel}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="flex-1 min-w-0 min-h-0 overflow-y-auto overflow-x-hidden">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * Application shell with sidebar, skip link, and layout-aware content container.
 */
export function AppShell({
  appName,
  children,
  sidebar,
  layout,
  layoutMaxWidth,
  appKey = "app",
  userId,
}: AppShellProps) {
  const navigationDefaults = uiDefaults.navigation;
  const resolvedLayout = layout ?? uiDefaults.layout.mode;
  const resolvedLayoutMaxWidth = layoutMaxWidth ?? uiDefaults.layout.maxWidth;
  const resolvedLayoutOptions = Array.isArray(uiDefaults.layout.modeOptions)
    ? uiDefaults.layout.modeOptions
    : [];
  const storageKey = buildNavigationStorageKey(appKey, userId);
  const legacyStorageKey = buildLegacyNavigationStorageKey(appKey, userId);
  return (
    <NavigationStateProvider
      storageKey={storageKey}
      legacyStorageKey={legacyStorageKey}
      maxFavorites={navigationDefaults.maxFavorites}
      maxRecents={navigationDefaults.maxRecents}
      defaultSidebarCollapsed={navigationDefaults.sidebarCollapsed}
      defaultCollapsedSections={navigationDefaults.collapsedSections}
      defaultLayoutMode={resolvedLayout}
      layoutModeOptions={
        resolvedLayoutOptions.length > 0
          ? resolvedLayoutOptions
          : [resolvedLayout]
      }
    >
      <AppShellLayout
        appName={appName}
        children={children}
        sidebar={sidebar}
        layout={resolvedLayout}
        layoutMaxWidth={resolvedLayoutMaxWidth}
        appKey={appKey}
      />
    </NavigationStateProvider>
  );
}

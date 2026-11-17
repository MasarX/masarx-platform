"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { getUiDefaults } from "@masarx/config";
import { createUiTranslator } from "./i18n";
const CommandPalette = React.lazy(() =>
  import("./command-palette").then((mod) => ({ default: mod.CommandPalette }))
);
import {
  formatShortcutLabel,
  isEditableTarget,
  matchesShortcut,
} from "./keyboard-shortcuts";
import {
  Navigation,
  NavigationItem,
  NavigationSection,
  isActivePath,
} from "./navigation";
import { normalizeBasePath, stripBasePath } from "./navigation-paths";
import {
  buildLegacyNavigationStorageKey,
  buildNavigationStorageKey,
  useNavigationState,
} from "./navigation-preferences";
import { reportUiEvent } from "./reporting";
import { useReadRegistry } from "./read-registry-client";
import { labelFromKey } from "./resource-query";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import {
  flattenNavigationSections,
  normalizeNavigationSections,
} from "./navigation-utils";
import { resolveSafeAppBasePath } from "./url-guard";

type NavigationNextProps = {
  sections: NavigationSection[];
  appKey?: string;
  userId?: string | null;
  basePath?: string;
  onNavigate?: (item: NavigationItem) => void;
  capabilities?: string[] | null;
};

const uiDefaults = getUiDefaults();

/**
 * Next.js navigation wrapper that renders sections via Navigation.
 */
export function NavigationNext({
  sections,
  appKey = "app",
  userId,
  basePath,
  onNavigate,
  capabilities,
}: NavigationNextProps) {
  const t = createUiTranslator("ui.navigation");
  const pathname = usePathname();
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const navigationDefaults = uiDefaults.navigation;
  const testIdPrefix = appKey ?? "app";
  const safeBasePath = React.useMemo(
    () => resolveSafeAppBasePath(basePath ?? ""),
    [basePath]
  );
  const capabilitySet = React.useMemo(
    () => resolveCapabilitySet(capabilities),
    [capabilities]
  );
  const normalizedSections = React.useMemo(
    () => normalizeNavigationSections(sections, safeBasePath ?? undefined),
    [sections, safeBasePath]
  );
  const shouldUseFallback = normalizedSections.length === 0;
  const { data: readRegistry } = useReadRegistry({
    enabled: shouldUseFallback && Boolean(userId),
  });
  const fallbackSections = React.useMemo(() => {
    if (!shouldUseFallback) return [];
    const resources = Array.isArray(readRegistry?.resources)
      ? readRegistry.resources
      : [];
    if (!resources.length) return [];
    const basePrefix = normalizeBasePath(safeBasePath ?? undefined);
    const items = resources.reduce<NavigationItem[]>((acc, resource) => {
      const key = resource.key?.trim();
      if (!key) return acc;
      const label =
        typeof resource.label === "string" && resource.label.trim()
          ? resource.label.trim()
          : labelFromKey(key);
      const href = stripBasePath(
        `${basePrefix}/resources/${key}`,
        safeBasePath ?? undefined
      );
      acc.push({
        id: `resource-${key}`,
        label,
        href,
        resource: key,
        capability: resource.capability_read ?? null,
      });
      return acc;
    }, []);
    items.sort((a, b) => a.label.localeCompare(b.label));
    if (items.length === 0) return [];
    return [
      {
        id: "registry-resources",
        label: t("fallbackResourcesLabel"),
        items,
      },
    ] satisfies NavigationSection[];
  }, [readRegistry, safeBasePath, shouldUseFallback, t]);
  const sourceSections =
    fallbackSections.length > 0 ? fallbackSections : normalizedSections;
  const resolvedSections = React.useMemo(() => {
    const applyCapabilityGate = (items: NavigationItem[]): NavigationItem[] =>
      items.map((item) => {
        const nestedItems = Array.isArray(item.items)
          ? applyCapabilityGate(item.items)
          : item.items;
        const requiredCapability = item.capability?.trim() ?? "";
        const capabilityAllowed = hasCapability(capabilitySet, requiredCapability);
        const disabledReason =
          item.disabled_reason ??
          (!capabilityAllowed
            ? t("disabled.missingCapability", {
                capability: requiredCapability,
              })
            : null);
        if (
          nestedItems === item.items &&
          disabledReason === item.disabled_reason
        ) {
          return item;
        }
        return {
          ...item,
          items: nestedItems ?? null,
          disabled_reason: disabledReason,
        };
      });
    return sourceSections.map((section) => {
      const nextItems = applyCapabilityGate(section.items);
      return nextItems === section.items
        ? section
        : { ...section, items: nextItems };
    });
  }, [capabilitySet, sourceSections, t]);
  const storageKey = buildNavigationStorageKey(appKey, userId);
  const legacyStorageKey = buildLegacyNavigationStorageKey(appKey, userId);
  const {
    favorites,
    recents,
    sidebarCollapsed,
    collapsedSections,
    setCollapsedSections,
    toggleSectionCollapsed,
    toggleSidebarCollapsed,
    toggleFavorite,
    recordRecent,
  } = useNavigationState({
    storageKey,
    legacyStorageKey,
    maxFavorites: navigationDefaults.maxFavorites,
    maxRecents: navigationDefaults.maxRecents,
    defaultSidebarCollapsed: navigationDefaults.sidebarCollapsed,
    defaultCollapsedSections: navigationDefaults.collapsedSections,
    defaultLayoutMode: uiDefaults.layout.mode,
  });

  const flatItems = React.useMemo(
    () => flattenNavigationSections(resolvedSections),
    [resolvedSections]
  );
  const itemLookup = React.useMemo(() => {
    const lookup = new Map<string, NavigationItem>();
    flatItems.forEach(({ item }) => {
      lookup.set(item.id, item);
    });
    return lookup;
  }, [flatItems]);

  const favoriteItems = React.useMemo(
    () =>
      favorites
        .map((id) => itemLookup.get(id))
        .filter((item): item is NavigationItem => Boolean(item?.href)),
    [favorites, itemLookup]
  );
  const recentItems = React.useMemo(
    () =>
      recents
        .map((id) => itemLookup.get(id))
        .filter((item): item is NavigationItem => Boolean(item?.href)),
    [recents, itemLookup]
  );

  const navigationSections = React.useMemo(() => {
    const extraSections: NavigationSection[] = [];
    if (favoriteItems.length > 0) {
      extraSections.push({
        id: "favorites",
        label: t("favoritesLabel"),
        items: favoriteItems,
      });
    }
    if (recentItems.length > 0) {
      extraSections.push({
        id: "recents",
        label: t("recentsLabel"),
        items: recentItems,
      });
    }
    return [...extraSections, ...resolvedSections];
  }, [favoriteItems, recentItems, resolvedSections, t]);

  const activeSectionIds = React.useMemo(() => {
    const activeIds = new Set<string>();
    const walkItems = (items: NavigationItem[], sectionId: string) => {
      items.forEach((item) => {
        if (
          item.href &&
          isActivePath(pathname, item.href ?? undefined, safeBasePath ?? undefined)
        ) {
          activeIds.add(sectionId);
        }
        if (Array.isArray(item.items) && item.items.length > 0) {
          walkItems(item.items, sectionId);
        }
      });
    };
    navigationSections.forEach((section) => {
      walkItems(section.items, section.id);
    });
    return Array.from(activeIds);
  }, [navigationSections, pathname, safeBasePath]);

  React.useEffect(() => {
    if (!activeSectionIds.length) return;
    const next = collapsedSections.filter(
      (sectionId) => !activeSectionIds.includes(sectionId)
    );
    if (next.length !== collapsedSections.length) {
      setCollapsedSections(next);
    }
  }, [activeSectionIds, collapsedSections, setCollapsedSections]);

  const handleNavigate = React.useCallback(
    (item: NavigationItem) => {
      recordRecent(item.id);
      onNavigate?.(item);
    },
    [onNavigate, recordRecent]
  );

  const reportNavEvent = React.useCallback(
    (type: string, name?: string) => {
      reportUiEvent({
        type,
        timestamp: new Date().toISOString(),
        context: appKey,
        name,
      });
    },
    [appKey]
  );

  const handleToggleFavorite = React.useCallback(
    (item: NavigationItem) => {
      toggleFavorite(item.id);
      reportNavEvent("ui.navigation.favorite.toggle", item.id);
    },
    [reportNavEvent, toggleFavorite]
  );

  const sectionIds = React.useMemo(
    () => navigationSections.map((section) => section.id),
    [navigationSections]
  );
  const nonNavigationCollapsed = React.useMemo(() => {
    if (!Array.isArray(collapsedSections) || collapsedSections.length === 0) {
      return [];
    }
    if (sectionIds.length === 0) return collapsedSections;
    const sectionIdSet = new Set(sectionIds);
    return collapsedSections.filter((id) => !sectionIdSet.has(id));
  }, [collapsedSections, sectionIds]);
  const handleSidebarShortcut = React.useCallback(() => {
    const nextState = sidebarCollapsed ? "expanded" : "collapsed";
    toggleSidebarCollapsed();
    reportNavEvent("ui.navigation.sidebar.toggle", nextState);
  }, [reportNavEvent, sidebarCollapsed, toggleSidebarCollapsed]);
  const handleCollapseAll = React.useCallback(() => {
    const next = Array.from(new Set([...nonNavigationCollapsed, ...sectionIds]));
    setCollapsedSections(next);
    reportNavEvent("ui.navigation.section.collapse_all");
  }, [nonNavigationCollapsed, reportNavEvent, sectionIds, setCollapsedSections]);
  const handleExpandAll = React.useCallback(() => {
    setCollapsedSections(nonNavigationCollapsed);
    reportNavEvent("ui.navigation.section.expand_all");
  }, [nonNavigationCollapsed, reportNavEvent, setCollapsedSections]);
  const handleSectionToggle = React.useCallback(
    (sectionId: string) => {
      toggleSectionCollapsed(sectionId);
      reportNavEvent("ui.navigation.section.toggle", sectionId);
    },
    [reportNavEvent, toggleSectionCollapsed]
  );

  React.useEffect(() => {
    const shortcut = navigationDefaults.toggleShortcut;
    if (!shortcut || typeof window === "undefined") return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (!matchesShortcut(event, shortcut)) return;
      event.preventDefault();
      handleSidebarShortcut();
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [handleSidebarShortcut, navigationDefaults.toggleShortcut]);

  const commandPaletteShortcut = navigationDefaults.commandPaletteShortcut;
  const commandShortcutLabel = commandPaletteShortcut
    ? formatShortcutLabel(commandPaletteShortcut)
    : "";

  React.useEffect(() => {
    if (!commandPaletteShortcut || typeof window === "undefined") return;
    const handlePaletteShortcut = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (!matchesShortcut(event, commandPaletteShortcut)) return;
      event.preventDefault();
      setPaletteOpen(true);
    };
    window.addEventListener("keydown", handlePaletteShortcut);
    return () => window.removeEventListener("keydown", handlePaletteShortcut);
  }, [commandPaletteShortcut]);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-md border border-ui-accent/25 bg-ui-highlight/60 px-3 py-2 text-sm text-ui-muted shadow-sm transition hover:bg-ui-highlight hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper"
          onClick={() => setPaletteOpen(true)}
          aria-label={t("commandPaletteAria")}
          data-testid={`${testIdPrefix}-navigation-command-palette`}
        >
          <span className="truncate">{t("searchPlaceholder")}</span>
          {commandShortcutLabel ? (
            <span className="rounded border border-ui-accent/20 bg-ui-accent-soft/20 px-2 py-0.5 text-[10px] text-ui-accent">
              {commandShortcutLabel}
            </span>
          ) : null}
        </button>
        {navigationSections.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-ui-muted">
            <button
              type="button"
              className="rounded px-2 py-1 font-medium text-ui-muted transition hover:text-ui-ink"
              onClick={handleExpandAll}
              data-testid={`${testIdPrefix}-navigation-expand-all`}
            >
              {t("expandAllLabel")}
            </button>
            <button
              type="button"
              className="rounded px-2 py-1 font-medium text-ui-muted transition hover:text-ui-ink"
              onClick={handleCollapseAll}
              data-testid={`${testIdPrefix}-navigation-collapse-all`}
            >
              {t("collapseAllLabel")}
            </button>
          </div>
        ) : null}
      </div>
      <Navigation
        sections={navigationSections}
        activeHref={pathname}
        basePath={safeBasePath ?? undefined}
        favorites={favorites}
        collapsedSections={collapsedSections}
        renderLink={(item, options, content) => (
          <Link
            href={item.href ?? "#"}
            className={options.className}
            aria-current={options.active ? "page" : undefined}
            onClick={options.onNavigate}
          >
            {content}
          </Link>
        )}
        onToggleSection={handleSectionToggle}
        onToggleFavorite={handleToggleFavorite}
        onNavigate={handleNavigate}
      />
      {paletteOpen ? (
        <React.Suspense fallback={null}>
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            appKey={appKey}
            appBasePath={safeBasePath ?? undefined}
            navigationSections={resolvedSections}
            favorites={favorites}
            recents={recents}
            onRecordRecent={recordRecent}
            capabilities={capabilities}
            shortcut={commandPaletteShortcut}
          />
        </React.Suspense>
      ) : null}
    </div>
  );
}

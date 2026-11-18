"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { UiCommandDefinition } from "@masarx/api";
import { getPublicConfig } from "@masarx/config";
import { Input } from "./input";
import { createUiTranslator, resolveRowDisplayText } from "./i18n";
import { Modal, ModalContent, ModalDescription, ModalHeader, ModalTitle } from "./modal";
import { resolveCommandHrefForRouter, resolveCommandReadState, formatCommandBackendReference } from "./command-utils";
import { useCommandRegistry } from "./command-registry-client";
import { useReadRegistry } from "./read-registry-client";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import type { NavigationSection } from "./navigation";
import { flattenNavigationSections } from "./navigation-utils";
import { stripBasePath } from "./navigation-paths";
import { resolveSafeAppBasePath, resolveSafeHref } from "./url-guard";
import { reportUiEvent } from "./reporting";
import { cn, formatUiError } from "./utils";
import { fuzzyMatch } from "./fuzzy-match";
import { resolveNavigationDisabledReason } from "./navigation-disabled-reason";
import { formatShortcutLabel, isEditableTarget, matchesShortcut } from "./keyboard-shortcuts";

type CommandPaletteItem = {
  id: string;
  label: string;
  description?: string | null;
  href?: string | null;
  kind: "navigation" | "command";
  section?: string | null;
  capability?: string | null;
  disabledReason?: string | null;
  navigationId?: string | null;
  backendReference?: string;
};

type CommandPaletteProps = {
  organizationId?: string | null;
  userId?: string | null;
  scopeType?: string | null;
  scopeId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appKey?: string;
  appBasePath?: string;
  navigationSections: NavigationSection[];
  favorites: string[];
  recents: string[];
  onRecordRecent: (id: string) => void;
  capabilities?: string[] | null;
  shortcut?: string;
};

type CommandPaletteSection = {
  id: string;
  label: string;
  items: CommandPaletteItem[];
};

const highlightMatch = (label: string, query: string) => {
  if (!query) return label;
  const result = fuzzyMatch(label, query);
  if (!result || result.indices.length === 0) return label;
  const indexSet = new Set(result.indices);
  const parts: React.ReactNode[] = [];
  let i = 0;
  while (i < label.length) {
    if (indexSet.has(i)) {
      const start = i;
      while (i < label.length && indexSet.has(i)) i++;
      parts.push(
        <span key={start} className="rounded bg-ui-accent-soft px-0.5 text-ui-ink">
          {label.slice(start, i)}
        </span>
      );
    } else {
      const start = i;
      while (i < label.length && !indexSet.has(i)) i++;
      parts.push(label.slice(start, i));
    }
  }
  return <>{parts}</>;
};

const toSearchText = (value: string | null | undefined) =>
  value ? value.trim().toLowerCase() : "";

const selectionRequiresContext = (command: UiCommandDefinition) => {
  const mode = command.selection?.mode;
  if (!mode || mode === "none") return false;
  return true;
};

const resolveCommandLabel = (command: UiCommandDefinition) =>
  resolveRowDisplayText(command.label?.trim() || command.key, command.label_ar, getPublicConfig().locale);

export function CommandPalette({
  organizationId,
  userId,
  scopeType,
  scopeId,
  open,
  onOpenChange,
  appKey,
  appBasePath = "",
  navigationSections,
  favorites,
  recents,
  onRecordRecent,
  capabilities,
  shortcut,
}: CommandPaletteProps) {
  const t = createUiTranslator("ui.commandPalette");
  const router = useRouter();
  const safeBasePath = React.useMemo(
    () => resolveSafeAppBasePath(appBasePath ?? ""),
    [appBasePath]
  );
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const shortcutLabel = shortcut ? formatShortcutLabel(shortcut) : "";
  const testIdPrefix = appKey ?? "app";
  const capabilitySet = React.useMemo(
    () => resolveCapabilitySet(capabilities),
    [capabilities]
  );
  const { data: commandRegistry, isLoading, error: commandError } = useCommandRegistry({
    enabled: open,
  });

  const { data: readRegistry, error: readError, isLoading: readLoading } = useReadRegistry({ enabled: open, userId, scopeType, scopeId, organizationId });

  const navigationItems = React.useMemo(() => {
    const flattened = flattenNavigationSections(navigationSections);
    return flattened
      .filter(({ item }) => Boolean(item.href))
      .map(({ item, sectionLabel }) => {
        const capabilityAllowed = hasCapability(capabilitySet, item.capability);
        const href = typeof item.href === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(item.href.trim())
          ? resolveSafeHref("", item.href) : null;
        const disabledReason =
          (!href ? t("disabled.noTarget") : null) ??
          resolveNavigationDisabledReason(item.disabled_reason) ??
          (!capabilityAllowed ? t("disabled.missingCapability") : null);
        return {
          id: `nav-${item.id}`,
          navigationId: item.id,
          label: item.label,
          description: sectionLabel,
          href,
          kind: "navigation",
          section: sectionLabel,
          capability: item.capability ?? null,
          disabledReason,
        } satisfies CommandPaletteItem;
      });
  }, [capabilitySet, navigationSections, t]);

  const navigationLookup = React.useMemo(() => {
    const map = new Map<string, CommandPaletteItem>();
    navigationItems.forEach((item) => {
      if (item.navigationId) {
        map.set(item.navigationId, item);
      }
    });
    return map;
  }, [navigationItems]);

  const favoriteItems = React.useMemo(
    () =>
      favorites
        .map((id) => navigationLookup.get(id))
        .filter((item): item is CommandPaletteItem => Boolean(item)),
    [favorites, navigationLookup]
  );
  const recentItems = React.useMemo(
    () =>
      recents
        .map((id) => navigationLookup.get(id))
        .filter((item): item is CommandPaletteItem => Boolean(item)),
    [recents, navigationLookup]
  );

  const commandItems = React.useMemo(() => {
    const commands = Array.isArray(commandRegistry) ? commandRegistry : [];
    return commands
      .map((command) => {
        const href = resolveCommandHrefForRouter(command, appBasePath, appKey);
        const capabilityAllowed = hasCapability(
          capabilitySet,
          command.capability
        );
        const readState = resolveCommandReadState(command, readError ? null : readRegistry, capabilitySet);
        let disabledReason: string | null = null;
        if (commandError || isLoading) {
          disabledReason = t("disabled.commandUnavailable");
        } else if (!capabilityAllowed) {
          disabledReason = t("disabled.missingCapability");
        } else if (readState === "unavailable") {
          disabledReason = t("disabled.readUnavailable");
        } else if (readState === "denied") {
          disabledReason = t("disabled.readRequired");
        } else if (selectionRequiresContext(command)) {
          disabledReason = t("disabled.needsSelection");
        } else if (!href) {
          disabledReason = t("disabled.noTarget");
        }
        return {
          id: `cmd-${command.key}`,
          label: resolveCommandLabel(command),
          description: command.description ?? null,
          backendReference: formatCommandBackendReference(command),
          href,
          kind: "command",
          section: command.schema_category ?? null,
          capability: command.capability ?? null,
          disabledReason,
        } satisfies CommandPaletteItem;
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [appBasePath, appKey, capabilitySet, commandRegistry, commandError, isLoading, readRegistry, readError, t]);

  const filterItems = React.useCallback(
    (items: CommandPaletteItem[]) => {
      if (!normalizedQuery) return items;
      return items
        .map((item) => {
          const fields = [
            item.label,
            item.description ?? "",
            item.section ?? "",
            item.capability ?? "",
            item.backendReference ?? "",
          ];
          let bestScore = -Infinity;
          for (const field of fields) {
            const result = fuzzyMatch(field, normalizedQuery);
            if (result && result.score > bestScore) {
              bestScore = result.score;
            }
          }
          return bestScore > -Infinity ? { item, score: bestScore } : null;
        })
        .filter((entry): entry is { item: CommandPaletteItem; score: number } =>
          entry !== null
        )
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.item);
    },
    [normalizedQuery]
  );

  const sections = React.useMemo<CommandPaletteSection[]>(() => {
    const results: CommandPaletteSection[] = [];
    const navItems = filterItems(navigationItems);
    const cmdItems = filterItems(commandItems);
    if (normalizedQuery) {
      if (navItems.length) {
        results.push({
          id: "nav",
          label: t("sections.navigation"),
          items: navItems,
        });
      }
      if (cmdItems.length) {
        results.push({
          id: "commands",
          label: t("sections.commands"),
          items: cmdItems,
        });
      }
      return results;
    }
    if (favoriteItems.length) {
      results.push({
        id: "favorites",
        label: t("sections.favorites"),
        items: favoriteItems,
      });
    }
    if (recentItems.length) {
      results.push({
        id: "recents",
        label: t("sections.recents"),
        items: recentItems,
      });
    }
    if (navItems.length) {
      results.push({
        id: "nav",
        label: t("sections.navigation"),
        items: navItems,
      });
    }
    if (cmdItems.length) {
      results.push({
        id: "commands",
        label: t("sections.commands"),
        items: cmdItems,
      });
    }
    return results;
  }, [
    commandItems,
    favoriteItems,
    filterItems,
    navigationItems,
    normalizedQuery,
    recentItems,
    t,
  ]);

  const visibleItems = React.useMemo(
    () => sections.flatMap((section) => section.items),
    [sections]
  );

  const resolveNextEnabledIndex = React.useCallback(
    (start: number, delta: number) => {
      if (visibleItems.length === 0) return 0;
      let nextIndex = start;
      for (let i = 0; i < visibleItems.length; i += 1) {
        nextIndex = (nextIndex + delta + visibleItems.length) % visibleItems.length;
        const candidate = visibleItems[nextIndex];
        if (candidate && !candidate.disabledReason) {
          return nextIndex;
        }
      }
      return start;
    },
    [visibleItems]
  );

  React.useEffect(() => {
    if (!open) return;
    reportUiEvent({
      type: "ui.command_palette.open",
      timestamp: new Date().toISOString(),
      context: appKey,
    });
  }, [appKey, open]);

  React.useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    if (visibleItems.length === 0) {
      setActiveIndex(0);
      return;
    }
    setActiveIndex(resolveNextEnabledIndex(-1, 1));
  }, [open, normalizedQuery, resolveNextEnabledIndex, visibleItems.length]);

  React.useEffect(() => {
    if (!shortcut || typeof window === "undefined") return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (!matchesShortcut(event, shortcut)) return;
      event.preventDefault();
      onOpenChange(true);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [onOpenChange, shortcut]);

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      onOpenChange(next);
      if (!next) {
        setQuery("");
      }
    },
    [onOpenChange]
  );

  const handleSelect = React.useCallback(
    (item: CommandPaletteItem) => {
      if (!item.href || item.disabledReason || /^[a-z][a-z0-9+.-]*:/i.test(item.href.trim())) return;
      const href = resolveSafeHref("", item.href);
      if (!href) return;
      if (item.navigationId) {
        onRecordRecent(item.navigationId);
      }
      reportUiEvent({
        type: "ui.command_palette.execute",
        timestamp: new Date().toISOString(),
        context: item.kind,
        name: item.label,
      });
      handleOpenChange(false);
      router.push(stripBasePath(href, safeBasePath ?? undefined));
    },
    [handleOpenChange, onRecordRecent, router, safeBasePath]
  );

  const handleInputKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        handleOpenChange(false);
        return;
      }
      if (!visibleItems.length) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((prev) => resolveNextEnabledIndex(prev, 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((prev) => resolveNextEnabledIndex(prev, -1));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const selected = visibleItems[activeIndex];
        if (selected) {
          handleSelect(selected);
        }
      }
    },
    [activeIndex, handleOpenChange, handleSelect, resolveNextEnabledIndex, visibleItems]
  );

  const allBlocked = normalizedQuery && visibleItems.length > 0 && visibleItems.every((item) => item.disabledReason);
  const activeItem = visibleItems[activeIndex] ?? (allBlocked ? visibleItems[0] : undefined);
  return (
    <Modal open={open} onOpenChange={handleOpenChange}>
      <ModalContent
        className="max-w-2xl p-0"
        data-testid={`${testIdPrefix}-command-palette-modal`}
      >
        <ModalHeader className="sr-only">
          <ModalTitle>{t("title")}</ModalTitle>
          <ModalDescription>{t("description")}</ModalDescription>
        </ModalHeader>
        <div className="border-b border-ui-border px-5 py-4">
          <label className="sr-only" htmlFor="command-palette-search">
            {t("searchAria")}
          </label>
          <Input
            id="command-palette-search"
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchAria")}
            autoComplete="off"
            spellCheck={false}
            className="rounded-md border border-ui-border/60 bg-ui-highlight/60"
            data-testid={`${testIdPrefix}-command-palette-search`}
          />
          {shortcutLabel ? (
            <div className="mt-2 text-[11px] text-ui-muted">
              {t("shortcutHint", { shortcut: shortcutLabel })}
            </div>
          ) : null}
        </div>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
          {isLoading ? (
            <div role="status" aria-live="polite" aria-atomic="true" data-testid={`${testIdPrefix}-command-palette-loading`} className="rounded-lg border border-ui-border bg-ui-surface p-4 text-xs text-ui-muted">
              {t("loading")}
            </div>
          ) : null}
          {commandError ? (
            <div role="status" aria-live="polite" aria-atomic="true" data-testid={`${testIdPrefix}-command-palette-registry-error`}>
              {t("registryUnavailable")} {formatUiError(commandError, t("registryUnavailable"))}
            </div>
          ) : null}
          {readError || readLoading ? (
            <div role="status" aria-live="polite" aria-atomic="true" data-testid={`${testIdPrefix}-command-palette-read-registry-error`}>
              {t("disabled.readUnavailable")} {readError ? formatUiError(readError, t("disabled.readUnavailable")) : t("readLoading")}
            </div>
          ) : null}
          {allBlocked ? (
            <div role="status" aria-live="polite" aria-atomic="true" data-testid={`${testIdPrefix}-command-palette-blocked-results`}>
              {Array.from(new Set(visibleItems.map((item) => item.disabledReason))).join(" ")}
            </div>
          ) : null}
          {activeItem ? (
            <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid={`${testIdPrefix}-command-palette-active-readback`}>
              {activeItem.label} {t(activeItem.kind === "command" ? "labels.command" : "labels.navigation")} {activeItem.disabledReason}
              {activeItem.backendReference ? t("backendReference", { value: activeItem.backendReference }) : null}
            </div>
          ) : null}
          {!isLoading && !commandError && sections.length === 0 ? (
            <div className="rounded-lg border border-ui-border bg-ui-surface p-4 text-sm text-ui-muted">
              <div className="font-medium text-ui-ink">{t("emptyTitle")}</div>
              <p className="text-xs text-ui-muted">{t("emptyDescription")}</p>
            </div>
          ) : null}
          {sections.map((section) => (
            <div key={section.id} className="space-y-2">
              <div className="text-[11px] font-medium text-ui-muted">
                {section.label}
              </div>
              <div className="space-y-1">
                {section.items.map((item) => {
                  const isActive =
                    visibleItems[activeIndex]?.id === item.id && open;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelect(item)}
                      className={cn(
                        "flex w-full items-start justify-between gap-4 rounded-lg px-3 py-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-surface",
                        isActive && "bg-ui-highlight",
                        item.disabledReason
                          ? "cursor-not-allowed opacity-60"
                          : "hover:bg-ui-highlight/70 hover:text-ui-ink"
                      )}
                      aria-selected={isActive}
                      disabled={Boolean(item.disabledReason)}
                      data-testid={`${testIdPrefix}-command-palette-item-${item.id}`}
                    >
                      <div>
                        <div className="font-medium text-ui-ink">
                          {highlightMatch(item.label, normalizedQuery)}
                        </div>
                        {item.description ? (
                          <div className="text-xs text-ui-muted">
                            {item.description}
                          </div>
                        ) : null}
                        {item.backendReference ? <div className="text-xs text-ui-muted">{t("backendReference", { value: item.backendReference })}</div> : null}
                        {item.disabledReason ? (
                          <div className="mt-1 text-[11px] text-ui-muted">
                            {item.disabledReason}
                          </div>
                        ) : null}
                      </div>
                      <span className="text-[11px] font-medium text-ui-muted">
                        {item.kind === "command"
                          ? t("labels.command")
                          : t("labels.navigation")}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </ModalContent>
    </Modal>
  );
}

import * as React from "react";
import { cn } from "./utils";
import { createUiTranslator } from "./i18n";
import { normalizePath } from "./navigation-paths";
import { PinIcon } from "./icons";
import { resolveSafeAppBasePath } from "./url-guard";

export type NavigationItem = {
  id: string;
  label: string;
  href?: string | null;
  badge?: string | null;
  capability?: string | null;
  resource?: string | null;
  disabled_reason?: string | null;
  items?: NavigationItem[] | null;
};

export type NavigationSection = {
  id: string;
  label: string;
  items: NavigationItem[];
};

type RenderLinkOptions = {
  className: string;
  active: boolean;
  onNavigate?: () => void;
};

type RenderLabelOptions = {
  active: boolean;
};

type NavigationProps = {
  sections: NavigationSection[];
  activeHref?: string;
  basePath?: string;
  favorites?: string[];
  activeItemId?: string;
  collapsedSections?: string[];
  renderLink?: (item: NavigationItem, options: RenderLinkOptions, content: React.ReactNode) => React.ReactNode;
  renderLabel?: (item: NavigationItem, options: RenderLabelOptions) => React.ReactNode;
  onToggleFavorite?: (item: NavigationItem) => void;
  onNavigate?: (item: NavigationItem) => void;
  onToggleSection?: (sectionId: string) => void;
};

export function isActivePath(
  activeHref: string | undefined,
  href: string | null | undefined,
  basePath?: string
) {
  if (!activeHref || !href) return false;
  const safeBasePath = resolveSafeAppBasePath(basePath ?? "");
  const normalizedActive = normalizePath(activeHref, safeBasePath ?? undefined);
  const normalizedHref = normalizePath(href, safeBasePath ?? undefined);
  if (normalizedHref === "/") return normalizedActive === "/";
  return normalizedActive === normalizedHref || normalizedActive.startsWith(`${normalizedHref}/`);
}

function NavigationItemRow({
  item,
  activeHref,
  basePath,
  renderLink,
  renderLabel,
  favorites,
  activeItemId,
  onToggleFavorite,
  onNavigate,
  t,
  depth
}: {
  item: NavigationItem;
  activeHref?: string;
  basePath?: string;
  renderLink?: NavigationProps["renderLink"];
  renderLabel?: NavigationProps["renderLabel"];
  favorites?: string[];
  activeItemId?: string;
  onToggleFavorite?: NavigationProps["onToggleFavorite"];
  onNavigate?: NavigationProps["onNavigate"];
  t: ReturnType<typeof createUiTranslator>;
  depth: number;
}) {
  const isHighlighted = Boolean(activeItemId && item.id === activeItemId);
  const active = isActivePath(activeHref, item.href ?? undefined, basePath) || isHighlighted;
  const disabled = !item.href || Boolean(item.disabled_reason);
  const isFavorite = Boolean(favorites?.includes(item.id));
  const canToggleFavorite = Boolean(onToggleFavorite) && Boolean(item.href) && !disabled;
  const handleNavigate = onNavigate ? () => onNavigate(item) : undefined;
  const baseClass = cn(
    "group flex min-h-[40px] items-center justify-between gap-3 rounded-md px-3 py-1.5 text-sm transition-all duration-150",
    "border-s-[3px]",
    active
      ? "border-ui-accent bg-ui-accent-soft/40 text-ui-accent font-medium"
      : "border-transparent text-ui-muted hover:bg-ui-highlight/80 hover:text-ui-ink hover:border-s-ui-accent/20",
    disabled && "cursor-not-allowed text-ui-muted hover:bg-transparent",
    depth > 0 && "ms-3"
  );
  const linkClass = cn(
    "flex min-w-0 flex-1 items-center gap-2 text-left",
    disabled && "pointer-events-none"
  );
  const labelNode = (
    <span className="truncate">
      {renderLabel ? renderLabel(item, { active }) : item.label}
    </span>
  );
  const badgeNode = item.badge ? (
    <span className="rounded-full bg-ui-accent-soft/40 px-2 py-0.5 text-xs text-ui-accent">
      {item.badge}
    </span>
  ) : null;
  const favoriteActionLabel = isFavorite ? t("unpin") : t("pin");
  const favoriteActionAria = isFavorite
    ? t("unpinAria", { label: item.label })
    : t("pinAria", { label: item.label });
  const itemTestId = `navigation-item-${item.id}`;
  const favoriteButton = canToggleFavorite ? (
    <button
      type="button"
      className="min-h-[32px] min-w-[32px] rounded-md px-2 text-ui-muted opacity-100 transition hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100"
      aria-pressed={isFavorite}
      aria-label={favoriteActionAria}
      title={favoriteActionLabel}
      onClick={() => onToggleFavorite?.(item)}
      data-testid={`navigation-favorite-toggle-${item.id}`}
    >
      <PinIcon pressed={isFavorite} />
    </button>
  ) : null;
  const disabledReason = !disabled
    ? undefined
    : item.disabled_reason?.trim()
      ? item.disabled_reason.trim()
      : !item.href
        ? t("disabled.noRoute")
        : undefined;
  const content = (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      {labelNode}
      {disabledReason ? (
        <span className="text-[10px] text-ui-muted">{disabledReason}</span>
      ) : null}
    </div>
  );
  const actions = (
    <div className="flex items-center gap-2">
      {badgeNode}
      {favoriteButton}
    </div>
  );

  if (renderLink && item.href && !disabled) {
    return (
      <div
        className={baseClass}
        title={disabledReason}
        aria-disabled={disabled}
        data-testid={itemTestId}
      >
        {renderLink(item, { className: linkClass, active, onNavigate: handleNavigate }, content)}
        {actions}
      </div>
    );
  }

  if (item.href && !disabled) {
    return (
      <div
        className={baseClass}
        title={disabledReason}
        aria-disabled={disabled}
        data-testid={itemTestId}
      >
        <a
          className={linkClass}
          href={item.href}
          aria-current={active ? "page" : undefined}
          onClick={handleNavigate}
        >
          {content}
        </a>
        {actions}
      </div>
    );
  }

  return (
    <div
      className={baseClass}
      title={disabledReason}
      aria-disabled={disabled}
      data-testid={itemTestId}
    >
      {content}
      {actions}
    </div>
  );
}

/**
 * Navigation list grouped by sections with active state resolution.
 */
export function Navigation({
  sections,
  activeHref,
  basePath,
  favorites,
  activeItemId,
  collapsedSections,
  renderLink,
  renderLabel,
  onToggleFavorite,
  onNavigate,
  onToggleSection,
}: NavigationProps) {
  const t = createUiTranslator("ui.navigation");
  if (!sections || sections.length === 0) {
    return (
      <div
        className="rounded-lg border border-ui-border bg-ui-surface p-4 text-sm text-ui-muted"
        data-testid="navigation-pending"
      >
        <div className="space-y-2">
          <p className="text-[11px] font-medium text-ui-muted">
            {t("pendingLabel")}
          </p>
          <p className="text-sm text-ui-muted">
            {t("pendingDescription")}
          </p>
          <div className="text-xs text-ui-muted">
            <p className="font-medium text-ui-muted">{t("nextStepsTitle")}</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              <li>{t("nextStepsRefresh")}</li>
              <li>{t("nextStepsAccess")}</li>
              <li>{t("nextStepsConnectivity")}</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  const renderItems = (items: NavigationItem[], depth: number) => (
    items.map((item) => (
      <div key={item.id} className="space-y-1">
        <NavigationItemRow
          item={item}
          activeHref={activeHref}
          basePath={basePath}
          renderLink={renderLink}
          renderLabel={renderLabel}
          favorites={favorites}
          activeItemId={activeItemId}
          onToggleFavorite={onToggleFavorite}
          onNavigate={onNavigate}
          t={t}
          depth={depth}
        />
        {Array.isArray(item.items) && item.items.length > 0 ? renderItems(item.items, depth + 1) : null}
      </div>
    ))
  );

  return (
    <nav className="space-y-6" data-testid="navigation-list">
      {sections.map((section) => {
        const isCollapsed = Boolean(
          collapsedSections?.includes(section.id)
        );
        const contentId = `nav-section-${section.id}`;
        const toggleLabel = isCollapsed ? t("expandLabel") : t("collapseLabel");
        const toggleAria = isCollapsed
          ? t("expandSectionAria", { section: section.label })
          : t("collapseSectionAria", { section: section.label });

        return (
          <div
            key={section.id}
            className="space-y-2"
            data-testid={`navigation-section-${section.id}`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-medium text-ui-muted rounded px-2 py-1 bg-ui-accent-soft/[0.12]">
                {section.label}
              </div>
              {onToggleSection ? (
                <button
                  type="button"
                  className="rounded px-2 py-1 text-[11px] font-medium text-ui-muted transition hover:text-ui-ink"
                  aria-expanded={!isCollapsed}
                  aria-controls={contentId}
                  aria-label={toggleAria}
                  onClick={() => onToggleSection(section.id)}
                  data-testid={`navigation-section-toggle-${section.id}`}
                >
                  {toggleLabel}
                </button>
              ) : null}
            </div>
            <div
              id={contentId}
              hidden={isCollapsed}
              className="space-y-1"
              data-testid={`navigation-section-items-${section.id}`}
            >
              {renderItems(section.items, 0)}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

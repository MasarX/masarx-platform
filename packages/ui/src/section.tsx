"use client";

import * as React from "react";
import { useOptionalNavigationState } from "./navigation-preferences";
import { ChevronDownIcon } from "./icons";
import { cn } from "./utils";

type SectionProps = {
  children: React.ReactNode;
  className?: string;
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  variant?: "panel" | "plain";
  collapsible?: boolean;
  defaultOpen?: boolean;
  persistCollapse?: boolean;
  collapseKey?: string;
  testId?: string;
};

/**
 * Section container with panel styling and padding.
 */
export function Section({
  children,
  className,
  title,
  description,
  actions,
  variant = "panel",
  collapsible = false,
  defaultOpen = true,
  persistCollapse = true,
  collapseKey,
  testId,
}: SectionProps) {
  const navigationState = useOptionalNavigationState();
  const actionsPresent = React.Children.toArray(actions).length > 0;
  const hasHeader = Boolean(title || description || actionsPresent);
  const resolvedCollapseKey = collapseKey?.trim() ?? "";
  const canPersist =
    persistCollapse && collapsible && hasHeader && Boolean(resolvedCollapseKey) && navigationState;
  const [localOpen, setLocalOpen] = React.useState(defaultOpen);
  const navCollapsed = navigationState?.collapsedSections ?? [];
  const setCollapsedSections = navigationState?.setCollapsedSections ?? null;
  const isCollapsed = canPersist
    ? navCollapsed.includes(resolvedCollapseKey)
    : false;
  const detailsRef = React.useRef<HTMLDetailsElement | null>(null);
  const contentId = React.useId();
  const sectionTestId = testId?.trim() || undefined;
  const detailsTestId = sectionTestId ? `${sectionTestId}-details` : undefined;
  const summaryTestId = sectionTestId ? `${sectionTestId}-summary` : undefined;
  const desiredOpen = canPersist ? !isCollapsed : localOpen;

  React.useEffect(() => {
    if (canPersist) return;
    setLocalOpen(defaultOpen);
  }, [canPersist, defaultOpen]);

  React.useEffect(() => {
    const node = detailsRef.current;
    if (!node) return;
    if (node.open !== desiredOpen) {
      node.open = desiredOpen;
    }
  }, [desiredOpen]);

  const handleToggle = React.useCallback(
    (event: React.SyntheticEvent<HTMLDetailsElement>) => {
      const nextOpen = event.currentTarget.open;
      if (canPersist && setCollapsedSections) {
        const next = new Set(navCollapsed);
        if (nextOpen) {
          next.delete(resolvedCollapseKey);
        } else {
          next.add(resolvedCollapseKey);
        }
        setCollapsedSections(Array.from(next));
        return;
      }
      setLocalOpen(nextOpen);
    },
    [
      canPersist,
      navCollapsed,
      resolvedCollapseKey,
      setCollapsedSections,
    ]
  );
  const header = hasHeader ? (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-1">
        {title ? (
          <div className="text-sm font-semibold text-ui-ink">{title}</div>
        ) : null}
        {description ? (
          <div className="text-xs text-ui-muted">{description}</div>
        ) : null}
      </div>
      {actionsPresent ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  ) : null;

  const body = (
    <>
      {header}
      {header ? (
        <div className={variant === "plain" ? "mt-3" : "mt-4"}>{children}</div>
      ) : (
        children
      )}
    </>
  );

  const content =
    collapsible && hasHeader ? (
      <details
        ref={detailsRef}
        open={desiredOpen}
        onToggle={handleToggle}
        className="group"
        data-testid={detailsTestId}
      >
        <summary
          className={cn(
            "flex list-none items-center justify-between gap-3 text-left text-sm text-ui-ink transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-surface",
            variant === "plain"
              ? "rounded-md px-2 py-2 hover:bg-ui-highlight/60 hover:text-ui-ink"
              : "rounded-xl border border-ui-border/60 border-s-2 border-s-ui-accent/30 bg-ui-surface px-4 py-3 shadow-sm hover:bg-ui-highlight/70 hover:text-ui-ink"
          )}
          aria-controls={contentId}
          data-testid={summaryTestId}
        >
          <div className="flex-1">{header}</div>
          <span
            className={cn(
              "inline-flex h-8 w-8 items-center justify-center text-ui-muted transition group-open:rotate-180",
              variant === "plain"
                ? "rounded-md group-hover:bg-ui-highlight/70 group-hover:text-ui-ink"
                : "rounded-full border border-ui-border/70 bg-ui-surface"
            )}
          >
            <ChevronDownIcon />
          </span>
        </summary>
        <div id={contentId} className={variant === "plain" ? "mt-3" : "mt-4"}>
          {children}
        </div>
      </details>
    ) : (
      body
    );

  return (
    <section
      className={cn(
        variant === "panel" ? "rounded-xl border border-ui-border/60 border-s-2 border-s-ui-accent/30 bg-ui-surface p-5 shadow-sm" : "",
        className
      )}
      data-testid={sectionTestId}
    >
      {content}
    </section>
  );
}

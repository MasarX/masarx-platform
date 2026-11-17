"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "./button";
import { stripBasePath } from "./navigation-paths";
import { resolveSafeAppBasePath } from "./url-guard";
import { cn } from "./utils";

type ResourceDetailNavigationProps = {
  prevHref?: string | null;
  nextHref?: string | null;
  currentIndex?: number | null;
  totalCount?: number | null;
  className?: string;
  appBasePath?: string;
  onNavigate?: (href: string) => void;
};

/**
 * Prev/next record navigation with keyboard shortcuts (Alt+ArrowLeft/Right).
 */
export function ResourceDetailNavigation({
  prevHref,
  nextHref,
  currentIndex,
  totalCount,
  className,
  appBasePath,
  onNavigate,
}: ResourceDetailNavigationProps) {
  const router = useRouter();
  const safeBasePath = React.useMemo(
    () => resolveSafeAppBasePath(appBasePath ?? ""),
    [appBasePath]
  );

  const navigate = React.useCallback(
    (href: string) => {
      if (onNavigate) {
        onNavigate(href);
      } else {
        router.push(stripBasePath(href, safeBasePath ?? undefined));
      }
    },
    [onNavigate, router, safeBasePath]
  );

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey) return;
      if (event.key === "ArrowLeft" && prevHref) {
        event.preventDefault();
        navigate(prevHref);
      }
      if (event.key === "ArrowRight" && nextHref) {
        event.preventDefault();
        navigate(nextHref);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [nextHref, prevHref, navigate]);

  const positionLabel =
    currentIndex != null && totalCount != null
      ? `${currentIndex + 1} / ${totalCount}`
      : null;

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Button
        type="button"
        variant="ghost"
        className="h-7 w-7 p-0"
        disabled={!prevHref}
        onClick={() => prevHref && navigate(prevHref)}
        aria-label="Previous record (Alt+←)"
        title="Previous record (Alt+←)"
      >
        <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 4l-4 4 4 4" />
        </svg>
      </Button>
      {positionLabel ? (
        <span className="text-[11px] tabular-nums text-ui-muted">{positionLabel}</span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        className="h-7 w-7 p-0"
        disabled={!nextHref}
        onClick={() => nextHref && navigate(nextHref)}
        aria-label="Next record (Alt+→)"
        title="Next record (Alt+→)"
      >
        <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 4l4 4-4 4" />
        </svg>
      </Button>
    </div>
  );
}

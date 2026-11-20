"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavigationSection, NavigationItem } from "./navigation";
import { normalizePath } from "./navigation-paths";

type BreadcrumbSegment = {
  label: string;
  href: string | null;
};

type BreadcrumbsProps = {
  appBasePath: string;
  navigationSections: NavigationSection[];
  testIdPrefix?: string | null;
};

function findMatchingItem(
  items: NavigationItem[],
  normalizedPath: string,
  basePath: string
): NavigationItem | null {
  for (const item of items) {
    if (item.href) {
      const itemPath = normalizePath(item.href, basePath);
      if (
        itemPath === normalizedPath ||
        (itemPath !== "/" && normalizedPath.startsWith(`${itemPath}/`))
      ) {
        return item;
      }
    }
    if (Array.isArray(item.items) && item.items.length > 0) {
      const nested = findMatchingItem(item.items, normalizedPath, basePath);
      if (nested) return nested;
    }
  }
  return null;
}

function buildSegments(
  pathname: string,
  appBasePath: string,
  sections: NavigationSection[]
): BreadcrumbSegment[] {
  const segments: BreadcrumbSegment[] = [
    { label: "Home", href: appBasePath || "/" },
  ];

  const normalizedPath = normalizePath(pathname, appBasePath);
  if (normalizedPath === "/") return segments;

  for (const section of sections) {
    const match = findMatchingItem(section.items, normalizedPath, appBasePath);
    if (!match) continue;

    const matchPath = match.href
      ? normalizePath(match.href, appBasePath)
      : null;
    const isExact = matchPath === normalizedPath;

    segments.push({
      label: match.label,
      href: isExact ? null : match.href ?? null,
    });

    // Append remaining path segments (record ID, tab name, etc.)
    if (!isExact && matchPath && normalizedPath.startsWith(`${matchPath}/`)) {
      const remainder = normalizedPath.slice(matchPath.length + 1);
      const parts = remainder.split("/").filter(Boolean);
      let cumulativePath = matchPath;
      parts.forEach((part, index) => {
        cumulativePath = `${cumulativePath}/${part}`;
        const isLast = index === parts.length - 1;
        const decodedLabel = decodeURIComponent(part);
        segments.push({
          label: decodedLabel,
          href: isLast ? null : `${appBasePath}${cumulativePath}`,
        });
      });
    }
    break;
  }

  return segments;
}

export function Breadcrumbs({
  appBasePath,
  navigationSections,
  testIdPrefix,
}: BreadcrumbsProps) {
  const pathname = usePathname();
  const segments = React.useMemo(
    () => buildSegments(pathname, appBasePath, navigationSections),
    [pathname, appBasePath, navigationSections]
  );

  if (segments.length <= 1) return null;

  const prefix = testIdPrefix ?? "breadcrumb";

  return (
    <nav aria-label="Breadcrumb" data-testid={`${prefix}-breadcrumb`}>
      <ol className="flex items-center gap-1 text-xs text-ui-muted">
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          return (
            <li key={index} className="flex items-center gap-1">
              {index > 0 && (
                <span aria-hidden="true" className="select-none">
                  /
                </span>
              )}
              {segment.href && !isLast ? (
                <Link
                  href={segment.href}
                  className="hover:text-ui-ink transition"
                  data-testid={`${prefix}-breadcrumb-${index}`}
                >
                  {segment.label}
                </Link>
              ) : (
                <span
                  aria-current={isLast ? "page" : undefined}
                  data-testid={`${prefix}-breadcrumb-${index}`}
                >
                  {segment.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

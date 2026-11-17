"use client";

import * as React from "react";

type UnsavedChangesGuardOptions = {
  enabled: boolean;
  isSubmitting: boolean;
  hasChanges: boolean;
  warningMessage: string;
};

const INTERNAL_NAVIGATIONS = ["#", "javascript:"];

const isRelativeOrSameOrigin = (href: string) => {
  try {
    const parsed = new URL(href, window.location.href);
    return parsed.origin === window.location.origin;
  } catch (_error) {
    return false;
  }
};

const isSkippableAnchor = (anchor: HTMLAnchorElement | null) => {
  if (!anchor) return true;
  const href = anchor.getAttribute("href")?.trim();
  if (!href) return true;
  const lowerHref = href.toLowerCase();
  const hasAllowedProtocol = INTERNAL_NAVIGATIONS.some((protocol) =>
    lowerHref.startsWith(protocol)
  );
  if (hasAllowedProtocol) return true;
  if (!isRelativeOrSameOrigin(anchor.href)) return true;
  return false;
};

export function useUnsavedChangesGuard({
  enabled,
  isSubmitting,
  hasChanges,
  warningMessage,
}: UnsavedChangesGuardOptions) {
  const shouldGuard = enabled && hasChanges && !isSubmitting;

  React.useEffect(() => {
    if (!shouldGuard) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = warningMessage;
      return warningMessage;
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [shouldGuard, warningMessage]);

  React.useEffect(() => {
    if (!shouldGuard) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]");
      if (!anchor || anchor.getAttribute("target") === "_blank") return;
      if (isSkippableAnchor(anchor as HTMLAnchorElement)) return;
      const message = warningMessage;
      const proceed = window.confirm(message);
      if (!proceed) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [shouldGuard, warningMessage]);

  return { guardActive: shouldGuard };
}

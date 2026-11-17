"use client";

import { isTrustedUrl } from "./url-guard";

export function navigateTo(href: string) {
  if (!isTrustedUrl(href)) {
    return false;
  }
  if (typeof window === "undefined") {
    return false;
  }
  window.location.assign(href);
  return true;
}

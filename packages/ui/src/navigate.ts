"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { isTrustedUrl } from "./url-guard";

/**
 * Hook for client-side navigation without full page reload.
 * Must be called inside components where Next.js app router is mounted.
 */
export function useNavigate() {
  const router = useRouter();
  return useCallback(
    (href: string) => {
      if (!isTrustedUrl(href)) return false;
      router.push(href);
      return true;
    },
    [router],
  );
}

/**
 * Imperative navigation — triggers a full page load.
 * Use `useNavigate` hook when inside React components for SPA navigation.
 */
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

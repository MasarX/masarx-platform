import { type Page } from "@playwright/test";
import { buildNavigationStorageKey } from "../../../packages/ui/src/navigation-preferences";
import { findSupabaseSessionIdentity } from "./auth-session";

type NavigationStateSnapshot = {
  key: string;
  value: unknown;
};

export async function waitForCollapsedSectionPersisted(params: {
  page: Page;
  appKey: string;
  email: string;
  collapseKey: string;
  timeoutMs?: number;
}) {
  const { page, appKey, email, collapseKey, timeoutMs = 10_000 } = params;
  const identity = findSupabaseSessionIdentity(await page.context().cookies(), email);
  if (!identity?.userId) {
    throw new Error("Expected authenticated navigation preference user is missing.");
  }
  const storageKey = buildNavigationStorageKey(appKey, identity.userId);
  await page.waitForFunction(
    ({ storageKey: storageKeyArg, collapseKey: collapseKeyArg }) => {
      const raw = window.localStorage.getItem(storageKeyArg);
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") return false;
        const value = parsed as Record<string, unknown>;
        const collapsedSections = value.collapsedSections;
        return (
          Array.isArray(collapsedSections) &&
          collapsedSections.includes(collapseKeyArg)
        );
      } catch {
        return false;
      }
    },
    { storageKey, collapseKey },
    { timeout: timeoutMs }
  );
}

export async function readNavigationStateSnapshots(params: {
  page: Page;
  appKey: string;
}): Promise<NavigationStateSnapshot[]> {
  const { page, appKey } = params;
  const prefix = `masarx:navigation:v2:${appKey}:`;
  return page.evaluate(({ prefix: prefixArg }) => {
    const keys = Object.keys(window.localStorage).filter((key) =>
      key.startsWith(prefixArg)
    );
    return keys
      .map((key) => {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        try {
          return { key, value: JSON.parse(raw) } as NavigationStateSnapshot;
        } catch {
          return { key, value: raw } as NavigationStateSnapshot;
        }
      })
      .filter((entry): entry is NavigationStateSnapshot => Boolean(entry));
  }, { prefix });
}

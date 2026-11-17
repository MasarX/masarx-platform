import { type Page } from "@playwright/test";

type NavigationStateSnapshot = {
  key: string;
  value: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export async function waitForCollapsedSectionPersisted(params: {
  page: Page;
  appKey: string;
  collapseKey: string;
  timeoutMs?: number;
}) {
  const { page, appKey, collapseKey, timeoutMs = 10_000 } = params;
  const prefix = `masarx:navigation:v2:${appKey}:`;
  await page.waitForFunction(
    ({ prefix: prefixArg, collapseKey: collapseKeyArg }) => {
      const keys = Object.keys(window.localStorage).filter((key) =>
        key.startsWith(prefixArg)
      );
      return keys.some((key) => {
        const raw = window.localStorage.getItem(key);
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
      });
    },
    { prefix: prefix, collapseKey },
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

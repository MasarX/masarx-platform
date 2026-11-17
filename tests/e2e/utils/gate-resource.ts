import { expect, type Page } from "@playwright/test";
import { signInWithPassword } from "./auth";
import {
  flattenNavigationSections,
  normalizeNavHref,
  type NavigationSection,
  type ReadRegistry,
} from "./role-matrix";

type ResourceProbeAttempt = {
  href: string;
  stateId: string | null;
};

function normalizeRegistryHref(resourceKey: string, basePath: string) {
  const encodedKey = encodeURIComponent(resourceKey);
  return normalizeNavHref(`/resources/${encodedKey}`, basePath);
}

export function buildGateResourceCandidates(params: {
  basePath: string;
  sections: NavigationSection[];
  readRegistry: ReadRegistry | null;
}) {
  const { basePath, sections, readRegistry } = params;

  const navCandidates = flattenNavigationSections(sections)
    .map(({ item }) => item)
    .filter(
      (item) =>
        typeof item.href === "string" &&
        item.href.includes("/resources/") &&
        !item.disabled_reason?.trim()
    )
    .map((item) => normalizeNavHref(item.href ?? "", basePath));

  const registryCandidates = Array.isArray(readRegistry?.resources)
    ? readRegistry.resources
        .map((entry) => entry?.key?.trim() ?? "")
        .filter(Boolean)
        .map((resourceKey) => normalizeRegistryHref(resourceKey, basePath))
    : [];

  return Array.from(new Set([...navCandidates, ...registryCandidates])).filter(
    (href) => href && !href.includes("/auth/")
  );
}

async function waitForRouteStateId(params: {
  page: Page;
  selector: string;
  timeoutMs: number;
}) {
  const { page, selector, timeoutMs } = params;
  const state = page.locator(selector).first();
  await expect(state).toBeVisible({ timeout: timeoutMs });
  return await state.getAttribute("data-testid");
}

export async function openFirstReadyGateResource(params: {
  page: Page;
  candidates: string[];
  selector: string;
  authTestId: string;
  email: string;
  password: string;
  timeoutMs?: number;
}) {
  const {
    page,
    candidates,
    selector,
    authTestId,
    email,
    password,
    timeoutMs = 60_000,
  } = params;
  const attempts: ResourceProbeAttempt[] = [];

  for (const href of candidates) {
    await page.goto(href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    let stateId = await waitForRouteStateId({
      page,
      selector,
      timeoutMs,
    });

    if (stateId === authTestId) {
      await signInWithPassword(page, email, password);
      stateId = await waitForRouteStateId({
        page,
        selector,
        timeoutMs,
      });
    }

    if (stateId?.endsWith("-ready")) {
      return { href, stateId, attempts };
    }

    attempts.push({ href, stateId });
  }

  const summary = attempts.length
    ? attempts.map(({ href, stateId }) => `${href} => ${stateId ?? "unknown"}`).join("; ")
    : "no candidates";
  throw new Error(`No ready resource route found. ${summary}`);
}

import { type Page } from "@playwright/test";
import { expectSignedIn, signInWithPassword } from "./auth";

function resolveContextUnavailableTestId(authTestId: string) {
  return authTestId.endsWith("-auth-required")
    ? authTestId.replace(/-auth-required$/, "-context-unavailable")
    : null;
}

async function assertNoContextUnavailable(params: {
  page: Page;
  authTestId: string;
  label: string;
}) {
  const { page, authTestId, label } = params;
  const contextTestId = resolveContextUnavailableTestId(authTestId);
  if (!contextTestId) return;

  const contextUnavailable = page.locator(`[data-testid="${contextTestId}"]`);
  if (await contextUnavailable.isVisible()) {
    throw new Error(`UI context unavailable while ${label}`);
  }
}

async function shouldSignIn(params: {
  page: Page;
  authTestId: string;
  timeoutMs: number;
}) {
  const { page, authTestId, timeoutMs } = params;
  const authGate = page.locator(`[data-testid="${authTestId}"]`).first();
  if (await authGate.isVisible().catch(() => false)) {
    return true;
  }
  if (timeoutMs <= 0) {
    return false;
  }
  return await authGate
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

export async function signInIfAuthRequired(params: {
  page: Page;
  authTestId: string;
  email: string;
  password: string;
  timeoutMs?: number;
}) {
  const { page, authTestId, email, password, timeoutMs = 0 } = params;
  await assertNoContextUnavailable({ page, authTestId, label: `loading auth gate ${authTestId}` });
  const needsSignIn = await shouldSignIn({ page, authTestId, timeoutMs });
  if (!needsSignIn) {
    return false;
  }
  await signInWithPassword(page, email, password);
  await assertNoContextUnavailable({ page, authTestId, label: `signing in as ${email}` });
  return true;
}

export async function ensureSignedIn(params: {
  page: Page;
  basePath: string;
  authTestId: string;
  email: string;
  password: string;
  scopeType?: string | null;
}) {
  const { page, basePath, authTestId, email, password, scopeType } = params;
  await page.goto(basePath || "/");
  await signInIfAuthRequired({ page, authTestId, email, password, timeoutMs: 0 });
  await expectSignedIn(page, email, scopeType);
}

export async function ensureSignedInAtUrl(params: {
  page: Page;
  baseUrl: string;
  authTestId: string;
  email: string;
  password: string;
  scopeType?: string | null;
}) {
  const { page, baseUrl, authTestId, email, password, scopeType } = params;
  await page.goto(baseUrl);
  await signInIfAuthRequired({ page, authTestId, email, password, timeoutMs: 0 });
  await expectSignedIn(page, email, scopeType);
}

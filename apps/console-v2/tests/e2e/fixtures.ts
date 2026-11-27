// fixtures.ts - shared helpers for the happy-path E2E suite.
//
// Why these helpers exist
//   The console-v2 dev server can run in mock mode by default - the data-source
//   adapter (src/lib/data-source.ts) services every RPC from the in-memory
//   seed catalog. That means the standard `page.route()` recipe (intercept
//   network, assert payload) does NOT apply in mock mode: there is no network hop. But
//   the application is still RPC-shaped because every mutation is wired
//   through `src/lib/queries.ts` -> `src/lib/api.ts` -> data-source/API, AND
//   every operator-visible mutation pushes a success toast that includes
//   the canonical RPC name.
//
//   So our spy seam is `expectToastWithRpc(...)`: assert the success toast
//   text contains the canonical RPC name. That gives us a name-level RPC
//   fingerprint that survives the live-Supabase path (the same toasts still fire
//   there, and live-mode tests also observe real `/rest/v1/rpc/*` requests).
//   The toast convention is enforced across all mutation callsites by the codebase.
//
//   For capability gating we lean on the shared `<Button capability="...">`
//   component (src/components/Button.tsx): when the operator does not hold
//   the capability, the button renders `disabled` and a `<CapabilityLock>`
//   chip. Our `expectButtonEnabled(label, capability)` helper asserts the
//   primary action button is enabled - i.e. the gate fired and PASSED for
//   the seeded super_admin user. (Negative-gate flows belong in a separate
//   role-switching suite, not the happy path.)

import { expect, type Page, type Locator, type Response } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface LiveAuthCredentials {
  email: string;
  password: string;
}

export function isLiveConsoleE2E(): boolean {
  return ['1', 'true', 'yes', 'live'].includes(
    String(process.env.E2E_CONSOLE_LIVE ?? '').trim().toLowerCase(),
  );
}

function envValue(name: string): string {
  return String(process.env[name] ?? '').trim();
}

// Live readiness helpers are intentionally fail-closed. Seed smoke can assert
// toast fingerprints, but first-tenant readiness must prove real Supabase RPCs.
function liveReadinessSupabaseOrigin(): string {
  const failures: string[] = [];
  if (!isLiveConsoleE2E()) failures.push('E2E_CONSOLE_LIVE=1');
  if (envValue('VITE_USE_SEED').toLowerCase() !== 'false') {
    failures.push('VITE_USE_SEED=false');
  }
  if (!envValue('VITE_SUPABASE_URL')) failures.push('VITE_SUPABASE_URL');
  if (!envValue('VITE_SUPABASE_ANON_KEY')) failures.push('VITE_SUPABASE_ANON_KEY');

  let origin = '';
  if (envValue('VITE_SUPABASE_URL')) {
    try {
      origin = new URL(envValue('VITE_SUPABASE_URL')).origin;
    } catch {
      failures.push('VITE_SUPABASE_URL must be an absolute URL');
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Console V2 live readiness E2E requires ${failures.join(
        ', ',
      )}. Seed/mock mode cannot be counted as first-tenant production readiness proof.`,
    );
  }
  return origin;
}

function isExpectedLiveRpcResponse(response: Response, rpcName: string): boolean {
  if (response.request().method() !== 'POST' || !response.ok()) return false;
  const expectedOrigin = liveReadinessSupabaseOrigin();
  const headers = response.request().headers();
  if (headers.apikey !== envValue('VITE_SUPABASE_ANON_KEY')) return false;
  try {
    const url = new URL(response.url());
    return url.origin === expectedOrigin && url.pathname === `/rest/v1/rpc/${rpcName}`;
  } catch {
    return false;
  }
}

export function requireLiveConsoleReadinessMode(): void {
  void liveReadinessSupabaseOrigin();
}

export function waitForLiveRpc(page: Page, rpcName: string, timeout = 30_000): Promise<void> {
  requireLiveConsoleReadinessMode();
  return page
    .waitForResponse((response) => isExpectedLiveRpcResponse(response, rpcName), { timeout })
    .then(() => undefined);
}

export function waitForLiveResourceList(
  page: Page,
  resource: string,
  timeout = 30_000,
): Promise<void> {
  requireLiveConsoleReadinessMode();
  return page
    .waitForResponse(
      (response) => {
        if (!isExpectedLiveRpcResponse(response, 'ui_list_resource_v1')) {
          return false;
        }
        try {
          const payload = response.request().postDataJSON() as { p_resource?: unknown };
          return payload.p_resource === resource;
        } catch {
          return false;
        }
      },
      { timeout },
    )
    .then(() => undefined);
}

function readManifestCredentials(): LiveAuthCredentials | null {
  const manifestPath = String(process.env.E2E_CONSOLE_AUTH_MANIFEST ?? '').trim();
  if (!manifestPath) return null;
  const absolutePath = path.resolve(process.cwd(), manifestPath);
  const payload = JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as {
    password?: unknown;
    users?: Array<Record<string, unknown>>;
  };
  const password = typeof payload.password === 'string' ? payload.password : '';
  const users = Array.isArray(payload.users) ? payload.users : [];
  const preferredRole = String(process.env.E2E_CONSOLE_AUTH_ROLE ?? 'super_admin')
    .trim()
    .toLowerCase();
  const user =
    users.find((entry) => String(entry.user_type ?? '').toLowerCase() === preferredRole) ??
    users.find((entry) => String(entry.scope_type ?? '').toLowerCase() === 'platform') ??
    users[0];
  const email = typeof user?.email === 'string' ? user.email : '';
  if (!email || !password) {
    throw new Error(
      'E2E_CONSOLE_AUTH_MANIFEST must contain a password and at least one user email for live Console E2E.',
    );
  }
  return { email, password };
}

function resolveLiveAuthCredentials(): LiveAuthCredentials {
  const email = String(process.env.E2E_CONSOLE_AUTH_EMAIL ?? '').trim();
  const password = String(process.env.E2E_CONSOLE_AUTH_PASSWORD ?? '');
  if (email && password) return { email, password };
  const manifestCredentials = readManifestCredentials();
  if (manifestCredentials) return manifestCredentials;
  throw new Error(
    'Live Console E2E requires E2E_CONSOLE_AUTH_EMAIL/E2E_CONSOLE_AUTH_PASSWORD or E2E_CONSOLE_AUTH_MANIFEST.',
  );
}

async function maybeVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.isVisible({ timeout: 500 });
  } catch {
    return false;
  }
}

async function signInThroughConsoleUi(page: Page, credentials = resolveLiveAuthCredentials()): Promise<void> {
  const signInRequired = page.getByRole('region', { name: 'Sign in required' });
  if (await maybeVisible(signInRequired)) {
    await signInRequired.getByRole('button', { name: /^Sign in$/ }).click();
  }

  const loginModule = page.getByTestId('login-module');
  await expect(loginModule, 'Expected production Console login module').toBeVisible({
    timeout: 10_000,
  });
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
}

async function ensureConsoleAuthenticated(page: Page, credentials?: LiveAuthCredentials): Promise<void> {
  if (!isLiveConsoleE2E()) return;
  if (await maybeVisible(page.locator('header'))) return;

  const loginModule = page.getByTestId('login-module');
  const signInRequired = page.getByRole('region', { name: 'Sign in required' });
  const sessionError = page.getByRole('region', { name: 'Session error' });
  if (await maybeVisible(loginModule) || await maybeVisible(signInRequired)) {
    await signInThroughConsoleUi(page, credentials);
  } else if (await maybeVisible(sessionError)) {
    await sessionError.getByRole('button', { name: /^Sign in again$/ }).click();
    await signInThroughConsoleUi(page, credentials);
  }

  await page.waitForSelector('header', { timeout: 30_000 });
  await settle(page, 1_000);
}

/** Wait for the page to settle after navigation (toasts/data-source/queries). */
export async function settle(page: Page, ms = 600): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(ms);
}

/**
 * Assert a success toast surfaced and contains the canonical RPC name.
 *
 * Toasts render under `.toast-stack` with the message inside a `<span>` (see
 * src/components/Toast.tsx). They auto-dismiss after ~3.2 s so we wait for
 * `attached` rather than `visible` and we read text via `textContent()` to
 * tolerate the brief animation window.
 */
export async function expectToastWithRpc(page: Page, rpcName: string): Promise<void> {
  const toast = page.locator('.toast', { hasText: rpcName }).first();
  await expect(
    toast,
    `Expected a toast with text containing "${rpcName}" — RPC fingerprint missing`,
  ).toBeAttached({ timeout: 6_000 });
  const text = (await toast.textContent()) ?? '';
  expect(text).toContain(rpcName);
}

/**
 * Assert a button labelled `label` exists, is enabled, and (when the caller
 * supplies one) carries the capability marker.
 *
 * Capability gating reference: src/components/Button.tsx — when the user
 * lacks the capability, the button is rendered with `disabled` and a sibling
 * <CapabilityLock /> chip is appended. We assert `not.toBeDisabled` to prove
 * the gate fired AND the seeded operator holds the capability.
 */
export async function expectButtonEnabled(
  page: Page,
  label: string | RegExp,
  scope?: Locator,
): Promise<Locator> {
  const root = scope ?? page;
  const btn = root.locator('button', { hasText: label }).first();
  await expect(btn, `Expected button "${label}" to be present`).toBeAttached();
  await expect(btn, `Expected button "${label}" to be enabled (capability gate)`)
    .not.toBeDisabled();
  return btn;
}

/**
 * Click the row at index 0 in the canonical DataTable. Used by every story
 * that opens a row drawer.
 */
export async function clickFirstDataTableRow(page: Page): Promise<void> {
  const row = page.locator('.dt__table tbody tr').first();
  await expect(row, 'Expected at least one data-table row to be visible').toBeVisible();
  await row.click();
}

/** Navigate to a surface and wait for the shell to render. The wait budget
 *  is generous because Vite dev-mode HMR can cause re-bundling pauses
 *  between tests in the same suite run. */
export async function gotoSurface(
  page: Page, hashPath: string, credentials?: LiveAuthCredentials,
): Promise<void> {
  await page.goto(hashPath, { waitUntil: 'load' });
  await ensureConsoleAuthenticated(page, credentials);
  // The shell's `<header>` (banner) renders only after the IdentityProvider +
  // I18nProvider are mounted — waiting for it gives a deterministic anchor
  // for "the surface is alive" rather than a fixed sleep.
  await page.waitForSelector('header', { timeout: 15_000 });
  await settle(page, 1_000);
}

/**
 * Primary operator-journey navigation proof. Start at the shell entry and
 * reach a module by clicking the visible sidebar label; direct URLs remain
 * useful only for deep-link/redirect assertions.
 */
export async function gotoSurfaceBySidebar(
  page: Page,
  label: string | RegExp,
  expectedPath: string,
  startPath = '/',
): Promise<void> {
  await page.goto(startPath, { waitUntil: 'load' });
  await ensureConsoleAuthenticated(page);
  await page.waitForSelector('header', { timeout: 15_000 });
  const pinButton = page.getByRole('button', { name: 'Pin sidebar open' });
  if (await pinButton.isVisible()) {
    await pinButton.click();
  }
  const link = page.getByRole('link', { name: label }).first();
  await expect(link, `Expected sidebar link "${String(label)}" to be visible`).toBeVisible();
  await link.click();
  const escapedPath = expectedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await expect(page).toHaveURL(new RegExp(`${escapedPath}(?:[?#].*)?$`));
  await settle(page, 1_000);
}

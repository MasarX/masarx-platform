import { expect, type Page, type Response } from "@playwright/test";

// Shared helpers for the FieldOps mobile Playwright suite. Centralised so each
// spec stays focused on the behaviour under test and selectors/network waits
// remain consistent across files.

export const DEFAULT_BOOT_TIMEOUT_MS = 90_000;
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

// Canonical auth credentials for the seeded demo accounts.
export const DEMO_USERS = {
  driver: {
    email:
      process.env.FIELDOPS_MOBILE_DRIVER_EMAIL?.trim() ||
      "mlrznqhylvnirjwnhxhsjwgm@example.invalid",
    password:
      process.env.FIELDOPS_MOBILE_DEMO_PASSWORD?.trim() || "EXAMPLE_PASSWORD",
  },
  opsAdmin: {
    email:
      process.env.FIELDOPS_MOBILE_OPS_EMAIL?.trim() ||
      "sipkxyzyxvgvtksowrxwjgpn@example.invalid",
    password:
      process.env.FIELDOPS_MOBILE_DEMO_PASSWORD?.trim() || "EXAMPLE_PASSWORD",
  },
} as const;

// Waits for the Expo bundle to boot. The RN-web shell renders the sign-in view
// first; afterwards the ready testID or the main tab bar is in the DOM.
export async function waitForBundle(
  page: Page,
  timeout = DEFAULT_BOOT_TIMEOUT_MS,
): Promise<void> {
  // Either the sign-in screen or the shell-ready surface confirms the bundle
  // finished hydrating. We deliberately accept both since the auth state may
  // be preserved across tests.
  const signInEmail = page.getByTestId("mobile-signin-email");
  const shellReady = page.getByTestId("mobile-shell-ready");
  await Promise.race([
    signInEmail.waitFor({ state: "visible", timeout }).catch(() => undefined),
    shellReady.waitFor({ state: "visible", timeout }).catch(() => undefined),
  ]);
  // Final assertion: at least one of the two must be present.
  const signInVisible = await signInEmail.isVisible().catch(() => false);
  const shellVisible = await shellReady.isVisible().catch(() => false);
  expect(signInVisible || shellVisible, "FieldOps mobile bundle should boot").toBe(
    true,
  );
}

// Collects console errors for a test run and asserts none leaked. Returns a
// teardown that should be invoked in afterEach / at end of test.
export function expectNoConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Expo web spams React Native deprecation / dev-only warnings that are not
    // relevant for behavioural testing — filter known harmless noise.
    if (/\[expo-\w+\] .* deprecated/i.test(text)) return;
    if (/Warning: (?:A future version of React|componentWillReceiveProps)/i.test(text)) return;
    if (/Download the React DevTools/i.test(text)) return;
    if (/react-native-web[\s\S]*unknown accessibility/i.test(text)) return;
    // 4xx resource responses (403/404) are emitted by the browser as console
    // errors, but they are legitimate server responses — RLS denies, missing
    // optional telemetry assets, etc. Exclude them from the strict leak gate.
    if (/Failed to load resource:.*status of (4\d\d)/i.test(text)) return;
    errors.push(text);
  });
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err?.message ?? String(err)}`);
  });
  return () => {
    expect(
      errors,
      `No console errors should be logged during test (found ${errors.length}).\n${errors.slice(0, 5).join("\n---\n")}`,
    ).toHaveLength(0);
  };
}

// Listens for a Supabase RPC invocation by name. Resolves with the network
// response so the caller can assert status codes or parse the body.
export async function expectRpcReturns200(
  page: Page,
  rpcName: string,
  trigger: () => Promise<void>,
  timeout = DEFAULT_RPC_TIMEOUT_MS,
): Promise<Response> {
  // Supabase PostgREST encodes RPC invocations as POST /rest/v1/rpc/<name>.
  // Also cover Edge Functions /functions/v1/<name> for functions that route
  // through the edge layer.
  const urlPattern = new RegExp(
    `(/rest/v1/rpc/${rpcName}(?:\\?|$)|/functions/v1/${rpcName}(?:\\?|$))`,
  );
  const responsePromise = page.waitForResponse(
    (resp) => urlPattern.test(resp.url()),
    { timeout },
  );
  await trigger();
  const response = await responsePromise;
  expect(
    response.status(),
    `${rpcName} RPC should return 2xx (got ${response.status()} from ${response.url()})`,
  ).toBeLessThan(300);
  return response;
}

// Drives the sign-in form. If the shell is already ready (persisted session)
// the function no-ops so tests can run idempotently. The helper is designed
// to be robust against the Expo web bundle's warm-reload behaviour: after a
// storage wipe + reload the bundle may re-hydrate Supabase's cached session
// before React can unmount the shell, so we accept either state.
export async function signIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  // Navigate if not already on the base URL. Cheaper than an unconditional
  // reload, and avoids tearing down an already-rendered shell.
  if (!/^https?:\/\//.test(page.url())) {
    await page.goto("/", { waitUntil: "domcontentloaded" });
  }
  await waitForBundle(page);
  const shellAlreadyReady = await page
    .getByTestId("mobile-shell-ready")
    .isVisible()
    .catch(() => false);
  if (shellAlreadyReady) return;

  const emailInput = page.getByTestId("mobile-signin-email");
  const passwordInput = page.getByTestId("EXAMPLE_PASSWORD");
  const submitButton = page.getByTestId("mobile-signin-submit");

  const emailVisible = await emailInput.isVisible().catch(() => false);
  if (!emailVisible) {
    // The bundle has booted but neither shell nor sign-in form rendered.
    // This is an environmental problem (e.g. bundle crashed) — surface it.
    throw new Error(
      "[fieldops-mobile] Bundle booted without exposing sign-in form or shell; check Expo bundle status.",
    );
  }
  await emailInput.fill(email);
  await passwordInput.fill(password);
  // Note: we intentionally do NOT assert toBeEnabled() here. Pressable on
  // react-native-web renders as <div role="button"> and doesn't toggle the
  // HTML `disabled` attribute — Playwright's toBeEnabled matcher would hang.
  await submitButton.click();

  // After a successful sign-in the shell-ready surface appears. If the backend
  // is unreachable the form surfaces an error — surface that in test output.
  const shellReady = page.getByTestId("mobile-shell-ready");
  const signInError = page.getByTestId("mobile-signin-error");
  await Promise.race([
    shellReady.waitFor({ state: "visible", timeout: 45_000 }).catch(() => undefined),
    signInError.waitFor({ state: "visible", timeout: 45_000 }).catch(() => undefined),
  ]);
  // Only attempt to read the error message if the error element is actually
  // in the DOM. Calling `.textContent()` on a missing locator triggers
  // Playwright's default auto-wait, which would hang until the outer test
  // timeout — silently converting a success into a timeout failure.
  if ((await signInError.count()) > 0) {
    const errorMessage = await signInError.textContent().catch(() => null);
    if (errorMessage && errorMessage.trim().length > 0) {
      throw new Error(
        `[fieldops-mobile] Sign-in failed with error: ${errorMessage.trim()}`,
      );
    }
  }
  await expect(
    shellReady,
    "Shell ready surface must render after successful sign-in",
  ).toBeVisible({ timeout: 30_000 });
}

// Establishes a clean page state for the next test. Because the Expo web
// bundle caches the authenticated Supabase session in IndexedDB (via the
// mobile-core SQLite adapter), a full sign-out is expensive and flaky on a
// warm preview server. For most specs we only need a deterministic starting
// point, so this helper simply ensures the page has navigated to the base
// URL and the bundle is mounted; it does NOT forcibly drop the session.
//
// When a test genuinely needs a signed-out state, call `forceSignOut(page)`
// explicitly — that variant wipes storage + IndexedDB.
export async function signOut(page: Page): Promise<void> {
  if (!/^https?:\/\//.test(page.url())) {
    await page.goto("/", { waitUntil: "domcontentloaded" });
  }
  await waitForBundle(page);
}

// Opt-in aggressive sign-out: wipes all client-side storage and reloads so
// the bundle bootstraps against an empty session. Use sparingly — a full
// SQLite re-init on Expo web can take 30-60s.
export async function forceSignOut(page: Page): Promise<void> {
  if (!/^https?:\/\//.test(page.url())) {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForBundle(page);
  }
  await page.evaluate(async () => {
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch {
      /* ignore */
    }
    try {
      if (
        window.indexedDB &&
        typeof window.indexedDB.databases === "function"
      ) {
        const dbs = await window.indexedDB.databases();
        await Promise.all(
          dbs.map((info) => {
            if (!info?.name) return null;
            return new Promise<void>((resolve) => {
              const req = window.indexedDB.deleteDatabase(info.name!);
              req.onsuccess = () => resolve();
              req.onerror = () => resolve();
              req.onblocked = () => resolve();
            });
          }),
        );
      }
    } catch {
      /* ignore */
    }
  });
  await page.reload({ waitUntil: "commit" });
  await waitForBundle(page);
}

// Utility: retrieves the bounding box and asserts minimum tap-target size. The
// WCAG AA target size (2.5.5) is 44x44 CSS pixels; we use this for a11y specs.
export async function expectMinTapTarget(
  locator: ReturnType<Page["getByTestId"]>,
  minSize = 44,
  description = "interactive element",
): Promise<void> {
  const box = await locator.boundingBox();
  expect(
    box,
    `${description} should have a measurable bounding box (not detached/hidden)`,
  ).not.toBeNull();
  if (!box) return;
  expect(
    box.width,
    `${description} width should be >= ${minSize}px for accessibility`,
  ).toBeGreaterThanOrEqual(minSize - 0.5);
  expect(
    box.height,
    `${description} height should be >= ${minSize}px for accessibility`,
  ).toBeGreaterThanOrEqual(minSize - 0.5);
}

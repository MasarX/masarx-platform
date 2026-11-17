import { expect, type Page } from "@playwright/test";
import { normalizeUiScopeType } from "../../../packages/api/src/scope-normalize";
import {
  isPasswordGrantTokenRequest,
  summarizeAuthErrorBody,
} from "./auth-request";
import { findSupabaseSessionIdentity } from "./auth-session";
import { seedBrowserAuthSession } from "./browser-auth";
import { resolveUsableDemoPassword } from "./demo-accounts";

export async function signInWithPassword(
  page: Page,
  email: string,
  password: string,
) {
  let effectivePassword = await resolveUsableDemoPassword({ email, password });
  const visibleAuthGateCandidate = page
    .locator('[data-testid$="-auth-required"]:visible')
    .first();
  const gateFormCandidate = visibleAuthGateCandidate
    .locator('form:has(input[name="email"])')
    .first();
  const formCandidate = (await gateFormCandidate.count())
    ? gateFormCandidate
    : page.locator('form:has(input[name="email"])').first();
  const form = (await formCandidate.count()) ? formCandidate : page.locator("form").first();
  const authGate = (await visibleAuthGateCandidate.count())
    ? visibleAuthGateCandidate
    : page
        .locator('[data-testid$="-auth-required"]')
        .filter({ has: form })
        .first();

  const passwordInput = form.locator('input[name="password"]');
  const emailInput = form.locator('input[name="email"]');
  await expect(emailInput).toBeVisible({ timeout: 20_000 });

  const ensurePasswordMethodSelected = async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await passwordInput.isVisible().catch(() => false)) return;

      const passwordRadio = form.locator('input[type="radio"][value="password"]');
      if (await passwordRadio.count()) {
        await passwordRadio.first().click({ force: true });
      } else {
        const passwordMethodRadio = form.getByRole("radio", { name: /password/i });
        if (await passwordMethodRadio.count()) {
          try {
            await passwordMethodRadio.first().check();
          } catch {
            await passwordMethodRadio.first().click({ force: true });
          }
        } else {
          const passwordMethodLabel = form.locator("label", { hasText: /password/i });
          if (await passwordMethodLabel.count()) {
            await passwordMethodLabel.first().click({ force: true });
          } else {
            const passwordText = form.getByText(/password/i).first();
            if (await passwordText.count()) {
              await passwordText.click({ force: true });
            }
          }
        }
      }

      if (await passwordInput.isVisible().catch(() => false)) return;
      await page.waitForTimeout(250);
    }
  };

  await ensurePasswordMethodSelected();
  await expect(passwordInput).toBeVisible({ timeout: 30_000 });

  await expect(emailInput).toBeVisible({ timeout: 20_000 });
  const signInButtonCandidate = form.locator('button[type="submit"]').first();
  const signInButton = (await signInButtonCandidate.count())
    ? signInButtonCandidate
    : form.getByRole("button", { name: /sign in/i }).first();
  const ensurePasswordSubmissionReady = async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await ensurePasswordMethodSelected();
      await expect(emailInput).toBeVisible({ timeout: 20_000 });
      await expect(passwordInput).toBeVisible({ timeout: 30_000 });

      const currentEmail = await emailInput.inputValue().catch(() => "");
      if (currentEmail !== email) {
        await emailInput.fill(email);
      }

      const currentPassword = await passwordInput.inputValue().catch(() => "");
      if (currentPassword !== effectivePassword) {
        await passwordInput.fill(effectivePassword);
      }

      let enabled = await signInButton.isEnabled().catch(() => false);
      if (
        !enabled &&
        currentEmail === email &&
        currentPassword === effectivePassword
      ) {
        // Some client-side forms show the intended values before the framework
        // state is hydrated. Re-firing input events keeps fallback sign-in
        // deterministic for the auth gate flows.
        await emailInput.fill("");
        await emailInput.fill(email);
        await passwordInput.fill("");
        await passwordInput.fill(effectivePassword);
        enabled = await signInButton.isEnabled().catch(() => false);
      }
      if (enabled) return;
      await page.waitForTimeout(250);
    }

    throw new Error(`Sign-in form never became submittable for ${email}.`);
  };
  await ensurePasswordSubmissionReady();
  const authResponses: Array<{
    ok: boolean;
    status: number;
    statusText: string;
    details: string;
  }> = [];
  const isDemoUser = /@demo\.local$/i.test(email);
  const recoverAuthenticatedShell = async () => {
    const identity = findSupabaseSessionIdentity(await page.context().cookies(), email);
    if (!identity) return false;

    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});

    const signedInShell = page.locator(
      '[data-testid="ui-context-strip-signed-in"], [data-testid$="-app-shell-sidebar"], [data-testid="navigation-list"], [data-testid$="-dashboard-ready"]',
    );
    const shellVisible = await signedInShell
      .first()
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (!shellVisible) {
      return false;
    }

    const visibleAuthGate = page.locator('[data-testid$="-auth-required"]:visible');
    return !(await visibleAuthGate.count());
  };
  const waitForAuthGateToHide = async () => {
    if (!(await authGate.count())) return true;
    return await expect(authGate)
      .toBeHidden({ timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
  };
  const trySeedSessionRecovery = async () => {
    const pageUrl = String(page.url() || "").trim();
    if (!pageUrl) return false;

    try {
      const surfaceOrigin = new URL(pageUrl).origin;
      await seedBrowserAuthSession({
        page,
        surfaceOrigin,
        email,
        password: effectivePassword,
        label: `auth-recover:${email}`,
      });
    } catch {
      return false;
    }

    return await recoverAuthenticatedShell();
  };
  const maybeRetryInvalidCredentials = async () => {
    const lastResponse = authResponses[authResponses.length - 1];
    const details = String(lastResponse?.details ?? "");
    const invalidCredentials =
      lastResponse?.status === 400 &&
      /invalid_credentials|invalid login credentials/i.test(details);
    if (!invalidCredentials) {
      return false;
    }

    await page.waitForTimeout(1_000);
    if (isDemoUser) {
      effectivePassword = await resolveUsableDemoPassword({
        email,
        password: effectivePassword,
      });
    }
    await ensurePasswordSubmissionReady();
    authResponses.length = 0;
    await signInButton.click();
    return true;
  };
  const onResponse = async (response: Awaited<ReturnType<Page["waitForResponse"]>>) => {
    const request = response.request();
    if (
      !isPasswordGrantTokenRequest({
        method: request.method(),
        url: response.url(),
        postData: request.postData() || "",
        email,
      })
    ) {
      return;
    }

    let details = "";
    if (!response.ok()) {
      try {
        const summary = summarizeAuthErrorBody(await response.text());
        if (summary) details = summary;
      } catch {
        // Best-effort error diagnostics only.
      }
    }
    authResponses.push({
      ok: response.ok(),
      status: response.status(),
      statusText: response.statusText(),
      details,
    });
  };

  page.on("response", onResponse);
  try {
    if (await recoverAuthenticatedShell()) {
      return;
    }
    try {
      await signInButton.click({ timeout: 10_000 });
    } catch (error) {
      if (await trySeedSessionRecovery()) {
        return;
      }
      throw error;
    }

    if (await authGate.count()) {
      let hidden = await waitForAuthGateToHide();

      if (!hidden) {
        const successResponse = authResponses.find((entry) => entry.ok);
        if (successResponse && (await recoverAuthenticatedShell())) {
          return;
        }
        if (await trySeedSessionRecovery()) {
          return;
        }
        if (await maybeRetryInvalidCredentials()) {
          hidden = await waitForAuthGateToHide();
        }
      }

      if (!hidden) {
        const lastResponse = authResponses[authResponses.length - 1];
        const successResponse = authResponses.find((entry) => entry.ok);
        if (successResponse && (await recoverAuthenticatedShell())) {
          return;
        }
        if (await trySeedSessionRecovery()) {
          return;
        }
        if (lastResponse) {
          const details = lastResponse.details ? ` (${lastResponse.details})` : "";
          throw new Error(
            `Sign-in failed: POST /auth/v1/token responded ${lastResponse.status} ${lastResponse.statusText}${details}`,
          );
        }
        throw new Error(
          "Sign-in failed: auth-required gate remained visible and no password-grant response was captured.",
        );
      }
    } else {
      const successResponse = authResponses.find((entry) => entry.ok);
      if (!successResponse) {
        const lastResponse = authResponses[authResponses.length - 1];
        if (lastResponse) {
          const details = lastResponse.details ? ` (${lastResponse.details})` : "";
          throw new Error(
            `Sign-in failed: POST /auth/v1/token responded ${lastResponse.status} ${lastResponse.statusText}${details}`,
          );
        }
      } else if (!(await recoverAuthenticatedShell())) {
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }
    }
  } finally {
    page.off("response", onResponse);
  }
}

export async function expectSignedIn(
  page: Page,
  email: string,
  scopeType?: string,
) {
  const visibleContextUnavailable = page.locator(
    '[data-testid$="-context-unavailable"]:visible',
  );
  if (await visibleContextUnavailable.count()) {
    throw new Error(`UI context unavailable while expecting ${email} to be signed in.`);
  }

  const assertContextStrip = async (timeout: number) => {
    const signedInBadge = page.locator('[data-testid="ui-context-strip-signed-in"]').first();
    const visible = await signedInBadge
      .waitFor({ state: "visible", timeout })
      .then(() => true)
      .catch(() => false);

    if (!visible) {
      return false;
    }

    await expect(signedInBadge).toContainText(email, { timeout });

    if (scopeType) {
      const normalizedScopeType = normalizeUiScopeType(scopeType) ?? scopeType;
      const scopeBadge = page.locator('[data-testid="ui-context-strip-scope"]').first();
      const scopeVisible = await scopeBadge
        .waitFor({ state: "visible", timeout })
        .then(() => true)
        .catch(() => false);
      if (scopeVisible) {
        await expect(scopeBadge).toContainText(normalizedScopeType, { timeout });
      }
    }

    return true;
  };

  if (await assertContextStrip(8_000)) {
    return;
  }

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});

  if (await assertContextStrip(8_000)) {
    return;
  }

  if (await visibleContextUnavailable.count()) {
    throw new Error(`UI context unavailable while expecting ${email} to be signed in.`);
  }

  const visibleAuthGate = page.locator('[data-testid$="-auth-required"]:visible');
  if (await visibleAuthGate.count()) {
    throw new Error(`Auth gate remained visible while expecting ${email} to be signed in.`);
  }

  const identity = findSupabaseSessionIdentity(await page.context().cookies(), email);
  if (!identity) {
    throw new Error(`No Supabase browser auth session found for ${email}.`);
  }

  const authenticatedShell = page.locator(
    '[data-testid$="-app-shell-sidebar"], [data-testid="navigation-list"], [data-testid$="-dashboard-ready"]',
  ).first();
  await expect(authenticatedShell).toBeVisible({ timeout: 20_000 });
}

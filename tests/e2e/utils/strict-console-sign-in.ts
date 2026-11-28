import { readFileSync } from "node:fs";
import type { BrowserContext, Request } from "@playwright/test";
import * as sweepRoles from "../../../config/dev/sweep-roles.json";
import { isPasswordGrantTokenRequest } from "./auth-request";
import { findSupabaseSessionIdentity } from "./auth-session";
import { getConsoleBaseUrl } from "./base-urls";

export const CONSOLE_AUTH_GATE = "console-auth-required";
export const CONSOLE_SIGNED_IN_SHELL = "ui-context-strip-sign-out";

type SweepRole = keyof typeof sweepRoles;
type Credentials = { email: string; password: string };
const timeout = 10_000;

function readCredentials(role: SweepRole): Credentials {
  try {
    const file = process.env.E2E_SWEEP_CREDENTIALS_FILE?.trim();
    if (!file || !Object.hasOwn(sweepRoles, role)) throw new Error();
    const accounts = JSON.parse(readFileSync(file, "utf8")) as Partial<
      Record<SweepRole, Partial<Credentials>>
    >;
    const account = accounts[role];
    if (
      typeof account?.email !== "string" ||
      typeof account.password !== "string" ||
      !account.email.trim() ||
      !account.password.trim()
    ) {
      throw new Error();
    }
    return { email: account.email.trim(), password: account.password };
  } catch {
    throw new Error("FIXTURE_UNAVAILABLE");
  }
}

function isPasswordGrant(request: Request) {
  return isPasswordGrantTokenRequest({
    method: request.method(),
    url: request.url(),
  });
}

// Use a fresh test context with automatic recording disabled before loading credentials.
export async function strictConsoleSignIn(
  context: BrowserContext,
  role: SweepRole,
  route: string,
) {
  const credentials = readCredentials(role);
  let failure = "SIGN_IN_FAILED/FORM_NOT_READY";
  let passwordRequests = 0;
  let submitted = false;
  try {
    const page = await context.newPage();
    const url = new URL(route, getConsoleBaseUrl());
    const countGrants = (request: Request) => {
      if (isPasswordGrant(request)) passwordRequests += 1;
    };
    page.on("request", countGrants);
    try {
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout });
      const gate = page.getByTestId(CONSOLE_AUTH_GATE);
      const form = page
        .getByTestId(CONSOLE_AUTH_GATE + "-sign-in")
        .and(page.locator('[data-hydrated="true"]'))
        .locator("form");
      await form.waitFor({ state: "visible", timeout });
      const method = form.locator('input[type="radio"][name="method"][value="password"]');
      if (await method.count()) await method.check({ timeout });
      await Promise.all([
        form.locator('input[name="email"]').waitFor({ state: "visible", timeout }),
        form.locator('input[name="password"]').waitFor({ state: "visible", timeout }),
      ]);

      // Playwright's fill step logs the supplied value. Use the native setter so React sees one input event per field.
      const filled = await form.evaluate((element, { email, password }) => {
        const emailInput = element.querySelector<HTMLInputElement>('input[name="email"]');
        const passwordInput = element.querySelector<HTMLInputElement>('input[name="password"]');
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (!emailInput || !passwordInput || !setValue) return false;
        setValue.call(emailInput, email);
        emailInput.dispatchEvent(new Event("input", { bubbles: true }));
        setValue.call(passwordInput, password);
        passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }, credentials, { timeout });
      if (!filled) throw new Error();

      const [response, submission] = await Promise.allSettled([
        page.waitForResponse((result) => isPasswordGrant(result.request()), { timeout }),
        form.locator('button[type="submit"]').click({ timeout }),
      ]);
      submitted = submission.status === "fulfilled";
      if (submitted) failure = "SIGN_IN_FAILED/NO_RESPONSE";
      if (!submitted || response.status === "rejected") throw new Error();
      if (!response.value.ok()) {
        failure = "SIGN_IN_FAILED/REJECTED_" + response.value.status();
        throw new Error();
      }

      failure = "SIGN_IN_FAILED/SHELL_NOT_READY";
      await Promise.all([
        gate.waitFor({ state: "detached", timeout }),
        page.getByTestId(CONSOLE_SIGNED_IN_SHELL).waitFor({ state: "visible", timeout }),
      ]);
      failure = "SIGN_IN_FAILED/IDENTITY_MISMATCH";
      const cookies = await context.cookies(url.origin);
      if (!findSupabaseSessionIdentity(cookies, credentials.email)) throw new Error();

      if (passwordRequests !== 1) throw new Error();
      return page;
    } finally {
      page.off("request", countGrants);
    }
  } catch {
    const wrongRequestCount = passwordRequests > 1 || (submitted && passwordRequests === 0);
    throw new Error(wrongRequestCount ? "SIGN_IN_FAILED/REQUEST_COUNT" : failure);
  }
}

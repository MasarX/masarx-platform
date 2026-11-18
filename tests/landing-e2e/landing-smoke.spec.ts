import { test, expect } from "@playwright/test";
import {
  LANDING_CONTACT_ENDPOINT_MOCK,
  LANDING_CONTACT_ROUTE,
  mockContactEndpoint,
  mockTurnstile,
  patchRuntimeConfig,
  routePayload,
  routePayloadWithDelay,
} from "./helpers";

test.describe("landing smoke", () => {
  test("omits customer references and does not request the marketing feed", async ({ page }) => {
    const endpoint = "/functions/v1/marketing-lead-intake/clients";
    let feedHits = 0;
    await patchRuntimeConfig(page, { clientsEndpoint: endpoint });
    await page.route(`**${endpoint}**`, async (route) => {
      feedHits += 1;
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, clients: [] }),
      });
    });
    for (const route of ["/?motion=off", "/ar/?motion=off"]) {
      await page.goto(route);
      await expect(page.locator("html")).toHaveClass(/js/);
      await expect(page.locator("[data-clients-row], .client-ref, img.client-logo")).toHaveCount(0);
    }
    expect(feedHits).toBe(0);
  });

  test("renders English and navigates to Arabic via toggle", async ({ page }) => {
    await page.goto("/?motion=off");

    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveClass(/js/);
    await expect(page.getByRole("link", { name: "Product" })).toBeVisible();

    await page.locator("[data-lang-toggle]").click();

    await expect(page).toHaveURL(/\/ar\/(\?.*)?$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.getByRole("link", { name: "المنتج" })).toBeVisible();
  });

  test("theme toggle switches between light and dark modes", async ({ page }) => {
    await page.goto("/?motion=off&theme=light");

    const html = page.locator("html");
    const toggle = page.locator("[data-theme-toggle]");

    await expect(html).toHaveAttribute("data-theme", "light");
    await toggle.click();
    await expect(html).toHaveAttribute("data-theme", "dark");

    await toggle.click();
    await expect(html).toHaveAttribute("data-theme", "light");
  });

  for (const storageFailure of ["access", "read", "write"] as const) {
    test(`theme, language, and contact form work when browser storage ${storageFailure} fails`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript((failure) => {
        const denied = () => {
          throw new DOMException("Storage is unavailable", "SecurityError");
        };
        if (failure === "access") {
          Object.defineProperty(window, "localStorage", { configurable: true, get: denied });
        } else if (failure === "read") {
          Storage.prototype.getItem = denied;
        } else {
          Storage.prototype.setItem = () => {
            throw new DOMException("Storage quota exceeded", "QuotaExceededError");
          };
        }
      }, storageFailure);
      await patchRuntimeConfig(page, {
        contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
        turnstileSiteKey: "",
      });
      await mockContactEndpoint(page, routePayload({ ok: true }, 200));

      await page.goto("/");
      const html = page.locator("html");
      await expect(html).toHaveAttribute("data-theme", /light|dark/);
      const initialTheme = await html.getAttribute("data-theme");
      await page.locator("[data-theme-toggle]").click();
      await expect(html).toHaveAttribute("data-theme", initialTheme === "dark" ? "light" : "dark");

      const form = page.locator("[data-contact-form]");
      await form.locator('input[name="full_name"]').fill("Storage Reviewer");
      await form.locator('input[name="email"]').fill("yujvlqmxqjmqsmmgghummosj@example.invalid");
      await form.locator('input[name="organization_name"]').fill("MasarX");
      await form.locator('button[type="submit"]').click();
      await expect(page.locator("[data-contact-status]")).toContainText(/Thanks|under review/i);

      await page.locator("[data-lang-toggle]").click();
      await expect(html).toHaveAttribute("lang", "ar");
      await expect(page.locator("[data-contact-form]")).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  test("login CTA links to configured app URL", async ({ page }) => {
    await patchRuntimeConfig(page, { appUrl: "https://app.example.com/login" });
    await page.goto("/?motion=off");

    const login = page.locator('a[data-runtime-href="appUrl"]');
    await expect(login).toBeVisible();
    await expect(login).toHaveAttribute("href", "https://app.example.com/login");

    await page.locator("[data-lang-toggle]").click();
    await expect(page).toHaveURL(/\/ar\/(\?.*)?$/);
    await expect(login).toHaveAttribute("href", "https://app.example.com/login");
  });

  test("login CTA is hidden when appUrl is unset (mocked runtime)", async ({ page }) => {
    await patchRuntimeConfig(page, { appUrl: "" });
    await page.goto("/?motion=off");
    await expect(page.locator('a[data-runtime-href="appUrl"]')).toBeHidden();
  });

  test("login CTA is shown when appUrl is configured (mocked runtime)", async ({ page }) => {
    await patchRuntimeConfig(page, { appUrl: "https://app.masarx.test" });
    await page.goto("/?motion=off");
    await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "https://app.masarx.test");
  });

  test("login CTA is localized in Arabic when appUrl is configured (mocked runtime)", async ({ page }) => {
    await patchRuntimeConfig(page, { appUrl: "https://app.masarx.test" });
    await page.goto("/ar/?motion=off");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.getByRole("link", { name: "تسجيل الدخول" })).toBeVisible();
    await expect(page.getByRole("link", { name: "تسجيل الدخول" })).toHaveAttribute("href", "https://app.masarx.test");
  });

  test("all in-page links target existing sections", async ({ page }) => {
    await page.goto("/?motion=off");

    const missingTargets = await page.evaluate(() => {
      const hrefs = Array.from(document.querySelectorAll('a[href^="#"]'))
        .map((el) => el.getAttribute("href") || "")
        .filter((href) => href.startsWith("#") && href.length > 1);

      return Array.from(new Set(hrefs))
        .filter((href) => !document.getElementById(href.slice(1)));
    });

    expect(missingTargets).toEqual([]);
  });

  test("primary CTA links navigate to working targets", async ({ page }) => {
    await page.goto("/?motion=off");

    const ctaSelectors = [
      'a[href="#how"]',
      'a[href="#contact"]',
      'a[href="#enterprise"]',
      'a[href="#faq"]',
    ];

    for (const selector of ctaSelectors) {
      const link = page.locator(selector).first();
      await expect(link).toBeVisible();
      await link.click();
      const hash = await page.evaluate(() => window.location.hash);
      expect(hash).toMatch(/^#(how|contact|enterprise|faq)$/);
    }
  });

  test("driver public routes render the onboarding surface", async ({ page }) => {
    const routes = [
      "/drivers?motion=off",
      "/drivers/apply?motion=off",
      "/ar/drivers/apply?motion=off",
    ];

    for (const route of routes) {
      await page.goto(route);
      await expect(page.locator("[data-driver-form]")).toBeVisible();
      await expect(page.locator("[data-driver-status-form]")).toBeVisible();
    }
  });

  test("submits the contact form (mocked)", async ({ page }) => {
    await patchRuntimeConfig(page, {
      contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockContactEndpoint(page, routePayload({ ok: true }, 200));

    await page.goto("/?motion=off");
    const contactForm = page.locator("[data-contact-form]");

    await contactForm.locator('input[name="full_name"]').fill("Landing Reviewer");
    await contactForm.locator('input[name="email"]').fill("lhwmilsokgrmgptsihhuoljt@example.invalid");
    await contactForm.locator('input[name="organization_name"]').fill("MasarX");
    await contactForm.locator('input[name="role"]').fill("Ops");
    await contactForm.locator('textarea[name="notes"]').fill("Test lead.");

    const contactResponse = page.waitForResponse((response) => response.url().includes(LANDING_CONTACT_ENDPOINT_MOCK));
    await contactForm.locator('button[type="submit"]').click();
    const response = await contactResponse;

    await expect(page.locator("[data-contact-status]")).toContainText(/Thanks|under review/i);
    expect(response.ok()).toBeTruthy();
    expect(response.url()).toContain(LANDING_CONTACT_ENDPOINT_MOCK);
  });

  test("guards contact submission while the request is in flight", async ({ page }) => {
    let contactCalls = 0;
    let releaseContact: (() => void) | null = null;
    const contactGate = new Promise<void>((resolve) => {
      releaseContact = resolve;
    });
    await patchRuntimeConfig(page, {
      contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockContactEndpoint(page, async (route) => {
      contactCalls += 1;
      await contactGate;
      await routePayload({ ok: true }, 200)(route);
    });

    await page.goto("/?motion=off");
    const contactForm = page.locator("[data-contact-form]");
    await contactForm.locator('input[name="full_name"]').fill("Landing Reviewer");
    await contactForm.locator('input[name="email"]').fill("rrolmohmqthkyjnjqgzqgxht@example.invalid");
    await contactForm.locator('input[name="organization_name"]').fill("MasarX");
    const previouslyDisabledField = contactForm.locator('input[name="website_url"]');
    await previouslyDisabledField.evaluate((input: HTMLInputElement) => {
      input.disabled = true;
    });

    await contactForm.evaluate((form) => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await expect(contactForm).not.toHaveAttribute("inert", "");
    await expect(page.locator("[data-contact-status]")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator("[data-contact-status]")).toContainText("Sending");
    await expect(contactForm.locator('input[name="full_name"]')).toBeDisabled();
    await expect(contactForm.locator('button[type="submit"]')).toBeDisabled();
    await expect(previouslyDisabledField).toBeDisabled();

    releaseContact?.();
    await expect(page.locator("[data-contact-status]")).toContainText(/Thanks|under review/i);
    await expect(contactForm.locator('input[name="full_name"]')).toBeEnabled();
    await expect(contactForm.locator('input[name="full_name"]')).toHaveValue("");
    await expect(contactForm.locator('button[type="submit"]')).toBeEnabled();
    await expect(previouslyDisabledField).toBeDisabled();
    expect(contactCalls).toBe(1);
  });

  test("releases the contact guard after a failed request and allows retry", async ({ page }) => {
    let contactCalls = 0;
    await patchRuntimeConfig(page, {
      contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockContactEndpoint(page, async (route) => {
      contactCalls += 1;
      if (contactCalls === 1) {
        await routePayloadWithDelay({ ok: false }, 500, 200)(route);
        return;
      }
      await routePayload({ ok: true }, 200)(route);
    });

    await page.goto("/?motion=off");
    const contactForm = page.locator("[data-contact-form]");
    await contactForm.locator('input[name="full_name"]').fill("Landing Reviewer");
    await contactForm.locator('input[name="email"]').fill("ygxlvzlyhqwhoqqyyohliops@example.invalid");
    await contactForm.locator('input[name="organization_name"]').fill("MasarX");

    await contactForm.evaluate((form) => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await expect(contactForm.locator('button[type="submit"]')).toBeDisabled();
    await expect(page.locator("[data-contact-status]")).toContainText("Something went wrong");
    await expect(contactForm.locator('button[type="submit"]')).toBeEnabled();
    expect(contactCalls).toBe(1);

    await contactForm.locator('button[type="submit"]').click();
    await expect(page.locator("[data-contact-status]")).toContainText(/Thanks|under review/i);
    expect(contactCalls).toBe(2);
  });

  test("renews the submitted contact Turnstile token before a failed-request retry", async ({ page }) => {
    const submittedTokens: string[] = [];
    await patchRuntimeConfig(page, {
      contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
      turnstileSiteKey: "1x00000000000000000000AA",
    });
    await mockTurnstile(page);
    await mockContactEndpoint(page, async (route) => {
      submittedTokens.push(String(route.request().postDataJSON().turnstile_token || ""));
      await routePayload(
        submittedTokens.length === 1 ? { ok: false, error: { code: "rate_limited" } } : { ok: true },
        submittedTokens.length === 1 ? 429 : 200,
      )(route);
    });

    await page.goto("/?motion=off");
    const contactForm = page.locator("[data-contact-form]");
    await contactForm.locator('input[name="full_name"]').fill("Landing Reviewer");
    await contactForm.locator('input[name="email"]').fill("rprrgnzgqkiqxhoxtovvnini@example.invalid");
    await contactForm.locator('input[name="organization_name"]').fill("MasarX");
    const turnstileInput = page.locator('[data-turnstile] input[name="cf-turnstile-response"]');
    await expect(turnstileInput).toHaveValue(/^TURNSTILE-TEST-TOKEN-\d+$/);
    const initialToken = await turnstileInput.inputValue();

    await contactForm.locator('button[type="submit"]').click();
    await expect(page.locator("[data-contact-status]")).toContainText("Too many requests");
    await expect(turnstileInput).not.toHaveValue(initialToken);
    await expect(turnstileInput).toHaveValue(/^TURNSTILE-TEST-TOKEN-\d+$/);
    const retryToken = await turnstileInput.inputValue();

    await contactForm.locator('button[type="submit"]').click();
    await expect(page.locator("[data-contact-status]")).toContainText(/Thanks|under review/i);
    expect(retryToken).not.toBe(initialToken);
    expect(submittedTokens).toEqual([initialToken, retryToken]);
  });

  test("shows an error when the contact endpoint fails (mocked)", async ({ page }) => {
    await patchRuntimeConfig(page, {
      contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockContactEndpoint(page, routePayload({ ok: false }, 500));

    await page.goto("/?motion=off");
    const contactForm = page.locator("[data-contact-form]");

    await contactForm.locator('input[name="full_name"]').fill("Landing Reviewer");
    await contactForm.locator('input[name="email"]').fill("lhwmilsokgrmgptsihhuoljt@example.invalid");
    await contactForm.locator('input[name="organization_name"]').fill("MasarX");

    await contactForm.locator('button[type="submit"]').click();

    await expect(page.locator("[data-contact-status]")).toContainText("Something went wrong");
  });

  test("mobile nav: toggle opens/closes, link click closes, Escape closes", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/?motion=off");

    const toggle = page.locator(".nav-toggle");
    const nav = page.locator("#nav-primary");

    // Initially closed.
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(nav).not.toHaveClass(/is-open/);

    // Click opens.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(nav).toHaveClass(/is-open/);

    // Nav link click closes.
    await nav.locator('a[href="#product"]').click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(nav).not.toHaveClass(/is-open/);

    // Reopen and close with Escape.
    await toggle.click();
    await expect(nav).toHaveClass(/is-open/);
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(nav).not.toHaveClass(/is-open/);
  });

  test("shows an error when the contact endpoint returns ok=false (mocked)", async ({ page }) => {
    await patchRuntimeConfig(page, {
      contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockContactEndpoint(
      page,
      routePayload({ ok: false, error: { code: "rate_limited" } }, 200),
    );

    await page.goto("/?motion=off");
    const contactForm = page.locator("[data-contact-form]");

    await contactForm.locator('input[name="full_name"]').fill("Landing Reviewer");
    await contactForm.locator('input[name="email"]').fill("lhwmilsokgrmgptsihhuoljt@example.invalid");
    await contactForm.locator('input[name="organization_name"]').fill("MasarX");

    await contactForm.locator('button[type="submit"]').click();

    await expect(page.locator("[data-contact-status]")).toContainText("Too many requests");
  });

  test("shows deduped confirmation when backend reports duplicate", async ({ page }) => {
    await patchRuntimeConfig(page, {
      contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockContactEndpoint(
      page,
      routePayload({ ok: true, deduped: true }, 200),
    );

    await page.goto("/?motion=off");
    const contactForm = page.locator("[data-contact-form]");

    await contactForm.locator('input[name="full_name"]').fill("Landing Reviewer");
    await contactForm.locator('input[name="email"]').fill("lhwmilsokgrmgptsihhuoljt@example.invalid");
    await contactForm.locator('input[name="organization_name"]').fill("MasarX");
    await contactForm.locator('button[type="submit"]').click();

    await expect(page.locator("[data-contact-status]")).toHaveText("Your request was already received.");
  });

  test("maps backend validation and availability errors to user-facing states", async ({ page }) => {
    const cases = [
      { code: "invalid_email", expected: "Please enter a valid email." },
      { code: "disabled", expected: "Requests are temporarily disabled." },
      { code: "turnstile_required", expected: "We could not load the verification check. Please try again later." },
    ];

    await patchRuntimeConfig(page, {
      contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockContactEndpoint(
      page,
      routePayload({ ok: false, error: { code: cases[0].code } }, 400),
    );

    for (const testCase of cases) {
      await page.unroute(LANDING_CONTACT_ROUTE);
      await page.route(
        LANDING_CONTACT_ROUTE,
        async (route) => routePayload({ ok: false, error: { code: testCase.code } }, 400)(route),
      );

      await page.goto("/?motion=off");
      const contactForm = page.locator("[data-contact-form]");
      await contactForm.locator('input[name="full_name"]').fill("Landing Reviewer");
      await contactForm.locator('input[name="email"]').fill("lhwmilsokgrmgptsihhuoljt@example.invalid");
      await contactForm.locator('input[name="organization_name"]').fill("MasarX");
      await contactForm.locator('button[type="submit"]').click();
      await expect(page.locator("[data-contact-status]")).toContainText(testCase.expected);
      await page.unroute(LANDING_CONTACT_ROUTE);
    }
  });
});

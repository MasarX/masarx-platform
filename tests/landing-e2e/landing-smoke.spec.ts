import { test, expect } from "@playwright/test";
import {
  LANDING_CONTACT_ENDPOINT_MOCK,
  LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
  LANDING_TENANT_SIGNUP_ROUTE,
  mockContactEndpoint,
  mockTenantSignupEndpoint,
  patchRuntimeConfig,
  routePayload,
} from "./helpers";

test.describe("landing smoke", () => {
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

  test("keeps tenant signup CTA visible inside a narrow header", async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 812 });
    await page.goto("/?motion=off");

    await expect(page.locator(".header-actions .btn-primary")).toHaveText("Start signup");
    await expect(page.locator("#contact h2")).toHaveText("Request tenant signup");
    await expect(page.locator("[data-contact-form] button[type='submit']")).toHaveText("Submit signup request");

    const metrics = await page.evaluate(() => {
      const cta = document.querySelector<HTMLElement>(".header-actions .btn-primary");
      const header = document.querySelector<HTMLElement>(".header");
      if (!cta || !header) return null;

      const ctaRect = cta.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      return {
        ctaLeft: ctaRect.left,
        ctaRight: ctaRect.right,
        documentWidth: document.documentElement.scrollWidth,
        headerLeft: headerRect.left,
        headerRight: headerRect.right,
        viewportWidth: window.innerWidth,
      };
    });

    expect(metrics).not.toBeNull();
    if (!metrics) throw new Error("Missing landing header metrics");

    expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(metrics.headerLeft).toBeGreaterThanOrEqual(0);
    expect(metrics.headerRight).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(metrics.ctaLeft).toBeGreaterThanOrEqual(0);
    expect(metrics.ctaRight).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  });

  test("header Start signup CTA lands on the tenant signup form", async ({ page }) => {
    await page.goto("/?motion=off");

    await page.locator(".header-actions .btn-primary").click();

    await expect(page).toHaveURL(/#contact$/);
    await page.waitForFunction(() => {
      const contact = document.querySelector<HTMLElement>("#contact");
      const header = document.querySelector<HTMLElement>(".header");
      if (!contact || !header) return false;

      const top = contact.getBoundingClientRect().top;
      return top >= header.offsetHeight - 1 && top < header.offsetHeight + 48;
    });
    await expect(page.locator("#contact h2")).toBeVisible();
    await expect(page.locator("#contact [data-contact-form]")).toBeVisible();

    const metrics = await page.evaluate(() => {
      const contact = document.querySelector<HTMLElement>("#contact");
      const drivers = document.querySelector<HTMLElement>("#drivers");
      const header = document.querySelector<HTMLElement>(".header");
      if (!contact || !drivers || !header) return null;

      const contactRect = contact.getBoundingClientRect();
      const driversRect = drivers.getBoundingClientRect();
      return {
        contactTop: contactRect.top,
        driversTop: driversRect.top,
        headerHeight: header.offsetHeight,
        viewportHeight: window.innerHeight,
      };
    });

    expect(metrics).not.toBeNull();
    if (!metrics) throw new Error("Missing landing CTA navigation metrics");

    expect(metrics.contactTop).toBeGreaterThanOrEqual(metrics.headerHeight - 1);
    expect(metrics.contactTop).toBeLessThan(metrics.headerHeight + 48);
    expect(metrics.driversTop).toBeGreaterThan(metrics.contactTop + 300);
    expect(metrics.contactTop).toBeLessThan(metrics.viewportHeight / 2);
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
      'a[href="#contact-sales"]',
      'a[href="#contact"]',
      'a[href="#enterprise"]',
      'a[href="#faq"]',
    ];

    for (const selector of ctaSelectors) {
      const link = page.locator(selector).first();
      await expect(link).toBeVisible();
      await link.click();
      const hash = await page.evaluate(() => window.location.hash);
      expect(hash).toMatch(/^#(how|contact-sales|contact|enterprise|faq)$/);
    }
  });

  test("loads customer references from the marketing clients feed", async ({ page }) => {
    const clientsFeed = "/functions/v1/marketing-lead-intake/clients";
    const logoUrl = "https://assets.example.test/masarx-live.svg";
    let clientsFeedHits = 0;

    await patchRuntimeConfig(page, { clientsEndpoint: clientsFeed });
    await page.route(logoUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 32"><text x="0" y="22">MasarX</text></svg>',
      });
    });
    await page.route(`**${clientsFeed}?**`, async (route) => {
      clientsFeedHits += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          clients: [
            { name: "First Tenant Retail Client", logo_url: null },
            { name: "MasarX Live Brand", logo_url: logoUrl },
          ],
        }),
      });
    });

    await page.goto("/?motion=off");

    await expect(page.locator("[data-clients-row] .client-ref")).toHaveCount(2);
    await expect(page.locator("[data-clients-row]")).toContainText("First Tenant Retail Client");
    await expect(page.locator("[data-clients-row] img.client-logo")).toHaveAttribute(
      "src",
      logoUrl,
    );
    expect(clientsFeedHits).toBe(1);
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

  test("submits the marketing contact sales form to the dedicated endpoint (mocked)", async ({ page }) => {
    await patchRuntimeConfig(page, {
      contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockContactEndpoint(page, routePayload({
      ok: true,
      id: "lead-smoke",
      task_id: "task-smoke",
      workflow_run_id: "workflow-smoke",
    }, 200));
    await page.route(LANDING_TENANT_SIGNUP_ROUTE, async (route) => {
      throw new Error(`tenant signup endpoint should not receive marketing lead proof: ${route.request().url()}`);
    });

    await page.goto("/?motion=off");
    await page.locator("#nav-primary").getByRole("link", { name: "Contact sales" }).click();
    await expect(page).toHaveURL(/#contact-sales$/);

    const leadForm = page.locator("[data-marketing-lead-form]");
    await expect(leadForm).toBeVisible();
    await leadForm.locator('input[name="full_name"]').fill("Landing Lead Reviewer");
    await leadForm.locator('input[name="email"]').fill("lead@company.com");
    await leadForm.locator('input[name="organization_name"]').fill("MasarX Lead Co");
    await leadForm.locator('select[name="volume"]').selectOption("10k-60k");
    await leadForm.locator('input[name="role"]').fill("Operations");
    await leadForm.locator('textarea[name="notes"]').fill("Needs external intake and workflow planning.");

    const responsePromise = page.waitForResponse((response) => response.url().includes(LANDING_CONTACT_ENDPOINT_MOCK));
    await leadForm.locator('button[type="submit"]').click();
    const response = await responsePromise;
    const requestPayload = JSON.parse(response.request().postData() || "{}");

    expect(response.ok()).toBeTruthy();
    expect(response.url()).toContain(LANDING_CONTACT_ENDPOINT_MOCK);
    expect(requestPayload).toMatchObject({
      email: "lead@company.com",
      company: "MasarX Lead Co",
      organization_name: "MasarX Lead Co",
      volume: "10k-60k",
      role: "Operations",
      locale: "en",
    });
    expect(requestPayload.marketing).toMatchObject({
      full_name: "Landing Lead Reviewer",
      monthly_volume: "10k-60k",
      role: "Operations",
    });
    await expect(page.locator("[data-marketing-lead-status]")).toContainText("routed for follow-up");
    await expect(page.locator("[data-marketing-lead-request-reference]")).toBeVisible();
    await expect(page.locator("[data-marketing-lead-request-reference-value]")).toHaveText("lead-smoke");
    await expect(page.locator("[data-contact-request-reference]")).toBeHidden();
  });

  test("fails closed when marketing contact success omits backend reference", async ({ page }) => {
    await patchRuntimeConfig(page, {
      contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockContactEndpoint(page, routePayload({ ok: true }, 200));

    await page.goto("/?motion=off");
    const leadForm = page.locator("[data-marketing-lead-form]");
    await leadForm.locator('input[name="full_name"]').fill("Landing Lead Reviewer");
    await leadForm.locator('input[name="email"]').fill("lead-no-reference@company.com");
    await leadForm.locator('input[name="organization_name"]').fill("MasarX Lead Co");
    await leadForm.locator('button[type="submit"]').click();

    await expect(page.locator("[data-marketing-lead-status]")).toContainText("no lead reference");
    await expect(page.locator("[data-marketing-lead-request-reference]")).toBeHidden();
    await expect(leadForm.locator('input[name="email"]')).toHaveValue("lead-no-reference@company.com");
  });

  test("fails closed when deduped marketing contact success omits backend reference", async ({ page }) => {
    await patchRuntimeConfig(page, {
      contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockContactEndpoint(page, routePayload({ ok: true, deduped: true }, 200));

    await page.goto("/?motion=off");
    const leadForm = page.locator("[data-marketing-lead-form]");
    await leadForm.locator('input[name="full_name"]').fill("Landing Lead Reviewer");
    await leadForm.locator('input[name="email"]').fill("lead-deduped-no-reference@company.com");
    await leadForm.locator('input[name="organization_name"]').fill("MasarX Lead Co");
    await leadForm.locator('button[type="submit"]').click();

    await expect(page.locator("[data-marketing-lead-status]")).toContainText("no lead reference");
    await expect(page.locator("[data-marketing-lead-request-reference]")).toBeHidden();
    await expect(leadForm.locator('input[name="email"]')).toHaveValue("lead-deduped-no-reference@company.com");
  });

  test("shows deduped marketing contact reference when backend returns the existing lead", async ({ page }) => {
    await patchRuntimeConfig(page, {
      contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockContactEndpoint(page, routePayload({ ok: true, deduped: true, id: "lead-deduped-smoke" }, 200));

    await page.goto("/?motion=off");
    const leadForm = page.locator("[data-marketing-lead-form]");
    await leadForm.locator('input[name="full_name"]').fill("Landing Lead Reviewer");
    await leadForm.locator('input[name="email"]').fill("lead-deduped@company.com");
    await leadForm.locator('input[name="organization_name"]').fill("MasarX Lead Co");
    await leadForm.locator('button[type="submit"]').click();

    await expect(page.locator("[data-marketing-lead-status]")).toContainText("Already");
    await expect(page.locator("[data-marketing-lead-request-reference]")).toBeVisible();
    await expect(page.locator("[data-marketing-lead-request-reference-value]")).toHaveText("lead-deduped-smoke");
  });

  test("submits the tenant signup form to the dedicated endpoint (mocked)", async ({ page }) => {
    await patchRuntimeConfig(page, {
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTenantSignupEndpoint(page, routePayload({ ok: true, request_id: "tsr-smoke" }, 200));

    await page.goto("/?motion=off");
    const contactForm = page.locator("[data-contact-form]");

    await contactForm.locator('input[name="full_name"]').fill("Landing Reviewer");
    await contactForm.locator('input[name="email"]').fill("lhwmilsokgrmgptsihhuoljt@example.invalid");
    await contactForm.locator('input[name="organization_name"]').fill("MasarX");
    await contactForm.locator('input[name="role"]').fill("Ops");
    await contactForm.locator('textarea[name="notes"]').fill("Test lead.");

    const contactResponse = page.waitForResponse((response) => response.url().includes(LANDING_TENANT_SIGNUP_ENDPOINT_MOCK));
    await contactForm.locator('button[type="submit"]').click();
    const response = await contactResponse;

    await expect(page.locator("[data-contact-status]")).toContainText(/Thanks|under review/i);
    await expect(page.locator("[data-contact-request-reference]")).toBeVisible();
    await expect(page.locator("[data-contact-request-reference-value]")).toHaveText("tsr-smoke");
    expect(response.ok()).toBeTruthy();
    expect(response.url()).toContain(LANDING_TENANT_SIGNUP_ENDPOINT_MOCK);
  });

  test("shows an error when the tenant signup endpoint fails (mocked)", async ({ page }) => {
    await patchRuntimeConfig(page, {
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTenantSignupEndpoint(page, routePayload({ ok: false }, 500));

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

  test("shows an error when the tenant signup endpoint returns ok=false (mocked)", async ({ page }) => {
    await patchRuntimeConfig(page, {
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTenantSignupEndpoint(
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
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTenantSignupEndpoint(
      page,
      routePayload({ ok: true, deduped: true, request_id: "tsr-dedupe" }, 200),
    );

    await page.goto("/?motion=off");
    const contactForm = page.locator("[data-contact-form]");

    await contactForm.locator('input[name="full_name"]').fill("Landing Reviewer");
    await contactForm.locator('input[name="email"]').fill("lhwmilsokgrmgptsihhuoljt@example.invalid");
    await contactForm.locator('input[name="organization_name"]').fill("MasarX");
    await contactForm.locator('button[type="submit"]').click();

    await expect(page.locator("[data-contact-status]")).toContainText("under review");
    await expect(page.locator("[data-contact-request-reference]")).toBeVisible();
    await expect(page.locator("[data-contact-request-reference-value]")).toHaveText("tsr-dedupe");
  });

  test("shows status-aware confirmation when duplicate signup is already approved", async ({ page }) => {
    await patchRuntimeConfig(page, {
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTenantSignupEndpoint(
      page,
      routePayload({
        ok: true,
        deduped: true,
        request_id: "tsr-approved-dedupe",
        queue_status: "approved",
      }, 200),
    );

    await page.goto("/?motion=off");
    const contactForm = page.locator("[data-contact-form]");

    await contactForm.locator('input[name="full_name"]').fill("Landing Reviewer");
    await contactForm.locator('input[name="email"]').fill("lhwmilsokgrmgptsihhuoljt@example.invalid");
    await contactForm.locator('input[name="organization_name"]').fill("MasarX");
    await contactForm.locator('button[type="submit"]').click();

    await expect(page.locator("[data-contact-status]")).toContainText("Request already approved");
    await expect(page.locator("[data-contact-status]")).not.toContainText("under review");
    await expect(page.locator("[data-contact-request-reference-value]")).toHaveText("tsr-approved-dedupe");
  });

  test("shows status-aware confirmation when duplicate signup was rejected", async ({ page }) => {
    await patchRuntimeConfig(page, {
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTenantSignupEndpoint(
      page,
      routePayload({
        ok: true,
        deduped: true,
        request_id: "tsr-rejected-dedupe",
        queue_status: "rejected",
      }, 200),
    );

    await page.goto("/?motion=off");
    const contactForm = page.locator("[data-contact-form]");

    await contactForm.locator('input[name="full_name"]').fill("Landing Reviewer");
    await contactForm.locator('input[name="email"]').fill("lhwmilsokgrmgptsihhuoljt@example.invalid");
    await contactForm.locator('input[name="organization_name"]').fill("MasarX");
    await contactForm.locator('button[type="submit"]').click();

    await expect(page.locator("[data-contact-status]")).toContainText("Request already reviewed and not approved");
    await expect(page.locator("[data-contact-status]")).not.toContainText("under review");
    await expect(page.locator("[data-contact-request-reference-value]")).toHaveText("tsr-rejected-dedupe");
  });

  test("maps backend validation and availability errors to user-facing states", async ({ page }) => {
    const cases = [
      { code: "invalid_email", expected: "Please enter a valid email." },
      { code: "disabled", expected: "Requests are temporarily disabled." },
      { code: "turnstile_required", expected: "Anti-spam check is required but not configured." },
    ];

    await patchRuntimeConfig(page, {
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTenantSignupEndpoint(
      page,
      routePayload({ ok: false, error: { code: cases[0].code } }, 400),
    );

    for (const testCase of cases) {
      await page.unroute(LANDING_TENANT_SIGNUP_ROUTE);
      await page.route(
        LANDING_TENANT_SIGNUP_ROUTE,
        async (route) => routePayload({ ok: false, error: { code: testCase.code } }, 400)(route),
      );

      await page.goto("/?motion=off");
      const contactForm = page.locator("[data-contact-form]");
      await contactForm.locator('input[name="full_name"]').fill("Landing Reviewer");
      await contactForm.locator('input[name="email"]').fill("lhwmilsokgrmgptsihhuoljt@example.invalid");
      await contactForm.locator('input[name="organization_name"]').fill("MasarX");
      await contactForm.locator('button[type="submit"]').click();
      await expect(page.locator("[data-contact-status]")).toContainText(testCase.expected);
      await page.unroute(LANDING_TENANT_SIGNUP_ROUTE);
    }
  });

  test("validates tenant signup email before sending the backend request", async ({ page }) => {
    let backendCalls = 0;
    await patchRuntimeConfig(page, {
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await page.route(LANDING_TENANT_SIGNUP_ROUTE, async (route) => {
      backendCalls += 1;
      await routePayload({ ok: true, request_id: "should-not-submit" }, 200)(route);
    });

    await page.goto("/?motion=off");
    const contactForm = page.locator("[data-contact-form]");
    await contactForm.locator('input[name="full_name"]').fill("Landing Reviewer");
    await contactForm.locator('input[name="email"]').fill("not-an-email");
    await contactForm.locator('input[name="organization_name"]').fill("MasarX");
    await contactForm.locator('button[type="submit"]').click();

    await expect(page.locator("[data-contact-status]")).toContainText("Please enter a valid email.");
    expect(backendCalls).toBe(0);
  });
});

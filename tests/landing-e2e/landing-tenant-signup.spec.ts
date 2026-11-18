import { test, expect, type Page } from "@playwright/test";
import {
  LANDING_CONTACT_ENDPOINT_MOCK,
  LANDING_CONTACT_ROUTE,
  LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
  LANDING_TENANT_SIGNUP_ROUTE,
  mockContactEndpoint,
  mockTenantSignupEndpoint,
  patchRuntimeConfig,
  routePayload,
} from "./helpers";

async function fillTenantSignupForm(page: Page) {
  const form = page.locator("[data-contact-form]");
  await expect(form).toBeVisible();
  await form.locator('input[name="full_name"]').fill("Tenant Reviewer");
  await form.locator('input[name="email"]').fill("ops@example.com");
  await form.locator('input[name="organization_name"]').fill("MasarX Tenant Co");
  await form.locator('input[name="website_url"]').fill("https://tenant.example.com");
  await form.locator('select[name="volume"]').selectOption("10k-60k");
  await form.locator('input[name="role"]').fill("Operations");
  await form.locator('textarea[name="notes"]').fill("Needs tenant onboarding with API intake.");
}

test.describe("landing tenant signup intake", () => {
  test("uses local Turnstile dummy token for loopback tenant signup browser QA", async ({ page }) => {
    await patchRuntimeConfig(page, {
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "1x00000000000000000000AA",
    });
    await mockTenantSignupEndpoint(page, async (route) => {
      const body = route.request().postDataJSON();
      expect(body.turnstile_token).toBe("EXAMPLE_PASSWORD");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, request_id: "tsr-local-turnstile" }),
      });
    });

    await page.goto("/?motion=off");
    await fillTenantSignupForm(page);

    await page.locator("[data-contact-form]").locator('button[type="submit"]').click();

    await expect(page.locator("[data-contact-status]")).toContainText("under review");
    await expect(page.locator("[data-contact-request-reference]")).toBeVisible();
    await expect(page.locator("[data-contact-request-reference-value]")).toHaveText("tsr-local-turnstile");
    await expect(page.locator("[data-contact-request-reference]")).toHaveAttribute(
      "data-request-reference",
      "tsr-local-turnstile",
    );
  });

  test("submits organization signup to the dedicated tenant intake endpoint", async ({ page }) => {
    await patchRuntimeConfig(page, {
      contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockContactEndpoint(page, routePayload({ ok: true }, 200));
    await mockTenantSignupEndpoint(page, routePayload({ ok: true, request_id: "tsr-e2e" }, 200));

    await page.goto("/?motion=off");
    await fillTenantSignupForm(page);

    const responsePromise = page.waitForResponse((response) =>
      response.url().includes(LANDING_TENANT_SIGNUP_ENDPOINT_MOCK),
    );
    await page.locator("[data-contact-form]").locator('button[type="submit"]').click();
    const response = await responsePromise;
    const requestPayload = JSON.parse(response.request().postData() || "{}");

    expect(response.ok()).toBeTruthy();
    expect(response.url()).toContain(LANDING_TENANT_SIGNUP_ENDPOINT_MOCK);
    expect(requestPayload).toMatchObject({
      email: "ops@example.com",
      full_name: "Tenant Reviewer",
      organization_name: "MasarX Tenant Co",
      company: "MasarX Tenant Co",
      website_url: "https://tenant.example.com",
      volume: "10k-60k",
      role: "Operations",
      locale: "en",
    });
    expect(requestPayload.marketing).toMatchObject({
      monthly_volume: "10k-60k",
      role: "Operations",
    });
    await expect(page.locator("[data-contact-status]")).toContainText("under review");
    await expect(page.locator("[data-contact-request-reference]")).toBeVisible();
    await expect(page.locator("[data-contact-request-reference-value]")).toHaveText("tsr-e2e");
    await expect(page.locator("[data-contact-request-reference]")).toHaveAttribute(
      "data-request-reference",
      "tsr-e2e",
    );
  });

  test("shows Arabic request reference after tenant signup success", async ({ page }) => {
    await patchRuntimeConfig(page, {
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTenantSignupEndpoint(page, routePayload({ ok: true, request_id: "tsr-arabic" }, 200));

    await page.goto("/ar?motion=off");
    await fillTenantSignupForm(page);
    await page.locator("[data-contact-form]").locator('button[type="submit"]').click();

    await expect(page.locator("[data-contact-status]")).toContainText("قيد المراجعة");
    await expect(page.locator("[data-contact-request-reference]")).toBeVisible();
    await expect(page.locator("[data-contact-request-reference]")).toContainText("مرجع الطلب");
    await expect(page.locator("[data-contact-request-reference-value]")).toHaveText("tsr-arabic");
  });

  test("submits Arabic and long tenant signup values without losing backend request reference", async ({ page }) => {
    await patchRuntimeConfig(page, {
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTenantSignupEndpoint(page, routePayload({ ok: true, request_id: "tsr-arabic-long" }, 200));

    await page.goto("/ar?motion=off");
    const form = page.locator("[data-contact-form]");
    await expect(form).toBeVisible();
    await form.locator('input[name="full_name"]').fill("أحمد المشرف الأول للعمليات");
    await form.locator('input[name="email"]').fill("arabic.ops@example.com");
    await form
      .locator('input[name="organization_name"]')
      .fill("شركة الاختبار الدولية للخدمات اللوجستية ذات الاسم الطويل جدا");
    await form.locator('input[name="website_url"]').fill("https://tenant-ar.example.com");
    await form.locator('select[name="volume"]').selectOption("10k-60k");
    await form.locator('input[name="role"]').fill("مدير العمليات");
    await form.locator('textarea[name="notes"]').fill("نحتاج إلى إعداد المستأجر مع استقبال API وwebhook.");

    const responsePromise = page.waitForResponse((response) =>
      response.url().includes(LANDING_TENANT_SIGNUP_ENDPOINT_MOCK),
    );
    await form.locator('button[type="submit"]').click();
    const response = await responsePromise;
    const requestPayload = JSON.parse(response.request().postData() || "{}");

    expect(requestPayload).toMatchObject({
      email: "arabic.ops@example.com",
      full_name: "أحمد المشرف الأول للعمليات",
      organization_name: "شركة الاختبار الدولية للخدمات اللوجستية ذات الاسم الطويل جدا",
      company: "شركة الاختبار الدولية للخدمات اللوجستية ذات الاسم الطويل جدا",
      website_url: "https://tenant-ar.example.com",
      volume: "10k-60k",
      role: "مدير العمليات",
      locale: "ar",
    });
    expect(requestPayload.notes).toContain("webhook");
    expect(requestPayload.marketing).toMatchObject({
      monthly_volume: "10k-60k",
      role: "مدير العمليات",
    });
    await expect(page.locator("[data-contact-request-reference]")).toBeVisible();
    await expect(page.locator("[data-contact-request-reference-value]")).toHaveText("tsr-arabic-long");
  });

  test("deduped tenant signup still shows the backend request reference", async ({ page }) => {
    await patchRuntimeConfig(page, {
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTenantSignupEndpoint(page, routePayload({ ok: true, deduped: true, request_id: "tsr-deduped" }, 200));

    await page.goto("/?motion=off");
    await fillTenantSignupForm(page);
    await page.locator("[data-contact-form]").locator('button[type="submit"]').click();

    await expect(page.locator("[data-contact-status]")).toContainText("already received");
    await expect(page.locator("[data-contact-request-reference]")).toBeVisible();
    await expect(page.locator("[data-contact-request-reference-value]")).toHaveText("tsr-deduped");
  });

  test("fails closed when tenant signup success omits request reference", async ({ page }) => {
    await patchRuntimeConfig(page, {
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTenantSignupEndpoint(page, routePayload({ ok: true }, 200));

    await page.goto("/?motion=off");
    await fillTenantSignupForm(page);
    await page.locator("[data-contact-form]").locator('button[type="submit"]').click();

    await expect(page.locator("[data-contact-status]")).toContainText("no request reference");
    await expect(page.locator("[data-contact-request-reference]")).toBeHidden();
    await expect(page.locator('[data-contact-form] input[name="email"]')).toHaveValue("ops@example.com");
  });

  test("fails closed when tenant signup endpoint is missing", async ({ page }) => {
    let contactHits = 0;
    await patchRuntimeConfig(page, {
      contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
      tenantSignupEndpoint: "",
      turnstileSiteKey: "",
    });
    await page.route(LANDING_CONTACT_ROUTE, async (route) => {
      contactHits += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto("/?motion=off");
    await fillTenantSignupForm(page);
    await page.locator("[data-contact-form]").locator('button[type="submit"]').click();

    await expect(page.locator("[data-contact-status]")).toContainText(
      "Signup is temporarily unavailable.",
    );
    expect(contactHits).toBe(0);
  });

  test("maps tenant intake validation and throttling errors", async ({ page }) => {
    await patchRuntimeConfig(page, {
      tenantSignupEndpoint: LANDING_TENANT_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });

    const cases = [
      { code: "invalid_email", expected: "Please enter a valid email." },
      { code: "rate_limited", expected: "Too many requests. Please wait and try again." },
      { code: "public_intake_not_allowed", expected: "Requests are temporarily disabled." },
    ];

    for (const testCase of cases) {
      await page.unroute(LANDING_TENANT_SIGNUP_ROUTE).catch(() => {});
      await mockTenantSignupEndpoint(
        page,
        routePayload({ ok: false, error: { code: testCase.code } }, 400),
      );

      await page.goto("/?motion=off");
      await fillTenantSignupForm(page);
      await page.locator("[data-contact-form]").locator('button[type="submit"]').click();

      await expect(page.locator("[data-contact-status]")).toContainText(testCase.expected);
    }
  });
});

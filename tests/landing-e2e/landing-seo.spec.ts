import { test, expect } from "@playwright/test";

test.describe("landing SEO meta tags", () => {
  test("EN page has required OG and SEO meta tags", async ({ page }) => {
    await page.goto("/?motion=off");

    await expect(page).toHaveTitle(/MasarX/);

    const description = page.locator('meta[name="description"]');
    await expect(description).toHaveAttribute("content", /.+/);

    const ogType = page.locator('meta[property="og:type"]');
    await expect(ogType).toHaveAttribute("content", "website");

    const ogTitle = page.locator('meta[property="og:title"]');
    await expect(ogTitle).toHaveAttribute("content", /.+/);

    const ogDescription = page.locator('meta[property="og:description"]');
    await expect(ogDescription).toHaveAttribute("content", /.+/);

    const ogImage = page.locator('meta[property="og:image"]');
    await expect(ogImage).toHaveAttribute("content", /.+/);

    const twitterCard = page.locator('meta[name="twitter:card"]');
    await expect(twitterCard).toHaveAttribute("content", "summary_large_image");

    const twitterTitle = page.locator('meta[name="twitter:title"]');
    await expect(twitterTitle).toHaveAttribute("content", /.+/);

    const twitterDescription = page.locator('meta[name="twitter:description"]');
    await expect(twitterDescription).toHaveAttribute("content", /.+/);
  });

  test("EN page has JSON-LD Organization schema (when LANDING_SITE_URL is set)", async ({ page }) => {
    await page.goto("/?motion=off");

    const jsonLdScripts = page.locator('script[type="application/ld+json"]');
    const count = await jsonLdScripts.count();

    // JSON-LD is only injected when LANDING_SITE_URL is set at build time.
    if (count === 0) {
      test.skip();
      return;
    }

    const jsonLdContent = await jsonLdScripts.first().textContent();
    expect(jsonLdContent).toBeTruthy();

    const parsed = JSON.parse(jsonLdContent!);
    const schemas = Array.isArray(parsed) ? parsed : [parsed];

    const orgSchema = schemas.find(
      (s: { "@type"?: string }) => s["@type"] === "Organization"
    );
    expect(orgSchema).toBeTruthy();
    expect(orgSchema.name).toBe("MasarX");
  });
});

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

  test("EN page has JSON-LD Organization schema for the configured site URL", async ({ page, baseURL }) => {
    // The local Playwright server uses its baseURL as LANDING_SITE_URL.
    const configuredSiteUrl = process.env.LANDING_SITE_URL?.trim() || baseURL;
    if (!configuredSiteUrl) {
      throw new Error("Landing E2E requires a configured site URL");
    }
    const { origin, pathname } = new URL(configuredSiteUrl);
    const siteUrl = (origin + pathname).replace(/\/+$/, "");

    await page.goto("/?motion=off");

    const jsonLdScript = page.locator('script[type="application/ld+json"]').first();
    await expect(jsonLdScript).toBeAttached();

    const parsed = JSON.parse((await jsonLdScript.textContent()) ?? "");
    const schemas = Array.isArray(parsed) ? parsed : [parsed];
    expect(schemas).toContainEqual(
      expect.objectContaining({
        "@type": "Organization",
        name: "MasarX",
        url: siteUrl,
      })
    );
  });
});

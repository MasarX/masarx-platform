import { expect, test } from "@playwright/test";

export function registerPublicAuthTests(app: "console" | "portal", basePath: string) {
  test.describe(`${app} public authentication security`, () => {
    test("anonymous users see an accessible sign-in form with empty submission disabled", async ({ page }) => {
      await page.goto(basePath || "/");
      const signIn = page.getByTestId(`${app}-auth-required-sign-in`);
      await expect(signIn).toBeVisible();
      await expect(signIn).toHaveAttribute("data-hydrated", "true");
      await expect(signIn.locator('input[type="email"]')).toHaveAccessibleName(/.+/);
      await expect(signIn.getByRole("button", { name: /.+/ })).toBeDisabled();
    });

    test("callback redirects remain on this app for untrusted return URLs", async ({ request, baseURL }) => {
      const origin = new URL(baseURL!).origin;
      for (const next of [
        "https://untrusted.example.test/account",
        "//untrusted.example.test/account",
        "/\\untrusted.example.test/account",
      ]) {
        const response = await request.get(`${basePath}/auth/callback`, {
          params: { next },
          maxRedirects: 0,
        });
        expect(response.status()).toBe(307);
        expect(response.headers().location).toMatch(/^\/(?![\\/])/);
        expect(new URL(response.headers().location, baseURL).origin).toBe(origin);
        expect(new URL(response.headers().location, baseURL).pathname).toBe("/");
      }
    });

    test("callback preserves a safe return route and its query", async ({ request, baseURL }) => {
      const response = await request.get(`${basePath}/auth/callback`, {
        params: { next: "/resources/shipments?status=ready#details" },
        maxRedirects: 0,
      });
      expect(response.status()).toBe(307);
      expect(response.headers().location).toMatch(/^\/(?![\\/])/);
      const target = new URL(response.headers().location, baseURL);
      expect(target.origin).toBe(new URL(baseURL!).origin);
      expect(`${target.pathname}${target.search}${target.hash}`).toBe(
        "/resources/shipments?status=ready#details",
      );
    });

    test("callback ignores forged proxy and Host headers when choosing its return route", async ({ request, baseURL }) => {
      const response = await request.get(`${basePath}/auth/callback`, {
        params: { next: "/resources/shipments?status=ready#details" },
        headers: {
          host: "untrusted.example.test",
          "x-forwarded-host": "untrusted.example.test",
          "x-forwarded-proto": "https",
        },
        maxRedirects: 0,
      });
      expect(response.status()).toBe(307);
      expect(response.headers().location).toBe("/resources/shipments?status=ready#details");
      expect(new URL(response.headers().location, baseURL).origin).toBe(new URL(baseURL!).origin);
    });

    test("cross-site sign-out requests are rejected before changing authentication", async ({ request }) => {
      const authCookies = async () => (await request.storageState()).cookies.filter(
        (cookie) => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name),
      );
      const initialCookies = await authCookies();
      const untrustedHeaders: Array<Record<string, string>> = [
        { "sec-fetch-site": "cross-site" },
        { origin: "https://untrusted.example.test", "sec-fetch-site": "same-site" },
      ];
      for (const headers of untrustedHeaders) {
        const response = await request.get(`${basePath}/auth/sign-out`, {
          headers,
          maxRedirects: 0,
        });
        expect(response.status()).toBe(403);
        expect(response.headers().location).toBeUndefined();
        expect(response.headers()["set-cookie"] ?? "").not.toMatch(/\bsb-[^=;,\s]*-auth-token/);
        expect(await authCookies()).toEqual(initialCookies);
        expect(await response.json()).toMatchObject({
          code: expect.stringMatching(/cross_site_request_rejected|origin_mismatch/),
        });
      }
    });
  });
}

import { test, expect, type Page } from "@playwright/test";

function rootScrollBehavior(page: Page) {
  return page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior);
}

// Motion off must also stop smooth scrolling on the root scroller (#592).
test.describe("landing motion", () => {
  for (const path of ["/", "/ar/"]) {
    test(`motion off makes the root scroller jump on ${path}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(`${path}?motion=off`);
      await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
      expect(await rootScrollBehavior(page)).toBe("auto");
    });

    test(`motion on keeps smooth root scrolling on ${path}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("data-motion", "on");
      expect(await rootScrollBehavior(page)).toBe("smooth");
    });
  }
});

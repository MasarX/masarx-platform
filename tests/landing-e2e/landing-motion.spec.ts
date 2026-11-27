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

// Landing and public tracking motion (#493, WCAG 2.2.2): an explicit choice wins,
// then the OS reduced-motion setting, then motion on; a named control pauses and resumes it.
const PAGES = [
  { path: "/", arPath: "/ar/" },
  { path: "/track/", arPath: "/ar/track/" },
];

function runningInfiniteAnimations(page: Page) {
  return page.evaluate(
    () =>
      document
        .getAnimations()
        .filter((a) => a.playState === "running" && a.effect?.getTiming().iterations === Infinity).length,
  );
}

function storedMotion(page: Page) {
  return page.evaluate(() => ({
    choice: localStorage.getItem("masarx-motion"),
    legacy: localStorage.getItem("masarx_motion"),
  }));
}

for (const target of PAGES) {
  test.describe(`motion on ${target.path}`, () => {
    test("reduced motion turns motion off when no choice is stored", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(target.path);
      const html = page.locator("html");
      await expect(html).toHaveClass(/js/);
      await expect(html).toHaveAttribute("data-motion", "off");
      await expect(page.getByRole("button", { name: "Play motion" })).toBeVisible();
      expect(await runningInfiniteAnimations(page)).toBe(0);
      expect(await storedMotion(page)).toEqual({ choice: null, legacy: null });
    });

    test("a state stored by older builds does not override reduced motion", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("masarx_motion", "on"));
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(target.path);
      await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
    });

    test("with no choice, motion follows a live OS change", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(target.path);
      const html = page.locator("html");
      await expect(html).toHaveAttribute("data-motion", "on");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(html).toHaveAttribute("data-motion", "off");
      await expect(page.getByRole("button", { name: "Play motion" })).toBeVisible();
    });

    test("the control pauses and resumes motion from the keyboard and the choice is remembered", async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(target.path);
      const html = page.locator("html");
      await expect(html).toHaveAttribute("data-motion", "on");
      expect(await runningInfiniteAnimations(page)).toBeGreaterThan(0);

      const pause = page.getByRole("button", { name: "Pause motion" });
      await expect(pause).toBeVisible();
      await pause.focus();
      await page.keyboard.press("Enter");
      await expect(html).toHaveAttribute("data-motion", "off");
      expect(await runningInfiniteAnimations(page)).toBe(0);
      expect((await storedMotion(page)).choice).toBe("off");

      await page.reload();
      await expect(html).toHaveAttribute("data-motion", "off");
      expect(await runningInfiniteAnimations(page)).toBe(0);

      const play = page.getByRole("button", { name: "Play motion" });
      await play.focus();
      await page.keyboard.press("Enter");
      await expect(html).toHaveAttribute("data-motion", "on");
      expect((await storedMotion(page)).choice).toBe("on");

      // An explicit choice to keep motion on wins over the OS setting.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.reload();
      await expect(html).toHaveAttribute("data-motion", "on");
    });

    test("the control is named in Arabic", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(target.arPath);
      await expect(page.locator("html")).toHaveAttribute("lang", "ar");
      await page.getByRole("button", { name: "إيقاف الحركة" }).click();
      await expect(page.getByRole("button", { name: "تشغيل الحركة" })).toBeVisible();
    });
  });
}

import * as fs from "fs";
import * as path from "path";
import { test, expect, type Page } from "@playwright/test";

// Landing and public tracking follow the shared theme contract (#162 slice 2).
const sharedThemeSource = fs.readFileSync(
  path.resolve(process.cwd(), "packages/ui/src/theme.tsx"),
  "utf8",
);
const SHARED_THEME_STORAGE_KEY = /THEME_STORAGE_KEY = "([^"]+)"/.exec(
  sharedThemeSource,
)?.[1];
const LEGACY_THEME_STORAGE_KEY = "masarx_theme";

function storedThemes(page: Page) {
  return page.evaluate(
    ([sharedKey, legacyKey]) => ({
      shared: localStorage.getItem(sharedKey),
      legacy: localStorage.getItem(legacyKey),
    }),
    [SHARED_THEME_STORAGE_KEY!, LEGACY_THEME_STORAGE_KEY] as const,
  );
}

test.describe("landing theme", () => {
  test("app.js uses the shared theme storage key", () => {
    expect(SHARED_THEME_STORAGE_KEY).toBe("masarx-ui-theme");
    const appSource = fs.readFileSync(
      path.resolve(process.cwd(), "docs/marketing/landing-v2/app.js"),
      "utf8",
    );
    expect(appSource).toContain(
      `const THEME_STORAGE_KEY = '${SHARED_THEME_STORAGE_KEY}';`,
    );
  });

  for (const route of ["/?motion=off", "/track/?motion=off"]) {
    test(`an untouched visit to ${route} follows the OS live and stores nothing`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto(route);
      const html = page.locator("html");
      await expect(html).toHaveClass(/js/);
      await expect(html).toHaveAttribute("data-theme", "dark");

      await page.emulateMedia({ colorScheme: "light" });
      await expect(html).toHaveAttribute("data-theme", "light");

      await page.emulateMedia({ colorScheme: "dark" });
      await expect(html).toHaveAttribute("data-theme", "dark");
      expect(await storedThemes(page)).toEqual({ shared: null, legacy: null });
    });
  }

  test("the toggle stores an explicit choice in the shared key and ignores later OS changes", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/?motion=off");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "light");

    await page.locator("[data-theme-toggle]").click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    expect(await storedThemes(page)).toEqual({ shared: "dark", legacy: null });

    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    await expect(html).toHaveClass(/js/);
    await expect(html).toHaveAttribute("data-theme", "dark");
  });

  test("?theme= overrides the OS and a stored choice", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/?motion=off");
    await page.evaluate(
      (key) => localStorage.setItem(key, "dark"),
      SHARED_THEME_STORAGE_KEY!,
    );

    await page.goto("/?motion=off&theme=light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect((await storedThemes(page)).shared).toBe("light");
  });

  test("a choice saved under the old landing key moves to the shared key once", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/?motion=off");
    await page.evaluate(
      (key) => localStorage.setItem(key, "dark"),
      LEGACY_THEME_STORAGE_KEY,
    );

    await page.reload();
    const html = page.locator("html");
    await expect(html).toHaveClass(/js/);
    await expect(html).toHaveAttribute("data-theme", "dark");
    expect(await storedThemes(page)).toEqual({ shared: "dark", legacy: null });
  });
});

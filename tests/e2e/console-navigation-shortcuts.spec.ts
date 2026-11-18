import { test, expect } from "@playwright/test";
import { loadDemoContext, pickConsoleUser } from "./utils/demo-accounts";
import { expectSignedIn } from "./utils/auth";
import { getConsoleBaseUrl } from "./utils/base-urls";
import { assertNoAppErrorReload } from "./utils/error-guards";
import { assertSingleAppShellSidebar, waitForAppShellHydrated } from "./utils/layout-guards";
import { isStrictE2EEnv } from "./utils/env";
import { gotoEnsuringSignedIn } from "./utils/session";

const demo = loadDemoContext();
const strict = isStrictE2EEnv();

test.describe("console navigation and keyboard shortcuts", () => {
  test.skip(!demo.available && !strict, demo.reason ?? "Demo accounts missing.");

  test.beforeEach(async ({ page }) => {
    const user = pickConsoleUser(demo);
    if (!user?.email || !demo.password) throw new Error(demo.reason ?? "Console demo credentials are required.");
    await gotoEnsuringSignedIn({
      page, url: getConsoleBaseUrl(), authTestId: "console-auth-required",
      email: user.email, password: demo.password, timeoutMs: 60_000,
    });
    await expectSignedIn(page, user.email, user.scope_type);
    await waitForAppShellHydrated(page, "console");
  });

  test("sidebar toggle collapses and expands the receiving shell", async ({ page }) => {
    await assertSingleAppShellSidebar(page, "console");
    const sidebar = page.getByTestId("console-app-shell-sidebar");
    const toggle = page.getByTestId("console-app-shell-sidebar-toggle-main");
    const initialLabel = await toggle.getAttribute("aria-label");
    if (!initialLabel) throw new Error("The sidebar toggle must have an accessible name.");
    await expect(sidebar).toBeVisible();
    await toggle.click();
    await expect(toggle).not.toHaveAttribute("aria-label", initialLabel);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-label", initialLabel);
    await assertNoAppErrorReload(page);
  });

  test("command palette opens from the keyboard and dismisses with Escape", async ({ page }) => {
    await page.keyboard.press("Control+k");
    const search = page.getByTestId("console-command-palette-search");
    await expect(search).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(search).not.toBeVisible();
    await assertNoAppErrorReload(page);
  });

  test("question mark opens the shortcuts help and Escape dismisses it", async ({ page }) => {
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await page.keyboard.press("?");
    await expect(help).toBeVisible();
    await expect(help.getByText("Show keyboard shortcuts")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(help).not.toBeVisible();
    await assertNoAppErrorReload(page);
  });
});

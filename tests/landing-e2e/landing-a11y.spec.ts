import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("landing accessibility", () => {
  test("EN page has no critical or serious axe violations", async ({ page }) => {
    await page.goto("/?motion=off");

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();

    const serious = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious"
    );

    expect(serious, formatViolations(serious)).toHaveLength(0);
  });

  test("AR page has no critical or serious axe violations", async ({ page }) => {
    await page.goto("/ar/?motion=off");

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();

    const serious = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious"
    );

    expect(serious, formatViolations(serious)).toHaveLength(0);
  });
});

function formatViolations(violations: { id: string; description: string; impact?: string | null }[]) {
  if (!violations.length) return "No violations";
  return violations
    .map((v) => `[${v.impact}] ${v.id}: ${v.description}`)
    .join("\n");
}

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// WCAG 2.2 AA axe pass over landing and public tracking (#301), in both themes,
// both languages and at desktop and phone width. Each run writes its axe JSON as evidence.
const PAGES = [
  { id: "landing-en", path: "/", lang: "en" },
  { id: "landing-ar", path: "/ar/", lang: "ar" },
  { id: "track-en", path: "/track/", lang: "en" },
  { id: "track-ar", path: "/ar/track/", lang: "ar" },
];
const VARIANTS = [
  { id: "light-1440", theme: "light", width: 1440, height: 900 },
  { id: "dark-1440", theme: "dark", width: 1440, height: 900 },
  { id: "light-390", theme: "light", width: 390, height: 844 },
  { id: "dark-390", theme: "dark", width: 390, height: 844 },
];
const WCAG22_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const EVIDENCE_DIR = process.env.A11Y_EVIDENCE_DIR || join("test-results", "a11y-evidence");

for (const variant of VARIANTS) {
  for (const target of PAGES) {
    test(`a11y wcag22 ${variant.id}: ${target.id}`, async ({ page }) => {
      await page.setViewportSize({ width: variant.width, height: variant.height });
      await page.goto(`${target.path}?motion=off&theme=${variant.theme}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", variant.theme);
      await expect(page.locator("html")).toHaveAttribute("lang", target.lang);

      const results = await new AxeBuilder({ page }).withTags(WCAG22_AA_TAGS).analyze();

      mkdirSync(EVIDENCE_DIR, { recursive: true });
      writeFileSync(
        join(EVIDENCE_DIR, `landing--${variant.id}--${target.id}.json`),
        JSON.stringify(
          {
            screen: target.id,
            route: target.path,
            variant,
            tags: WCAG22_AA_TAGS,
            axeVersion: results.testEngine.version,
            timestamp: results.timestamp,
            violations: results.violations,
            incomplete: results.incomplete.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.length })),
            passes: results.passes.map(({ id }) => id),
          },
          null,
          2
        )
      );

      const serious = results.violations
        .filter((v) => v.impact === "critical" || v.impact === "serious")
        .map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
      expect(serious, `serious/critical WCAG 2.2 AA violations on ${target.id} (${variant.id})`).toEqual([]);
    });
  }
}

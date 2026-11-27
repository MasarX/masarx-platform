import { test, expect } from "@playwright/test";

// The tracking request banner (#464) keeps text and badge at WCAG 2.2 AA 4.5:1 (1.4.3)
// for every tone in both themes, measured from the browser's computed colors.
const THEMES = ["light", "dark"] as const;
const TONES = ["success", "warning", "danger"] as const;
const TEXT = 4.5;

type Rgba = [number, number, number, number];

// Parses every rgb()/rgba()/color(srgb) value in a computed style string.
function colors(value: string): Rgba[] {
  const out: Rgba[] = [];
  for (const m of value.matchAll(/rgba?\(([^)]+)\)|color\(srgb ([^)]+)\)/g)) {
    if (m[1]) {
      const [r, g, b, a = 1] = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      out.push([r, g, b, a]);
    } else {
      const [r, g, b, a = 1] = m[2].split(/[\s/]+/).filter(Boolean).map(Number);
      out.push([r * 255, g * 255, b * 255, a]);
    }
  }
  return out;
}

const over = (fg: Rgba, bg: Rgba): Rgba => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as Rgba;
const luminance = ([r, g, b]: Rgba) =>
  [r, g, b]
    .map((v) => v / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
function contrast(fg: Rgba, bg: Rgba) {
  const [hi, lo] = [luminance(over(fg, bg)), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("contrast helper matches known values", () => {
  expect(contrast([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 5);
  expect(colors("linear-gradient(135deg, color(srgb 1 1 1), rgba(0, 0, 0, 0.5))")).toEqual([
    [255, 255, 255, 1],
    [0, 0, 0, 0.5],
  ]);
});

for (const theme of THEMES) {
  test(`request banner text and badge meet 4.5:1 in the ${theme} theme`, async ({ page }) => {
    await page.goto(`/track/?motion=off&theme=${theme}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

    for (const tone of TONES) {
      const styles = await page.evaluate((t) => {
        const banner = document.querySelector<HTMLElement>("[data-track-request-banner]")!;
        const badge = banner.querySelector<HTMLElement>("[data-track-request-banner-badge]")!;
        const text = banner.querySelector<HTMLElement>("[data-track-request-banner-text]")!;
        banner.hidden = false;
        banner.dataset.tone = t;
        badge.textContent = "Status";
        text.textContent = "Synthetic request outcome";
        const read = (el: Element) => getComputedStyle(el);
        return {
          page: read(document.body).backgroundColor,
          banner: read(banner).backgroundImage,
          badgeBg: read(badge).backgroundColor,
          badgeText: read(badge).color,
          text: read(text).color,
        };
      }, tone);

      const pageBg = over(colors(styles.page)[0], [255, 255, 255, 1]);
      const stops = colors(styles.banner).map((stop) => over(stop, pageBg));
      expect(stops.length, `${tone} banner gradient stops: ${styles.banner}`).toBeGreaterThanOrEqual(2);
      const [textColor] = colors(styles.text);
      const [badgeText] = colors(styles.badgeText);
      for (const stop of stops) {
        expect(contrast(textColor, stop), `${theme} ${tone} text on ${styles.banner}`).toBeGreaterThanOrEqual(TEXT);
        const badgeBg = over(colors(styles.badgeBg)[0], stop);
        expect(contrast(badgeText, badgeBg), `${theme} ${tone} badge on ${styles.badgeBg}`).toBeGreaterThanOrEqual(TEXT);
      }
    }
  });
}

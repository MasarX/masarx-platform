const fs = require("fs");
const path = require("path");
const {
  readSharedUiTokenCss,
  sharedUiTokenCss,
} = require("../../../scripts/frontend/landing-shared-tokens");

// #162 slice 3: landing names that equal a shared token alias it, and each
// alias still resolves to the value the landing shipped before.
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const appCss = fs.readFileSync(path.join(repoRoot, "docs/marketing/landing-v2/app.css"), "utf8");
// The token rules sit at the top of app.css, before the first element rule.
const tokenCss = readSharedUiTokenCss(repoRoot) + appCss.slice(0, appCss.indexOf("\n* {"));

const ALIASES = {
  light: { "--bg": "#FAFBFE", "--text": "#0F172A", "--brand": "#4F46E5", "--surface-strong": "#FFFFFF" },
  dark: { "--bg": "#0B1121", "--text": "#F1F5F9" },
};
// Values that really differ stay landing literals in the dark theme.
const DARK_OVERRIDES = { "--brand": "#4F46E5", "--surface-strong": "#111827" };

function themeProps(theme) {
  const selectors = new Set([":root", "html", 'html[data-variant="ai"]', `html[data-theme="${theme}"]`]);
  if (theme === "dark") selectors.add(':root[data-theme="dark"]');
  const props = {};
  for (const [, selector, body] of tokenCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.has(selector.replace(/\/\*[\s\S]*?\*\//g, "").trim())) continue;
    for (const declaration of body.split(";")) {
      const colon = declaration.indexOf(":");
      const name = declaration.slice(0, colon).trim();
      if (colon > 0 && name.startsWith("--")) props[name] = declaration.slice(colon + 1).trim();
    }
  }
  return props;
}

function resolveHex(props, name) {
  const value = props[name].replace(/var\((--[\w-]+)\)/g, (_, ref) => props[ref]);
  const rgb = /^rgb\((\d+) (\d+) (\d+)\)$/.exec(value);
  if (!rgb) return value.toUpperCase();
  return `#${rgb.slice(1).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

describe("landing shared tokens", () => {
  test("the build copies only the shared --ui-* tokens for both themes", () => {
    const css = readSharedUiTokenCss(repoRoot);
    expect(css).toMatch(/^:root \{\n {2}--ui-paper: 250 251 254;/);
    expect(css).toContain(':root[data-theme="dark"] {\n  --ui-paper: 11 17 33;');
    expect(css).not.toMatch(/color-scheme|--font-|--app-font-/);
    expect(() => sharedUiTokenCss(".x { --ui-paper: 1 2 3; }")).toThrow(/no ":root" block/);
  });

  for (const theme of ["light", "dark"]) {
    test(`${theme} aliases resolve to the shared tokens with unchanged values`, () => {
      const props = themeProps(theme);
      for (const [name, shipped] of Object.entries(ALIASES[theme])) {
        expect([name, props[name]]).toEqual([name, expect.stringMatching(/^rgb\(var\(--ui-[a-z-]+\)\)$/)]);
        expect([name, resolveHex(props, name)]).toEqual([name, shipped]);
      }
    });
  }

  test("dark keeps the landing values that differ from the shared tokens", () => {
    const props = themeProps("dark");
    for (const [name, shipped] of Object.entries(DARK_OVERRIDES)) {
      expect([name, resolveHex(props, name)]).toEqual([name, shipped]);
    }
  });
});

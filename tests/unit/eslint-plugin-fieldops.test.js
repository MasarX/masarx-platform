/**
 * tests/unit/eslint-plugin-fieldops.test.js
 *
 * RuleTester coverage for the three custom
 * FieldOps lint rules:
 *
 *   - no-hex-color-outside-theme
 *   - no-spacing-literal-off-ramp
 *   - no-raw-typography-literals
 *
 * Uses the TypeScript-ESLint parser so JSX/TSX-shaped sources behave
 * identically to the lint pass under `apps/fieldops/**\/*.tsx`. Each rule
 * exercises:
 *   - happy-path token usage (no report)
 *   - bad-input literal usage (one report per occurrence)
 *   - SSOT-allowlist behavior (no report inside the canonical theme
 *     files even when the literal pattern matches).
 */

"use strict";

const path = require("path");

const { RuleTester } = require("eslint");
const tsParser = require("@typescript-eslint/parser");

const noHexColorOutsideTheme = require("../../config/tooling/eslint-plugin-fieldops/rules/no-hex-color-outside-theme");
const noSpacingLiteralOffRamp = require("../../config/tooling/eslint-plugin-fieldops/rules/no-spacing-literal-off-ramp");
const noRawTypographyLiterals = require("../../config/tooling/eslint-plugin-fieldops/rules/no-raw-typography-literals");

// Repo-relative absolute paths so the rules' SSOT-allowlist suffix match
// (`/apps/fieldops/src/mobile-theme.ts` etc.) resolves identically to a
// real lint pass. The repo root is the project root checkout — three
// levels up from this test file (`/tests/unit/` -> repo root).
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const COMPONENT_FILE = path.join(
  REPO_ROOT,
  "apps",
  "fieldops",
  "src",
  "components",
  "Sample.tsx"
);
const SSOT_THEME_FILE = path.join(
  REPO_ROOT,
  "apps",
  "fieldops",
  "src",
  "mobile-theme.ts"
);
const SSOT_STYLESHEET_FILE = path.join(
  REPO_ROOT,
  "apps",
  "fieldops",
  "src",
  "mobile-theme-stylesheet.ts"
);

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      ecmaFeatures: { jsx: true },
    },
  },
});

// ---------------------------------------------------------------------------
// no-hex-color-outside-theme
// ---------------------------------------------------------------------------

tester.run("no-hex-color-outside-theme", noHexColorOutsideTheme, {
  valid: [
    // Happy path — token usage, no hex literal.
    {
      filename: COMPONENT_FILE,
      code: 'const tone = tokens.color.accent; const x = "not a color";',
    },
    // Hex literal IS allowed inside the SSOT theme file.
    {
      filename: SSOT_THEME_FILE,
      code: 'const PALETTE = { accent: "#0e7c8a", border: "#e2e8f0" };',
    },
    // Hex literal IS allowed inside the SSOT stylesheet file.
    {
      filename: SSOT_STYLESHEET_FILE,
      code: 'const PALETTE = { backgroundColor: "#ffffff" };',
    },
    // Non-color string with `#` prefix that doesn't match the hex shape.
    {
      filename: COMPONENT_FILE,
      code: 'const anchor = "#section-2"; const id = "#abcd-not-hex";',
    },
  ],
  invalid: [
    {
      filename: COMPONENT_FILE,
      code: 'const tone = "#0e7c8a";',
      errors: [{ messageId: "hexColorForbidden" }],
    },
    {
      filename: COMPONENT_FILE,
      code: 'const a = "#fff"; const b = "#abcdef"; const c = "#aabbccdd";',
      errors: [
        { messageId: "hexColorForbidden" },
        { messageId: "hexColorForbidden" },
        { messageId: "hexColorForbidden" },
      ],
    },
    // Static template literal that is just a hex color.
    {
      filename: COMPONENT_FILE,
      code: "const tone = `#0e7c8a`;",
      errors: [{ messageId: "hexColorForbidden" }],
    },
  ],
});

// ---------------------------------------------------------------------------
// no-spacing-literal-off-ramp
// ---------------------------------------------------------------------------

tester.run("no-spacing-literal-off-ramp", noSpacingLiteralOffRamp, {
  valid: [
    // Token-driven values are fine.
    {
      filename: COMPONENT_FILE,
      code: "const styles = { padding: tokens.spacing.md, margin: tokens.spacing.lg };",
    },
    // Canonical 4-pt ramp values are allowed.
    {
      filename: COMPONENT_FILE,
      code: "const styles = { padding: 0, paddingTop: 4, marginHorizontal: 8, gap: 12, paddingLeft: 16, marginBottom: 24, padding: 32, gap: 48, padding: 64 };",
    },
    // Non-spacing keys with off-ramp numeric values must NOT trip.
    {
      filename: COMPONENT_FILE,
      code: "const styles = { width: 17, height: 33, borderRadius: 7, opacity: 0.42 };",
    },
    // SSOT allowlist — off-ramp values allowed inside the SSOT theme files.
    {
      filename: SSOT_THEME_FILE,
      code: "const SHARED_SPACING = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };",
    },
    {
      filename: SSOT_STYLESHEET_FILE,
      code: "const styles = { padding: 17, margin: 33, gap: 9 };",
    },
  ],
  invalid: [
    {
      filename: COMPONENT_FILE,
      code: "const styles = { padding: 17 };",
      errors: [{ messageId: "offRamp" }],
    },
    {
      filename: COMPONENT_FILE,
      code: "const styles = { paddingTop: 5, marginHorizontal: 9, gap: 13 };",
      errors: [
        { messageId: "offRamp" },
        { messageId: "offRamp" },
        { messageId: "offRamp" },
      ],
    },
    // Negative literal off-ramp.
    {
      filename: COMPONENT_FILE,
      code: "const styles = { marginTop: -3 };",
      errors: [{ messageId: "offRamp" }],
    },
  ],
});

// ---------------------------------------------------------------------------
// no-raw-typography-literals
// ---------------------------------------------------------------------------

tester.run("no-raw-typography-literals", noRawTypographyLiterals, {
  valid: [
    // Token-driven typography is fine.
    {
      filename: COMPONENT_FILE,
      code: "const styles = { fontSize: tokens.font.scale.md, fontWeight: tokens.font.weight.semibold, fontFamily: tokens.font.sans };",
    },
    // Non-typography keys with literals must NOT trip.
    {
      filename: COMPONENT_FILE,
      code: 'const styles = { color: "#000", lineHeight: 18, letterSpacing: 0.2 };',
    },
    // SSOT allowlist — literals allowed inside the SSOT theme files.
    {
      filename: SSOT_THEME_FILE,
      code: 'const role = { fontSize: 16, fontWeight: "600", fontFamily: "Inter" };',
    },
    {
      filename: SSOT_STYLESHEET_FILE,
      code: 'const role = { fontSize: 14, fontWeight: "bold", fontFamily: "System" };',
    },
  ],
  invalid: [
    {
      filename: COMPONENT_FILE,
      code: "const styles = { fontSize: 16 };",
      errors: [{ messageId: "rawTypography" }],
    },
    {
      filename: COMPONENT_FILE,
      code: 'const styles = { fontWeight: "600" };',
      errors: [{ messageId: "rawTypography" }],
    },
    {
      filename: COMPONENT_FILE,
      code: 'const styles = { fontFamily: "Inter" };',
      errors: [{ messageId: "rawTypography" }],
    },
    {
      filename: COMPONENT_FILE,
      code: 'const styles = { fontSize: 18, fontWeight: "bold", fontFamily: "System" };',
      errors: [
        { messageId: "rawTypography" },
        { messageId: "rawTypography" },
        { messageId: "rawTypography" },
      ],
    },
    // Static template literal counts as a raw literal too.
    {
      filename: COMPONENT_FILE,
      code: "const styles = { fontWeight: `bold` };",
      errors: [{ messageId: "rawTypography" }],
    },
  ],
});

// Smoke `describe` so `--testPathPattern` filtering and Jest output show a
// suite name. RuleTester registers its own `describe`/`it` calls under the
// hood, so this is just a friendly anchor.
describe("eslint-plugin-fieldops", () => {
  test("RuleTester suites registered", () => {
    expect(typeof noHexColorOutsideTheme.create).toBe("function");
    expect(typeof noSpacingLiteralOffRamp.create).toBe("function");
    expect(typeof noRawTypographyLiterals.create).toBe("function");
  });
});

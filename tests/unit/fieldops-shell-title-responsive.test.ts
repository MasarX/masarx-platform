/** Verify the shared responsive shell title across small screens and right-to-left layouts. */

import * as fs from "node:fs";
import * as path from "node:path";

const APP_TSX_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "apps",
  "fieldops",
  "App.tsx",
);

const APP_SOURCE = fs.readFileSync(APP_TSX_PATH, "utf8");

/**
 * Extract the shell-header `<View style={[styles.header, ...]}>...</View>`
 * block. We anchor on the unique `MOBILE_TEST_IDS.shell.menuToggle` testID
 * (which only appears inside the shell header `Pressable`) and walk
 * forward to the matching closing `</View>` of the header row. The
 * resulting slice is what we assert against — this avoids accidentally
 * matching unrelated parts of the file (e.g. the drawer, modals, etc).
 */
function extractShellHeaderSection(): string {
  const startIdx = APP_SOURCE.indexOf("MOBILE_TEST_IDS.shell.menuToggle");
  if (startIdx === -1) {
    throw new Error("Could not locate the shell header anchor (menuToggle testID).");
  }
  // Walk back a few hundred chars to capture the opening <View> tag for the
  // header row (`styles.header`).
  const headerOpenIdx = APP_SOURCE.lastIndexOf("styles.header", startIdx);
  if (headerOpenIdx === -1) {
    throw new Error("Could not locate the shell header opening tag.");
  }
  // The shell header section reasonably finishes within ~3500 chars after
  // the menuToggle anchor (it contains the menu button + brand text + the
  // headerRight pill cluster). We slice forward conservatively.
  const sliceEnd = Math.min(startIdx + 3500, APP_SOURCE.length);
  return APP_SOURCE.slice(headerOpenIdx, sliceEnd);
}

const SHELL_HEADER_SECTION = extractShellHeaderSection();

describe("shell-header brand title is responsive (no single-line clip)", () => {
  test("brand title renders with `numberOfLines={2}` so the full app name stays visible at small viewports", () => {
    // Old behavior was numberOfLines={1} + ellipsizeMode="tail" — that's
    // the regression we are guarding against.
    expect(SHELL_HEADER_SECTION).toMatch(/numberOfLines=\{2\}/);
  });

  test("brand title still preserves the full title in `accessibilityLabel` (a11y announcement parity)", () => {
    // `shellHeaderTitle` is the resolved "MasarX Field Ops · Driver" string
    // from `resolveMobileShellHeaderTitle`. Even when the visible layout
    // wraps the brand line, screen readers must still hear the full
    // "<app> · <role>" announcement.
    expect(SHELL_HEADER_SECTION).toMatch(/accessibilityLabel=\{shellHeaderTitle\}/);
  });

  test("brand line renders the resolved app name (`shellHeaderLines.title`), not a hardcoded literal", () => {
    expect(SHELL_HEADER_SECTION).toContain("{shellHeaderLines.title}");
  });

  test("role line renders `shellHeaderLines.role` so the second line stays in sync with the resolved role", () => {
    expect(SHELL_HEADER_SECTION).toContain("{shellHeaderLines.role}");
  });
});

describe("shell-header connectivity + outbox pills share the ShellPill primitive", () => {
  test("App.tsx imports the canonical ShellPill primitive from src/components/ShellPill", () => {
    expect(APP_SOURCE).toMatch(
      /import \{ ShellPill \} from ['"]\.\/src\/components\/ShellPill['"]/,
    );
  });

  test("connectivity pill is rendered via <ShellPill /> with a stable testID", () => {
    expect(SHELL_HEADER_SECTION).toContain('testID="shell-pill-connectivity"');
  });

  test("outbox pill is rendered via <ShellPill /> with a stable testID", () => {
    expect(SHELL_HEADER_SECTION).toContain('testID="shell-pill-outbox"');
  });

  test("connectivity pill maps `connectivityStatus` → tone (offline → 'offline', degraded → 'warning', else 'positive')", () => {
    expect(SHELL_HEADER_SECTION).toMatch(/connectivityStatus === ['"]offline['"]/);
    expect(SHELL_HEADER_SECTION).toMatch(/connectivityStatus === ['"]degraded['"]/);
    expect(SHELL_HEADER_SECTION).toMatch(/tone=\{[\s\S]*?['"]offline['"][\s\S]*?['"]warning['"][\s\S]*?['"]positive['"][\s\S]*?\}/);
  });

  test("outbox pill uses the `neutral` tone (Outbox counter should be a low-emphasis pill)", () => {
    // The outbox tone literal sits inside the second ShellPill block (after
    // the connectivity pill). Asserting both 'neutral' and the i18n outbox
    // helper appear in the section is enough to confirm wiring.
    expect(SHELL_HEADER_SECTION).toContain('tone="neutral"');
    expect(SHELL_HEADER_SECTION).toMatch(/i18nStrings\.shell\.outbox_count\(/);
  });

  test("legacy inline pill markup (`styles.headerPillRow` / `styles.headerPill` text node) no longer appears in the shell header section", () => {
    // We do NOT assert against the StyleSheet block (the style entries
    // remain at the bottom of the file as part of the broader stylesheet
    // and may stay for other callers). We only assert that the *shell
    // header render section* no longer wires those styles up directly —
    // ShellPill replaces them.
    expect(SHELL_HEADER_SECTION).not.toMatch(/style=\{[^}]*styles\.headerPillRow[^}]*\}/);
    expect(SHELL_HEADER_SECTION).not.toMatch(/style=\{styles\.headerPill\}/);
    expect(SHELL_HEADER_SECTION).not.toMatch(/style=\{[^}]*styles\.headerPillDot[^}]*\}/);
  });

  test("`connectivityStatusLabel` is now passed as the ShellPill `label` prop (not as a raw <Text> child)", () => {
    expect(SHELL_HEADER_SECTION).toMatch(/label=\{connectivityStatusLabel\}/);
  });
});

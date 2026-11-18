import * as fs from "fs";
import * as path from "path";

// Verify shared icons in the tab bar and drawer, along with the anchored outbox badge.

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const APP_TSX_PATH = path.join(
  REPO_ROOT,
  "apps",
  "fieldops",
  "App.tsx",
);
const BOTTOM_TAB_BAR_PATH = path.join(
  REPO_ROOT,
  "apps",
  "fieldops",
  "src",
  "components",
  "BottomTabBar.tsx",
);

function readFileText(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

describe("fieldops tab + drawer icons", () => {
  describe("App.tsx — tab bar icons", () => {
    let source: string;

    beforeAll(() => {
      source = readFileText(APP_TSX_PATH);
    });

    test("imports `Icon` and the `IconName` type from IconRegistry", () => {
      // The wiring depends on a single import site so future contributors
      // do not duplicate the import or shadow it with a local alias.
      expect(source).toContain('from "./src/components/IconRegistry"');
      expect(source).toMatch(/import\s*\{\s*[\s\S]*?\bIcon\b[\s\S]*?\}\s*from\s*"\.\/src\/components\/IconRegistry"/);
      expect(source).toMatch(/import\s*\{\s*[\s\S]*?\btype\s+IconName\b[\s\S]*?\}\s*from\s*"\.\/src\/components\/IconRegistry"/);
    });

    test("primary tab items pass an `icon` prop for every destination", () => {
      // The tab items config must wire an `icon: buildIcon(<key>)` line
      // for each of the six canonical tab keys. Catching this at the
      // source level guards against accidental removal of the icon hook
      // (e.g. a future refactor that drops the icon prop while keeping
      // the label).
      const tabKeys = ["home", "tasks", "route", "scan", "outbox", "more"];
      for (const key of tabKeys) {
        expect(source).toContain(`icon: buildIcon("${key}")`);
      }
    });

    test("each canonical tab IconName alias appears in App.tsx", () => {
      // Match the shared Icon by its name prop.
      const tabIconNames = ["home", "tasks", "route", "scan", "outbox", "more"];
      for (const name of tabIconNames) {
        expect(source).toContain(`${name}: "${name}"`);
      }
    });

    test("active tab tone resolves through `activeNavKey` (no hardcoded tone)", () => {
      // Active vs inactive tone must be derived from the resolver-driven
      // `activeNavKey`, not a hardcoded constant. This assertion makes
      // sure the icon tone stays in lock-step with the existing TabLabel
      // tone behavior on the BottomTabBar primitive.
      expect(source).toMatch(/const isActive = activeNavKey === key/);
      expect(source).toMatch(/tone=\{isActive\s*\?\s*"accent"\s*:\s*"default"\}/);
    });
  });

  describe("App.tsx — drawer module icons", () => {
    let source: string;

    beforeAll(() => {
      source = readFileText(APP_TSX_PATH);
    });

    test("drawer module rows wire an `<Icon name=...>` per entry", () => {
      // The drawer render must mount an `<Icon size="sm" ...>` callsite
      // for the per-row module glyph. We assert the size + tone hooks so
      // the visual hierarchy stays consistent with the tab bar.
      expect(source).toMatch(/<Icon\s+name=\{moduleIconName\}/);
      expect(source).toContain('size="sm"');
    });

    test("the drawer module mapping table covers every canonical module key", () => {
      // The mapping object enumerates the curated drawer-only IconName
      // aliases. Asserting each entry guards against accidental removal
      // of a row (which would silently fall back to the "more" glyph).
      const drawerEntries: Array<[string, string]> = [
        ["tasks", "tasks"],
        ["route", "route"],
        ["scan", "scan"],
        ["location", "map-pin"],
        ["outbox", "outbox"],
        ["settlements", "package"],
        ["more", "more"],
        ["diagnostics", "check"],
      ];
      for (const [key, iconName] of drawerEntries) {
        expect(source).toContain(`${key}: "${iconName}"`);
      }
    });

    test("uses the `map-pin` IconRegistry alias for the location row", () => {
      // The location module must use a
      // map-pin glyph. Asserting the alias by name catches a regression
      // where the row falls back to the generic "more" icon.
      expect(source).toContain('"map-pin"');
    });

    test("falls back to the `more` IconName for unknown nav keys", () => {
      // The fallback keeps the drawer visually consistent (no bare text
      // rows) when a nav key has no canonical icon.
      expect(source).toMatch(/const moduleIconName: IconName = moduleIconForKey\[navKey\] \?\? "more"/);
    });
  });

  describe("App.tsx — drawer brand header", () => {
    let source: string;

    beforeAll(() => {
      source = readFileText(APP_TSX_PATH);
    });

    test("drawer brand header mounts with the three canonical testIDs", () => {
      // Keep the brand header test IDs stable for diagnostics and automation.
      expect(source).toContain('testID="mobile-drawer-brand-header"');
      expect(source).toContain('testID="mobile-drawer-brand-logo"');
      expect(source).toContain('testID="mobile-drawer-brand-role-chip"');
    });

    test("brand logo renders the row-driven app name (no hardcoded brand string)", () => {
      // The logo text mark must come from the canonical publicConfig so
      // the brand stays row-driven (the hardcoded "MasarX" literal would
      // break tenant-customized builds).
      expect(source).toMatch(/testID="mobile-drawer-brand-logo"[\s\S]{0,200}\{publicConfig\.appName\}/);
    });

    test("brand role chip renders the resolved userRoleLabel", () => {
      // The role chip must use the same resolver the top header avatar
      // uses, so EN/AR catalogs and the role registry stay the SSOT.
      expect(source).toMatch(/testID="mobile-drawer-brand-role-chip"[\s\S]{0,300}\{userRoleLabel\}/);
    });

    test("brand header includes an avatar Pressable wired to handleSignOut", () => {
      // The drawer mirrors the top-header avatar (long-press to sign out)
      // so the user can confirm identity without closing the drawer.
      // Asserting the wiring guards against accidental removal of the
      // long-press affordance from this surface.
      expect(source).toMatch(/testID="mobile-drawer-brand-header"[\s\S]{0,1500}onLongPress=\{handleSignOut\}/);
    });
  });

  describe("BottomTabBar.tsx — outbox badge clip fix", () => {
    let source: string;

    beforeAll(() => {
      source = readFileText(BOTTOM_TAB_BAR_PATH);
    });

    test("legacy clip-prone badge offsets are gone from active style", () => {
      // The previous values placed the badge outside the icon-stack
      // bounding box, which clipped past the cell edge on a 320 px
      // viewport. We scope the regex to the active `badge:` style block
      // (not the file as a whole) so the explanatory comment that
      // mentions the old values does not match the active style block.
      const badgeBlockMatch = source.match(/badge:\s*\{[\s\S]*?\},/);
      expect(badgeBlockMatch).not.toBeNull();
      const badgeBlock = badgeBlockMatch?.[0] ?? "";
      // Strip line comments + block comments so a comment-only mention of
      // "-4" / "-10" does not satisfy the negative assertion. Both legacy
      // values must be absent from the executable style declarations.
      const codeOnly = badgeBlock
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      expect(codeOnly).not.toMatch(/top:\s*-4\b/);
      expect(codeOnly).not.toMatch(/right:\s*-10\b/);
    });

    test("badge now sits inside the tab cell (top:0 / right:0)", () => {
      // Inside-cell positioning keeps the badge anchored to the icon
      // corner without extending past the cell. Visual prominence is
      // preserved through the existing red fill + bold text.
      const badgeBlockMatch = source.match(/badge:\s*\{[\s\S]*?\},/);
      expect(badgeBlockMatch).not.toBeNull();
      const badgeBlock = badgeBlockMatch?.[0] ?? "";
      expect(badgeBlock).toMatch(/top:\s*0\b/);
      expect(badgeBlock).toMatch(/right:\s*0\b/);
    });
  });
});

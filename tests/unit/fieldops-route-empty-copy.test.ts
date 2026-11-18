import * as fs from "fs";
import * as path from "path";

import { EN_STRINGS } from "../../apps/fieldops/src/i18n/strings-en";
import { AR_STRINGS } from "../../apps/fieldops/src/i18n/strings-ar";

// Verify route empty-state copy in the supported locales.

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const APP_TSX_PATH = path.join(
  REPO_ROOT,
  "apps",
  "fieldops",
  "App.tsx",
);

function readAppTsx(): string {
  return fs.readFileSync(APP_TSX_PATH, "utf8");
}

describe("fieldops Route surface empty-state copy", () => {
  describe("App.tsx — forbidden inline literals", () => {
    test("the empty route-stop result no longer emits a misleading 'warning' literal", () => {
      const source = readAppTsx();
      // The legacy inline literal that misframed an empty result as a warning
      // must be gone from `App.tsx`. The render path now consumes
      // `i18nStrings.route.empty_title` + `i18nStrings.route.empty_subtitle`
      // through the shared `<EmptyState>` component.
      expect(source).not.toContain(
        'sortedItems.length === 0 ? "No assigned route stops are currently visible."',
      );
    });

    test("the route surface empty state renders <EmptyState> through the i18n catalog", () => {
      const source = readAppTsx();
      // The branded EmptyState invocation must be present at the route surface
      // render block so a 0-stop result no longer falls through to the
      // noticeCard slot reserved for legitimate scope warnings.
      expect(source).toContain('testID="mobile-route-empty"');
      expect(source).toContain("i18nStrings.route.empty_title");
      expect(source).toContain("i18nStrings.route.empty_subtitle");
    });
  });

  describe("i18n catalogs — route empty-state keys", () => {
    test("EN catalog exposes route.empty_title and route.empty_subtitle as non-empty strings", () => {
      expect(typeof EN_STRINGS.route.empty_title).toBe("string");
      expect(EN_STRINGS.route.empty_title.length).toBeGreaterThan(0);
      expect(typeof EN_STRINGS.route.empty_subtitle).toBe("string");
      expect(EN_STRINGS.route.empty_subtitle.length).toBeGreaterThan(0);
    });

    test("AR catalog exposes route.empty_title and route.empty_subtitle as non-empty strings", () => {
      expect(typeof AR_STRINGS.route.empty_title).toBe("string");
      expect(AR_STRINGS.route.empty_title.length).toBeGreaterThan(0);
      expect(typeof AR_STRINGS.route.empty_subtitle).toBe("string");
      expect(AR_STRINGS.route.empty_subtitle.length).toBeGreaterThan(0);
    });

    test("EN copy frames a 0-stop result semantically (no 'workspace' / 'unavailable' framing)", () => {
      const lower = EN_STRINGS.route.empty_title.toLowerCase();
      // The copy must describe the actual condition (no assigned stops),
      // not a workspace/permission failure.
      expect(lower).not.toContain("workspace");
      expect(lower).not.toContain("unavailable");
      expect(lower).toContain("no");
      expect(lower).toContain("stop");
    });

    test("AR copy uses the canonical 'لا توجد محطات مُسندة' phrasing", () => {
      // The Arabic title must distinguish an empty route from unavailable access.
      expect(AR_STRINGS.route.empty_title).toBe("لا توجد محطات مُسندة");
    });

    test("EN and AR route empty copies differ from each other (no untranslated leak)", () => {
      expect(EN_STRINGS.route.empty_title).not.toBe(
        AR_STRINGS.route.empty_title,
      );
      expect(EN_STRINGS.route.empty_subtitle).not.toBe(
        AR_STRINGS.route.empty_subtitle,
      );
    });
  });
});

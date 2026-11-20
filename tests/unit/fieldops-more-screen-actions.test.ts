import * as fs from "fs";
import * as path from "path";

import { EN_STRINGS } from "../../apps/fieldops/src/i18n/strings-en";
import { AR_STRINGS } from "../../apps/fieldops/src/i18n/strings-ar";

// Verify the confirmation step for sign-out and the accessible theme and locale controls.

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

function locateMoreScreen(source: string): string {
  // Slice the MoreScreen function so the assertions cannot be satisfied by
  // unrelated call sites elsewhere in the file (SignInScreen, ScanScreen,
  // Bootstrap, etc.). The next top-level `function ` declaration after the
  // MoreScreen header bounds the slice.
  const headerIdx = source.indexOf("function MoreScreen(");
  expect(headerIdx).toBeGreaterThan(-1);
  const nextHeaderIdx = source.indexOf("\nfunction ", headerIdx + 1);
  return nextHeaderIdx === -1 ? source.slice(headerIdx) : source.slice(headerIdx, nextHeaderIdx);
}

describe("fieldops MoreScreen actions", () => {
  describe("App.tsx — sign-out confirmation", () => {
    test("the sign-out Pressable still exposes the canonical mobile-sign-out testID", () => {
      const moreScreen = locateMoreScreen(readAppTsx());
      // Keep the display control test ID stable for diagnostics and automation.
      expect(moreScreen).toContain('testID="mobile-sign-out"');
    });

    test("the sign-out press routes through confirmMobileAction (no plain onSignOut wiring)", () => {
      const moreScreen = locateMoreScreen(readAppTsx());
      // `confirmMobileAction` must be invoked inside the MoreScreen body so
      // a sign-out press cannot fire `onSignOut` synchronously without a
      // confirmation step. The destructive flag must be present so the
      // system surface highlights the consequence.
      expect(moreScreen).toContain("confirmMobileAction");
      expect(moreScreen).toContain("danger: true");
      // The copy must come from the i18n catalog, not inline literals.
      expect(moreScreen).toContain("i18nStrings.confirm.sign_out_title");
      expect(moreScreen).toContain("i18nStrings.confirm.sign_out_message");
      expect(moreScreen).toContain("i18nStrings.confirm.sign_out_button");
      expect(moreScreen).toContain("i18nStrings.confirm.cancel_button");
    });

    test("the legacy synchronous wiring (`onPress={onSignOut}`) is gone from MoreScreen", () => {
      const moreScreen = locateMoreScreen(readAppTsx());
      // The legacy direct binding would let a single tap end the session;
      // it must no longer appear in the MoreScreen body.
      expect(moreScreen).not.toContain("onPress={onSignOut}");
    });
  });

  describe("App.tsx — theme + locale switcher testIDs", () => {
    test("the theme switcher renders all three canonical testIDs", () => {
      const moreScreen = locateMoreScreen(readAppTsx());
      // "auto" is the user-facing label for the canonical `system` theme
      // mode (auto-follow OS appearance). The other two map 1:1.
      expect(moreScreen).toContain("mobile-theme-switcher-auto");
      expect(moreScreen).toContain("mobile-theme-switcher-light");
      expect(moreScreen).toContain("mobile-theme-switcher-dark");
    });

    test("the locale switcher renders both canonical testIDs", () => {
      const moreScreen = locateMoreScreen(readAppTsx());
      expect(moreScreen).toContain("mobile-locale-switcher-en");
      expect(moreScreen).toContain("mobile-locale-switcher-ar");
    });

    test("switcher labels resolve from the i18n catalog (no hardcoded English literals)", () => {
      const moreScreen = locateMoreScreen(readAppTsx());
      // The chip labels must come from the row-driven i18n keys so EN/AR
      // bundles can override them independently. The catalog reads also
      // anchor the section heading so the visible title is row-driven too.
      expect(moreScreen).toContain("i18nStrings.more.theme_section_title");
      expect(moreScreen).toContain("i18nStrings.more.locale_en");
      expect(moreScreen).toContain("i18nStrings.more.locale_ar");
      expect(moreScreen).toContain("i18nStrings.more.theme_auto");
      expect(moreScreen).toContain("i18nStrings.more.theme_light");
      expect(moreScreen).toContain("i18nStrings.more.theme_dark");
    });
  });

  describe("i18n catalogs — new MoreScreen keys", () => {
    const requiredKeys: ReadonlyArray<keyof typeof EN_STRINGS.more> = [
      "theme_section_title",
      "theme_auto",
      "theme_light",
      "theme_dark",
      "locale_en",
      "locale_ar",
    ];

    test("EN catalog exposes every new MoreScreen key as a non-empty string", () => {
      for (const key of requiredKeys) {
        const value = EN_STRINGS.more[key];
        expect(typeof value).toBe("string");
        expect((value as string).length).toBeGreaterThan(0);
      }
    });

    test("AR catalog exposes every new MoreScreen key as a non-empty string", () => {
      for (const key of requiredKeys) {
        const value = (AR_STRINGS.more as unknown as Record<string, unknown>)[key];
        expect(typeof value).toBe("string");
        expect((value as string).length).toBeGreaterThan(0);
      }
    });

    test("EN/AR translatable copy actually differs (no untranslated leak)", () => {
      // Locale labels are intentionally identical in both bundles (the user
      // identifies their own locale in its own script), so we only assert
      // divergence on the labels that should localize.
      const localizableKeys: ReadonlyArray<keyof typeof EN_STRINGS.more> = [
        "theme_section_title",
        "theme_auto",
        "theme_light",
        "theme_dark",
      ];
      for (const key of localizableKeys) {
        const en = EN_STRINGS.more[key] as string;
        const ar = (AR_STRINGS.more as unknown as Record<string, string>)[key];
        expect(en).not.toBe(ar);
      }
    });

    test("AR locale label uses the canonical 'العربية' phrasing", () => {
      const ar = (AR_STRINGS.more as unknown as Record<string, string>).locale_ar;
      expect(ar).toBe("العربية");
    });
  });
});

// Verify that the FieldOps entry screen uses translated bootstrap copy.

import * as fs from "fs";
import * as path from "path";

import { EN_STRINGS } from "../../apps/fieldops/src/i18n/strings-en";
import { AR_STRINGS } from "../../apps/fieldops/src/i18n/strings-ar";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const APP_TSX_PATH = path.join(REPO_ROOT, "apps", "fieldops", "App.tsx");

describe("fieldops Bootstrap i18n catalog", () => {
  test("EN strings catalog exposes bootstrap.missing_public_configuration with non-empty value", () => {
    expect(EN_STRINGS.bootstrap).toBeDefined();
    expect(typeof EN_STRINGS.bootstrap.missing_public_configuration).toBe("string");
    expect(EN_STRINGS.bootstrap.missing_public_configuration.trim().length).toBeGreaterThan(0);
    expect(EN_STRINGS.bootstrap.missing_public_configuration).toBe(
      "Missing public configuration."
    );
  });

  test("AR strings catalog exposes bootstrap.missing_public_configuration with non-empty value", () => {
    expect(AR_STRINGS.bootstrap).toBeDefined();
    expect(typeof AR_STRINGS.bootstrap.missing_public_configuration).toBe("string");
    expect(AR_STRINGS.bootstrap.missing_public_configuration.trim().length).toBeGreaterThan(0);
  });

  test("EN/AR catalogs have parity for bootstrap namespace keys", () => {
    const enKeys = Object.keys(EN_STRINGS.bootstrap).sort();
    const arKeys = Object.keys(AR_STRINGS.bootstrap).sort();
    expect(arKeys).toEqual(enKeys);
    expect(enKeys).toContain("missing_public_configuration");
  });

  test("App.tsx no longer contains the hardcoded \"Missing public configuration.\" string literal", () => {
    const source = fs.readFileSync(APP_TSX_PATH, "utf8");
    // The literal (with surrounding double quotes) must not appear in source
    // after the i18n migration; the only acceptable occurrence is via the
    // catalog reference, which uses the key path, not the raw string.
    expect(source).not.toContain('"Missing public configuration."');
  });

  test("App.tsx Bootstrap reads the i18n key bootstrap.missing_public_configuration", () => {
    const source = fs.readFileSync(APP_TSX_PATH, "utf8");
    expect(source).toContain("i18nStrings.bootstrap.missing_public_configuration");
  });
});

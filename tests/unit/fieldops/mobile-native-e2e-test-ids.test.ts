import * as fs from "node:fs";
import * as path from "node:path";

import {
  FIELDOPS_NATIVE_E2E_TEST_IDS,
  fieldOpsSignInMethodTestId,
} from "../../../apps/fieldops/src/mobile-native-e2e-test-ids";

describe("FieldOps native E2E selectors", () => {
  test("keeps stable unique selector values", () => {
    expect(FIELDOPS_NATIVE_E2E_TEST_IDS.signInPassword).toBe("mobile-signin-password");
    const selectors = Object.values(FIELDOPS_NATIVE_E2E_TEST_IDS);
    expect(new Set(selectors).size).toBe(selectors.length);
    expect(selectors.every((selector) => selector.startsWith("mobile-"))).toBe(true);
  });

  test("normalizes policy-backed sign-in methods without credentials", () => {
    expect(fieldOpsSignInMethodTestId(" Password ")).toBe(
      "mobile-signin-method-password"
    );
    expect(fieldOpsSignInMethodTestId("magic_link")).toBe(
      "mobile-signin-method-magic_link"
    );
  });

  test("wires every selector into the current FieldOps shell", () => {
    const appSource = fs.readFileSync(
      path.resolve(__dirname, "../../../apps/fieldops/App.tsx"),
      "utf8"
    );
    const controlSource = fs.readFileSync(path.resolve(__dirname, "../../../apps/fieldops/src/mobile-drawer-close-button.tsx"), "utf8");
    expect(appSource).toContain("<FieldOpsDrawerCloseButton");
    for (const key of Object.keys(FIELDOPS_NATIVE_E2E_TEST_IDS)) {
      expect(appSource + controlSource).toContain(`FIELDOPS_NATIVE_E2E_TEST_IDS.${key}`);
    }
    expect(appSource).toContain("fieldOpsSignInMethodTestId(candidate)");
  });
});

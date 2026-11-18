// Verify accessibility and sensitive-input settings on the sign-in form.
import * as fs from "node:fs";
import * as path from "node:path";

const APP_TSX_PATH = path.resolve(__dirname, "..", "..", "apps", "fieldops", "App.tsx");

function readSignInScreenSource(): string {
  const fullSource = fs.readFileSync(APP_TSX_PATH, "utf8");
  const startMarker = "function SignInScreen(";
  const startIdx = fullSource.indexOf(startMarker);
  if (startIdx < 0) {
    throw new Error("SignInScreen function not found in apps/fieldops/App.tsx");
  }
  // SignInScreen is followed by Bootstrap; capture everything up to that.
  const endIdx = fullSource.indexOf("function Bootstrap(", startIdx);
  if (endIdx < 0) {
    throw new Error("Bootstrap function not found after SignInScreen");
  }
  return fullSource.slice(startIdx, endIdx);
}

describe("Sign-in accessibility and sensitive inputs", () => {
  const source = readSignInScreenSource();

  describe("inputs expose accessibilityLabel for screen readers", () => {
    test("email TextInput has accessibilityLabel=\"Email\"", () => {
      expect(source).toMatch(/accessibilityLabel="Email"/);
    });

    test("password TextInput has accessibilityLabel=\"Password\"", () => {
      expect(source).toMatch(/accessibilityLabel="Password"/);
    });
  });

  describe("password input ships with sensitive-input hardening", () => {
    test("source contains autoComplete for the password input", () => {
      // current-password is preferred; password is also acceptable per spec.
      expect(source).toMatch(/autoComplete="(?:current-password|password)"/);
    });

    test("source contains autoComplete=\"email\" for the email input", () => {
      expect(source).toMatch(/autoComplete="email"/);
    });

    test("password block contains autoCapitalize=\"none\"", () => {
      const passwordBlockMatch = source.match(
        /testID=\{MOBILE_TEST_IDS\.auth\.passwordInput\}[\s\S]*?\/>/,
      );
      expect(passwordBlockMatch).not.toBeNull();
      const passwordBlock = passwordBlockMatch![0];
      expect(passwordBlock).toMatch(/autoCapitalize="none"/);
    });

    test("password block contains autoCorrect={false}", () => {
      const passwordBlockMatch = source.match(
        /testID=\{MOBILE_TEST_IDS\.auth\.passwordInput\}[\s\S]*?\/>/,
      );
      expect(passwordBlockMatch).not.toBeNull();
      const passwordBlock = passwordBlockMatch![0];
      expect(passwordBlock).toMatch(/autoCorrect=\{false\}/);
    });

    test("password block contains spellCheck={false}", () => {
      const passwordBlockMatch = source.match(
        /testID=\{MOBILE_TEST_IDS\.auth\.passwordInput\}[\s\S]*?\/>/,
      );
      expect(passwordBlockMatch).not.toBeNull();
      const passwordBlock = passwordBlockMatch![0];
      expect(passwordBlock).toMatch(/spellCheck=\{false\}/);
    });

    test("password block retains secureTextEntry", () => {
      const passwordBlockMatch = source.match(
        /testID=\{MOBILE_TEST_IDS\.auth\.passwordInput\}[\s\S]*?\/>/,
      );
      expect(passwordBlockMatch).not.toBeNull();
      const passwordBlock = passwordBlockMatch![0];
      expect(passwordBlock).toMatch(/secureTextEntry/);
    });
  });

  describe("disabled submit exposes muted color + SR cue", () => {
    test("source contains accessibilityState with disabled flag for the submit", () => {
      const submitBlockMatch = source.match(
        /testID=\{MOBILE_TEST_IDS\.auth\.submitButton\}[\s\S]*?<\/Pressable>/,
      );
      expect(submitBlockMatch).not.toBeNull();
      // The <Pressable ...> opening precedes the testID line; widen capture
      // backward to include the props block.
      const submitIdx = source.indexOf("testID={MOBILE_TEST_IDS.auth.submitButton}");
      const pressableOpenIdx = source.lastIndexOf("<Pressable", submitIdx);
      const closeIdx = source.indexOf("</Pressable>", submitIdx);
      const fullSubmitBlock = source.slice(pressableOpenIdx, closeIdx + "</Pressable>".length);
      expect(fullSubmitBlock).toMatch(/accessibilityState=\{\{[^}]*disabled:\s*!canSubmit/);
    });

    test("submit Text declares a muted color when disabled", () => {
      const submitIdx = source.indexOf("testID={MOBILE_TEST_IDS.auth.submitButton}");
      const closeIdx = source.indexOf("</Pressable>", submitIdx);
      const fullSubmitBlock = source.slice(submitIdx, closeIdx);
      // The disabled style array entry references a muted color literal or
      // a TODO-tracked theme token swap.
      expect(fullSubmitBlock).toMatch(/!canSubmit\s*&&\s*\{\s*color:/);
    });
  });

  describe("submit CTA Text uses 17pt body (HIG default)", () => {
    test("submit Pressable Text has fontSize: 17 styled inline", () => {
      const submitIdx = source.indexOf("testID={MOBILE_TEST_IDS.auth.submitButton}");
      const closeIdx = source.indexOf("</Pressable>", submitIdx);
      const fullSubmitBlock = source.slice(submitIdx, closeIdx);
      expect(fullSubmitBlock).toMatch(/fontSize:\s*17/);
    });
  });
});

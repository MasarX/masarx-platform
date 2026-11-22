import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const app = readFileSync(resolve(__dirname, "../../apps/fieldops/App.tsx"), "utf8");
const signIn = app.slice(app.indexOf("function SignInScreen("), app.indexOf("function Bootstrap("));

function input(name: "Email" | "Password" | "Otp") {
  const index = signIn.indexOf(`testID={FIELDOPS_NATIVE_E2E_TEST_IDS.signIn${name}}`);
  expect(index).toBeGreaterThanOrEqual(0);
  return signIn.slice(signIn.lastIndexOf("<TextInput", index), signIn.indexOf("/>", index));
}

test("sign-in inputs retain accessible names and appropriate autofill hints", () => {
  expect(input("Email")).toContain('accessibilityLabel="Email"');
  expect(input("Email")).toContain('autoComplete={method === "password" ? "username" : "email"}');
  expect(input("Email")).toContain('keyboardType="email-address"');
  expect(input("Email")).toContain("spellCheck={false}");

  expect(input("Password")).toContain('accessibilityLabel="Password"');
  expect(input("Password")).toContain('autoComplete="current-password"');
  expect(input("Password")).toContain("secureTextEntry");
  expect(input("Password")).toContain('autoCapitalize="none"');
  expect(input("Password")).toContain("autoCorrect={false}");
  expect(input("Password")).toContain("spellCheck={false}");

  expect(input("Otp")).toContain('accessibilityLabel="Verification code"');
  expect(input("Otp")).toContain('autoComplete="one-time-code"');
});

test("sign-in submit exposes its disabled state to touch and assistive technology", () => {
  const index = signIn.indexOf("testID={FIELDOPS_NATIVE_E2E_TEST_IDS.signInSubmit}");
  expect(index).toBeGreaterThanOrEqual(0);
  const submit = signIn.slice(signIn.lastIndexOf("<Pressable", index), signIn.indexOf("</Pressable>", index));
  expect(submit).toContain("accessibilityState={{ disabled: !canSubmit }}");
  expect(submit).toContain("disabled={!canSubmit}");
  expect(submit).toContain("!canSubmit && styles.primaryButtonDisabled");
});

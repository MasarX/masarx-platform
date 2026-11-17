import {
  normalizeAuthEmail,
  normalizeAuthMethods,
  resolvePreferredAuthMethod,
} from "../../../apps/fieldops/src/mobile-auth-methods";

describe("mobile auth methods", () => {
  test("normalizes auth email by stripping whitespace", () => {
    expect(normalizeAuthEmail(" ops_admin@demo. local ")).toBe("ops_admin@demo.local");
  });

  test("normalizes auth email with hidden spaces and uppercase", () => {
    expect(normalizeAuthEmail(" Ops_Admin@\u200BDEMO.LOCAL ")).toBe("ops_admin@demo.local");
  });

  test("normalizes and deduplicates allowed methods", () => {
    expect(
      normalizeAuthMethods([" password ", "magic_link", "PASSWORD", "unsupported"])
    ).toEqual(["password", "magic_link"]);
  });

  test("falls back to password when no valid methods are configured", () => {
    expect(normalizeAuthMethods(null)).toEqual(["password"]);
    expect(normalizeAuthMethods(["unknown"])).toEqual(["password"]);
  });

  test("prefers password sign-in when available", () => {
    expect(resolvePreferredAuthMethod(["magic_link", "password"])).toBe("password");
  });

  test("uses first method when password is unavailable", () => {
    expect(resolvePreferredAuthMethod(["magic_link"])).toBe("magic_link");
  });
});

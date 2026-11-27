// Arabic coverage for the FieldOps setup, sign-in, loading and session copy (issue #302).
// App.tsx is too large to render in a unit test, so this checks the catalogs, the
// sign-in error helper, and the screens' source through the i18n literal guard.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AR_STRINGS, EN_STRINGS } from "../../../apps/fieldops/src/i18n";
import { formatAuthErrorMessage } from "../../../apps/fieldops/src/mobile-auth-errors";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { scanSource } = require("../../../scripts/tooling/i18n-literal-guard");

const ARABIC = /[\u0600-\u06ff]/;
const GROUPS = ["signIn", "setup", "session"] as const;
const app = readFileSync(resolve(__dirname, "../../../apps/fieldops/App.tsx"), "utf8");

function placeholders(value: string) {
  return (value.match(/\{\w+\}/g) ?? []).sort();
}

describe("FieldOps setup, sign-in and session catalog", () => {
  test.each(GROUPS)("%s has the same keys and placeholders in English and Arabic", (group) => {
    const en = EN_STRINGS[group] as Record<string, string>;
    const ar = AR_STRINGS[group] as Record<string, string>;
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect({ key, arabic: ARABIC.test(ar[key]) }).toEqual({ key, arabic: true });
      expect({ key, placeholders: placeholders(ar[key]) }).toEqual({ key, placeholders: placeholders(en[key]) });
    }
  });

  test("keeps the English the screens showed before", () => {
    expect(EN_STRINGS.session.loading).toBe("Loading session...");
    expect(EN_STRINGS.session.bootstrapping).toBe("Bootstrapping...");
    expect(EN_STRINGS.session.retryStorage).toBe("Retry storage");
    expect(EN_STRINGS.setup.invalidSupabaseKey).toBe("Invalid Supabase key");
    expect(EN_STRINGS.signIn.usePassword).toBe("Use password");
    expect(EN_STRINGS.session.avatarSignOut.replace("{role}", () => "Driver")).toBe("Role Driver. Long press to sign out.");
  });

  test("uses the agreed Arabic terms", () => {
    expect(AR_STRINGS.session.loading).toBe("جارٍ تحميل الجلسة...");
    expect(AR_STRINGS.signIn.usePassword).toBe("استخدام كلمة المرور");
    expect(AR_STRINGS.setup.invalidSupabaseKey).toBe("مفتاح Supabase غير صالح");
    expect(AR_STRINGS.session.avatarSignOut.replace("{role}", () => "سائق")).toBe("الدور سائق. اضغط مطولًا لتسجيل الخروج.");
  });
});

describe("sign-in error messages", () => {
  test.each([
    "Failed to fetch",
    "Invalid login credentials",
    "email NOT confirmed",
    "Email rate limit exceeded",
    "Token has expired or is invalid",
    "Password should be at least 8 characters",
    "Password should be at least 1024 characters",
    "Invalid email",
  ])("formats %s in Arabic with no English words left", (message) => {
    const formatted = formatAuthErrorMessage(new Error(message), AR_STRINGS);
    expect(formatted).toMatch(ARABIC);
    // Product names and the sample address are data, not copy.
    const copy = formatted.replace(/MasarX|\S+@\S+\.invalid/g, "");
    expect(copy).not.toMatch(/[A-Za-z]{2,}/);
  });

  test("keeps English for existing callers and fills the Arabic templates", () => {
    expect(formatAuthErrorMessage(new Error("Invalid email"))).toBe(EN_STRINGS.signIn.checkEmailFormat);
    expect(formatAuthErrorMessage(new Error("Password should be at least 8 characters"), AR_STRINGS))
      .toBe("يجب أن تتكون كلمة المرور من 8 أحرف على الأقل. اختر كلمة مرور أطول وحاول مرة أخرى.");
    expect(formatAuthErrorMessage(new Error("Failed to fetch"), AR_STRINGS)).toBe(AR_STRINGS.auth.networkUnreachable);
  });
});

describe("App.tsx setup, sign-in, loading and session screens", () => {
  test("hold no English literals except the input labels a source test pins", () => {
    const start = app.indexOf("function SignInScreen(");
    const end = app.indexOf("type MobileThemeBootProps", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const found = scanSource(app.slice(start, end), "App.tsx").map((f: { text: string }) => f.text);
    // fieldops-signin-input-hardening.test.ts asserts these three as literal source text.
    expect(found).toEqual(["Email", "Password", "Verification code"]);
  });

  test("the header avatar reads its sign-out hint from the catalog", () => {
    expect(app).toContain('accessibilityLabel={strings.session.avatarSignOut.replace("{role}", () => String(userRoleLabel))}');
    expect(app).not.toContain("Long press to sign out.");
  });
});

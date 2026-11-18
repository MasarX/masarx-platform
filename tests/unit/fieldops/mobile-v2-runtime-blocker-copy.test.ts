import {
  resolveMobileV2RuntimeBlockerCopy,
  type MobileV2RuntimeBlockerKind,
} from "../../../apps/fieldops/src/mobile-v2-runtime-blocker-copy";

const FORBIDDEN_VISIBLE_TOKENS = [
  "NEXT_PUBLIC_",
  "SUPABASE",
  "Missing required env",
  "Configuration error",
  "service role",
  "stack",
  "mobile_shell_policy",
  "resolve_mobile_shell_policy",
];

describe("FieldOps Mobile V2 runtime blocker copy", () => {
  test.each<MobileV2RuntimeBlockerKind>([
    "configuration",
    "clientCredential",
    "mobileV2Unavailable",
  ])("keeps %s blocker copy operator-friendly", (kind) => {
    const copy = resolveMobileV2RuntimeBlockerCopy({
      kind,
      appName: "MasarX FieldOps",
    });
    const visibleText = Object.values(copy).join("\n");

    expect(copy.title).toBe("MasarX FieldOps");
    expect(visibleText).toContain("FieldOps");
    for (const token of FORBIDDEN_VISIBLE_TOKENS) {
      expect(visibleText).not.toContain(token);
    }
  });

  test("falls back to the public app label when appName is blank", () => {
    expect(resolveMobileV2RuntimeBlockerCopy({ kind: "configuration", appName: "  " }).title)
      .toBe("FieldOps");
  });
});

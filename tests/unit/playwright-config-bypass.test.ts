import { resolveVercelBypassHeaders } from "../e2e/utils/vercel-bypass";

describe("playwright vercel bypass headers", () => {
  test("uses automation bypass secret when configured", () => {
    const headers = resolveVercelBypassHeaders({
      VERCEL_AUTOMATION_BYPASS_SECRET: "automation-secret",
    } as NodeJS.ProcessEnv);
    expect(headers).toEqual({
      "x-vercel-protection-bypass": "automation-secret",
      "x-vercel-set-bypass-cookie": "true",
    });
  });

  test("falls back to legacy bypass secret", () => {
    const headers = resolveVercelBypassHeaders({
      VERCEL_PROTECTION_BYPASS_SECRET: "legacy-secret",
    } as NodeJS.ProcessEnv);
    expect(headers).toEqual({
      "x-vercel-protection-bypass": "legacy-secret",
      "x-vercel-set-bypass-cookie": "true",
    });
  });

  test("returns null when no bypass secret is set", () => {
    expect(resolveVercelBypassHeaders({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

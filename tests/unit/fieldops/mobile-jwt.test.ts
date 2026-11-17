import { isJwtPrivilegedRole, resolveJwtRole } from "../../../apps/fieldops/src/mobile-jwt";

function encodeBase64Url(value: string) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function makeJwt(payload: Record<string, unknown>) {
  const header = encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = encodeBase64Url(JSON.stringify(payload));
  return `${header}.${body}.sig`;
}

describe("mobile jwt helpers", () => {
  const originalAtob = globalThis.atob;

  afterEach(() => {
    if (typeof originalAtob === "function") {
      globalThis.atob = originalAtob;
    } else {
      delete (globalThis as { atob?: unknown }).atob;
    }
  });

  test("resolves JWT role via base64url payload decoding", () => {
    const token = makeJwt({ role: "service_role" });
    expect(resolveJwtRole(token)).toBe("service_role");
  });

  test("falls back to Buffer decoding when atob is unavailable or throws", () => {
    globalThis.atob = (() => {
      throw new Error("atob unavailable");
    }) as typeof globalThis.atob;

    const token = makeJwt({ role: "authenticated" });
    expect(resolveJwtRole(token)).toBe("authenticated");
  });

  test("returns null for malformed payloads or missing role", () => {
    expect(resolveJwtRole("not-a-jwt")).toBeNull();
    expect(resolveJwtRole(makeJwt({}))).toBeNull();
  });

  test("detects privileged service role only", () => {
    expect(isJwtPrivilegedRole("service_role")).toBe(true);
    expect(isJwtPrivilegedRole("authenticated")).toBe(false);
    expect(isJwtPrivilegedRole(null)).toBe(false);
  });
});

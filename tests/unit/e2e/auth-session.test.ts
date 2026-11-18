import * as fs from "node:fs";
import * as path from "node:path";
import {
  extractSupabaseSessionIdentities,
  findSupabaseSessionIdentity,
} from "../../e2e/utils/auth-session";
import { rpcWithRetry, signOutSupabaseClient } from "../../e2e/utils/supabase";
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";

function encodeBase64Url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function buildJwt(payload: Record<string, unknown>) {
  return `${encodeBase64Url({ alg: "HS256", typ: "JWT" })}.${encodeBase64Url(payload)}.sig`;
}

describe("Supabase E2E session cookie parsing", () => {
  test("extracts identity from a raw session cookie", () => {
    const cookies = [
      {
        name: "sb-project-auth-token",
        value: JSON.stringify({
          access_token: buildJwt({
            sub: "user-1",
            email: "super_admin@example.com",
          }),
          refresh_token: "refresh-token",
          expires_at: 1_900_000_000,
          user: {
            id: "user-1",
            email: "super_admin@example.com",
          },
        }),
      },
    ];

    expect(extractSupabaseSessionIdentities(cookies)).toEqual([
      {
        storageKey: "sb-project-auth-token",
        email: "super_admin@example.com",
        userId: "user-1",
      },
    ]);
  });

  test("combines base64url chunked cookies and falls back to the paired user cookie", () => {
    const sessionValue = `base64-${Buffer.from(
      JSON.stringify({
        access_token: buildJwt({
          sub: "user-2",
          email: "sender@example.com",
        }),
        refresh_token: "refresh-token",
        expires_at: 1_900_000_000,
      })
    ).toString("base64url")}`;
    const midpoint = Math.floor(sessionValue.length / 2);
    const cookies = [
      {
        name: "sb-preview-auth-token.0",
        value: sessionValue.slice(0, midpoint),
      },
      {
        name: "sb-preview-auth-token.1",
        value: sessionValue.slice(midpoint),
      },
      {
        name: "sb-preview-auth-token-user",
        value: JSON.stringify({
          user: {
            id: "user-2",
            email: "sender@example.com",
          },
        }),
      },
    ];

    expect(findSupabaseSessionIdentity(cookies, "sender@example.com")).toEqual({
      storageKey: "sb-preview-auth-token",
      email: "sender@example.com",
      userId: "user-2",
    });
  });

  test("ignores unrelated cookies and returns null when the email does not match", () => {
    const cookies = [
      { name: "theme", value: "dark" },
      { name: "next-url", value: "/console" },
      {
        name: "sb-project-auth-token",
        value: JSON.stringify({
          access_token: buildJwt({
            sub: "user-3",
            email: "tenant@example.com",
          }),
          refresh_token: "refresh-token",
          expires_at: 1_900_000_000,
        }),
      },
    ];

    expect(findSupabaseSessionIdentity(cookies, "missing@example.com")).toBeNull();
  });
});

describe("Supabase E2E session cleanup", () => {
  test("signs out only the helper client session", async () => {
    const signOut = jest.fn().mockResolvedValue({ error: null });

    await signOutSupabaseClient(
      { auth: { signOut } } as any,
      { label: "unit-session-cleanup" },
    );

    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  test("keeps demo-password probes local to their helper session", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "tests", "e2e", "utils", "demo-accounts.ts"),
      "utf8",
    );

    expect(source).toContain('client.auth.signOut({ scope: "local" })');
    expect(source).not.toContain("client.auth.signOut();");
  });
});

describe("Supabase E2E bounded transient retries", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test.each([false, true])("recovers from an opaque SDK fetch error (wrapped=%s)", async (wrapped) => {
    const transient = new AuthRetryableFetchError("{}", 503);
    const error = wrapped ? Object.assign(new Error("sign-in failed: {}"), { cause: transient }) : transient;
    const rpc = jest.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue({ data: { ok: true }, error: null });
    const result = rpcWithRetry({ rpc } as any, "unit_lookup");
    await jest.runAllTimersAsync();
    await expect(result).resolves.toEqual({ data: { ok: true }, error: null });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  test("exhausts the existing three attempts and preserves the original error", async () => {
    const error = new AuthRetryableFetchError("{}", 503);
    const rpc = jest.fn().mockRejectedValue(error);
    const assertion = expect(rpcWithRetry({ rpc } as any, "unit_lookup")).rejects.toBe(error);
    await jest.runAllTimersAsync();
    await assertion;
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  test.each([400, 403])("does not retry credentials or permission failures (%s)", async (status) => {
    const error = new AuthApiError("Access denied", status, "invalid_credentials");
    const rpc = jest.fn().mockRejectedValue(error);
    await expect(rpcWithRetry({ rpc } as any, "unit_lookup")).rejects.toBe(error);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

const getVerifiedAccessToken = jest.fn();
const validateTrustedBrowserRequest = jest.fn();
const createClient = jest.fn();
const userRpc = jest.fn();
const finalRpc = jest.fn();
const providerRpc = jest.fn();
const createUser = jest.fn();
const resetPasswordForEmail = jest.fn();

jest.mock("@masarx/auth", () => ({
  ...jest.requireActual("../../packages/auth/src/redirect"), getVerifiedAccessToken, validateTrustedBrowserRequest,
}));
jest.mock("server-only", () => ({}));
jest.mock("@masarx/auth/server", () => ({ createServerReachableFetch: () => undefined }));
jest.mock("@masarx/config", () => ({ getPublicConfig: () => ({ supabaseUrl: "https://auth.example.test", supabaseAnonKey: "public-key" }) }));
jest.mock("@supabase/supabase-js", () => ({ createClient }));
import { POST } from "../../apps/console/app/api/tenant-user-invite/route";
import { createHash } from "node:crypto";

const requestId = "1282d522-ea52-44c7-a870-c958cd087f80";
const actorId = "c575f0b7-8998-4df1-b2fa-29ba8763767c";
const targetId = "ea53ab2d-c6b5-4142-ad93-1c90660a6846";
const payload = { request_id: requestId, action: "invite", email: "new@example.test", full_name: "Example Person",
  user_type: "account_manager", role_id: "9c78866b-1746-48d5-a31a-72179ced9b99", access_scope_type: "tenant" };
const publicResponse = { ok: true, request_id: requestId, code: "invite_request_recorded" };
const request = (body = payload) => new Request("https://unjijvxjrwurjgsnokovrvom.example.invalid/api/tenant-user-invite", {
  method: "POST", headers: { "content-type": "application/json", origin: "https://unjijvxjrwurjgsnokovrvom.example.invalid" }, body: JSON.stringify(body),
});
function streamedRequest(chunks: Uint8Array[], contentLength?: string) {
  const cancel = jest.fn();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else controller.close();
    },
    cancel,
  });
  const headers: Record<string, string> = { "content-type": "application/json", origin: "https://unjijvxjrwurjgsnokovrvom.example.invalid" };
  if (contentLength !== undefined) headers["content-length"] = contentLength;
  const req = new Request("https://unjijvxjrwurjgsnokovrvom.example.invalid/api/tenant-user-invite", {
    method: "POST", headers, body: stream, duplex: "half",
  } as RequestInit);
  return { req, cancel, consumed: () => index };
}

describe("tenant user invite route (fake provider only)", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.CONSOLE_BASE_URL = "https://unjijvxjrwurjgsnokovrvom.example.invalid";
    process.env.NEXT_PUBLIC_APP_BASE_PATH = "";
    process.env.SUPABASE_SECRET_KEY = "synthetic-server-secret";
    validateTrustedBrowserRequest.mockReturnValue({ ok: true });
    getVerifiedAccessToken
      .mockResolvedValueOnce({ client: { rpc: userRpc }, user: { id: actorId }, accessToken: "verified", error: null })
      .mockResolvedValue({ client: { rpc: finalRpc }, user: { id: actorId }, accessToken: "fresh", error: null });
    userRpc.mockImplementation(async (name: string) => name === "tenant_user_invite_prepare_v1"
      ? { data: { provider_state: "ready" }, error: null }
      : { data: { should_dispatch: true, email: payload.email }, error: null });
    finalRpc.mockResolvedValue({ data: { request_id: requestId, provider_state: "accepted", membership_state: "pending" }, error: null });
    providerRpc.mockImplementation(async (name: string) => name === "tenant_user_invite_mailbox_issue_v1"
      ? { data: { auth_user_id: targetId, email: payload.email, acceptance_mode: "new_account" }, error: null } : { error: null });
    createUser.mockResolvedValue({ data: { user: { id: targetId } }, error: null });
    resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    createClient.mockReturnValue({ auth: { admin: { createUser }, resetPasswordForEmail }, rpc: providerRpc });
  });

  test("rejects untrusted browser requests before session/provider calls", async () => {
    validateTrustedBrowserRequest.mockReturnValue({ ok: false, status: 403, code: "origin_mismatch" });
    expect((await POST(request())).status).toBe(403);
    expect(getVerifiedAccessToken).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  test("requires a verified actor and checks authorization before provider construction", async () => {
    getVerifiedAccessToken.mockReset().mockResolvedValue({ error: new Error("missing"), user: null });
    expect((await POST(request())).status).toBe(401);
    expect(userRpc).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  test("tokenless chunked requests are rejected without reading or dispatching their body", async () => {
    getVerifiedAccessToken.mockReset().mockResolvedValue({ error: new Error("missing"), user: null });
    const { req } = streamedRequest([new Uint8Array(8193)]);
    const getReader = jest.spyOn(req.body!, "getReader");
    expect((await POST(req)).status).toBe(401);
    expect(getReader).not.toHaveBeenCalled();
    expect(userRpc).not.toHaveBeenCalled();
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  test.each([undefined, "1", "not-a-length"])(
    "bounds chunked body bytes even with missing/lying Content-Length %s", async (length) => {
      const { req, cancel, consumed } = streamedRequest(Array.from({ length: 20 }, () => new Uint8Array(1024)), length);
      const text = jest.spyOn(req, "text");
      const result = await POST(req);
      expect(result.status).toBe(413);
      expect((await result.json()).code).toBe("request_too_large");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(consumed()).toBeLessThan(20);
      expect(text).not.toHaveBeenCalled();
      expect(userRpc).not.toHaveBeenCalled();
      expect(resetPasswordForEmail).not.toHaveBeenCalled();
    });

  test("accepts a valid body exactly at the byte limit without trusting declared length", async () => {
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const padded = new Uint8Array(8192).fill(32);
    padded.set(json);
    const { req, cancel } = streamedRequest([padded.subarray(0, 4096), padded.subarray(4096)], "1");
    expect((await POST(req)).status).toBe(202);
    expect(cancel).not.toHaveBeenCalled();
    expect(resetPasswordForEmail).toHaveBeenCalledTimes(1);
  });

  test.each([new TextEncoder().encode('{"broken":'), new Uint8Array([0xff])])(
    "rejects malformed streamed JSON/UTF-8 without dispatch (case %#)", async (bytes) => {
      const { req } = streamedRequest([bytes]);
      expect((await POST(req)).status).toBe(400);
      expect(userRpc).not.toHaveBeenCalled();
      expect(resetPasswordForEmail).not.toHaveBeenCalled();
    });

  test("uses the same verified client, strips supplied authority and configures only the server callback", async () => {
    const result = await POST(request({ ...payload, actor_user_id: "forged", organization_id: "forged",
      invite_redirect_to: "https://attacker.example.test", tenant_user_invite_confirm_url: "https://attacker.example.test",
      data: { tenant_user_invite_confirm_url: "https://attacker.example.test", role: "platform_admin" } } as typeof payload));
    expect(result.status).toBe(202);
    expect(userRpc.mock.calls[0]).toEqual(["tenant_user_invite_prepare_v1", { p_request_id: requestId,
      p_args: { action: "invite", email: payload.email, full_name: payload.full_name, user_type: payload.user_type,
        role_id: payload.role_id, access_scope_type: "tenant", access_scope_id: null } }]);
    expect(createUser).toHaveBeenCalledWith({ email: payload.email, email_confirm: true,
      password: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(resetPasswordForEmail).toHaveBeenCalledTimes(1);
    const [email, options] = resetPasswordForEmail.mock.calls[0];
    const acceptance = new URL(options.redirectTo);
    expect(email).toBe(payload.email);
    expect(acceptance.origin + acceptance.pathname).toBe("https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/invite-confirm");
    expect([...acceptance.searchParams.keys()]).toEqual(["request_id"]);
    expect(acceptance.searchParams.get("request_id")).toBe(requestId);
    const token = acceptance.hash.slice("#token=".length);
    expect(acceptance.hash).toBe(`#token=${token}`);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(options).toEqual({ redirectTo: acceptance.toString() });
    expect(providerRpc).toHaveBeenCalledWith("tenant_user_invite_mailbox_issue_v1", {
      p_request_id: requestId, p_token_hash: createHash("sha256").update(token).digest("hex"),
      p_created_auth_user_id: targetId,
    });
    expect(JSON.stringify(providerRpc.mock.calls)).not.toContain(token);
    expect(JSON.stringify(userRpc.mock.calls)).not.toContain(token);
    expect(acceptance.origin + acceptance.pathname + acceptance.search).not.toContain(token);
    expect(providerRpc).toHaveBeenCalledWith("tenant_user_invite_provider_result_v1", {
      p_request_id: requestId, p_state: "accepted", p_auth_user_id: targetId,
    });
    expect(finalRpc).toHaveBeenCalledWith("tenant_user_invite_finalize_v1", { p_request_id: requestId });
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual(publicResponse);
    const placeholderPassword = createUser.mock.calls[0][0].password;
    expect(placeholderPassword).not.toBe(token);
    expect(JSON.stringify(providerRpc.mock.calls)).not.toContain(placeholderPassword);
    expect(JSON.stringify(resetPasswordForEmail.mock.calls)).not.toContain(placeholderPassword);
  });

  test("never exposes global Auth identity or unexpected RPC fields", async () => {
    finalRpc.mockResolvedValue({ error: null, data: { request_id: requestId, provider_state: "accepted",
      membership_state: "applied", user_id: targetId, auth_user_id: targetId, private_detail: "private" } });
    const body = await (await POST(request())).json();
    expect(body).not.toHaveProperty("user_id");
    expect(body).not.toHaveProperty("auth_user_id");
    expect(body).not.toHaveProperty("private_detail");
    expect(body.request_id).toBe(requestId);
    expect(body).toEqual(publicResponse);
  });

  test("does not call provider on capability, tenant, scope or role refusal", async () => {
    userRpc.mockResolvedValue({ error: { code: "42501", message: "synthetic private refusal" } });
    const result = await POST(request());
    expect(result.status).toBe(403);
    expect(JSON.stringify(await result.json())).not.toContain("private refusal");
    expect(createClient).not.toHaveBeenCalled();
  });

  test("loss of SQL authority at dispatch prevents the provider side effect", async () => {
    userRpc.mockImplementation(async (name: string) => name === "tenant_user_invite_prepare_v1"
      ? { data: { provider_state: "ready" }, error: null } : { error: { code: "42501" } });
    expect((await POST(request())).status).toBe(403);
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
    expect(finalRpc).not.toHaveBeenCalled();
  });

  test.each(["http://unjijvxjrwurjgsnokovrvom.example.invalid", "http://127.0.0.1:5175", "http://localhost:5175",
    "https://127.0.0.1", (["https",":","/","/","user",":","ujvjpuxjqotvyoigplxyylmo","@","example.invalid"].join("")), "https://console.example.test", ""]) (
    "fails before dispatch for unavailable configured callback %s", async (url) => {
      process.env.CONSOLE_BASE_URL = url;
      expect((await POST(request())).status).toBe(503);
      expect(userRpc).toHaveBeenCalledTimes(1);
      expect(createUser).not.toHaveBeenCalled();
      expect(providerRpc).not.toHaveBeenCalled();
      expect(resetPasswordForEmail).not.toHaveBeenCalled();
    });

  test.each([["/console", "/auth/invite-confirm"], ["/portal", "/auth/invite-confirm"]])(
    "uses the house app base %s and excludes configured URL path/query/hash", async (base, expectedPath) => {
      process.env.NEXT_PUBLIC_APP_BASE_PATH = base;
      process.env.CONSOLE_BASE_URL = "https://unjijvxjrwurjgsnokovrvom.example.invalid/ignored?private=value#fragment";
      expect((await POST(request())).status).toBe(202);
      const expected = `https://unjijvxjrwurjgsnokovrvom.example.invalid${expectedPath}`;
      const acceptance = new URL(resetPasswordForEmail.mock.calls[0][1].redirectTo);
      expect(acceptance.origin + acceptance.pathname).toBe(expected);
      expect(acceptance.searchParams.get("request_id")).toBe(requestId);
    });

  test.each(["https://unjijvxjrwurjgsnokovrvom.example.invalid", "https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid", "https://vtgspxqkvhurpwtxnnyvhjzw.example.invalid"])(
    "uses only a canonical root-served Console recovery template for %s", async (origin) => {
      process.env.CONSOLE_BASE_URL = origin;
      expect((await POST(request())).status).toBe(202);
      const acceptance = new URL(resetPasswordForEmail.mock.calls[0][1].redirectTo);
      expect(acceptance.origin + acceptance.pathname).toBe(`${origin}/auth/invite-confirm`);
    });

  test("custom app bases fail before dispatch instead of falling through the legacy recovery link", async () => {
    process.env.NEXT_PUBLIC_APP_BASE_PATH = "/tenant-console";
    expect((await POST(request())).status).toBe(503);
    expect(userRpc).toHaveBeenCalledTimes(1);
    expect(createUser).not.toHaveBeenCalled();
    expect(providerRpc).not.toHaveBeenCalled();
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  test("receipt replay never instantiates an admin or resends", async () => {
    delete process.env.CONSOLE_BASE_URL;
    userRpc.mockImplementation(async (name: string) => ({ error: null,
      data: name === "tenant_user_invite_prepare_v1" ? { provider_state: "accepted" } : { should_dispatch: false } }));
    expect((await POST(request())).status).toBe(202);
    expect(createClient).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  test("an existing active member receives proof but never a new-account attestation", async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { code: "email_exists", status: 422 } });
    providerRpc.mockImplementation(async (name: string) => name === "tenant_user_invite_mailbox_issue_v1"
      ? { data: { auth_user_id: targetId, email: payload.email, acceptance_mode: "active_member" }, error: null } : { error: null });
    const result = await POST(request());
    expect(result.status).toBe(202);
    expect(await result.json()).toEqual(publicResponse);
    expect(providerRpc).toHaveBeenCalledWith("tenant_user_invite_mailbox_issue_v1", {
      p_request_id: requestId, p_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      p_created_auth_user_id: null,
    });
    expect(resetPasswordForEmail).toHaveBeenCalledTimes(1);
  });

  test("an orphan receives only the neutral support email link and the identical administrator response", async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { code: "email_exists", status: 422 } });
    providerRpc.mockImplementation(async (name: string) => name === "tenant_user_invite_mailbox_issue_v1"
      ? { data: { email: payload.email, acceptance_mode: "support_only" }, error: null } : { error: null });
    const result = await POST(request());
    expect(result.status).toBe(202);
    expect(await result.json()).toEqual(publicResponse);
    expect(providerRpc).toHaveBeenCalledWith("tenant_user_invite_mailbox_issue_v1", {
      p_request_id: requestId, p_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/), p_created_auth_user_id: null,
    });
    const acceptance = new URL(resetPasswordForEmail.mock.calls[0][1].redirectTo);
    expect(acceptance.toString()).toBe("https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/invite-confirm?support=1");
    expect(acceptance.searchParams.has("token")).toBe(false);
    expect(acceptance.searchParams.has("request_id")).toBe(false);
    expect(acceptance.hash).toBe("");
    expect(providerRpc).toHaveBeenCalledWith("tenant_user_invite_provider_result_v1", {
      p_request_id: requestId, p_state: "accepted", p_auth_user_id: null,
    });
  });

  test("an ambiguous create response never attests an account or issues a mailbox token", async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: null });
    expect(await (await POST(request())).json()).toEqual(publicResponse);
    expect(providerRpc).not.toHaveBeenCalledWith("tenant_user_invite_mailbox_issue_v1", expect.anything());
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
    expect(providerRpc).toHaveBeenCalledWith("tenant_user_invite_provider_result_v1", {
      p_request_id: requestId, p_state: "unknown", p_auth_user_id: null,
    });
  });

  test("different invitations never reuse their application secret", async () => {
    const actor = { client: { rpc: userRpc }, user: { id: actorId }, accessToken: "verified", error: null };
    const current = { ...actor, client: { rpc: finalRpc }, accessToken: "fresh" };
    getVerifiedAccessToken.mockReset()
      .mockResolvedValueOnce(actor).mockResolvedValueOnce(current)
      .mockResolvedValueOnce(actor).mockResolvedValueOnce(current);
    await POST(request());
    await POST(request({ ...payload, request_id: "28746cab-1f44-4d7a-8ae7-aed933fa4f01" }));
    const urls = resetPasswordForEmail.mock.calls.map(([, options]) => new URL(options.redirectTo));
    expect(urls).toHaveLength(2);
    const [first, second] = urls;
    if (!first || !second) throw new Error("Expected separate delivery links for both invitations");
    expect(first.hash).toMatch(/^#token=[a-f0-9]{64}$/);
    expect(second.hash).toMatch(/^#token=[a-f0-9]{64}$/);
    expect(first.hash).not.toBe(second.hash);
    expect(first.searchParams.get("request_id")).not.toBe(second.searchParams.get("request_id"));
  });

  test.each([
    { data: null, error: { code: "42501" } },
    { data: { auth_user_id: "invalid", email: payload.email, acceptance_mode: "new_account" }, error: null },
    { data: { auth_user_id: actorId, email: payload.email, acceptance_mode: "new_account" }, error: null },
    { data: { auth_user_id: targetId, email: "different@example.test", acceptance_mode: "new_account" }, error: null },
    { data: { auth_user_id: targetId, email: payload.email, acceptance_mode: "unexpected" }, error: null },
  ])("never sends email if the service-only mailbox binding is not exact (case %#)", async (issued) => {
    providerRpc.mockImplementation(async (name: string) => name === "tenant_user_invite_mailbox_issue_v1"
      ? issued : { error: null });
    await POST(request());
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
    expect(providerRpc).toHaveBeenCalledWith("tenant_user_invite_provider_result_v1", {
      p_request_id: requestId, p_state: "unknown", p_auth_user_id: null,
    });
  });

  test("a definite account-creation refusal does not send email or issue a mailbox token", async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { code: "other_refusal", status: 422 } });
    await POST(request());
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
    expect(providerRpc).toHaveBeenCalledTimes(1);
    expect(providerRpc).toHaveBeenCalledWith("tenant_user_invite_provider_result_v1", {
      p_request_id: requestId, p_state: "failed", p_auth_user_id: null,
    });
  });

  test("explicit resend accepts target only; browser grants cannot change existing membership", async () => {
    await POST(request({ ...payload, action: "resend", target_user_id: targetId } as typeof payload));
    expect(userRpc.mock.calls[0]).toEqual(["tenant_user_invite_prepare_v1", {
      p_request_id: requestId, p_args: { action: "resend", target_user_id: targetId },
    }]);
  });

  test.each([408, 429, 500, undefined])("records provider status %s as unknown, without retry", async (status) => {
    resetPasswordForEmail.mockResolvedValue({ data: {}, error: { status, message: "private upstream text" } });
    finalRpc.mockResolvedValue({ data: { request_id: requestId, provider_state: "unknown", membership_state: "pending" }, error: null });
    const result = await POST(request());
    expect(result.status).toBe(202);
    expect(await result.json()).toEqual(publicResponse);
    expect(resetPasswordForEmail).toHaveBeenCalledTimes(1);
    expect(providerRpc).toHaveBeenCalledWith("tenant_user_invite_provider_result_v1", {
      p_request_id: requestId, p_state: "unknown", p_auth_user_id: null,
    });
  });

  test("a definite provider refusal does not become email or membership success", async () => {
    resetPasswordForEmail.mockResolvedValue({ data: {}, error: { status: 422 } });
    finalRpc.mockResolvedValue({ data: { provider_state: "failed", membership_state: "pending" }, error: null });
    const result = await POST(request());
    expect(result.status).toBe(202);
    expect(await result.json()).toEqual(publicResponse);
    expect(providerRpc).toHaveBeenCalledWith("tenant_user_invite_provider_result_v1", {
      p_request_id: requestId, p_state: "failed", p_auth_user_id: null,
    });
  });

  test("lost provider response is durable unknown, not an automatic retry or deletion", async () => {
    resetPasswordForEmail.mockRejectedValue(new Error("response lost"));
    await POST(request());
    expect(providerRpc).toHaveBeenCalledWith("tenant_user_invite_provider_result_v1", {
      p_request_id: requestId, p_state: "unknown", p_auth_user_id: null,
    });
    expect(resetPasswordForEmail).toHaveBeenCalledTimes(1);
  });

  test("private finalization refusal cannot become an account-existence oracle", async () => {
    finalRpc.mockResolvedValue({ error: { code: "42501" } });
    const result = await POST(request());
    expect(result.status).toBe(202);
    expect(await result.json()).toEqual(publicResponse);
    expect(providerRpc).toHaveBeenCalledWith("tenant_user_invite_provider_result_v1", {
      p_request_id: requestId, p_state: "accepted", p_auth_user_id: targetId,
    });
  });

  test("a thrown private finalization error has the same neutral recorded response", async () => {
    finalRpc.mockRejectedValue(new Error("transport lost"));
    const result = await POST(request());
    expect(result.status).toBe(202);
    expect(await result.json()).toEqual(publicResponse);
    expect(resetPasswordForEmail).toHaveBeenCalledTimes(1);
  });

  test("changed post-provider identity cannot finalize using the old session", async () => {
    getVerifiedAccessToken.mockReset()
      .mockResolvedValueOnce({ client: { rpc: userRpc }, user: { id: actorId }, accessToken: "verified" })
      .mockResolvedValueOnce({ client: { rpc: finalRpc }, user: { id: targetId }, accessToken: "other" });
    expect((await POST(request())).status).toBe(409);
    expect(finalRpc).not.toHaveBeenCalled();
    expect(resetPasswordForEmail).toHaveBeenCalledTimes(1);
  });

  test("provider receipt failure is not exposed as a private row flag", async () => {
    providerRpc.mockImplementation(async (name: string) => {
      if (name === "tenant_user_invite_mailbox_issue_v1") return { data: { auth_user_id: targetId, email: payload.email, acceptance_mode: "new_account" }, error: null };
      throw new Error("database unavailable");
    });
    const result = await POST(request());
    expect(await result.json()).toEqual(publicResponse);
  });

  test("does not expose no-email provisioning to the caller", async () => {
    expect((await POST(request({ ...payload, send_email: false } as typeof payload))).status).toBe(400);
    expect(createClient).not.toHaveBeenCalled();
  });

  test("rejects malformed/oversized input before external activity", async () => {
    expect((await POST(request({ ...payload, request_id: "invalid" }))).status).toBe(400);
    expect((await POST(request({ ...payload, full_name: "x".repeat(8192) }))).status).toBe(413);
    expect(createClient).not.toHaveBeenCalled();
  });
});

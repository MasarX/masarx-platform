import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
const createServerClient = jest.fn();
const getVerifiedAccessToken = jest.fn();
const rpc = jest.fn();
const recipientRpc = jest.fn();
const reset = jest.fn();
const signOut = jest.fn();
const recipientLogin = jest.fn();
const createTenantUserInviteProviderClient = jest.fn();
jest.mock("server-only", () => ({}));
jest.mock("@masarx/auth", () => ({
  ...jest.requireActual("../../packages/auth/src/redirect"), createServerClient, getVerifiedAccessToken,
}));
jest.mock("../../apps/shared/tenant-user-invite-provider", () => ({ createTenantUserInviteProviderClient }));
import { GET, POST } from "../../apps/console/app/auth/invite-confirm/route";

const token = "a".repeat(64);
const requestId = "10000000-0000-4000-8000-000000000001";
const password = "synthetic-new-private-password";
const query = "request_id=" + requestId + "&token=" + token;
const body = query + "&new_password=" + password;
const fragmentQuery = "request_id=" + requestId + "#token=" + token;
const identity = { auth_user_id: "verified-user", email: "synthetic@example.test", acceptance_mode: "new_account" };
const sessionResult = () => ({ error: null, data: {
  user: { id: identity.auth_user_id },
  session: { access_token: "synthetic-private-session", user: { id: identity.auth_user_id } },
} });
const request = (value = fragmentQuery) => new Request("https://internal.example.test/auth/invite-confirm?" + value);
const confirmRequest = (value = body, origin: string | null = "https://console.example.test") => {
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" });
  if (origin !== null) headers.set("origin", origin);
  return new Request("https://internal.example.test/auth/invite-confirm", { method: "POST", headers, body: value });
};
beforeEach(() => {
  jest.resetAllMocks();
  process.env.CONSOLE_BASE_URL = "https://console.example.test";
  process.env.NEXT_PUBLIC_APP_BASE_PATH = "/console";
  rpc.mockImplementation(async (name: string) => ({
    error: null, data: name.endsWith("claim_v1") ? identity : { accepted: true },
  }));
  recipientRpc.mockImplementation(async (name: string) => ({ error: null,
    data: name.endsWith("claim_v1") ? { ...identity, acceptance_mode: "active_member" } : { accepted: true } }));
  getVerifiedAccessToken.mockResolvedValue({ user: { id: identity.auth_user_id }, accessToken: "verified-recipient", error: null,
    client: { rpc: recipientRpc } });
  reset.mockResolvedValue({ error: null, data: { user: { id: identity.auth_user_id } } });
  recipientLogin.mockResolvedValue(sessionResult());
  signOut.mockResolvedValue({ error: null });
  createTenantUserInviteProviderClient.mockReturnValue({ rpc, auth: { admin: { updateUserById: reset, signOut } } });
  createServerClient.mockReturnValue({ auth: { signInWithPassword: recipientLogin } });
});

test("scanner GET renders a nonce-only bridge and manual form without exposing or spending proof", async () => {
  const result = await GET(request());
  expect(result.status).toBe(200);
  const html = await result.text();
  expect(html).toContain('<form method="post"');
  expect(html).toContain('action="https://console.example.test/auth/invite-confirm"');
  expect(html).toContain('autocomplete="new-password"');
  expect(html).toContain('<label for="new-password">');
  expect(html).toContain("manager must then check");
  expect(html).toContain("sign in to that same account first");
  expect(html).toContain("existing password and sessions will not change");
  expect(html).not.toContain(token);
  expect(html).toContain('<input type="hidden" id="invite-token" name="token" value="">');
  expect(html).toContain('id="accept-invite" disabled');
  expect(html).toContain('<p id="invite-status" role="status">');
  expect(html).toContain("<noscript>");
  expect(html).toContain("Enable it and reopen the link from your email");
  expect(html).not.toMatch(/http-equiv="refresh"|<script[^>]+src=|\son\w+=/i);
  const nonce = /<script nonce="([A-Za-z0-9+/]{24})">/.exec(html)?.[1];
  expect(nonce).toBeDefined();
  expect(result.headers.get("content-security-policy")).toBe(
    `default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'nonce-${nonce}'`);
  expect([...result.headers.values()].join(" ")).not.toContain(token);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(result.headers.get("referrer-policy")).toBe("no-referrer");
  const secondHtml = await (await GET(request())).text();
  expect(secondHtml).not.toContain(`nonce="${nonce}"`);
  expect(createTenantUserInviteProviderClient).not.toHaveBeenCalled();
  expect(createServerClient).not.toHaveBeenCalled();
  expect(getVerifiedAccessToken).not.toHaveBeenCalled();
});

async function runBridge(fragment: string, clearFails = false) {
  const html = await (await GET(request())).text();
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error("Expected the private-link bridge");
  const events: string[] = [];
  const tokenInput = { value: "" };
  const submit = { disabled: true };
  const status = { textContent: "Checking" };
  const replaceState = jest.fn((_state: unknown, _unused: string, path: string) => {
    events.push("cleared");
    expect(path).toBe("/auth/invite-confirm?request_id=" + requestId);
    expect(tokenInput.value).toBe("");
    expect(submit.disabled).toBe(true);
    if (clearFails) throw new Error("history unavailable");
  });
  const elements: Record<string, unknown> = {
    "invite-status": status, "invite-token": tokenInput, "accept-invite": submit,
  };
  const getElementById = jest.fn((id: string) => elements[id]);
  runInNewContext(script, {
    document: { getElementById }, history: { replaceState },
    location: { hash: fragment, pathname: "/auth/invite-confirm", search: "?request_id=" + requestId },
  });
  return { script, events, tokenInput, submit, status, replaceState };
}

test("bridge clears the fragment before populating proof and enables explicit submission only", async () => {
  const bridge = await runBridge("#token=" + token);
  expect(bridge.events).toEqual(["cleared"]);
  expect(bridge.replaceState).toHaveBeenCalledTimes(1);
  expect(bridge.tokenInput.value).toBe(token);
  expect(bridge.submit.disabled).toBe(false);
  expect(bridge.status.textContent).toContain("choose Accept invitation");
  expect(bridge.script).not.toMatch(/fetch\s*\(|XMLHttpRequest|sendBeacon|\.submit\s*\(|requestSubmit|innerHTML|localStorage|sessionStorage|console\./);
  expect(rpc).not.toHaveBeenCalled();
  expect(createTenantUserInviteProviderClient).not.toHaveBeenCalled();
});

test.each(["", "#", "#token=", "#unknown=" + token, "#token=" + token + "&token=" + token,
  "#token=" + token + "&unknown=value", "#token=" + token + "#other", "#token=" + "a".repeat(65),
  "#token=" + "A".repeat(64), "#token=%61" + "a".repeat(63), "#token=" + token + "\n",
  "#token=" + token + "%0a", "#token=<script>"])(
  "malformed, duplicate or unknown fragment is cleared and cannot enable acceptance: %s", async (fragment) => {
    const bridge = await runBridge(fragment);
    expect(bridge.replaceState).toHaveBeenCalledTimes(1);
    expect(bridge.tokenInput.value).toBe("");
    expect(bridge.submit.disabled).toBe(true);
    expect(bridge.status.textContent).toContain("incomplete or invalid");
    expect(bridge.status.textContent).not.toContain(fragment.replace(/^#/, "") || "token=");
    expect(rpc).not.toHaveBeenCalled();
  });

test("unavailable history clearing fails closed without populating the token", async () => {
  const bridge = await runBridge("#token=" + token, true);
  expect(bridge.tokenInput.value).toBe("");
  expect(bridge.submit.disabled).toBe(true);
  expect(bridge.status.textContent).toContain("could not be cleared");
  expect(bridge.status.textContent).not.toContain(token);
});

test.each([query, query + "#token=" + token, "request_id=" + requestId + "&other=value#token=" + token])(
  "legacy token query and unknown query fields are denied without reflecting the secret: %s", async (value) => {
    const response = await GET(request(value));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://console.example.test/?error=invite_confirmation_invalid");
    expect([...response.headers.values()].join(" ") + await response.text()).not.toContain(token);
    expect(createTenantUserInviteProviderClient).not.toHaveBeenCalled();
  });

test("attested new account claim -> first known password -> DB acceptance -> recipient session", async () => {
  const result = await POST(confirmRequest());
  const args = { p_request_id: requestId, p_token_hash: createHash("sha256").update(token).digest("hex") };
  expect(rpc.mock.calls).toEqual([
    ["tenant_user_invite_mailbox_claim_v1", { ...args, p_new_password: password }],
    ["tenant_user_invite_mailbox_accept_v1", { ...args, p_new_password: password }],
  ]);
  expect(reset).toHaveBeenCalledWith(identity.auth_user_id, { password, email_confirm: true });
  expect(signOut).not.toHaveBeenCalled();
  expect(getVerifiedAccessToken).not.toHaveBeenCalled();
  expect(createTenantUserInviteProviderClient).toHaveBeenCalledTimes(1);
  expect(createServerClient).toHaveBeenCalledWith({ allowCookieSet: true });
  expect(recipientLogin).toHaveBeenCalledWith({ email: identity.email, password });
  const [claimOrder, acceptanceOrder] = rpc.mock.invocationCallOrder;
  const [passwordOrder] = reset.mock.invocationCallOrder;
  const [loginOrder] = recipientLogin.mock.invocationCallOrder;
  if (claimOrder === undefined || acceptanceOrder === undefined || passwordOrder === undefined || loginOrder === undefined) {
    throw new Error("Expected claim, password setup, acceptance and recipient login calls");
  }
  expect(claimOrder).toBeLessThan(passwordOrder);
  expect(passwordOrder).toBeLessThan(acceptanceOrder);
  expect(acceptanceOrder).toBeLessThan(loginOrder);
  expect(result.status).toBe(303);
  expect(result.headers.get("location")).toBe("https://console.example.test/?invite=accepted_pending_manager");
});

test("active member needs this token and their verified same-account session, without credential changes", async () => {
  rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "tenant_user_invite:recipient_session_required" } });
  const result = await POST(confirmRequest(query));
  expect(result.headers.get("location")).toContain("accepted_pending_manager");
  const args = { p_request_id: requestId, p_token_hash: createHash("sha256").update(token).digest("hex"), p_new_password: null };
  expect(recipientRpc.mock.calls).toEqual([
    ["tenant_user_invite_mailbox_claim_v1", args], ["tenant_user_invite_mailbox_accept_v1", args],
  ]);
  expect(getVerifiedAccessToken).toHaveBeenCalledWith({ allowCookieSet: false });
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(reset).not.toHaveBeenCalled();
  expect(signOut).not.toHaveBeenCalled();
  expect(createServerClient).not.toHaveBeenCalled();
});

test.each(["claim", "reset", "accept", "recipient"])("uncertain new-account %s fails closed without later side effects", async (step) => {
  if (step === "claim") rpc.mockResolvedValue({ error: new Error("private claim"), data: null });
  if (step === "reset") reset.mockResolvedValue({ error: new Error("private reset"), data: { user: null } });
  if (step === "accept") rpc.mockImplementation(async (name: string) => ({ error: null, data: name.endsWith("claim_v1") ? identity : { accepted: false } }));
  if (step === "recipient") recipientLogin.mockResolvedValue({ error: null, data: { user: { id: "wrong" }, session: null } });
  const result = await POST(confirmRequest());
  expect(result.headers.get("location")).toBe("https://console.example.test/?error=invite_confirmation_failed");
  const publicResult = [...result.headers.values()].join(" ") + await result.text();
  for (const secret of [token, password, identity.auth_user_id, identity.email]) expect(publicResult).not.toContain(secret);
  if (step === "claim") expect(reset).not.toHaveBeenCalled();
  expect(signOut).not.toHaveBeenCalled();
  if (["claim", "reset"].includes(step)) expect(rpc).toHaveBeenCalledTimes(1);
  if (step !== "recipient") expect(createServerClient).not.toHaveBeenCalled();
});

test("orphan denial cannot record acceptance or call any credential API", async () => {
  rpc.mockResolvedValue({ error: { code: "42501", message: "private orphan/credential detail" }, data: null });
  expect((await POST(confirmRequest(query))).headers.get("location")).toContain("invite_confirmation_failed");
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(getVerifiedAccessToken).not.toHaveBeenCalled();
  expect(reset).not.toHaveBeenCalled();
  expect(signOut).not.toHaveBeenCalled();
});

test("support-only GET is neutral and never confirms, accepts, or calls Auth", async () => {
  const result = await GET(request("support=1"));
  const html = await result.text();
  expect(result.status).toBe(200);
  expect(html).toContain("Contact your administrator or support");
  expect(html).toContain("does not confirm an account, change credentials, or grant tenant access");
  expect(html).not.toContain("<form");
  expect(html).not.toContain("<script");
  expect(html).not.toContain(token);
  expect(result.headers.get("referrer-policy")).toBe("no-referrer");
  expect(createTenantUserInviteProviderClient).not.toHaveBeenCalled();
  expect(createServerClient).not.toHaveBeenCalled();
  expect(getVerifiedAccessToken).not.toHaveBeenCalled();
});

test.each([
  { user: null, accessToken: null, error: new Error("missing") },
  { user: { id: identity.auth_user_id }, accessToken: null, error: null },
  { user: { id: identity.auth_user_id }, accessToken: "token", error: new Error("revoked") },
])("member proof cannot replace a verified recipient session: %j", async (session) => {
  rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "tenant_user_invite:recipient_session_required" } });
  getVerifiedAccessToken.mockResolvedValue({ ...session, client: { rpc: recipientRpc } });
  expect((await POST(confirmRequest(query))).headers.get("location")).toContain("invite_confirmation_failed");
  expect(recipientRpc).not.toHaveBeenCalled();
  expect(reset).not.toHaveBeenCalled();
});

test("wrong signed-in recipient cannot accept or fall back to a service-authority update", async () => {
  rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "tenant_user_invite:recipient_session_required" } });
  getVerifiedAccessToken.mockResolvedValue({ user: { id: "wrong" }, accessToken: "other", error: null,
    client: { rpc: recipientRpc } });
  expect((await POST(confirmRequest(query))).headers.get("location")).toContain("invite_confirmation_failed");
  expect(recipientRpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(reset).not.toHaveBeenCalled();
});

test.each(["claim", "accept"])("member %s refusal never falls back to service acceptance", async (step) => {
  rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "tenant_user_invite:recipient_session_required" } });
  recipientRpc.mockImplementation(async (name: string) => ({
    data: name.endsWith("claim_v1") ? { ...identity, acceptance_mode: "active_member" } : { accepted: true },
    error: name.endsWith(step + "_v1") ? { code: "42501" } : null,
  }));
  expect((await POST(confirmRequest(query))).headers.get("location")).toContain("invite_confirmation_failed");
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(reset).not.toHaveBeenCalled();
  expect(signOut).not.toHaveBeenCalled();
});

test.each([
  { auth_user_id: "verified-user", email: identity.email },
  { auth_user_id: 1, email: identity.email, acceptance_mode: "new_account" },
  { ...identity, acceptance_mode: "active_member" },
  { ...identity, acceptance_mode: "support_only" },
  null,
])("malformed service claim cannot select an Auth account: %j", async (data) => {
  rpc.mockResolvedValue({ error: null, data });
  expect((await POST(confirmRequest())).headers.get("location")).toContain("invite_confirmation_failed");
  expect(reset).not.toHaveBeenCalled();
});

test("no new password cannot proceed for a nonmember, even with a malformed permissive claim", async () => {
  expect((await POST(confirmRequest(query))).headers.get("location")).toContain("invite_confirmation_failed");
  expect(reset).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledTimes(1);
});

test.each(["", "token=" + token, query + "&token=other", query + "&request_id=" + requestId,
  "request_id=" + requestId + "&token=" + "a".repeat(65), "request_id=wrong&token=" + token,
  "request_id=" + requestId + "&token=%3Cscript%3E"])("invalid/duplicate invite proof never reaches provider: %s", async (value) => {
  expect((await GET(request(value))).headers.get("location")).toContain("invite_confirmation_invalid");
  expect((await POST(confirmRequest(value))).headers.get("location")).toContain("invite_confirmation_invalid");
  expect(createTenantUserInviteProviderClient).not.toHaveBeenCalled();
});

test.each(["short", "a".repeat(73), "🙂".repeat(19)])("invalid password length/UTF8 byte limit is rejected (case %#)", async (value) => {
  expect((await POST(confirmRequest(query + "&new_password=" + encodeURIComponent(value)))).headers.get("location")).toContain("invite_confirmation_invalid");
  expect(createTenantUserInviteProviderClient).not.toHaveBeenCalled();
});

test("duplicate password fields fail closed", async () => {
  expect((await POST(confirmRequest(body + "&new_password=other"))).headers.get("location")).toContain("invite_confirmation_invalid");
  expect(rpc).not.toHaveBeenCalled();
});

test("Host/next/redirect cannot change server-configured destination", async () => {
  expect((await POST(confirmRequest(body + "&next=https://attacker.example/"))).headers.get("location")).toBe("https://console.example.test/?invite=accepted_pending_manager");
});

test("configured nonlegacy app base is retained and URL query/hash discarded", async () => {
  process.env.NEXT_PUBLIC_APP_BASE_PATH = "/tenant-console";
  process.env.CONSOLE_BASE_URL = "https://console.example.test/ignored?private=value#fragment";
  expect(await (await GET(request())).text()).toContain('action="https://console.example.test/tenant-console/auth/invite-confirm"');
  expect((await POST(confirmRequest())).headers.get("location")).toBe("https://console.example.test/tenant-console?invite=accepted_pending_manager");
});

test.each(["", "http://console.example.test", "http://127.0.0.1:5175", "http://localhost:5175",
  (["https",":","/","/","user",":","pass","@","console.example.test"].join("")), "https://127.0.0.1"])("invalid configuration fails before reading or changing Auth: %s", async (base) => {
  process.env.CONSOLE_BASE_URL = base;
  expect((await GET(request())).status).toBe(503);
  expect((await POST(confirmRequest())).status).toBe(503);
  expect(createTenantUserInviteProviderClient).not.toHaveBeenCalled();
});

test.each([null, "null", "https://attacker.example.test", "https://console.example.test.attacker.test"])("untrusted Origin is rejected before body/Auth: %s (case %#)", async (origin) => {
  const req = confirmRequest(body, origin);
  const read = jest.spyOn(req.body!, "getReader");
  expect((await POST(req)).status).toBe(403);
  expect(read).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});

test("cross-site Fetch Metadata fails even with claimed correct Origin", async () => {
  const req = confirmRequest();
  req.headers.set("sec-fetch-site", "cross-site");
  expect((await POST(req)).status).toBe(403);
  expect(rpc).not.toHaveBeenCalled();
});

test("missing Fetch Metadata still requires exact Origin", async () => {
  const req = confirmRequest();
  req.headers.delete("sec-fetch-site");
  expect((await POST(req)).headers.get("location")).toContain("accepted_pending_manager");
});

test("only form body is accepted, not query proof or JSON", async () => {
  const req = confirmRequest("");
  expect((await POST(new Request(req.url + "?" + query, { method: "POST", headers: req.headers, body: "" }))).headers.get("location")).toContain("invite_confirmation_invalid");
  req.headers.set("content-type", "application/json");
  expect((await POST(new Request(req.url, { method: "POST", headers: req.headers, body: "{}" }))).status).toBe(415);
  expect(rpc).not.toHaveBeenCalled();
});

test("chunked form is bounded despite false Content-Length", async () => {
  const cancel = jest.fn();
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(2049)); }, cancel });
  const result = await POST(new Request(confirmRequest().url, {
    method: "POST", headers: { ...Object.fromEntries(confirmRequest().headers), "content-length": "1" },
    body: stream, duplex: "half",
  } as RequestInit));
  expect(result.status).toBe(413);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(rpc).not.toHaveBeenCalled();
});

test.each(["invalid UTF-8", "stream failure"])("unreadable form fails closed: %s", async (failure) => {
  const stream = new ReadableStream<Uint8Array>({ start(c) {
    if (failure === "stream failure") c.error(new Error("private stream"));
    else { c.enqueue(new Uint8Array([255])); c.close(); }
  } });
  const result = await POST(new Request(confirmRequest().url, {
    method: "POST", headers: confirmRequest().headers, body: stream, duplex: "half",
  } as RequestInit));
  expect(result.headers.get("location")).toContain("invite_confirmation_invalid");
  expect(rpc).not.toHaveBeenCalled();
});

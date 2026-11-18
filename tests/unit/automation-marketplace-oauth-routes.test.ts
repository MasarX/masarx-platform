jest.mock("@masarx/auth", () => ({
  getVerifiedAccessToken: jest.fn(),
  validateTrustedBrowserRequest: jest.requireActual("../../packages/auth/src/request-guard").validateTrustedBrowserRequest,
}), { virtual: true });
jest.mock("../../apps/console/app/api/automation-marketplace/oauth/_lib/service-client", () => ({ createOAuthServiceClient: jest.fn() }));
jest.mock("../../apps/console/app/api/automation-marketplace/oauth/_lib/token-transport.mjs", () => ({ requestOAuthTokens: jest.fn() }));

import { createHash } from "node:crypto";
import { getVerifiedAccessToken } from "@masarx/auth";
import { createOAuthServiceClient } from "../../apps/console/app/api/automation-marketplace/oauth/_lib/service-client";
import { createOAuthRoutes } from "../../apps/console/app/api/automation-marketplace/oauth/_lib/routes";
import { resolveAppBasePath } from "../../apps/shared/app-base-path";
import { resolveSafeAppBasePath } from "../../packages/ui/src/url-guard";
import { POST as runtimeStart, GET as getStart } from "../../apps/console/app/api/automation-marketplace/oauth/start/route";
import { GET as getRefresh } from "../../apps/console/app/api/automation-marketplace/oauth/refresh/route";
import { POST as runtimeRefresh } from "../../apps/console/app/api/automation-marketplace/oauth/refresh/route";
import { requestOAuthTokens } from "../../apps/console/app/api/automation-marketplace/oauth/_lib/token-transport.mjs";
import { GET as stubAuthorize } from "../../apps/console/app/api/automation-marketplace/oauth-stub/authorize/route";
import { POST as stubToken } from "../../apps/console/app/api/automation-marketplace/oauth-stub/token/route";

const CONNECTION = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830";
const USER = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const ATTEMPT = "44444444-4444-4444-8444-444444444444";
const CLAIM = "55555555-5555-4555-8555-555555555555";
const ORIGIN = "https://console.example.test";
const PREFIX = `${ORIGIN}/console/api/automation-marketplace/oauth`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const payload = { token_type: "Bearer", access_token: "private-access", refresh_token: "private-refresh", expires_in: 60 };
const binding = {
  provider_key: "approved-provider", authorization_url: "https://identity.example.test/authorize", token_url: "https://identity.example.test/token",
  client_id: "owner-configured-client", scopes: ["shipments.read"], redirect_uri: `${PREFIX}/callback`, console_origin: ORIGIN,
};
const originalBasePath = process.env.NEXT_PUBLIC_APP_BASE_PATH;
beforeEach(() => { process.env.NEXT_PUBLIC_APP_BASE_PATH = "/console"; });
afterEach(() => {
  if (originalBasePath === undefined) delete process.env.NEXT_PUBLIC_APP_BASE_PATH;
  else process.env.NEXT_PUBLIC_APP_BASE_PATH = originalBasePath;
});
const post = (leaf: string, body: unknown = { connection_id: CONNECTION }, headers: Record<string, string> = {}) => new Request(`${PREFIX}/${leaf}`, {
  method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers }, body: JSON.stringify(body),
});

// This atomic test store models the four native RPC boundaries, not a runtime singleton.
function fixture() {
  const state = {
    time: Date.parse("2026-10-19T00:00:00Z"), generation: 0, authorized: true, active: true, revoked: false, configured: true,
    sessionId: SESSION, provider: { ...binding }, refreshToken: "old-refresh", saved: null as unknown,
    attempts: new Map<string, any>(), claimedRefresh: new Set<number>(),
  };
  const context = () => ({ configured: true, connection_id: CONNECTION, provider_key: state.provider.provider_key, status: state.revoked ? "revoked" : "ready",
    credential_generation: state.generation, provider_binding: { ...state.provider }, binding_hash: sha(JSON.stringify(state.provider)) });
  const userRpc = jest.fn(async (name: string, args: any) => {
    if (!state.authorized || !state.active || args.p_connection_id !== CONNECTION || state.revoked) return { data: null, error: new Error("denied") };
    if (name === "integration_connection_oauth_context_v1") return { data: state.configured ? context() : { configured: false }, error: null };
    if (name !== "integration_connection_oauth_begin_v1") throw new Error(`Unexpected user RPC: ${name}`);
    state.attempts.set(args.p_state_hash, { ...args, id: ATTEMPT, user: USER, session: state.sessionId, generation: state.generation,
      provider: { ...state.provider }, bindingHash: context().binding_hash, deadline: state.time + 300_000, claimed: false, finished: false });
    return { data: { attempt_id: ATTEMPT, expires_at: new Date(state.time + 300_000).toISOString(), credential_generation: state.generation, binding_hash: context().binding_hash }, error: null };
  });
  const serviceRpc = jest.fn(async (name: string, args: any) => {
    const fail = () => ({ data: null, error: new Error("unconfirmed operation") });
    if (name === "integration_connection_oauth_consume_v1") {
      const attempt = state.attempts.get(args.p_state_hash);
      if (!attempt || attempt.claimed || state.revoked || !state.authorized || !state.active || attempt.deadline <= state.time ||
          attempt.generation !== state.generation || attempt.bindingHash !== context().binding_hash || args.p_actor_user_id !== attempt.user ||
          args.p_session_id !== attempt.session || args.p_connection_id !== CONNECTION || args.p_operation !== attempt.p_operation ||
          args.p_operation === "refresh" && state.claimedRefresh.has(state.generation)) return fail();
      attempt.claimed = true;
      if (args.p_operation === "refresh") state.claimedRefresh.add(state.generation);
      return { data: { attempt_id: attempt.id, claim_token: CLAIM, connection_id: CONNECTION, credential_generation: attempt.generation,
        provider_binding: attempt.provider, binding_hash: attempt.bindingHash, pkce_verifier: attempt.p_pkce_verifier, refresh_token: state.refreshToken }, error: null };
    }
    if (name !== "integration_connection_oauth_finish_v1") throw new Error(`Unexpected service RPC: ${name}`);
    const attempt = [...state.attempts.values()].find((candidate) => candidate.claimed && !candidate.finished && candidate.id === args.p_attempt_id);
    if (!attempt || args.p_claim_token !== CLAIM || state.revoked || !state.authorized || !state.active || attempt.deadline <= state.time ||
        attempt.session !== state.sessionId || attempt.generation !== state.generation || attempt.bindingHash !== context().binding_hash) return fail();
    attempt.finished = true;
    state.generation += 1;
    if (args.p_secret_payload) { state.saved = args.p_secret_payload; state.refreshToken = args.p_secret_payload.refresh_token || state.refreshToken; }
    return { data: { ok: true }, error: null };
  });
  const authenticate = jest.fn(async () => ({ client: { rpc: userRpc }, user: { id: USER }, accessToken: `header.${Buffer.from(JSON.stringify({ sub: USER, session_id: state.sessionId })).toString("base64url")}.verified`, error: null }));
  const serviceClient = jest.fn(() => ({ rpc: serviceRpc }));
  const exchange = jest.fn(async (_url: string, args: Record<string, string>) => {
    if (args.grant_type === "authorization_code") {
      const attempt = [...state.attempts.values()].find((entry) => entry.claimed);
      if (args.code !== "one-use-code" || args.code_verifier !== attempt.p_pkce_verifier || args.redirect_uri !== attempt.provider.redirect_uri) throw new Error("PKCE mismatch");
    }
    return { status: 200, body: { ...payload } };
  });
  const routes = createOAuthRoutes({ authenticate, serviceClient, exchange, now: () => state.time });
  const start = async () => {
    const response = await routes.start(post("start"));
    expect(response.status).toBe(303);
    return new URL(response.headers.get("location")!);
  };
  const callback = (stateToken: string, extras = "code=one-use-code") => routes.callback(new Request(`${PREFIX}/callback?state=${encodeURIComponent(stateToken)}&${extras}`));
  return { state, userRpc, serviceRpc, authenticate, serviceClient, exchange, routes, start, callback };
}

test("runtime defaults remain unavailable without owner config and never construct privileged I/O", async () => {
  const h = fixture(); h.state.configured = false;
  (getVerifiedAccessToken as jest.Mock).mockImplementation(h.authenticate);
  const response = await runtimeStart(post("start"));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "oauth_not_configured" });
  expect(createOAuthServiceClient).not.toHaveBeenCalled();
  expect(h.userRpc.mock.calls.map(([name]) => name)).toEqual(["integration_connection_oauth_context_v1"]);
  for (const method of [getStart, getRefresh]) expect(method().status).toBe(405);
  for (const method of [stubAuthorize, stubToken]) expect(method().status).toBe(503);
});

test("configured same actual core completes public PKCE without browser-visible verifier or secrets", async () => {
  const h = fixture(); const authorization = await h.start();
  const attempt = [...h.state.attempts.values()][0];
  expect(authorization.origin).toBe("https://identity.example.test");
  expect(authorization.searchParams.get("redirect_uri")).toBe(binding.redirect_uri);
  expect(authorization.searchParams.get("code_challenge")).toBe(createHash("sha256").update(attempt.p_pkce_verifier).digest("base64url"));
  expect(authorization.toString()).not.toContain(attempt.p_pkce_verifier);
  const response = await h.callback(authorization.searchParams.get("state")!);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toContain("oauth_status=connected");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("location")).not.toMatch(/private-|one-use-code|verifier/);
  expect(h.state.saved).toEqual({ access_token: "private-access", token_type: "Bearer", refresh_token: "private-refresh" });
});

test.each([
  [undefined, ""], ["", ""], ["/", ""], ["/ops", "/ops"], [" /ops/ ", "/ops"], ["/ops/team", "/ops/team"], ["/console", "/console"],
  ["/ops+team", "/ops+team"], ["/ops!$&'()*+,;=:@/team-v2._~", "/ops!$&'()*+,;=:@/team-v2._~"],
])("uses exact safe configured callback base %j (normalized %j)", async (configured, base) => {
  if (configured === undefined) delete process.env.NEXT_PUBLIC_APP_BASE_PATH;
  else process.env.NEXT_PUBLIC_APP_BASE_PATH = configured;
  expect(resolveSafeAppBasePath(configured ?? "")).toBe(base);
  if (configured) expect(resolveAppBasePath("apps/console")).toBe(base);
  const h = fixture();
  h.state.provider.redirect_uri = `${ORIGIN}${base}/api/automation-marketplace/oauth/callback`;
  expect(new URL(h.state.provider.redirect_uri).pathname).toBe(`${base}/api/automation-marketplace/oauth/callback`);
  const request = new Request(`${ORIGIN}${base}/api/automation-marketplace/oauth/start`, {
    method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ connection_id: CONNECTION }),
  });
  const response = await h.routes.start(request); expect(response.status).toBe(200);
  const authorization = new URL((await response.json()).authorization_url);
  expect(authorization.searchParams.get("redirect_uri")).toBe(h.state.provider.redirect_uri);
  const callback = await h.routes.callback(new Request(`${h.state.provider.redirect_uri}?state=${authorization.searchParams.get("state")}&code=one-use-code`));
  expect(callback.status).toBe(303);
  const manage = new URL(callback.headers.get("location")!);
  expect(manage.origin).toBe(ORIGIN); expect(manage.pathname).toBe(`${base}/automation/marketplace/connections/manage`);
  expect(h.exchange).toHaveBeenCalledTimes(1);
});

test.each([
  ["/ops", `${ORIGIN}/api/automation-marketplace/oauth/callback`],
  ["/ops", `${ORIGIN}/console/api/automation-marketplace/oauth/callback`],
  ["/ops", `https://attacker.test/ops/api/automation-marketplace/oauth/callback`],
  ["/ops", `${ORIGIN}/ops/other-callback`],
  ["/ops", `${ORIGIN}/ops/../ops/api/automation-marketplace/oauth/callback`],
  ["/ops", `${ORIGIN}/ops/%2e%2e/ops/api/automation-marketplace/oauth/callback`],
  ["/ops", `${ORIGIN}/%6fps/api/automation-marketplace/oauth/callback`],
  ["/ops", `${ORIGIN}/ops/api/automation-marketplace/oauth/callback?extra=1`],
  ["/ops", `${ORIGIN}/ops/api/automation-marketplace/oauth/callback#fragment`],
  ["/ops/../ops", `${ORIGIN}/ops/api/automation-marketplace/oauth/callback`],
  ["/ops/%2e%2e/ops", `${ORIGIN}/ops/api/automation-marketplace/oauth/callback`],
  ["/ops//team", `${ORIGIN}/ops/team/api/automation-marketplace/oauth/callback`],
  ["//attacker.test", `${ORIGIN}/api/automation-marketplace/oauth/callback`],
  ["/ops?query", `${ORIGIN}/ops/api/automation-marketplace/oauth/callback`],
  ["/ops\\team", `${ORIGIN}/ops/team/api/automation-marketplace/oauth/callback`],
  ["/ops+team", `${ORIGIN}/ops%2Bteam/api/automation-marketplace/oauth/callback`],
  ["/ops%2Bteam", `${ORIGIN}/ops%2Bteam/api/automation-marketplace/oauth/callback`],
  ["/ops+team", `${ORIGIN}/ops+team//api/automation-marketplace/oauth/callback`],
  ["/ops+team\n", `${ORIGIN}/ops+team/api/automation-marketplace/oauth/callback`],
])("rejects wrong or noncanonical configured callback %j -> %j before privileged I/O", async (base, redirect) => {
  process.env.NEXT_PUBLIC_APP_BASE_PATH = base;
  const h = fixture(); h.state.provider.redirect_uri = redirect;
  expect((await h.routes.start(post("start"))).status).toBe(403);
  expect(h.state.attempts.size).toBe(0); expect(h.serviceClient).not.toHaveBeenCalled(); expect(h.exchange).not.toHaveBeenCalled();
});

test("actual exported start/refresh support JSON fetch handoff without following cross-origin redirects", async () => {
  const h = fixture();
  (getVerifiedAccessToken as jest.Mock).mockImplementation(h.authenticate);
  (createOAuthServiceClient as jest.Mock).mockImplementation(h.serviceClient);
  (requestOAuthTokens as jest.Mock).mockImplementation(h.exchange);
  const start = await runtimeStart(post("start", { connection_id: CONNECTION }, { accept: "application/json" }));
  expect(start.status).toBe(200); expect(start.headers.get("location")).toBeNull();
  const startJson = await start.json(); expect(startJson.ok).toBe(true);
  expect(new URL(startJson.authorization_url).origin).toBe("https://identity.example.test");
  expect(startJson.authorization_url).not.toContain([...h.state.attempts.values()][0].p_pkce_verifier);
  const refresh = await runtimeRefresh(post("refresh", { connection_id: CONNECTION }, { accept: "application/json" }));
  expect(refresh.status).toBe(200); expect(await refresh.json()).toEqual({ ok: true, connection_id: CONNECTION, status: "refreshed" });
  expect(refresh.headers.get("location")).toBeNull();
});

test("configured provider but missing service configuration cannot begin or redirect authorization", async () => {
  const h = fixture(); (getVerifiedAccessToken as jest.Mock).mockImplementation(h.authenticate);
  (createOAuthServiceClient as jest.Mock).mockImplementation(() => { throw new Error("missing-service-secret"); });
  const response = await runtimeStart(post("start", { connection_id: CONNECTION }, { accept: "application/json" }));
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "oauth_not_configured" });
  expect(h.userRpc.mock.calls.map(([name]) => name)).toEqual(["integration_connection_oauth_context_v1"]);
  expect(h.state.attempts.size).toBe(0); expect(response.headers.get("location")).toBeNull();
});

test("uncertain begin/finish is unconfirmed and never retried", async () => {
  const h = fixture(); const original = h.userRpc.getMockImplementation()!;
  h.userRpc.mockImplementation(async (name, args) => {
    if (name === "integration_connection_oauth_begin_v1") throw new Error("uncertain-secret-network");
    return original(name, args);
  });
  const response = await h.routes.start(post("start", { connection_id: CONNECTION }, { accept: "application/json" }));
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "oauth_attempt_unconfirmed" });
  expect(h.userRpc.mock.calls.filter(([name]) => name === "integration_connection_oauth_begin_v1")).toHaveLength(1);
  const f = fixture(); const service = f.serviceRpc.getMockImplementation()!;
  f.serviceRpc.mockImplementation(async (name, args) => {
    if (name === "integration_connection_oauth_finish_v1") throw new Error("uncertain-secret-network");
    return service(name, args);
  });
  const refresh = await f.routes.refresh(post("refresh", { connection_id: CONNECTION }, { accept: "application/json" }));
  expect(refresh.status).toBe(409); expect(await refresh.json()).toEqual({ error: "oauth_completion_unconfirmed" });
  expect(f.exchange).toHaveBeenCalledTimes(1);
  expect(f.serviceRpc.mock.calls.filter(([name]) => name === "integration_connection_oauth_finish_v1")).toHaveLength(1);
});

test.each([
  { origin: "https://attacker.test" },
  { "sec-fetch-site": "cross-site" }, { "content-type": "text/plain" }, { origin: "" },
])("rejects cross-site/forged-origin/content type before auth: %j", async (headers) => {
  const h = fixture(); const response = await h.routes.start(post("start", { connection_id: CONNECTION }, headers));
  expect([403, 415]).toContain(response.status); expect(h.authenticate).not.toHaveBeenCalled(); expect(h.serviceClient).not.toHaveBeenCalled();
});

test("fixed owner binding supports an internal proxy URL without adopting forwarded origin", async () => {
  const h = fixture();
  const headers = { origin: ORIGIN, "x-forwarded-host": "console.example.test", "x-forwarded-proto": "https", "content-type": "application/json", accept: "application/json" };
  const request = new Request("http://internal:3000/console/api/automation-marketplace/oauth/start", { method: "POST", headers, body: JSON.stringify({ connection_id: CONNECTION }) });
  const response = await h.routes.start(request); expect(response.status).toBe(200);
  const authorization = new URL((await response.json()).authorization_url);
  expect(authorization.searchParams.get("redirect_uri")).toBe(binding.redirect_uri);
  const callback = await h.routes.callback(new Request(`http://internal:3000/console/api/automation-marketplace/oauth/callback?state=${authorization.searchParams.get("state")}&code=one-use-code`));
  expect(callback.status).toBe(303); expect(new URL(callback.headers.get("location")!).origin).toBe(ORIGIN);
  const forged = fixture();
  const attack = new Request("http://internal:3000/console/api/automation-marketplace/oauth/start", { method: "POST", headers: { ...headers, origin: "https://attacker.test", "x-forwarded-host": "attacker.test" }, body: JSON.stringify({ connection_id: CONNECTION }) });
  expect((await forged.routes.start(attack)).status).toBe(403); expect(forged.state.attempts.size).toBe(0);
  expect(forged.serviceClient).not.toHaveBeenCalled(); expect(forged.exchange).not.toHaveBeenCalled();
});

test("rejects malformed or endpoint-injecting bodies without auth or privileged I/O", async () => {
  const h = fixture();
  for (const body of [{ connection_id: CONNECTION, token_url: "http://127.0.0.1" }, { connection_id: "wrong" }, { connection_id: "a".repeat(5000) }]) {
    expect((await h.routes.start(post("start", body))).status).toBe(400);
  }
  expect(h.authenticate).not.toHaveBeenCalled();
});

test("missing/invalid verified identity and missing JWT session fail before DB/service", async () => {
  for (const auth of [{ user: null }, { accessToken: "invalid" }, { error: new Error("expired") }]) {
    const h = fixture(); const valid = await h.authenticate(); h.authenticate.mockResolvedValue({ ...valid, ...auth } as any);
    expect((await h.routes.start(post("start"))).status).toBe(401); expect(h.userRpc).not.toHaveBeenCalled(); expect(h.serviceClient).not.toHaveBeenCalled();
  }
});

test("cross-scope/unknown provider or unsafe trusted binding cannot touch Vault or endpoints", async () => {
  for (const edit of [
    (h: ReturnType<typeof fixture>) => { h.state.authorized = false; },
    (h: ReturnType<typeof fixture>) => { h.state.configured = false; },
    (h: ReturnType<typeof fixture>) => { h.state.provider.token_url = "http://127.0.0.1/token"; },
    (h: ReturnType<typeof fixture>) => { h.state.provider.redirect_uri = "https://attacker.test/callback"; },
    (h: ReturnType<typeof fixture>) => { h.state.provider.console_origin = "https://attacker.test"; },
  ]) {
    const h = fixture(); edit(h); expect([403, 503]).toContain((await h.routes.start(post("start"))).status);
    expect(h.serviceClient).not.toHaveBeenCalled(); expect(h.exchange).not.toHaveBeenCalled();
  }
});

test("tampered, expired, other-session, moved-binding and replayed state never exchanges twice", async () => {
  for (const mutation of [
    (h: ReturnType<typeof fixture>, state: string) => `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`,
    (h: ReturnType<typeof fixture>, state: string) => { h.state.time += 300_001; return state; },
    (h: ReturnType<typeof fixture>, state: string) => { h.state.sessionId = CLAIM; return state; },
    (h: ReturnType<typeof fixture>, state: string) => { h.state.provider.client_id = "replacement-owner-client"; return state; },
  ]) {
    const h = fixture(); const auth = await h.start(); const state = mutation(h, auth.searchParams.get("state")!);
    expect((await h.callback(state)).status).toBe(409); expect(h.exchange).not.toHaveBeenCalled();
  }
  const h = fixture(); const auth = await h.start(); const state = auth.searchParams.get("state")!;
  expect((await h.callback(state)).status).toBe(303); expect((await h.callback(state)).status).toBe(409); expect(h.exchange).toHaveBeenCalledTimes(1);
});

test.each(["revoked", "active", "authorized", "generation", "provider"])("fresh %s change during exchange cannot commit stale credentials", async (change) => {
  const h = fixture(); const auth = await h.start();
  h.exchange.mockImplementationOnce(async () => {
    if (change === "revoked") h.state.revoked = true;
    if (change === "active") h.state.active = false;
    if (change === "authorized") h.state.authorized = false;
    if (change === "generation") h.state.generation += 1;
    if (change === "provider") h.state.provider.client_id = "changed";
    return { status: 200, body: { ...payload } };
  });
  expect((await h.callback(auth.searchParams.get("state")!)).status).toBe(409); expect(h.state.saved).toBeNull();
});

test("refresh rotates and preserves omitted replacement token without exposing either token", async () => {
  const h = fixture();
  expect((await h.routes.refresh(post("refresh"))).headers.get("location")).toContain("oauth_status=refreshed");
  expect(h.exchange).toHaveBeenCalledWith(binding.token_url, { client_id: binding.client_id, grant_type: "refresh_token", refresh_token: "old-refresh" });
  h.exchange.mockResolvedValueOnce({ status: 200, body: { token_type: "bearer", access_token: "replacement", expires_in: 60 } } as any);
  expect((await h.routes.refresh(post("refresh"))).status).toBe(303);
  expect(h.state.saved).toEqual({ access_token: "replacement", token_type: "Bearer", refresh_token: "private-refresh" });
});

test("concurrent refresh, revoked refresh, uncertainty and malformed token fail closed without retry", async () => {
  const h = fixture(); let release!: () => void;
  h.exchange.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { status: 200, body: payload }; });
  const first = h.routes.refresh(post("refresh"));
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  expect((await h.routes.refresh(post("refresh"))).status).toBe(409);
  h.state.revoked = true; release(); expect((await first).status).toBe(409); expect(h.state.saved).toBeNull();
  for (const result of [null, { status: 400, body: { error_description: "private-refresh should-never-echo" } }, { status: 200, body: { ...payload, access_token: "" } }]) {
    const f = fixture();
    if (result) f.exchange.mockResolvedValueOnce(result); else f.exchange.mockRejectedValueOnce(new Error("private-refresh uncertain-network"));
    const response = await f.routes.refresh(post("refresh"));
    expect(response.headers.get("location")).toContain("oauth_status=reauth_required");
    expect(response.headers.get("location")).not.toContain("private-refresh"); expect(f.exchange).toHaveBeenCalledTimes(1); expect(f.state.saved).toBeNull();
  }
});

test("provider denial consumes state without echoing or exchanging provider-controlled errors", async () => {
  const h = fixture(); const auth = await h.start();
  const response = await h.callback(auth.searchParams.get("state")!, "error=private-error&error_description=attacker-controlled");
  expect(response.headers.get("location")).toContain("oauth_status=reauth_required"); expect(response.headers.get("location")).not.toContain("private"); expect(h.exchange).not.toHaveBeenCalled();
});

test.each([
  { access_token: "" }, { access_token: "unsafe\nheader" }, { refresh_token: 123 }, { token_type: "Other" },
  { expires_in: -1 }, { expires_in: 1.5 }, { expires_in: 31_536_001 },
])("invalid provider token cannot be stored or echoed: %j", async (invalid) => {
  const h = fixture(); h.exchange.mockResolvedValueOnce({ status: 200, body: { ...payload, ...invalid } } as any);
  const response = await h.routes.refresh(post("refresh", { connection_id: CONNECTION }, { accept: "application/json" }));
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ ok: false, connection_id: CONNECTION, status: "reauth_required" });
  expect(h.state.saved).toBeNull(); expect(h.exchange).toHaveBeenCalledTimes(1);
});

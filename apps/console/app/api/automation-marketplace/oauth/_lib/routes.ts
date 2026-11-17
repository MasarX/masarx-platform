import { createHash, randomBytes } from "node:crypto";
import { getVerifiedAccessToken, validateTrustedBrowserRequest } from "@masarx/auth";
import { createOAuthServiceClient } from "./service-client";
import { requestOAuthTokens } from "./token-transport.mjs";
import { resolveSafeAppBasePath } from "../../../../../../../packages/ui/src/url-guard";

type RecordValue = Record<string, unknown>;
type RpcClient = { rpc(name: string, args: RecordValue): PromiseLike<{ data: unknown; error: unknown }> };
type Session = { client: RpcClient; user: { id: string } | null; accessToken: string | null; error: unknown };
type Dependencies = {
  authenticate?: () => Promise<Session>;
  serviceClient?: () => RpcClient;
  exchange?: typeof requestOAuthTokens;
  now?: () => number;
};
type Binding = {
  provider_key: string; authorization_url: string; token_url: string; client_id: string;
  scopes: string[]; redirect_uri: string; console_origin: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i;
const HASH = /^[0-9a-f]{64}$/;
const CALLBACK = "/api/automation-marketplace/oauth/callback";
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const responseJson = (body: RecordValue, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
const json = (error: string, status: number) => responseJson({ error }, status);
export const oauthUnavailable = () => json("oauth_not_configured", 503);
export const oauthMethodNotAllowed = () => new Response(null, { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });

function bindingFrom(value: unknown): Binding {
  const binding = record(value);
  for (const key of ["provider_key", "authorization_url", "token_url", "client_id", "redirect_uri", "console_origin"]) {
    if (typeof binding[key] !== "string" || !binding[key] || String(binding[key]).length > 2048) throw new Error();
  }
  if (!Array.isArray(binding.scopes) || binding.scopes.length > 50 || binding.scopes.some((scope) => typeof scope !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/.test(scope))) throw new Error();
  const origin = new URL(String(binding.console_origin));
  if (origin.protocol !== "https:" || origin.origin !== binding.console_origin) throw new Error();
  for (const key of ["authorization_url", "token_url", "redirect_uri"]) {
    const url = new URL(String(binding[key]));
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443") throw new Error();
  }
  const redirect = new URL(String(binding.redirect_uri));
  const basePath = resolveSafeAppBasePath(process.env.NEXT_PUBLIC_APP_BASE_PATH ?? "");
  if (basePath === null || !/^(?:\/[A-Za-z0-9._~!$&'()*+,;=:@-]+)*$/.test(basePath) || basePath.split("/").some((part) => part === "." || part === "..")) throw new Error();
  if (redirect.origin !== origin.origin || redirect.search || binding.redirect_uri !== `${origin.origin}${basePath}${CALLBACK}`) throw new Error();
  return binding as Binding;
}

async function readConnectionId(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (Object.keys(body).length !== 1 || typeof body.connection_id !== "string" || !UUID.test(body.connection_id)) throw new Error();
  return body.connection_id;
}

function tokensFrom(value: unknown, refreshToken?: string) {
  const tokens = record(value);
  const validToken = (token: unknown) => typeof token === "string" && token.length > 0 && token.length <= 16_384 && !/[\x00-\x20\x7f]/.test(token);
  if (!validToken(tokens.access_token) || typeof tokens.token_type !== "string" || !/^Bearer$/i.test(tokens.token_type) || !Number.isSafeInteger(tokens.expires_in) || Number(tokens.expires_in) <= 0 || Number(tokens.expires_in) > 31_536_000 || tokens.refresh_token !== undefined && !validToken(tokens.refresh_token)) throw new Error();
  return { secret: { access_token: tokens.access_token, token_type: "Bearer", ...(tokens.refresh_token || refreshToken ? { refresh_token: tokens.refresh_token || refreshToken } : {}) }, expiresIn: Number(tokens.expires_in) };
}

export function createOAuthRoutes(dependencies: Dependencies = {}) {
  const authenticate = dependencies.authenticate || (async () => getVerifiedAccessToken({ allowCookieSet: false }));
  const serviceClient = dependencies.serviceClient || createOAuthServiceClient;
  const exchange = dependencies.exchange || requestOAuthTokens;
  const now = dependencies.now || Date.now;
  const rpc = async (client: RpcClient, name: string, args: RecordValue) => {
    const result = await client.rpc(name, args);
    if (result.error) throw new Error("OAuth operation failed.");
    return record(result.data);
  };
  const identity = async () => {
    const session = await authenticate();
    if (session.error || !session.user || !UUID.test(session.user.id) || !session.accessToken) return null;
    try {
      // The token has already been verified by getVerifiedAccessToken, not by decoding it.
      const claims = record(JSON.parse(Buffer.from(session.accessToken.split(".")[1] || "", "base64url").toString("utf8")));
      if (claims.sub !== session.user.id || typeof claims.session_id !== "string" || !UUID.test(claims.session_id)) return null;
      return { ...session, userId: session.user.id, sessionId: claims.session_id };
    } catch { return null; }
  };
  const context = async (session: NonNullable<Awaited<ReturnType<typeof identity>>>, connectionId: string) => {
    const current = await rpc(session.client, "integration_connection_oauth_context_v1", { p_connection_id: connectionId });
    if (current.configured === false) return null;
    if (current.connection_id !== connectionId || current.status === "revoked" || !Number.isSafeInteger(current.credential_generation) || Number(current.credential_generation) < 0 || !HASH.test(String(current.binding_hash))) throw new Error();
    const binding = bindingFrom(current.provider_binding);
    if (current.provider_key !== binding.provider_key) throw new Error();
    return { current, binding };
  };
  const redirect = (binding: Binding, connectionId: string, status: string) => {
    const url = new URL(binding.redirect_uri);
    url.pathname = url.pathname.replace(CALLBACK, "/automation/marketplace/connections/manage");
    url.searchParams.set("connection_id", connectionId);
    url.searchParams.set("oauth_status", status);
    return new Response(null, { status: 303, headers: { location: url.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  };
  const run = async (request: Request, operation: "authorize" | "refresh" | "callback") => {
    const wantsJson = request.headers.get("accept")?.includes("application/json");
    if (operation !== "callback") {
      const trusted = validateTrustedBrowserRequest(request, { requireJson: true });
      if (!trusted.ok) return json(trusted.code, trusted.status);
      if (!request.headers.get("origin")) return json("origin_mismatch", 403);
    }
    let connectionId: string;
    let state = "";
    let code = "";
    let denied = false;
    try {
      if (operation === "callback") {
        const query = new URL(request.url).searchParams;
        if (["state", "code", "error"].some((key) => query.getAll(key).length > 1)) throw new Error();
        state = query.get("state") || "";
        const match = STATE.exec(state);
        connectionId = match?.[1] || "";
        if (!UUID.test(connectionId)) throw new Error();
        code = query.get("code") || "";
        denied = query.has("error");
        if (code.length > 4096 || !code && !denied) throw new Error();
      } else connectionId = await readConnectionId(request);
    } catch { return json("invalid_oauth_request", 400); }
    let session;
    try { session = await identity(); } catch { return json("unauthorized", 401); }
    if (!session) return json("unauthorized", 401);
    let resolved;
    try { resolved = await context(session, connectionId); } catch { return json("connection_not_authorized", 403); }
    if (!resolved) return oauthUnavailable();
    const { current, binding } = resolved;
    // Only the owner-approved binding establishes the public origin, not proxy headers.
    if (operation !== "callback" && request.headers.get("origin") !== binding.console_origin) return json("origin_mismatch", 403);
    let service: RpcClient;
    try { service = serviceClient(); } catch { return oauthUnavailable(); }
    let verifier = "";
    if (operation !== "callback") {
      state = `${connectionId}.${randomBytes(32).toString("base64url")}`;
      verifier = operation === "authorize" ? randomBytes(32).toString("base64url") : "";
      try {
        const begun = await rpc(session.client, "integration_connection_oauth_begin_v1", {
          p_connection_id: connectionId, p_operation: operation, p_state_hash: hash(state),
          p_pkce_verifier: verifier || null, p_redirect_uri: binding.redirect_uri,
        });
        if (!UUID.test(String(begun.attempt_id)) || begun.binding_hash !== current.binding_hash || begun.credential_generation !== current.credential_generation) throw new Error();
      } catch { return json("oauth_attempt_unconfirmed", 409); }
      if (operation === "authorize") {
        const url = new URL(binding.authorization_url);
        for (const [key, value] of Object.entries({ response_type: "code", client_id: binding.client_id, redirect_uri: binding.redirect_uri, scope: binding.scopes.join(" "), state, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") })) url.searchParams.set(key, value);
        if (wantsJson) return responseJson({ ok: true, authorization_url: url.toString() });
        return new Response(null, { status: 303, headers: { location: url.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
      }
    }
    let claim: RecordValue;
    try {
      claim = await rpc(service, "integration_connection_oauth_consume_v1", {
        p_state_hash: hash(state), p_actor_user_id: session.userId, p_session_id: session.sessionId,
        p_connection_id: connectionId, p_operation: operation === "callback" ? "authorize" : "refresh",
      });
      const claimedBinding = bindingFrom(claim.provider_binding);
      if (!UUID.test(String(claim.attempt_id)) || !UUID.test(String(claim.claim_token)) || claim.connection_id !== connectionId || claim.binding_hash !== current.binding_hash || claim.credential_generation !== current.credential_generation ||
          ["provider_key", "authorization_url", "token_url", "client_id", "redirect_uri", "console_origin"].some((key) => record(claimedBinding)[key] !== record(binding)[key]) || JSON.stringify(claimedBinding.scopes) !== JSON.stringify(binding.scopes)) throw new Error();
    } catch { return json("oauth_attempt_unconfirmed", 409); }
    const finish = async (secret: unknown, status: string, expiresAt: string | null, reason: string | null) => {
      const result = await rpc(service, "integration_connection_oauth_finish_v1", {
        p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token, p_secret_payload: secret,
        p_oauth_metadata: { refresh_status: status === "ready" ? "ready" : "reauth_required" },
        p_status: status, p_expires_at: expiresAt, p_status_reason: reason,
      });
      if (result.ok !== true) throw new Error();
    };
    let tokens;
    try {
      if (denied) throw new Error();
      const parameters: Record<string, string> = { client_id: binding.client_id };
      if (operation === "callback") {
        if (typeof claim.pkce_verifier !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(claim.pkce_verifier)) throw new Error();
        Object.assign(parameters, { grant_type: "authorization_code", code, code_verifier: claim.pkce_verifier, redirect_uri: binding.redirect_uri });
      } else {
        if (typeof claim.refresh_token !== "string" || !claim.refresh_token || claim.refresh_token.length > 16_384) throw new Error();
        Object.assign(parameters, { grant_type: "refresh_token", refresh_token: claim.refresh_token });
      }
      const response = await exchange(binding.token_url, parameters);
      if (response.status < 200 || response.status >= 300) throw new Error();
      tokens = tokensFrom(response.body, operation === "refresh" ? String(claim.refresh_token) : undefined);
    } catch {
      try { await finish(null, "reauth_required", null, denied ? "authorization_denied" : "token_exchange_failed"); }
      catch { return json("oauth_completion_unconfirmed", 409); }
      if (operation === "refresh" && wantsJson) return responseJson({ ok: false, connection_id: connectionId, status: "reauth_required" }, 409);
      return redirect(binding, connectionId, "reauth_required");
    }
    try { await finish(tokens.secret, "ready", new Date(now() + tokens.expiresIn * 1000).toISOString(), null); }
    catch { return json("oauth_completion_unconfirmed", 409); }
    if (operation === "refresh" && wantsJson) return responseJson({ ok: true, connection_id: connectionId, status: "refreshed" });
    return redirect(binding, connectionId, operation === "refresh" ? "refreshed" : "connected");
  };
  return {
    start: (request: Request) => run(request, "authorize"),
    callback: (request: Request) => run(request, "callback"),
    refresh: (request: Request) => run(request, "refresh"),
  };
}

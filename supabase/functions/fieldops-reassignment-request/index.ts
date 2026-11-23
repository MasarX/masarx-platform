import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { extractToken, parseRequestBody, readEnv } from "./_shared/mod.mjs";

const url = readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]);
const anonKey = readEnv("EDGE_SUPABASE_ANON_KEY", ["SUPABASE_ANON_KEY"]);
const serviceKey = readEnv("EDGE_SUPABASE_SECRET_KEY", ["SUPABASE_SECRET_KEY"])
  || readEnv("EDGE_SUPABASE_SERVICE_ROLE_KEY", ["SUPABASE_SERVICE_ROLE_KEY", "SERVICE_ROLE_KEY"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : "";

Deno.serve(async (req: Request): Promise<Response> => {
  // Bearer-only API, matching existing authenticated browser Edge transports.
  // CORS is not an authorization decision; cookies are never accepted.
  const headers = {
    "content-type": "application/json",
    "access-control-allow-origin": req.headers.get("origin") || "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-correlation-id, traceparent",
    "vary": "Origin",
  };
  const fail = (status: number, code: string) =>
    new Response(JSON.stringify({ ok: false, error: { code } }), { status, headers });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return fail(405, "method_not_allowed");
  const token = extractToken(req, { prefer: "authorization", allowWebhookHeader: false, allowQueryParam: false });
  if (!token) return fail(401, "missing_authorization");
  if (!url || !anonKey || !serviceKey) return fail(503, "server_misconfigured");
  let body: Record<string, unknown>;
  try { body = record((await parseRequestBody(req)).json); }
  catch { return fail(400, "invalid_json"); }
  const payload = record(record(body.p_params).payload);
  const stopId = text(body.p_selection_id);
  const targetId = text(payload.target_driver_id);
  const actorId = text(body.p_expected_actor_user_id);
  const reason = text(payload.reason).trim();
  const key = text(body.p_idempotency_key);
  if (body.p_action_key !== "route_stops.request_reassignment" || body.p_resource_key !== "route_stops"
    || !uuid.test(stopId) || !uuid.test(targetId) || !uuid.test(actorId)
    || reason.length < 3 || reason.length > 2000 || key.length < 1 || key.length > 200
    || body.p_selection_count !== 1 || !Array.isArray(body.p_selection_ids)
    || body.p_selection_ids.length !== 1 || body.p_selection_ids[0] !== stopId) {
    return fail(400, "invalid_request");
  }
  try {
    const userClient = createClient(url, anonKey, {
      db: { schema: "api" },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: "Bearer " + token } },
      accessToken: async () => token,
    });
    const prepared = await userClient.rpc("prepare_fieldops_reassignment_v1", {
      p_stop_id: stopId, p_target_driver_id: targetId, p_reason: reason,
      p_idempotency_key: key, p_expected_actor_user_id: actorId,
    });
    if (prepared.error) {
      const code = prepared.error.code;
      if (code === "42501") return fail(403, "request_forbidden");
      if (code === "23505") return fail(409, "idempotency_conflict");
      if (code === "22023") return fail(400, "invalid_request");
      return fail(503, "request_preparation_failed");
    }
    const requestId = text(record(prepared.data).request_id);
    if (!uuid.test(requestId)) return fail(503, "request_preparation_incomplete");
    // No caller actor/org/task/workflow input crosses the service boundary.
    // The SDK uses the selected service JWT or secret key as its matching apikey.
    const serviceClient = createClient(url, serviceKey, {
      db: { schema: "api" },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const submitted = await serviceClient.rpc("submit_fieldops_reassignment_v1", { p_request_id: requestId });
    const result = record(submitted.data);
    if (submitted.error || result.ok !== true || result.request_id !== requestId
      || !uuid.test(text(result.dispatch_task_id)) || !uuid.test(text(result.workflow_run_id))
      || !uuid.test(text(result.dispatch_id)) || !uuid.test(text(result.decision_log_id))) {
      return fail(503, "dispatch_not_confirmed");
    }
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch {
    return fail(503, "request_unavailable");
  }
});

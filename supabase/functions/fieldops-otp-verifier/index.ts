// FieldOps Mobile V2 — OTP verifier edge function.
//
// Audit fix (2026-05-13 engineering re-audit P1): the `mobile_auth_policy`
// `edge_fn` provider path was registered in `verify_fieldops_otp_v1`
// (migration `202605131200_fieldops_auth_otp_verifier_v1.sql:137-148`)
// but the companion edge function was not shipped. Production tenants
// opting into `edge_fn` provider would fail closed (correct posture)
// but have no working OTP path until this function landed.
//
// Contract (POST /functions/v1/fieldops-otp-verifier):
//
//   Body: {
//     "employee_id":         "EMP-1234",        // required
//     "otp":                 "654321",          // required (6 digits)
//     "p_idempotency_key":   "<uuid>",          // required
//     "p_correlation_id":    "<uuid>" | null    // optional, for trace
//   }
//
//   200: { ok: true, decision_log_id: "<uuid>" }
//   400: { ok: false, error: "validation", message: "..." }
//   401: { ok: false, error: "verifier_failed", message: "..." }
//   429: { ok: false, error: "rate_limited", retry_after_ms: <int> }
//   5xx: { ok: false, error: "internal", message: "..." }
//
// Flow:
//   1. CORS preflight + body parse + shape validation.
//   2. Call the SMS provider configured under `mobile_auth_policy`.
//      Provider HTTP credentials are resolved from edge env (e.g.
//      `FIELDOPS_OTP_PROVIDER_URL`, `FIELDOPS_OTP_PROVIDER_API_KEY`)
//      so per-tenant secrets stay in Supabase Vault + Edge env, NOT
//      embedded in code. When env is absent, the function short-
//      circuits to fail-closed (returns 401) — matching the verifier's
//      default posture in `verify_fieldops_otp_v1`.
//   3. On provider verify success: open a DB session via the
//      service-role client, `set_config('app.fieldops_otp_verified',
//      'true', true)` inside that session, then invoke
//      `submit_fieldops_auth_otp_v1(...)`. The verifier sees the GUC
//      set and returns TRUE; the write proceeds.
//   4. On any failure: log via the RPC's own `decision_log` audit row
//      (the RPC raises 28000 which we map to a 401 response).
//
// Production cutover: wire `FIELDOPS_OTP_PROVIDER_URL` +
// `FIELDOPS_OTP_PROVIDER_API_KEY` (and any provider-specific headers)
// in the function's secrets. Until those are set, the function stays
// fail-closed which keeps production tenants on the DB-side `test`
// provider until OTP rollout is explicitly approved.

import { createClient } from "npm:@supabase/supabase-js@^2.45.4";
import { buildCorsHeaders, withCorsJson } from "../_shared/cors.mjs";

type VerifyBody = {
  employee_id?: unknown;
  otp?: unknown;
  p_idempotency_key?: unknown;
  p_correlation_id?: unknown;
};

const SUPABASE_URL =
  Deno.env.get("EDGE_SUPABASE_URL") ||
  Deno.env.get("SUPABASE_URL") ||
  "";
const SUPABASE_SERVICE_KEY =
  Deno.env.get("EDGE_SUPABASE_SERVICE_ROLE_KEY") ||
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  "";

const PROVIDER_URL =
  Deno.env.get("FIELDOPS_OTP_PROVIDER_URL") || "";
const PROVIDER_API_KEY =
  Deno.env.get("FIELDOPS_OTP_PROVIDER_API_KEY") || "";

// Provider HTTP timeout. Bounded so a hung SMS provider never blocks
// driver login for more than this. 6 seconds gives the provider room
// while staying inside the FE's 10s mutation timeout.
const PROVIDER_TIMEOUT_MS = Number(
  Deno.env.get("FIELDOPS_OTP_PROVIDER_TIMEOUT_MS") || "6000",
);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuidLike(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

/**
 * Verify the OTP with the upstream SMS provider. When provider env is
 * not configured, fail closed — the verifier's `edge_fn` provider
 * path default in `verify_fieldops_otp_v1` does exactly the same
 * (`current_setting('app.fieldops_otp_verified', TRUE) <> 'true'` →
 * return FALSE → submit RPC raises 28000).
 *
 * The SMS-provider HTTP contract is intentionally provider-agnostic:
 * we POST JSON to `FIELDOPS_OTP_PROVIDER_URL` with employee_id + otp,
 * and treat any 2xx with `{ verified: true }` as success. To wire a
 * specific provider, you write a thin adapter under
 * `_shared/otp-providers/<name>.ts` and switch on a provider env.
 */
async function verifyWithProvider(
  employeeId: string,
  otp: string,
  correlationId: string | null,
): Promise<{ ok: boolean; message: string }> {
  if (!PROVIDER_URL || !PROVIDER_API_KEY) {
    return {
      ok: false,
      message: "provider not configured (fail-closed default)",
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetch(PROVIDER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${PROVIDER_API_KEY}`,
        ...(correlationId ? { "x-correlation-id": correlationId } : {}),
      },
      body: JSON.stringify({ employee_id: employeeId, otp }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, message: `provider returned ${res.status}` };
    }
    const payload = (await res.json()) as { verified?: unknown };
    if (payload && payload.verified === true) {
      return { ok: true, message: "verified" };
    }
    return { ok: false, message: "provider rejected the OTP" };
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, message: "provider timeout" };
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : "provider error",
    };
  }
}

Deno.serve(async (req) => {
  const cors = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== "POST") {
    return withCorsJson(
      405,
      { ok: false, error: "method", message: "POST required" },
      cors,
    );
  }

  let body: VerifyBody;
  try {
    body = (await req.json()) as VerifyBody;
  } catch {
    return withCorsJson(
      400,
      { ok: false, error: "validation", message: "invalid JSON body" },
      cors,
    );
  }

  const employeeId = isNonEmptyString(body.employee_id)
    ? body.employee_id.trim()
    : null;
  const otp = isNonEmptyString(body.otp) ? body.otp.trim() : null;
  const idempotencyKey = isUuidLike(body.p_idempotency_key)
    ? (body.p_idempotency_key as string)
    : null;
  const correlationId = isUuidLike(body.p_correlation_id)
    ? (body.p_correlation_id as string)
    : null;

  if (!employeeId || !otp || !idempotencyKey) {
    return withCorsJson(
      400,
      {
        ok: false,
        error: "validation",
        message:
          "missing required fields: employee_id, otp, p_idempotency_key",
      },
      cors,
    );
  }

  if (!/^\d{4,8}$/.test(otp)) {
    return withCorsJson(
      400,
      { ok: false, error: "validation", message: "otp must be 4-8 digits" },
      cors,
    );
  }

  // Provider call. Fail-closed when env unset.
  const providerResult = await verifyWithProvider(
    employeeId,
    otp,
    correlationId,
  );
  if (!providerResult.ok) {
    return withCorsJson(
      401,
      {
        ok: false,
        error: "verifier_failed",
        message: providerResult.message,
      },
      cors,
    );
  }

  // Service-role client for the post-verify write.
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return withCorsJson(
      500,
      {
        ok: false,
        error: "internal",
        message: "edge env not configured (SUPABASE_URL / service key)",
      },
      cors,
    );
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    db: { schema: "public" },
    global: {
      headers: correlationId
        ? { "x-correlation-id": correlationId }
        : {},
    },
  });

  // The DB-side verifier reads `current_setting('app.fieldops_otp_verified')`
  // in its `edge_fn` branch. supabase-js's `.rpc()` is one call per
  // session, so the canonical pattern is a wrapper RPC that:
  //   1. set_config('app.fieldops_otp_verified', 'true', TRUE)
  //   2. calls submit_fieldops_auth_otp_v1(...)
  // both inside the same function body so the GUC stays scoped.
  // See migration `202605131700_submit_fieldops_auth_otp_via_edge_v1.sql`.
  // service_role only — this function's auth gate is its only caller.
  const { data: writeData, error: writeError } = await supabase.rpc(
    "submit_fieldops_auth_otp_via_edge_v1",
    {
      p_employee_id: employeeId,
      p_otp: otp,
      p_edge_verified: true,
      p_idempotency_key: idempotencyKey,
      p_correlation_id: correlationId,
    },
  );

  if (writeError) {
    // RPC raises errcode 28000 when verifier returns FALSE — map to 401.
    const sqlState =
      (writeError as { code?: string }).code ||
      (writeError as { hint?: string }).hint ||
      "";
    if (sqlState === "28000") {
      return withCorsJson(
        401,
        {
          ok: false,
          error: "verifier_failed",
          message: writeError.message,
        },
        cors,
      );
    }
    return withCorsJson(
      500,
      {
        ok: false,
        error: "internal",
        message: writeError.message,
        sqlstate: sqlState || null,
      },
      cors,
    );
  }

  return withCorsJson(
    200,
    { ok: true, decision_log_id: writeData ?? null },
    cors,
  );
});

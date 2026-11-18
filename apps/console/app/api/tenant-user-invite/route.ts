import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getVerifiedAccessToken, normalizeAppBasePath, validateTrustedBrowserRequest } from "@masarx/auth";
import { createTenantUserInviteProviderClient } from "../../../../shared/tenant-user-invite-provider";

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const response = (status: number, body: JsonRecord) => Response.json(body, {
  status, headers: { "cache-control": "no-store" },
});
const MAX_INVITE_BODY_BYTES = 8192;

// Same bounded reader/cancel pattern as the existing UI-event route, with this route's smaller limit.
async function readInviteBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_INVITE_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function callbackUrl() {
  // Never accept a browser-supplied redirect or derive it from forwarded Host headers.
  const url = new URL(process.env.CONSOLE_BASE_URL || "");
  if (url.protocol !== "https:" || url.username || url.password
      || /^(localhost$|127\.|\[?::1\]?$)/i.test(url.hostname)) {
    throw new Error("invite_callback_unavailable");
  }
  const appBasePath = normalizeAppBasePath(process.env.NEXT_PUBLIC_APP_BASE_PATH);
  const callback = new URL(`${appBasePath === "/" ? "" : appBasePath}/auth/invite-confirm`, url.origin).toString();
  // The recovery template recognizes only these owner-managed Console origins from the existing Auth URL policies.
  if (!["https://vtgspxqkvhurpwtxnnyvhjzw.example.invalid/auth/invite-confirm", "https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/invite-confirm",
    "https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/invite-confirm"].includes(callback)) {
    throw new Error("invite_callback_unavailable");
  }
  return callback;
}

export async function POST(request: Request) {
  const trusted = validateTrustedBrowserRequest(request, { requireJson: true });
  if (!trusted.ok) return response(trusted.status, { ok: false, code: trusted.code });
  if (Number(request.headers.get("content-length") || 0) > MAX_INVITE_BODY_BYTES) {
    return response(413, { ok: false, code: "request_too_large" });
  }
  const verified = await getVerifiedAccessToken({ allowCookieSet: false });
  if (verified.error || !verified.user?.id || !verified.accessToken) {
    return response(401, { ok: false, code: "authenticated_actor_required" });
  }
  let args: JsonRecord;
  try {
    const text = await readInviteBody(request);
    if (text === null) return response(413, { ok: false, code: "request_too_large" });
    args = record(JSON.parse(text));
  } catch {
    return response(400, { ok: false, code: "invalid_request" });
  }
  const requestId = String(args.request_id || "");
  if (!uuid.test(requestId) || !["invite", "resend"].includes(String(args.action)) || args.send_email === false) {
    return response(400, { ok: false, code: "invalid_request" });
  }
  // The SQL contract derives tenant/actor and validates both capability and RBAC subsets.
  const { data: prepared, error: prepareError } = await verified.client.rpc("tenant_user_invite_prepare_v1", {
    p_request_id: requestId,
    p_args: args.action === "resend" ? { action: "resend", target_user_id: args.target_user_id } : {
      action: "invite", email: args.email, full_name: args.full_name, user_type: args.user_type,
      role_id: args.role_id, access_scope_type: args.access_scope_type,
      access_scope_id: args.access_scope_id || null,
    },
  });
  if (prepareError) return response(prepareError.code === "22023" ? 400 : 403, {
    ok: false, code: "invite_not_authorized_or_conflicting", request_id: requestId,
  });

  let admin: ReturnType<typeof createTenantUserInviteProviderClient> | null = null;
  let redirectTo = "";
  // Fail before claiming dispatch if server configuration is unavailable.
  try {
    if (record(prepared).provider_state === "ready") {
      admin = createTenantUserInviteProviderClient();
      redirectTo = callbackUrl();
    }
  } catch {
    return response(503, { ok: false, code: "invite_configuration_unavailable", request_id: requestId });
  }
  const { data: dispatchData, error: dispatchError } = await verified.client.rpc("tenant_user_invite_dispatch_v1", {
    p_request_id: requestId,
  });
  if (dispatchError) return response(403, { ok: false, code: "invite_authority_changed", request_id: requestId });
  const dispatch = record(dispatchData);
  if (dispatch.should_dispatch === true && admin) {
    let state: "accepted" | "failed" | "unknown" = "unknown";
    let authUserId: string | null = null;
    try {
      const email = String(dispatch.email);
      // This unrevealed credential protects a new placeholder from public repeated signup.
      // Confirmation here is not mailbox proof: SQL still requires this dispatch's creation attestation and token.
      const created = await admin.auth.admin.createUser({
        email, email_confirm: true, password: randomBytes(32).toString("hex"),
      });
      if (created.error && created.error.code !== "email_exists") {
        // A server/transport error may have happened after a side effect. Never retry it automatically.
        state = created.error.status && created.error.status >= 400 && created.error.status < 500
          && created.error.status !== 408 && created.error.status !== 429 ? "failed" : "unknown";
      } else {
        if (!created.error && !uuid.test(String(created.data.user?.id))) throw new Error("invite_creation_unproven");
        const token = randomBytes(32).toString("hex");
        const { data: issuedData, error: issueError } = await admin.rpc("tenant_user_invite_mailbox_issue_v1", {
          p_request_id: requestId, p_token_hash: createHash("sha256").update(token).digest("hex"),
          p_created_auth_user_id: created.error ? null : created.data.user?.id ?? null,
        });
        const issued = record(issuedData);
        const supportOnly = issued.acceptance_mode === "support_only";
        if (issueError || issued.email !== email
            || !["new_account", "active_member", "support_only"].includes(String(issued.acceptance_mode))
            || (!supportOnly && (!uuid.test(String(issued.auth_user_id))
              || (created.data.user?.id && created.data.user.id !== issued.auth_user_id)))) {
          throw new Error("invite_mailbox_issue_failed");
        }
        const acceptance = new URL(redirectTo);
        if (supportOnly) {
          // A recovery email is only the existing delivery transport. Its Auth token is never linked or redeemed.
          acceptance.searchParams.set("support", "1");
        } else {
          acceptance.searchParams.set("request_id", requestId);
          acceptance.hash = `token=${token}`;
        }
        // Only the mailbox receives this invite's secret; metadata and administrator responses never do.
        const result = await admin.auth.resetPasswordForEmail(email, { redirectTo: acceptance.toString() });
        if (result.error) {
          state = result.error.status && result.error.status >= 400 && result.error.status < 500
            && result.error.status !== 408 && result.error.status !== 429 ? "failed" : "unknown";
        } else {
          state = "accepted";
          authUserId = supportOnly ? null : String(issued.auth_user_id);
        }
      }
    } catch {
      // The durable dispatch marker already says unknown; do not infer provider rollback.
    }
    try {
      await admin.rpc("tenant_user_invite_provider_result_v1", {
        p_request_id: requestId, p_state: state, p_auth_user_id: authUserId,
      });
    } catch {
      // The durable dispatch marker remains unknown. A response must not reveal private reporting state.
    }
  }
  // Re-verify the current session after the external side effect; SQL rechecks current rights too.
  let current: Awaited<ReturnType<typeof getVerifiedAccessToken>>;
  try {
    current = await getVerifiedAccessToken({ allowCookieSet: false });
  } catch {
    return response(409, { ok: false, code: "invite_partial_authority_changed", request_id: requestId });
  }
  if (current.error || current.user?.id !== verified.user.id || !current.accessToken) {
    return response(409, { ok: false, code: "invite_partial_authority_changed", request_id: requestId });
  }
  try {
    const { error } = await current.client.rpc("tenant_user_invite_finalize_v1", { p_request_id: requestId });
    if (error) throw error;
    // Eligibility, provider state and membership state are private: never expose an account-existence oracle.
    return response(202, { ok: true, request_id: requestId, code: "invite_request_recorded" });
  } catch {
    return response(202, { ok: true, request_id: requestId, code: "invite_request_recorded" });
  }
}

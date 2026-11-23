import { resolveBrowserCorsPolicy } from "./_shared/cors.mjs";
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { readEnv } from "./_shared/mod.mjs";
import {
  asString,
  type JsonRecord,
} from "./_shared/marketplace_signup.ts";

const SUPABASE_URL = readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]);
const SUPABASE_ANON_KEY = readEnv("EDGE_SUPABASE_ANON_KEY", ["SUPABASE_ANON_KEY"]);
const SUPABASE_SERVICE_KEY = readEnv("EDGE_SUPABASE_SERVICE_ROLE_KEY", [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE_KEY",
]);
const EDGE_SUPABASE_SECRET_KEY = readEnv("EDGE_SUPABASE_SECRET_KEY", [
  "SUPABASE_SECRET_KEY",
]);

const DRIVER_SIGNUP_CORS_ALLOW_ORIGINS = readEnv("DRIVER_SIGNUP_CORS_ALLOW_ORIGINS", [
  "MARKETING_CORS_ALLOW_ORIGINS",
  "LANDING_CORS_ALLOW_ORIGINS",
]);
const DRIVER_SIGNUP_RPC_SCHEMA =
  readEnv("DRIVER_SIGNUP_RPC_SCHEMA", ["EDGE_RPC_SCHEMA", "API_RPC_SCHEMA"]) || "api";

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const json = (status: number, body: JsonRecord, corsHeaders: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });

const isJwtLike = (value: string): boolean => String(value || "").trim().split(".").length === 3;

const buildCorsHeaders = (req: Request) => resolveBrowserCorsPolicy(req, {
  hostedAllowedOrigins: DRIVER_SIGNUP_CORS_ALLOW_ORIGINS,
  localAllowedOrigins: readEnv("PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS"),
  localQaEnabled: readEnv("PUBLIC_EDGE_LOCAL_QA_ENABLED") === "1",
  allowedMethods: "POST, OPTIONS",
});

const createServiceClient = () => {
  const serviceKey = asString(EDGE_SUPABASE_SECRET_KEY) || asString(SUPABASE_SERVICE_KEY);
  const anonKey = asString(SUPABASE_ANON_KEY);
  if (!SUPABASE_URL || !serviceKey) {
    throw new Error("missing_supabase_configuration");
  }

  const apiKeyHeader = isJwtLike(serviceKey)
    ? (anonKey || serviceKey)
    : serviceKey;

  return createClient(SUPABASE_URL, serviceKey, {
    auth: { persistSession: false },
    db: {
      schema: DRIVER_SIGNUP_RPC_SCHEMA,
    },
    global: {
      headers: {
        apikey: apiKeyHeader,
      },
    },
  });
};


const DOCUMENT_BUCKET = readEnv("FIELDOPS_EVIDENCE_BUCKET", ["MOBILE_FIELDOPS_EVIDENCE_BUCKET"]) || "fieldops-evidence";
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const allowedTypes = new Set(["image/jpeg", "image/png", "application/pdf", "application/json"]);
const failure = (code: string) => ({ ok: false, error: { code } });
const committedResult = (result: JsonRecord | null | undefined) => result?.ok === true
  && result.status === "pending" && result.application_state === "documents_resubmitted"
  && uuidRegex.test(asString(result.attempt_id));

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = buildCorsHeaders(req);
  if (!cors.ok) return json(cors.status, cors.body, cors.headers);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors.headers });
  if (req.method !== "POST") return json(405, failure("method_not_allowed"), cors.headers);
  if (!String(req.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
    return json(415, failure("unsupported_content_type"), cors.headers);
  }
  let payload: JsonRecord;
  try {
    // Bound the stream before parsing, including requests without Content-Length.
    const reader = req.body?.getReader();
    if (!reader) throw new Error("invalid_json");
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_BODY_BYTES) { await reader.cancel(); return json(413, failure("documents_too_large"), cors.headers); }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    payload = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid_json");
  } catch { return json(400, failure("invalid_json"), cors.headers); }
  const token = asString(payload.token) || asString(payload.status_token);
  const retryKey = asString(payload.retry_key);
  if (!uuidRegex.test(token) || !uuidRegex.test(retryKey)) {
    return json(400, failure("invalid_status_token_or_retry_key"), cors.headers);
  }
  let client: ReturnType<typeof createServiceClient>;
  try { client = createServiceClient(); } catch { return json(500, failure("server_misconfigured"), cors.headers); }
  const rpc = async (name: string, args: JsonRecord): Promise<JsonRecord | null> => {
    try {
      const response = await client.rpc(name, args);
      if (response.error) {
        const code = asString(response.error.code);
        // A typed PostgreSQL rejection proves this RPC did not commit. Never turn
        // a payload conflict into success by reading an older committed receipt.
        if (/^(22|23)[0-9A-Z]{3}$/.test(code)) {
          const known = new Set(["document_attempt_payload_changed", "invalid_document_manifest",
            "document_bucket_unavailable", "document_manifest_mismatch", "document_cleanup_not_confirmed"]);
          const message = asString(response.error.message);
          return failure(known.has(message) ? message : "document_request_rejected");
        }
        return null;
      }
      return response.data && typeof response.data === "object"
        && !Array.isArray(response.data) ? response.data as JsonRecord : null;
    } catch { return null; }
  };
  const readback = () => rpc("driver_application_document_readback_v1", { p_status_token: token, p_retry_key: retryKey });
  const replyState = (state: JsonRecord | null) => {
    const result = state?.result as JsonRecord | undefined;
    if (state?.ok === true && state.state === "committed" && committedResult(result)) {
      return json(200, result, cors.headers);
    }
    if (state?.ok === true && state.state === "not_found") return json(404, { ...failure("document_attempt_not_found"), state: "not_found" }, cors.headers);
    if (state?.ok === false && (state.error as JsonRecord)?.code === "request_not_found") return json(404, failure("request_not_found"), cors.headers);
    if (state?.ok === true && state.state === "aborted") {
      return json(409, { ...failure("document_attempt_aborted"), state: "aborted", cleanup_state: state.cleanup_state }, cors.headers);
    }
    return json(202, { ok: false, state: "pending", retry_key: retryKey, error: { code: "document_outcome_pending" } }, cors.headers);
  };
  if (payload.mode === "readback") return replyState(await readback());
  if (payload.mode === "abandon") {
    const existing = await readback();
    if (existing?.ok !== true || existing.state !== "reserved" || !uuidRegex.test(asString(existing.attempt_id))) return replyState(existing);
    // Explicit token/retry-scoped recovery only fences apply. It never deletes
    // objects or asserts that the original invocation's uploads have settled.
    const aborted = await rpc("driver_application_document_abort_v1", { p_status_token: token, p_attempt_id: existing.attempt_id });
    return replyState(aborted?.ok === true ? aborted : await readback());
  }
  if (payload.mode && payload.mode !== "submit") return json(400, failure("invalid_mode"), cors.headers);
  if (!Array.isArray(payload.documents) || payload.documents.length < 1 || payload.documents.length > 12
    || asString(payload.note).length > 2000) return json(400, failure("invalid_document_manifest"), cors.headers);
  const documents: { descriptor: JsonRecord; bytes: Uint8Array }[] = [];
  try {
    for (const raw of payload.documents) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
      const d = raw as JsonRecord;
      if (["status", "verified_at", "verified_by_user_id", "storage_key", "storage_bucket", "ref"].some(key => key in d)) throw new Error();
      const type = asString(d.type) || asString(d.doc_type);
      const fileName = asString(d.file_name) || asString(d.fileName);
      const contentType = asString(d.content_type) || asString(d.contentType);
      const base64 = asString(d.base64);
      if (!type || type.length > 100 || !fileName || !allowedTypes.has(contentType) || (!base64 && !asString(d.text))) throw new Error();
      const bytes = base64 ? Uint8Array.from(atob(base64), c => c.charCodeAt(0)) : new TextEncoder().encode(asString(d.text));
      if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
      documents.push({ descriptor: { type, file_name: fileName, content_type: contentType, sha256, size_bytes: bytes.length }, bytes });
    }
  } catch { return json(400, failure("invalid_document_manifest"), cors.headers); }
  const reservation = await rpc("driver_application_document_reserve_v1", {
    p_status_token: token, p_retry_key: retryKey, p_documents: documents.map(d => d.descriptor), p_note: asString(payload.note) || null, p_storage_bucket: DOCUMENT_BUCKET,
  });
  if (!reservation) return replyState(await readback());
  if (reservation.ok !== true) {
    const code = asString((reservation.error as JsonRecord)?.code);
    const allowed = new Set(["request_not_found", "additional_documents_not_requested", "requested_documents_missing", "document_attempt_in_progress", "document_attempt_payload_changed", "invalid_document_manifest", "document_request_rejected"]);
    return json(409, failure(allowed.has(code) ? code : "document_reservation_failed"), cors.headers);
  }
  if (reservation.new_attempt !== true) return replyState(reservation);
  const attemptId = asString(reservation.attempt_id);
  const manifest = reservation.manifest;
  if (!uuidRegex.test(attemptId) || !Array.isArray(manifest) || manifest.length !== documents.length) return replyState(await readback());
  let transportUncertain = false;
  let uploadFailed = false;
  for (const entry of manifest) {
    const m = entry as JsonRecord;
    const doc = documents.find(d => d.descriptor.type === m.type && d.descriptor.sha256 === m.sha256
      && d.descriptor.size_bytes === m.size_bytes && d.descriptor.content_type === m.content_type);
    if (!doc || asString(m.storage_bucket) !== DOCUMENT_BUCKET || !asString(m.storage_key).includes("/" + attemptId + "/")) {
      transportUncertain = true; uploadFailed = true; break;
    }
    try {
      const uploaded = await client.storage.from(asString(m.storage_bucket)).upload(asString(m.storage_key), doc.bytes, {
        upsert: false, contentType: asString(m.content_type),
      });
      if (uploaded.error) {
        uploadFailed = true;
        // A transport/5xx failure can arrive after storage accepted the object.
        const status = Number((uploaded.error as unknown as JsonRecord).statusCode);
        transportUncertain = !Number.isInteger(status) || status < 400 || status >= 500;
        break;
      }
      if (!uploaded.data?.path || uploaded.data.path !== m.storage_key) { uploadFailed = true; transportUncertain = true; break; }
    } catch { uploadFailed = true; transportUncertain = true; break; }
  }
  if (!uploadFailed) {
    const applied = await rpc("driver_application_document_apply_v1", {
      p_status_token: token, p_attempt_id: attemptId, p_uploaded_manifest: manifest,
    });
    if (committedResult(applied)) return json(200, applied, cors.headers);
    if (!applied || applied.ok !== false) return replyState(await readback()); // Never compensate an unknown commit.
  }
  const aborted = await rpc("driver_application_document_abort_v1", { p_status_token: token, p_attempt_id: attemptId });
  if (aborted?.state === "committed") return replyState(aborted);
  if (aborted?.ok !== true || aborted.state !== "aborted") return replyState(await readback());
  // Only this original, settled uploader may compensate its abort-fenced exact manifest.
  if (!transportUncertain && JSON.stringify(aborted.cleanup_manifest) === JSON.stringify(manifest)) {
    try {
      const removed = await client.storage.from(DOCUMENT_BUCKET).remove(manifest.map(m => asString((m as JsonRecord).storage_key)));
      if (!removed.error) {
        await rpc("driver_application_document_abort_v1", { p_status_token: token, p_attempt_id: attemptId, p_cleanup_complete: true });
      }
    } catch { /* Durable pending cleanup manifest remains authoritative. */ }
  }
  return replyState(await readback());
});

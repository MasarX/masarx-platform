import { createClient } from "npm:@supabase/supabase-js@2.111.0";
import { extractToken, readEnv } from "./_shared/mod.mjs";
import { resolveCorsPolicy } from "./_shared/cors.mjs";
import { MAX_LOGO_BYTES, validatedLogoContentType } from "./_shared/raster-images.mjs";

type RecordValue = Record<string, unknown>;
const URL_BASE = readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]);
const ANON_KEY = readEnv("EDGE_SUPABASE_ANON_KEY", ["SUPABASE_ANON_KEY"]);
const SERVICE_KEY = readEnv("EDGE_SUPABASE_SECRET_KEY", ["SUPABASE_SECRET_KEY", "EDGE_SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SERVICE_ROLE_KEY"]);
const BUCKET = "label-render-assets";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): RecordValue | null => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const first = (value: unknown) => record(Array.isArray(value) ? value[0] : value);
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const publicProfile = (result: RecordValue) => ({
  profile: result.profile,
  logo: result.logo ? {
    artifact_id: record(result.logo)?.artifact_id,
    file_name: record(result.logo)?.file_name,
    mime_type: record(result.logo)?.mime_type,
    size_bytes: record(result.logo)?.size_bytes,
  } : null,
});

async function readBody(req: Request) {
  if (!req.body) throw new Error("invalid_json");
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let raw = "";
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > 7 * 1024 * 1024) { await reader.cancel(); throw new Error("request_too_large"); }
    raw += decoder.decode(part.value, { stream: true });
  }
  return record(JSON.parse(raw + decoder.decode()));
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = resolveCorsPolicy(req, {
    hostedAllowedOrigins: readEnv("API_GATEWAY_CORS_ALLOW_ORIGINS"),
    allowedMethods: ["POST", "OPTIONS"],
    allowedHeaders: ["accept", "authorization", "apikey", "content-type", "x-client-info"],
  });
  const reply = (status: number, body: RecordValue) => new Response(JSON.stringify(body), {
    status, headers: { ...cors.headers, "content-type": "application/json", "cache-control": "no-store" },
  });
  const fail = (status: number, code: string, compensation?: unknown) => reply(status, {
    ok: false, error: { code }, ...(compensation ? { compensation } : {}),
  });
  if (cors.isCorsRequest && !cors.allowed) return fail(403, "origin_not_allowed");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors.headers });
  if (req.method !== "POST") return fail(405, "method_not_allowed");
  const token = extractToken(req, { prefer: "authorization", allowWebhookHeader: false, allowQueryParam: false });
  if (!token) return fail(401, "missing_authorization");
  let payload: RecordValue | null;
  try { payload = await readBody(req); } catch (error) {
    return fail(error instanceof Error && error.message === "request_too_large" ? 413 : 400, "invalid_request_body");
  }
  if (!payload || !UUID.test(text(payload.organization_id)) || !["read", "save", "signed_url"].includes(text(payload.action))) return fail(400, "invalid_request");
  const allowed = ["action", "organization_id", "name", "timezone", "locale", "primary_color", "secondary_color", "file_name", "content_type", "file_base64"];
  if (Object.keys(payload).some((key) => !allowed.includes(key))) return fail(400, "invalid_profile_fields");
  for (const key of ["primary_color", "secondary_color"]) {
    if (Object.hasOwn(payload, key) && (typeof payload[key] !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(payload[key]))) return fail(400, "invalid_branding_color");
  }
  if (!URL_BASE || !ANON_KEY) return fail(503, "server_misconfigured");
  const user = createClient(URL_BASE, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }, db: { schema: "api" },
    global: { headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY } }, accessToken: async () => token,
  });
  const organizationId = text(payload.organization_id).toLowerCase();
  let guardData: unknown;
  let guardError: unknown;
  try {
    const result = await user.rpc("organization_profile_read_v1", { p_organization_id: organizationId });
    guardData = result.data;
    guardError = result.error;
  } catch { return fail(503, "organization_profile_authorization_unavailable"); }
  const guard = first(guardData);
  if (guardError || !guard || !record(guard.profile) || text(guard.organization_id) !== organizationId || !UUID.test(text(guard.actor_user_id))) return fail(403, "organization_profile_forbidden");
  const action = text(payload.action);
  if (action === "read") return reply(200, { ok: true, ...publicProfile(guard) });

  const service = () => {
    if (!SERVICE_KEY) throw new Error("server_misconfigured");
    return createClient(URL_BASE, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, db: { schema: "api" } });
  };
  if (action === "signed_url") {
    const logo = record(guard.logo);
    if (!logo || logo.storage_bucket !== BUCKET || !text(logo.storage_key).startsWith(`${organizationId}/branding/`)) return fail(404, "logo_not_found");
    try {
      const { data, error } = await service().storage.from(BUCKET).createSignedUrl(text(logo.storage_key), 60);
      if (error || !data?.signedUrl) return fail(502, "logo_preview_failed");
      return reply(200, { ok: true, signed_url: data.signedUrl });
    } catch { return fail(503, "logo_preview_failed"); }
  }

  const args: RecordValue = { organization_id: organizationId };
  for (const key of ["name", "timezone", "locale", "primary_color", "secondary_color"]) {
    if (Object.hasOwn(payload, key)) args[key] = payload[key];
  }
  let uploaded: { key: string; uploadId: string; artifactId: string | null } | null = null;
  let uploadAttempted = false;
  let storageClient: ReturnType<typeof service> | null = null;
  const compensate = async (registrationRolledBack = false) => {
    if (!uploaded || !storageClient) return { status: "not_needed" };
    try {
      if (uploaded.artifactId) {
        const { data, error } = await storageClient.rpc("organization_profile_abort_upload_v1", {
          p_artifact_id: uploaded.artifactId, p_organization_id: organizationId,
          p_actor_user_id: guard.actor_user_id, p_upload_id: uploaded.uploadId, p_storage_key: uploaded.key,
        });
        if (error || data !== true) return { status: "unconfirmed", reason: "artifact_abort_failed" };
      } else if (!registrationRolledBack) return { status: "unconfirmed", reason: "registration_state_unknown" };
      const { error } = await storageClient.storage.from(BUCKET).remove([uploaded.key]);
      return error ? { status: "unconfirmed", reason: "object_remove_failed" } : { status: "removed_new_upload" };
    } catch { return { status: "unconfirmed", reason: "compensation_transport_failed" }; }
  };
  if (Object.hasOwn(payload, "file_base64")) {
    const fileName = text(payload.file_name);
    const base64 = text(payload.file_base64);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(fileName) || !base64 || base64.length > Math.ceil(MAX_LOGO_BYTES / 3) * 4 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return fail(400, "invalid_logo_file");
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0)); } catch { return fail(400, "invalid_logo_file"); }
    const contentType = validatedLogoContentType(bytes, text(payload.content_type));
    if (!contentType) return fail(400, "invalid_logo_image");
    const uploadId = crypto.randomUUID();
    const key = `${organizationId}/branding/${uploadId}/${fileName}`;
    try {
      storageClient = service();
      uploadAttempted = true;
      const { error } = await storageClient.storage.from(BUCKET).upload(key, new Blob([bytes], { type: contentType }), { contentType, upsert: false });
      if (error) return fail(502, "logo_upload_unconfirmed", { status: "unconfirmed", reason: "upload_result_unknown" });
      uploaded = { key, uploadId, artifactId: null };
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
      const { data: artifactData, error: artifactError } = await storageClient.rpc("register_artifact_v1", { p_artifact: {
        organization_id: organizationId, created_by_user_id: guard.actor_user_id, source_system: "organization-profile",
        storage_bucket: BUCKET, storage_key: key, mime_type: contentType, size_bytes: bytes.length, sha256,
        metadata: { file_name: fileName, upload_id: uploadId },
      } });
      if (artifactError) return fail(502, "logo_artifact_failed", await compensate(/^[0-9A-Z]{5}$/.test(text(artifactError.code))));
      const artifact = first(artifactData);
      if (!artifact || artifact.created !== true || !UUID.test(text(artifact.artifact_id))) return fail(502, "logo_artifact_unconfirmed", await compensate());
      uploaded.artifactId = text(artifact.artifact_id);
      args.logo_artifact_id = uploaded.artifactId;
    } catch {
      return fail(502, "logo_upload_or_registration_unconfirmed", uploadAttempted && !uploaded
        ? { status: "unconfirmed", reason: "upload_result_unknown" } : await compensate());
    }
  }
  try {
    const { data, error } = await user.rpc("ui_update_organization_profile_v1", { p_args: args });
    const result = first(data);
    if (error || !result || text(result.organization_id) !== organizationId || !record(result.profile)) return fail(400, "organization_profile_update_failed", await compensate());
    return reply(200, { ok: true, ...publicProfile(result) });
  } catch { return fail(502, "organization_profile_update_unconfirmed", await compensate()); }
});

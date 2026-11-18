import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@^2.45.4";
import { extractToken, parseRequestBody, readEnv } from "./_shared/mod.mjs";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]);
const SUPABASE_ANON_KEY = readEnv("EDGE_SUPABASE_ANON_KEY", ["SUPABASE_ANON_KEY"]);
const SUPABASE_SERVICE_KEY = readEnv("EDGE_SUPABASE_SERVICE_ROLE_KEY", [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE_KEY",
]);
const EDGE_SUPABASE_SECRET_KEY = readEnv("EDGE_SUPABASE_SECRET_KEY", [
  "SUPABASE_SECRET_KEY",
]);
const ASSET_BUCKET =
  (readEnv("ORGANIZATION_LOGO_BUCKET", ["LABEL_RENDER_ASSETS_BUCKET", "LABEL_ASSET_BUCKET"]) ||
    "label-render-assets").trim() || "label-render-assets";

const corsHeaders = (req: Request): Record<string, string> => {
  const origin = req.headers.get("origin")?.trim() || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
    "access-control-max-age": "600",
    vary: "Origin",
  };
};

const json = (status: number, body: JsonRecord, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });

const asString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const isJwtLike = (value: string): boolean =>
  String(value || "").trim().split(".").length === 3;

const createUserClient = (token: string) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("missing_supabase_public_configuration");
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: "api" },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
        "x-client-info": "console-v2-organization-profile",
      },
    },
    accessToken: async () => token,
  });
};

const createServiceClient = () => {
  const serviceKey = asString(EDGE_SUPABASE_SECRET_KEY) || asString(SUPABASE_SERVICE_KEY);
  const anonKey = asString(SUPABASE_ANON_KEY);
  if (!SUPABASE_URL || !serviceKey) {
    throw new Error("missing_supabase_service_configuration");
  }
  const apiKeyHeader = isJwtLike(serviceKey) ? (anonKey || serviceKey) : serviceKey;
  return createClient(SUPABASE_URL, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: "api" },
    global: {
      headers: {
        apikey: apiKeyHeader,
        "x-client-info": "console-v2-organization-profile",
      },
    },
  });
};

const dataUrlToBase64 = (raw: string) => {
  const value = raw.trim();
  const idx = value.indexOf("base64,");
  return idx === -1 ? value : value.slice(idx + "base64,".length).trim();
};

const decodeBase64 = (raw: string): Uint8Array => {
  const normalized = dataUrlToBase64(raw).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const stripped = normalized.replace(/=+$/g, "");
  const padded = stripped + "=".repeat((4 - (stripped.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

const sanitizeFileName = (raw: string) => {
  const base = raw.split(/[\\/]/).pop() ?? "";
  return base
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
};

const allowedLogoContentType = (contentType: string): boolean =>
  ["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(contentType);

const canonicalLogoContentType = (contentType: string): string =>
  contentType === "image/jpg" ? "image/jpeg" : contentType;

const sniffLogoContentType = (bytes: Uint8Array): string | null => {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) return "image/webp";
  return null;
};

serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") {
    return json(405, { ok: false, error: { code: "method_not_allowed" } }, cors);
  }

  const token = extractToken(req, {
    prefer: "authorization",
    allowWebhookHeader: false,
    allowQueryParam: false,
  });
  if (!token) {
    return json(401, { ok: false, error: { code: "missing_authorization" } }, cors);
  }

  let payload: JsonRecord;
  try {
    payload = (await parseRequestBody(req)).json as JsonRecord;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_json";
    return json(400, { ok: false, error: { code: "invalid_json", message } }, cors);
  }

  let userClient;
  let serviceClient;
  try {
    userClient = createUserClient(token);
    serviceClient = createServiceClient();
  } catch (error) {
    const message = error instanceof Error ? error.message : "missing_supabase_configuration";
    return json(500, { ok: false, error: { code: "server_misconfigured", message } }, cors);
  }

  const organizationId = asString(payload.organization_id) || null;
  const { data: guardData, error: guardError } = await userClient.rpc(
    "organization_profile_assert_writer_v1",
    { p_organization_id: organizationId },
  );
  if (guardError) {
    return json(403, {
      ok: false,
      error: { code: "organization_profile_forbidden", message: guardError.message },
    }, cors);
  }

  const guard = guardData && typeof guardData === "object" ? guardData as JsonRecord : {};
  const resolvedOrgId = asString(guard.organization_id);
  if (!resolvedOrgId) {
    return json(403, { ok: false, error: { code: "organization_context_required" } }, cors);
  }

  const updateArgs: JsonRecord = {
    organization_id: resolvedOrgId,
    name: asString(payload.name) || undefined,
    timezone: asString(payload.timezone) || undefined,
    locale: asString(payload.locale) || undefined,
    logo_url: asString(payload.logo_url) || undefined,
    primary_color: asString(payload.primary_color) || undefined,
    secondary_color: asString(payload.secondary_color) || undefined,
  };
  if (
    payload.default_settings_patch &&
    typeof payload.default_settings_patch === "object" &&
    !Array.isArray(payload.default_settings_patch)
  ) {
    updateArgs.default_settings_patch = payload.default_settings_patch;
  }

  let artifact: JsonRecord | null = null;
    const fileBase64 = asString(payload.file_base64);
  if (fileBase64) {
    const fileName = sanitizeFileName(asString(payload.file_name));
    const contentType = (asString(payload.content_type) || "application/octet-stream").toLowerCase();
    const canonicalContentType = canonicalLogoContentType(contentType);
    if (!fileName) return json(400, { ok: false, error: { code: "invalid_file_name" } }, cors);
    if (!allowedLogoContentType(contentType)) {
      return json(415, {
        ok: false,
        error: { code: "unsupported_logo_content_type", message: contentType },
      }, cors);
    }

    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(fileBase64);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid_logo_base64";
      return json(400, { ok: false, error: { code: "invalid_logo_base64", message } }, cors);
    }
    if (bytes.length === 0) return json(400, { ok: false, error: { code: "empty_logo_file" } }, cors);
    if (bytes.length > 5 * 1024 * 1024) {
      return json(413, { ok: false, error: { code: "logo_file_too_large", message: "Max 5MB" } }, cors);
    }
    const sniffedContentType = sniffLogoContentType(bytes);
    if (sniffedContentType !== canonicalContentType) {
      return json(400, {
        ok: false,
        error: {
          code: "invalid_logo_file_signature",
          message: `Logo bytes do not match declared content type ${contentType}.`,
        },
      }, cors);
    }

    const storageKey = `${resolvedOrgId}/branding/${Date.now()}-${fileName}`;
    const { error: uploadError } = await serviceClient.storage
      .from(ASSET_BUCKET)
      .upload(storageKey, new Blob([bytes], { type: canonicalContentType }), {
        contentType: canonicalContentType,
        upsert: true,
      });
    if (uploadError) {
      return json(400, { ok: false, error: { code: "logo_upload_failed", message: uploadError.message } }, cors);
    }

    const { data: artifactRow, error: artifactError } = await serviceClient.rpc(
      "register_artifact_v1",
      {
        p_artifact: {
          source_system: "organization-profile",
          created_by_user_id: asString(guard.actor_user_id) || undefined,
          metadata: {
            source: "organization-profile",
            file_name: fileName,
          },
          organization_id: resolvedOrgId,
          storage_bucket: ASSET_BUCKET,
          storage_key: storageKey,
          mime_type: canonicalContentType,
          size_bytes: bytes.length,
        },
      },
    );
    if (artifactError) {
      return json(400, { ok: false, error: { code: "logo_artifact_failed", message: artifactError.message } }, cors);
    }

    const artifactResult = Array.isArray(artifactRow) ? artifactRow[0] : artifactRow;
    const artifactId = asString((artifactResult as JsonRecord | undefined)?.artifact_id);
    if (!artifactId) {
      return json(400, { ok: false, error: { code: "logo_artifact_failed", message: "artifact_id_missing" } }, cors);
    }

    artifact = {
      id: artifactId,
      artifact_id: artifactId,
      created: Boolean((artifactResult as JsonRecord | undefined)?.created),
      storage_bucket: ASSET_BUCKET,
      storage_key: storageKey,
      mime_type: contentType,
      size_bytes: bytes.length,
    };
    updateArgs.logo_storage_bucket = ASSET_BUCKET;
    updateArgs.logo_storage_key = storageKey;
    updateArgs.logo_artifact_id = artifactId;
    updateArgs.logo_file_name = fileName;
    updateArgs.logo_content_type = contentType;
  }

  const { data: updateData, error: updateError } = await userClient.rpc(
    "ui_update_organization_profile_v1",
    { p_args: updateArgs },
  );
  if (updateError) {
    return json(400, {
      ok: false,
      error: { code: "organization_profile_update_failed", message: updateError.message },
    }, cors);
  }

  return json(200, {
    ok: true,
    result: updateData && typeof updateData === "object" ? updateData as JsonRecord : {},
    artifact,
  }, cors);
});

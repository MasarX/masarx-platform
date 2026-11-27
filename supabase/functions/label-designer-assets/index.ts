import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { DOMParser } from "npm:@xmldom/xmldom@0.9.12";
import { isPngContainer, isJpegContainer } from "./_shared/raster-images.mjs";
import { canonicalStorageKey, extractToken, logStructured, parseRequestBody, readEnv } from "./_shared/mod.mjs";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]);
const SUPABASE_ANON_KEY = readEnv("EDGE_SUPABASE_ANON_KEY", ["SUPABASE_ANON_KEY"]);
const SUPABASE_SERVICE_KEY = readEnv("EDGE_SUPABASE_SERVICE_ROLE_KEY", [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE_KEY",
]);

const ASSET_BUCKET =
  (readEnv("LABEL_ASSET_BUCKET", ["LABEL_RENDER_ASSETS_BUCKET"]) || "label-render-assets").trim() ||
  "label-render-assets";
const DESIGNER_DIR = (readEnv("LABEL_DESIGNER_ASSETS_DIR", []) || "designer").trim() || "designer";

if (!SUPABASE_URL) console.error("[label-designer-assets] Missing SUPABASE_URL");
if (!SUPABASE_ANON_KEY) console.error("[label-designer-assets] Missing SUPABASE_ANON_KEY");

const asString = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const asBoolean = (value: unknown) => value === true;

const json = (status: number, body: JsonRecord, corsHeaders: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });

const dataUrlToBase64 = (raw: string) => {
  const s = raw.trim();
  const idx = s.indexOf("base64,");
  if (idx === -1) return s;
  return s.slice(idx + "base64,".length).trim();
};

const decodeBase64 = (raw: string): Uint8Array => {
  const b64 = dataUrlToBase64(raw).replace(/\s+/g, "");
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const stripped = normalized.replace(/=+$/g, "");
  const padded = stripped + "=".repeat((4 - (stripped.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
};


const imageContentTypeFromBytes = (bytes: Uint8Array, contentType: string): string | null => {
  if (isPngContainer(bytes)) return "image/png";
  if (isJpegContainer(bytes)) return "image/jpeg";
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
  ) {
    return "image/webp";
  }
  try {
    // RFC 7303: BOM > MIME charset > XML declaration/default. Hints choose decoding, never XML validity.
    const bom = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be"
      : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "utf-8" : null;
    let charset: string | undefined;
    for (const parameter of contentType.matchAll(/;\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/g)) {
      if (parameter[1].toLowerCase() === "charset") {
        charset = (parameter[2] ?? parameter[3]).replace(/\\(.)/g, "$1");
        break;
      }
    }
    let declaredEncoding: string | undefined;
    if (!bom && charset === undefined && String.fromCharCode(...bytes.subarray(0, 5)) === "<?xml") {
      // Scan only the leading declaration, bounded by the already-enforced 5 MiB input limit.
      const end = bytes.findIndex((value, index) => value === 0x3f && bytes[index + 1] === 0x3e);
      const declaration = new TextDecoder("windows-1252").decode(bytes.subarray(0, end < 0 ? 0 : end + 2));
      declaredEncoding = /[\t\n\r ]encoding[\t\n\r ]*=[\t\n\r ]*(["'])([^"']*)\1/.exec(declaration)?.[2];
    }
    const decoder = new TextDecoder(bom ?? charset ?? declaredEncoding ?? "utf-8", { fatal: true });
    const source = decoder.decode(bytes);
    const doc = new DOMParser({ onError: () => { throw new Error("Invalid SVG XML"); } })
      .parseFromString(source, "application/xml");
    return doc.documentElement?.localName === "svg" && doc.documentElement.namespaceURI === "http://www.w3.org/2000/svg"
      ? `image/svg+xml${!bom && charset !== undefined ? `; charset=${decoder.encoding}` : ""}` : null;
  } catch {
    return null;
  }
};

const sanitizeFileName = (raw: string) => {
  const base = raw.trim();
  const last = base.split(/[\\/]/).pop() ?? "";
  const cleaned = last
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 120);
};

const createUserClient = (token: string) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error("missing_supabase_config");
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: "api" },
    global: { headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY } },
    accessToken: async () => token,
  });
};

const createStorageClient = (token: string) => {
  if (!SUPABASE_URL) throw new Error("missing_supabase_config");
  if (SUPABASE_SERVICE_KEY) {
    return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      db: { schema: "api" },
    });
  }
  return createUserClient(token);
};

type RequestBody =
  | { mode: "list"; user_jwt: string }
  | { mode: "signed_url"; user_jwt: string; path: string; expires_seconds?: number }
  | {
    mode: "upload";
    user_jwt: string;
    file_name: string;
    content_type?: string;
    file_base64: string;
  }
  | { mode: "delete"; user_jwt: string; path: string };

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin") ?? "*";
  const corsHeaders = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  const rejectWithLog = (status: number, code: string, message: string, error: unknown) => {
    const correlationId = crypto.randomUUID();
    logStructured("error", "label_designer_assets.request_failed", { correlation_id: correlationId, code, error });
    return json(status, { ok: false, error: { code, message }, correlation_id: correlationId }, corsHeaders);
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: { code: "method_not_allowed" } }, corsHeaders);

  // Gateway JWT verification is disabled for browser compatibility with the
  // current key plane. This handler validates the signed-in user's JWT through
  // the canonical API/RLS path before performing any asset operation.
  const headerToken = extractToken(req, { prefer: "authorization", allowWebhookHeader: false, allowQueryParam: false });

  let payload: unknown;
  try {
    payload = (await parseRequestBody(req)).json;
  } catch (error) {
    return rejectWithLog(400, "invalid_json", "Invalid JSON payload", error);
  }

  const mode = asString((payload as any)?.mode);
  const bodyUserJwt = asString((payload as any)?.user_jwt);
  if (!mode) return json(400, { ok: false, error: { code: "mode_required" } }, corsHeaders);
  if (!headerToken && !bodyUserJwt) {
    return json(403, { ok: false, error: { code: "auth_required", message: "Authentication required" } }, corsHeaders);
  }

  try {
    const tryWhoami = async (jwt: string) => {
      const user = createUserClient(jwt);
      return await user.rpc("label_designer_whoami").single();
    };

    const headerRes = headerToken ? await tryWhoami(headerToken) : ({ data: null, error: null } as any);
    const headerOk = !!(headerRes?.data && (headerRes.data as any).ok === true);
    const authResult = !headerOk && bodyUserJwt ? await tryWhoami(bodyUserJwt) : headerRes;
    const who = authResult?.data;
    const whoErr = authResult?.error;
    if (whoErr || !who || (who as any).ok !== true) {
      return rejectWithLog(403, "org_required", "Authentication required", whoErr ?? who?.error);
    }
    const orgId = asString((who as any).organization_id);
    if (!orgId) {
      return json(403, { ok: false, error: { code: "org_required", message: "Organization context required" } }, corsHeaders);
    }
    const canRead = asBoolean((who as any).can_read);
    const canWrite = asBoolean((who as any).can_write);
    const requiresWrite = mode === "upload" || mode === "delete";
    if (requiresWrite && !canWrite) {
      return json(
        403,
        { ok: false, error: { code: "access_denied", message: "label_design.write capability is required" } },
        corsHeaders,
      );
    }
    if (!requiresWrite && !canRead && !canWrite) {
      return json(
        403,
        { ok: false, error: { code: "access_denied", message: "label_design.read capability is required" } },
        corsHeaders,
      );
    }

    const effectiveUserJwt = headerOk ? headerToken : bodyUserJwt;
    if (!effectiveUserJwt) {
      return json(403, { ok: false, error: { code: "auth_required", message: "Authentication required" } }, corsHeaders);
    }
    const user = createUserClient(effectiveUserJwt);
    const storageClient = createStorageClient(effectiveUserJwt);

    const typed = payload as RequestBody;

    if (typed.mode === "list") {
      const prefix = `${orgId}/${DESIGNER_DIR}`;
      const { data, error } = await storageClient.storage.from(ASSET_BUCKET).list(prefix, { limit: 200 });
      if (error) return rejectWithLog(400, "list_failed", "Could not list assets", error);
      const assets = (data ?? [])
        .filter((o) => o && typeof o.name === "string" && o.name.trim().length > 0)
        .map((o) => ({ name: o.name, path: `${prefix}/${o.name}` }));
      return json(200, { ok: true, assets }, corsHeaders);
    }

    if (typed.mode === "signed_url") {
      const rawPath = typed.path;
      const expires = Number((typed as any).expires_seconds ?? 60);
      if (!rawPath) return json(400, { ok: false, error: { code: "path_required" } }, corsHeaders);
      const path = canonicalStorageKey(rawPath, orgId, { allowShared: true });
      if (!path || (path.startsWith(`${orgId}/`) && !path.startsWith(`${orgId}/${DESIGNER_DIR}/`))) {
        return json(403, { ok: false, error: { code: "forbidden_path" } }, corsHeaders);
      }
      const ttl = Number.isFinite(expires) && expires > 0 ? Math.min(600, Math.floor(expires)) : 60;
      const { data, error } = await storageClient.storage.from(ASSET_BUCKET).createSignedUrls([path], ttl);
      const signed = data?.[0];
      if (error || !signed?.signedUrl) {
        return rejectWithLog(400, "signed_url_failed", "Could not create a signed URL", error ?? signed?.error ?? "Missing signed URL");
      }
      return json(200, { ok: true, signed_url: signed.signedUrl }, corsHeaders);
    }

    if (typed.mode === "upload") {
      const fileNameRaw = asString((typed as any).file_name);
      const fileBase64 = asString((typed as any).file_base64);
      let contentType = asString((typed as any).content_type) || "application/octet-stream";
      if (!fileNameRaw) return json(400, { ok: false, error: { code: "file_name_required" } }, corsHeaders);
      if (!fileBase64) return json(400, { ok: false, error: { code: "file_base64_required" } }, corsHeaders);

      const safeName = sanitizeFileName(fileNameRaw);
      if (!safeName || safeName === "." || safeName === "..") {
        return json(400, { ok: false, error: { code: "invalid_file_name" } }, corsHeaders);
      }

      let bytes: Uint8Array;
      try {
        bytes = decodeBase64(fileBase64);
      } catch {
        return json(400, { ok: false, error: { code: "invalid_file_base64" } }, corsHeaders);
      }
      if (bytes.length === 0) return json(400, { ok: false, error: { code: "empty_file" } }, corsHeaders);
      if (bytes.length > 5 * 1024 * 1024) {
        return json(413, { ok: false, error: { code: "file_too_large", message: "Max 5MB" } }, corsHeaders);
      }
      const mime = contentType.split(";", 1)[0].trim().toLowerCase();
      const declaredMime = mime === "image/jpg" ? "image/jpeg" : mime;
      const detectedType = imageContentTypeFromBytes(bytes, contentType);
      if (!detectedType) return json(400, { ok: false, error: { code: "invalid_image" } }, corsHeaders);
      if (declaredMime !== "application/octet-stream" && detectedType.split(";", 1)[0] !== declaredMime) {
        return json(400, { ok: false, error: { code: "image_mime_mismatch" } }, corsHeaders);
      }
      contentType = detectedType;

      const path = `${orgId}/${DESIGNER_DIR}/${safeName}`;
      const { error } = await storageClient.storage.from(ASSET_BUCKET).upload(path, new Blob([bytes], { type: contentType }), {
        contentType,
        upsert: true,
      });
      if (error) return rejectWithLog(400, "upload_failed", "Could not upload asset", error);
      return json(200, { ok: true, path }, corsHeaders);
    }

    if (typed.mode === "delete") {
      if (!typed.path) return json(400, { ok: false, error: { code: "path_required" } }, corsHeaders);
      const path = canonicalStorageKey(typed.path, orgId, { write: true });
      if (!path?.startsWith(`${orgId}/${DESIGNER_DIR}/`)) {
        return json(403, { ok: false, error: { code: "forbidden_path" } }, corsHeaders);
      }
      const { error } = await storageClient.storage.from(ASSET_BUCKET).remove([path]);
      if (error) return rejectWithLog(400, "delete_failed", "Could not delete asset", error);
      return json(200, { ok: true }, corsHeaders);
    }

    return json(400, { ok: false, error: { code: "unknown_mode" } }, corsHeaders);
  } catch (error) {
    return rejectWithLog(500, "internal_error", "Could not complete asset request", error);
  }
});

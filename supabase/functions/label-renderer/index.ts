import { createClient } from "npm:@supabase/supabase-js@2.119.0";
type PdfModule = typeof import("npm:pdf-lib@1.17.1");
type PDFDocument = import("npm:pdf-lib@1.17.1").PDFDocument;
let PDFDocument: PdfModule["PDFDocument"];
let rgb: PdfModule["rgb"];
let StandardFonts: PdfModule["StandardFonts"];
let degrees: PdfModule["degrees"];
let qrcode: typeof import("npm:qrcode-generator@1.5.2").default;
let bwip: typeof import("npm:bwip-js@4.11.2").default;
let fontkit: typeof import("npm:@pdf-lib/fontkit@1.1.1").default;
let bidi: ReturnType<typeof import("npm:bidi-js@1.1.0").default>;
let rendererDepsPromise: Promise<void> | undefined;

// Share one load (including a rejected load) per isolate; never partially render.
const ensureRendererDeps = (): Promise<void> => {
  if (!rendererDepsPromise) {
    rendererDepsPromise = Promise.all([
      import("npm:pdf-lib@1.17.1"),
      import("npm:qrcode-generator@1.5.2"),
      import("npm:@pdf-lib/fontkit@1.1.1"),
      import("npm:bidi-js@1.1.0"),
      import("npm:bwip-js@4.11.2"),
    ]).then(([pdf, qr, fonts, bidiModule, bwipModule]) => {
      const loadedBidi = bidiModule.default();
      PDFDocument = pdf.PDFDocument;
      rgb = pdf.rgb;
      StandardFonts = pdf.StandardFonts;
      degrees = pdf.degrees;
      qrcode = qr.default;
      bwip = bwipModule.default;
      fontkit = fonts.default;
      bidi = loadedBidi;
    });
  }
  return rendererDepsPromise;
};
import { classifyError, logStructured, readEnv } from "./_shared/mod.mjs";
import { resolveCorsPolicy } from "./_shared/cors.mjs";
import { authorizeLabelRendererRequest, resolveLabelRendererOperation, verifyLabelRendererToken } from "./auth.mjs";
import { BARCODE_MAX_CHARS, canonicalBarcodeType, encodeAdditionalBarcode, rotateBarcodePoint } from "./barcode.ts";
import { executeHotpathRpc, hotpathModeEnabled } from "../_shared/db-hotpath.ts";
import { projectSignedStorageUrlForResponse } from "../_shared/label-storage-url.ts";
import { AssetCache } from "../_shared/asset-cache.ts";

const logRenderer = (
  level: "warn" | "error",
  event: string,
  { error, ...context }: Record<string, unknown> = {},
) => {
  logStructured(level, `label_renderer.${event}`, {
    service: "label-renderer",
    ...context,
    ...(error == null ? {} : { error_type: classifyError(error) }),
  });
};

interface LeaseRequest {
  organization_id?: string;
  job_id?: string;
  job_ids?: string[];
  lease_seconds?: number;
  max_jobs?: number;
  job_concurrency?: number;
}

interface LabelJob {
  id: string;
  organization_id: string;
  client_id: string | null;
  shipment_id: string | null;
  shipment_box_id: string | null;
  target_type?: string | null;
  target_id?: string | null;
  target_box_id?: string | null;
  target_metadata?: Record<string, unknown> | null;
  label_id?: string | null;
  label_type?: string | null;
  template_id: string | null;
  template_version: number | null;
  attempts: number;
  job_purpose?: string | null;
  renderer_hint?: string | null;
  workflow_run_step_id?: string | null;
}

type TemplateErrorCode = "template_missing" | "asset_missing" | "render_failure";

interface TemplateAsset {
  name: string;
  path: string;
  content_type?: string;
}

type TemplateColorInput =
  | string
  | {
    r?: number;
    g?: number;
    b?: number;
  };

interface TemplateRenderCondition {
  path?: string;
  default?: unknown;
  equals?: unknown;
  not_equals?: unknown;
  in?: unknown[];
  not_in?: unknown[];
  exists?: boolean;
  truthy?: boolean;
}

interface TemplateBlock {
  type: "text" | "barcode" | "image" | "line" | "rect";
  x: number;
  y: number;
  width?: number;
  height?: number;
  font?: string;
  font_size?: number;
  min_font_size?: number;
  hard_min_font_size?: number;
  text_overflow?: "shrink" | "truncate" | "clip" | string;
  wrap?: boolean;
  line_height_factor?: number;
  max_height?: number;
  valign?: "top" | "middle" | "bottom";
  baseline_descent_factor?: number;
  color?: TemplateColorInput;
  fill_color?: TemplateColorInput;
  stroke_width?: number;
  value_path?: string;
  asset_ref?: string;
  fallback?: string;
  align?: "left" | "center" | "right";
  rotation?: number;
  max_width?: number;
  module_width?: number;
  max_scale?: number;
  reserve_bottom?: number;
  human_readable?: boolean;
  allow_upscale?: boolean;
  barcode_type?: string;
  quiet_zone_modules?: number;
  min_quiet_zone_modules?: number;
  render_if?: TemplateRenderCondition | TemplateRenderCondition[];
}

interface TemplateRendererConfig {
  page?: {
    width_inch?: number;
    height_inch?: number;
    margin_inch?: number;
    dpi?: number;
    orientation?: "portrait" | "landscape";
  };
  assets?: TemplateAsset[];
  blocks?: TemplateBlock[];
  barcode?: { type?: string; value_path?: string; human_readable?: string };
}

interface TemplateSnapshot {
  template_id?: string;
  template_key?: string;
  template_version?: number;
  renderer_config?: TemplateRendererConfig;
  asset_refs?: TemplateAsset[];
  label_config?: Record<string, unknown>;
  schema_version?: number;
}

interface WorkflowProgressRequest {
  workflow_run_id?: string;
  workflow_run_step_id?: string;
  workflow_progress_enabled?: boolean;
  workflow_progress_budget_ms?: number;
  workflow_progress_max_steps?: number;
  metadata?: Record<string, unknown>;
}

interface PrintRequest extends WorkflowProgressRequest {
  organization_id: string;
  client_id?: string;
  sender_id?: string;
  label_type?: string;
  job_purpose?: string | null;
  targets?: Array<{
    target_type?: string;
    target_id?: string;
    target_box_id?: string;
    label_type?: string;
  }>;
  shipments: Array<{ shipment_id: string; box_ids?: string[] }>;
  output_name?: string;
  expires_seconds?: number;
}

interface BundleRequest extends WorkflowProgressRequest {
  organization_id: string;
  client_id?: string;
  sender_id?: string;
  file_urls?: string[];
  label_ids?: string[];
  shipments?: Array<{ shipment_id: string; box_ids?: string[] }>;
  output_name?: string;
  expires_seconds?: number;
}

interface BundleTarget {
  labelId?: string | null;
  shipmentId?: string | null;
  shipmentBoxId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetBoxId?: string | null;
  fileUrl?: string | null;
  boxNumber?: number | null;
}

type EmbeddedFontPromise = Promise<ReturnType<PDFDocument["embedFont"]>>;

class TemplateError extends Error {
  constructor(
    public readonly code: TemplateErrorCode,
    message: string,
    public readonly metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TemplateError";
  }
}

const SUPABASE_URL = readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]);
const PUBLIC_SUPABASE_URL = readEnv("EDGE_PUBLIC_SUPABASE_URL", ["NEXT_PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL"]);
const SUPABASE_SERVICE_OR_EDGE_KEY = readEnv("LABEL_RENDERER_TOKEN", [
  "EDGE_SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE_KEY",
  "EDGE_SUPABASE_SECRET_KEY",
  "SUPABASE_SECRET_KEY",
]);
const SUPABASE_STORAGE_SERVICE_KEY = readEnv("LABEL_RENDERER_STORAGE_TOKEN", [
  "EDGE_SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE_KEY",
  "EDGE_SUPABASE_SECRET_KEY",
  "LABEL_RENDERER_TOKEN",
  "SUPABASE_SECRET_KEY",
]);
const LEGACY_SUPABASE_SERVICE_ROLE_KEY = readEnv("SUPABASE_SERVICE_ROLE_KEY", ["SERVICE_ROLE_KEY"]);
const SUPABASE_ANON_KEY = readEnv("EDGE_SUPABASE_ANON_KEY", ["SUPABASE_ANON_KEY"]);
const EDGE_DB_JWT = readEnv("LABEL_RENDERER_DB_JWT", ["EDGE_DB_JWT"]);
const EDGE_REQUIRE_DB_JWT = readEnv("EDGE_REQUIRE_DB_JWT", []) === "1";
const LABEL_BUCKET = (readEnv("LABEL_RENDER_BUCKET", ["LABEL_RENDERER_BUCKET"]) || "labels").trim() || "labels";
const ASSET_BUCKET =
  (readEnv("LABEL_ASSET_BUCKET", ["LABEL_RENDER_ASSETS_BUCKET"]) || "label-render-assets").trim() ||
  "label-render-assets";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type StorageAuthCandidate = {
  apiKey: string;
  bearer: string;
  source: string;
};
const dedupeStorageAuthCandidates = (candidates: Array<StorageAuthCandidate | null | undefined>) => {
  const out: StorageAuthCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const apiKey = String(candidate.apiKey || "").trim();
    const bearer = String(candidate.bearer || "").trim();
    if (!apiKey || !bearer) continue;
    const key = `${apiKey}::${bearer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ apiKey, bearer, source: candidate.source });
  }
  return out;
};
const STORAGE_AUTH_CANDIDATES = dedupeStorageAuthCandidates([
  SUPABASE_ANON_KEY && EDGE_DB_JWT
    ? { apiKey: SUPABASE_ANON_KEY, bearer: EDGE_DB_JWT, source: "EDGE_DB_JWT+SUPABASE_ANON_KEY" }
    : null,
  SUPABASE_STORAGE_SERVICE_KEY
    ? {
      apiKey: SUPABASE_STORAGE_SERVICE_KEY,
      bearer: SUPABASE_STORAGE_SERVICE_KEY,
      source: "LABEL_RENDERER_STORAGE_TOKEN",
    }
    : null,
  SUPABASE_STORAGE_SERVICE_KEY && LEGACY_SUPABASE_SERVICE_ROLE_KEY
    ? {
      apiKey: SUPABASE_STORAGE_SERVICE_KEY,
      bearer: LEGACY_SUPABASE_SERVICE_ROLE_KEY,
      source: "SUPABASE_SERVICE_ROLE_KEY",
    }
    : null,
  LEGACY_SUPABASE_SERVICE_ROLE_KEY
    ? {
      apiKey: LEGACY_SUPABASE_SERVICE_ROLE_KEY,
      bearer: LEGACY_SUPABASE_SERVICE_ROLE_KEY,
      source: "LEGACY_SERVICE_ROLE_DIRECT",
    }
    : null,
  SUPABASE_STORAGE_SERVICE_KEY && SUPABASE_SERVICE_OR_EDGE_KEY
    ? {
      apiKey: SUPABASE_STORAGE_SERVICE_KEY,
      bearer: SUPABASE_SERVICE_OR_EDGE_KEY,
      source: "LABEL_RENDERER_TOKEN_FALLBACK",
    }
    : null,
]);
const SETTINGS_AUTH_CANDIDATES = dedupeStorageAuthCandidates([
  SUPABASE_ANON_KEY && EDGE_DB_JWT
    ? { apiKey: SUPABASE_ANON_KEY, bearer: EDGE_DB_JWT, source: "EDGE_DB_JWT+SUPABASE_ANON_KEY" }
    : null,
  SUPABASE_SERVICE_OR_EDGE_KEY
    ? {
      apiKey: SUPABASE_SERVICE_OR_EDGE_KEY,
      bearer: SUPABASE_SERVICE_OR_EDGE_KEY,
      source: "LABEL_RENDERER_TOKEN",
    }
    : null,
  SUPABASE_SERVICE_OR_EDGE_KEY && LEGACY_SUPABASE_SERVICE_ROLE_KEY
    ? {
      apiKey: SUPABASE_SERVICE_OR_EDGE_KEY,
      bearer: LEGACY_SUPABASE_SERVICE_ROLE_KEY,
      source: "SUPABASE_SERVICE_ROLE_KEY_FALLBACK",
    }
    : null,
  LEGACY_SUPABASE_SERVICE_ROLE_KEY
    ? {
      apiKey: LEGACY_SUPABASE_SERVICE_ROLE_KEY,
      bearer: LEGACY_SUPABASE_SERVICE_ROLE_KEY,
      source: "LEGACY_SERVICE_ROLE_DIRECT",
    }
    : null,
]);
const STORAGE_API_BASE = SUPABASE_URL ? `${SUPABASE_URL.replace(/\/+$/, "")}/storage/v1` : "";

const buildLabelOutputFilePath = (organizationId: string, jobId: string) =>
  `${organizationId}/labels/${jobId}.pdf`;

const normalizeBundleFilePathCandidate = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const pathname = decodeURIComponent(parsed.pathname || "");
    const signMarker = `/storage/v1/object/sign/${LABEL_BUCKET}/`;
    const publicMarker = `/storage/v1/object/public/${LABEL_BUCKET}/`;
    if (pathname.includes(signMarker)) {
      const index = pathname.indexOf(signMarker);
      const slice = pathname.slice(index + signMarker.length);
      return slice.length > 0 ? slice : null;
    }
    if (pathname.includes(publicMarker)) {
      const index = pathname.indexOf(publicMarker);
      const slice = pathname.slice(index + publicMarker.length);
      return slice.length > 0 ? slice : null;
    }
    return pathname.startsWith("/") ? pathname.slice(1) : pathname;
  } catch (_err) {
    return trimmed;
  }
};

const dedupeBundleTargets = (targets: BundleTarget[]): BundleTarget[] => {
  const seen = new Set<string>();
  const deduped: BundleTarget[] = [];
  for (const target of targets) {
    const normalizedFilePath = normalizeBundleFilePathCandidate(target.fileUrl ?? null);
    const key =
      normalizedFilePath ??
      [
        target.labelId ?? "",
        target.shipmentId ?? "",
        target.shipmentBoxId ?? "",
        target.targetType ?? "",
        target.targetId ?? "",
        target.targetBoxId ?? "",
      ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(
      normalizedFilePath
        ? {
            ...target,
            fileUrl: normalizedFilePath,
          }
        : target,
    );
  }
  return deduped;
};

const TARGET_TYPE_ALIASES: Record<string, string> = {
  shipment: "shipment",
  shipments: "shipment",
  route: "route_run",
  route_run: "route_run",
  route_runs: "route_run",
  "route-run": "route_run",
  container: "handling_unit",
  handling_unit: "handling_unit",
  handling_units: "handling_unit",
  "handling-unit": "handling_unit",
  transfer: "warehouse_transfer",
  branch_transfer: "warehouse_transfer",
  branch_transfers: "warehouse_transfer",
  warehouse_transfer: "warehouse_transfer",
  warehouse_transfers: "warehouse_transfer",
};

const TARGET_LABEL_DEFAULTS: Record<string, string> = {
  shipment: "shipping",
  route_run: "route",
  handling_unit: "container",
  warehouse_transfer: "transfer",
};

const normalizeLabelTargetType = (value: unknown): string | null => {
  const raw = normalizeString(value);
  if (!raw) return null;
  const normalized = raw.toLowerCase().trim().replace(/\s+/g, "_").replace(/-/g, "_");
  return TARGET_TYPE_ALIASES[normalized] ?? normalized;
};

const defaultLabelTypeForTargetType = (targetType: string | null): string => {
  if (!targetType) return "shipping";
  return TARGET_LABEL_DEFAULTS[targetType] ?? targetType;
};

if (!SUPABASE_URL || (!SUPABASE_SERVICE_OR_EDGE_KEY && !(SUPABASE_ANON_KEY && EDGE_DB_JWT))) {
  logRenderer("error", "supabase_config_missing");
}
if (!SUPABASE_URL || STORAGE_AUTH_CANDIDATES.length === 0) {
  logRenderer("error", "storage_config_missing");
}

let supabase = null as ReturnType<typeof createClient> | null;
if (SUPABASE_URL) {
  if (SUPABASE_ANON_KEY && EDGE_DB_JWT) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      db: { schema: "api" },
      global: { headers: { Authorization: `Bearer ${EDGE_DB_JWT}` } },
    });
  } else if (!EDGE_REQUIRE_DB_JWT && SUPABASE_SERVICE_OR_EDGE_KEY) {
    logRenderer("warn", "database_jwt_fallback");
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_OR_EDGE_KEY, {
      auth: { persistSession: false },
      db: { schema: "api" },
    });
  }
}

let serviceSupabase = null as ReturnType<typeof createClient> | null;
if (SUPABASE_URL && SUPABASE_SERVICE_OR_EDGE_KEY) {
  serviceSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_OR_EDGE_KEY, {
    auth: { persistSession: false },
    db: { schema: "api" },
  });
}

if (!supabase && EDGE_REQUIRE_DB_JWT) {
  logRenderer("error", "required_database_jwt_missing");
}
if (!STORAGE_API_BASE || STORAGE_AUTH_CANDIDATES.length === 0) {
  logRenderer("error", "storage_service_key_missing");
}

type IntegrationContext =
  | {
    kind: "source";
    organizationId: string;
    clientId: string | null;
    sourceId: string;
    senderId: string | null;
  }
  | {
    kind: "provider";
    providerName: string;
  };

type SettingsScope = {
  scopeType: "global" | "tenant" | "client" | "sender" | "source";
  scopeId: string | null;
};

const assetCache = new AssetCache();
const bucketHealth = {
  state: "unknown" as "unknown" | "ok" | "error",
  checkedAt: 0,
  message: "",
};
const BUCKET_HEALTH_TTL_OK = 5 * 60 * 1000;
const BUCKET_HEALTH_TTL_ERROR = 60 * 1000;

const ensureSupabase = () => {
  if (!supabase) {
    throw new Error(
      EDGE_REQUIRE_DB_JWT
        ? "Supabase client not initialised. Provide SUPABASE_URL + SUPABASE_ANON_KEY + LABEL_RENDERER_DB_JWT (EDGE_REQUIRE_DB_JWT=1)."
        : "Supabase client not initialised. Provide LABEL_RENDERER_DB_JWT (preferred) or LABEL_RENDERER_TOKEN/service role key.",
    );
  }
  return supabase;
};

const resolveSettingsClients = () => {
  const clients: Array<ReturnType<typeof createClient>> = [];
  if (supabase) clients.push(supabase);
  if (serviceSupabase && serviceSupabase !== supabase) clients.push(serviceSupabase);
  return clients;
};

type RpcResult<T> = {
  data: T | null;
  error: string | null;
};

const parseRpcErrorBody = async (response: Response): Promise<string> => {
  const raw = String(await response.text().catch(() => "") || "").trim();
  if (!raw) return `${response.status} ${response.statusText}`.trim();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const message =
      (typeof parsed.message === "string" && parsed.message) ||
      (typeof parsed.error === "string" && parsed.error) ||
      (typeof parsed.details === "string" && parsed.details) ||
      "";
    return message || raw;
  } catch (_err) {
    return raw;
  }
};

const parseRpcSuccessBody = async <T>(response: Response): Promise<T | null> => {
  const raw = String(await response.text().catch(() => "") || "").trim();
  if (!raw) return null;
  return JSON.parse(raw) as T;
};

const callRpcViaClient = async <T>(
  client: ReturnType<typeof createClient>,
  rpcName: string,
  payload: Record<string, unknown>,
): Promise<RpcResult<T>> => {
  try {
    const { data, error } = await client.rpc(rpcName, payload);
    if (error) {
      return { data: null, error: error.message || `RPC ${rpcName} failed` };
    }
    return { data: (data as T | null | undefined) ?? null, error: null };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

const callRpcViaPublicRest = async <T>(
  rpcName: string,
  payload: Record<string, unknown>,
): Promise<RpcResult<T>> => {
  const base = SUPABASE_URL ? SUPABASE_URL.replace(/\/+$/, "") : "";
  if (!base || SETTINGS_AUTH_CANDIDATES.length === 0) {
    return { data: null, error: `RPC ${rpcName} failed: missing Supabase URL/auth candidates` };
  }

  let lastError = "";
  for (const candidate of SETTINGS_AUTH_CANDIDATES) {
    try {
      const response = await fetch(`${base}/rest/v1/rpc/${rpcName}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept-profile": "public",
          apikey: candidate.apiKey,
          authorization: `Bearer ${candidate.bearer}`,
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        lastError = await parseRpcErrorBody(response);
        continue;
      }
      const parsed = await parseRpcSuccessBody<T>(response);
      return { data: parsed, error: null };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return { data: null, error: lastError || `RPC ${rpcName} failed via public REST fallback` };
};

const callRpcWithPublicFallback = async <T>(
  rpcName: string,
  payload: Record<string, unknown>,
): Promise<RpcResult<T>> => {
  let lastError = "";
  for (const client of resolveSettingsClients()) {
    const result = await callRpcViaClient<T>(client, rpcName, payload);
    if (!result.error) return result;
    lastError = result.error;
  }

  const restResult = await callRpcViaPublicRest<T>(rpcName, payload);
  if (!restResult.error) return restResult;
  return { data: null, error: restResult.error || lastError || `RPC ${rpcName} failed` };
};

type StorageErrorLike = { message: string };
type StorageResult<T> = { data: T | null; error: StorageErrorLike | null };

const toStorageError = (error: unknown): StorageErrorLike => ({
  message: error instanceof Error ? error.message : String(error),
});

const isStorageAuthFailure = (status: number, message: string) => {
  if (![400, 401, 403].includes(Number(status || 0))) return false;
  const text = String(message || "").toLowerCase();
  return (
    text.includes("signature verification failed") ||
    text.includes("invalid compact jws") ||
    text.includes("invalid jwt") ||
    text.includes("unauthorized")
  );
};

const parseStorageErrorMessage = (status: number, statusText: string, bodyText: string) => {
  const raw = String(bodyText || "").trim();
  if (!raw) return statusText || `status ${status}`;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const message =
      (typeof parsed.message === "string" && parsed.message) ||
      (typeof parsed.error === "string" && parsed.error) ||
      (typeof parsed.details === "string" && parsed.details) ||
      "";
    return message || raw;
  } catch (_err) {
    return raw;
  }
};

const normalizeSignedStorageUrl = (value: string) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = SUPABASE_URL ? SUPABASE_URL.replace(/\/+$/, "") : "";
  if (!base) return raw;
  if (raw.startsWith("/storage/v1/")) return `${base}${raw}`;
  if (raw.startsWith("/")) return `${base}/storage/v1${raw}`;
  return `${base}/storage/v1/${raw.replace(/^\/+/, "")}`;
};

const encodeStoragePath = (path: string) =>
  String(path || "")
    .replace(/^\/+/, "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const storageFetchWithAuthFallback = async (path: string, init: RequestInit): Promise<Response> => {
  if (!STORAGE_API_BASE || STORAGE_AUTH_CANDIDATES.length === 0) {
    throw new Error(
      "Supabase storage client not initialised. Provide LABEL_RENDERER_DB_JWT+SUPABASE_ANON_KEY or LABEL_RENDERER_STORAGE_TOKEN.",
    );
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${STORAGE_API_BASE}${normalizedPath}`;
  let lastAuthError = "";
  for (const candidate of STORAGE_AUTH_CANDIDATES) {
    const headers = new Headers(init.headers || {});
    headers.set("apikey", candidate.apiKey);
    headers.set("authorization", `Bearer ${candidate.bearer}`);

    const response = await fetch(url, { ...init, headers });
    if (response.ok) return response;

    const bodyText = await response.text();
    const message = parseStorageErrorMessage(response.status, response.statusText, bodyText);
    if (STORAGE_AUTH_CANDIDATES.length > 1 && isStorageAuthFailure(response.status, message)) {
      lastAuthError = message;
      continue;
    }
    throw new Error(message || `Storage request failed (${response.status})`);
  }

  throw new Error(
    lastAuthError || "Storage authentication failed for all configured bearer candidates.",
  );
};

const storageGetBucket = async (bucket: string): Promise<StorageResult<Record<string, unknown>>> => {
  try {
    const response = await storageFetchWithAuthFallback(`/bucket/${encodeURIComponent(bucket)}`, {
      method: "GET",
    });
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") {
      return { data: null, error: { message: `Label bucket ${bucket} not found` } };
    }
    return { data: payload, error: null };
  } catch (error) {
    return { data: null, error: toStorageError(error) };
  }
};

const storageDownloadObject = async (bucket: string, path: string): Promise<StorageResult<Blob>> => {
  try {
    const response = await storageFetchWithAuthFallback(
      `/object/${encodeURIComponent(bucket)}/${encodeStoragePath(path)}`,
      { method: "GET" },
    );
    return { data: await response.blob(), error: null };
  } catch (error) {
    return { data: null, error: toStorageError(error) };
  }
};

const storageUploadObject = async (
  bucket: string,
  path: string,
  body: Blob,
  options: { contentType?: string; upsert?: boolean } = {},
): Promise<StorageResult<null>> => {
  try {
    const headers = new Headers();
    if (options.contentType) headers.set("content-type", options.contentType);
    if (options.upsert) headers.set("x-upsert", "true");
    await storageFetchWithAuthFallback(
      `/object/${encodeURIComponent(bucket)}/${encodeStoragePath(path)}`,
      { method: "PUT", headers, body },
    );
    return { data: null, error: null };
  } catch (error) {
    return { data: null, error: toStorageError(error) };
  }
};

const storageCreateSignedUrls = async (
  bucket: string,
  paths: string[],
  expiresSeconds: number,
): Promise<StorageResult<Array<Record<string, unknown>>>> => {
  const deduped = Array.from(
    new Set(
      (Array.isArray(paths) ? paths : [])
        .map((path) => String(path || "").trim())
        .filter((path) => path.length > 0),
    ),
  );
  if (deduped.length === 0) return { data: [], error: null };

  try {
    const response = await storageFetchWithAuthFallback(`/object/sign/${encodeURIComponent(bucket)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expiresIn: Math.max(1, Math.floor(Number(expiresSeconds) || 0)),
        paths: deduped,
      }),
    });

    const payload = await response.json().catch(() => null);
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as Record<string, unknown> | null)?.data)
        ? ((payload as Record<string, unknown>).data as unknown[])
        : payload && typeof payload === "object"
          ? [payload]
          : [];
    const fallbackPath = deduped.length === 1 ? deduped[0] : "";

    const normalized = rows
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const record = { ...(row as Record<string, unknown>) };
        const resolvedPath =
          (typeof record.path === "string" && record.path) ||
          (typeof record.name === "string" && record.name) ||
          (typeof record.filePath === "string" && record.filePath) ||
          (typeof record.file_path === "string" && record.file_path) ||
          fallbackPath ||
          "";
        const rawSignedUrl =
          (typeof record.signedUrl === "string" && record.signedUrl) ||
          (typeof record.signedURL === "string" && record.signedURL) ||
          (typeof record.signed_url === "string" && record.signed_url) ||
          (typeof record.url === "string" && record.url) ||
          "";
        const normalizedSignedUrl = normalizeSignedStorageUrl(rawSignedUrl);
        if (resolvedPath) record.path = resolvedPath;
        if (normalizedSignedUrl) {
          record.signedUrl = normalizedSignedUrl;
          if (!("signedURL" in record)) record.signedURL = normalizedSignedUrl;
        }
        return record;
      })
      .filter((row): row is Record<string, unknown> => !!row);
    return { data: normalized, error: null };
  } catch (error) {
    return { data: null, error: toStorageError(error) };
  }
};

const storageCreateSignedUrl = async (
  bucket: string,
  path: string,
  expiresSeconds: number,
): Promise<StorageResult<Record<string, unknown>>> => {
  const result = await storageCreateSignedUrls(bucket, [path], expiresSeconds);
  if (result.error) return { data: null, error: result.error };
  const first = Array.isArray(result.data) ? result.data[0] : null;
  if (!first) return { data: null, error: { message: "Missing signed url" } };
  const rowError = typeof first.error === "string" ? first.error.trim() : "";
  if (rowError) return { data: null, error: { message: rowError } };
  return { data: first, error: null };
};

const createUserClient = (token: string) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Supabase anon credentials missing");
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: "api" },
    global: { headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY } },
    accessToken: async () => token,
  });
};

const assertLabelBucketAvailable = async () => {
  const now = Date.now();
  if (bucketHealth.state === "ok" && now - bucketHealth.checkedAt < BUCKET_HEALTH_TTL_OK) return;
  if (bucketHealth.state === "error" && now - bucketHealth.checkedAt < BUCKET_HEALTH_TTL_ERROR) {
    throw new Error(bucketHealth.message || `Label bucket ${LABEL_BUCKET} unavailable`);
  }

  try {
    const { data, error } = await storageGetBucket(LABEL_BUCKET);
    if (error || !data) {
      const msg = `Label bucket ${LABEL_BUCKET} not available: ${error?.message ?? "missing bucket"}`;
      bucketHealth.state = "error";
      bucketHealth.checkedAt = now;
      bucketHealth.message = msg;
      throw new Error(msg);
    }
    bucketHealth.state = "ok";
    bucketHealth.checkedAt = now;
    bucketHealth.message = "";
  } catch (err) {
    const msg = err instanceof Error ? err.message : `Label bucket ${LABEL_BUCKET} check failed`;
    bucketHealth.state = "error";
    bucketHealth.checkedAt = now;
    bucketHealth.message = msg;
    throw new Error(msg);
  }
};

const emitMetric = async (
  name: string,
  labels: Record<string, string | number | null | undefined>,
  extra?: Record<string, unknown>,
) => {
  const payload = {
    metric: name,
    labels: Object.fromEntries(
      Object.entries(labels || {}).map(([k, v]) => [k, v === null || v === undefined ? "null" : String(v)]),
    ),
    data: extra ?? {},
    ts: new Date().toISOString(),
  };

  const metricRow = {
    metric: payload.metric,
    labels: payload.labels,
    data: payload.data,
  };

  let lastError = "";
  for (const client of resolveSettingsClients()) {
    try {
      const { error } = await client.from("metrics_webhook_events").insert(metricRow);
      if (!error) return;
      lastError = error.message || "metrics insert failed";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  const base = SUPABASE_URL ? SUPABASE_URL.replace(/\/+$/, "") : "";
  if (!base) return;

  for (const candidate of SETTINGS_AUTH_CANDIDATES) {
    try {
      const response = await fetch(`${base}/rest/v1/metrics_webhook_events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-profile": "public",
          prefer: "return=minimal",
          apikey: candidate.apiKey,
          authorization: `Bearer ${candidate.bearer}`,
        },
        body: JSON.stringify(metricRow),
      });
      if (response.ok) return;
      lastError = await parseRpcErrorBody(response);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  if (lastError) {
    logRenderer("warn", "metric_insert_failed", { metric: payload.metric, error: lastError });
  }
};

const runBestEffortBackgroundTask = (
  label: string,
  task: () => Promise<unknown>,
) => {
  const promise = Promise.resolve().then(task);
  const edgeRuntime = (globalThis as any).EdgeRuntime;
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(promise);
    return;
  }
  promise.catch((error) => {
    logRenderer("warn", "background_task_failed", { task: label, error });
  });
};

const INTERNAL_INTEGRATION: IntegrationContext = { kind: "provider", providerName: "internal_renderer" };

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};
const parseRequest = async (req: Request): Promise<any> => {
  if (req.method !== "POST") {
    throw new Error("Method not allowed. Use POST.");
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {};
  }

  try {
    return await req.json();
  } catch (_err) {
    return {};
  }
};

const fetchAsset = async (path: string, refresh = false): Promise<Uint8Array | null> => {
  if (!path) return null;
  if (refresh) assetCache.delete(path);
  const cached = assetCache.get(path);
  if (cached) return cached;

  try {
    const { data, error } = await storageDownloadObject(ASSET_BUCKET, path);
    if (error || !data) {
      logRenderer("warn", "template_asset_download_failed", { error });
      return null;
    }
    const bytes = new Uint8Array(await data.arrayBuffer());
    assetCache.set(path, bytes);
    return bytes;
  } catch (err) {
    logRenderer("warn", "template_asset_download_failed", { error: err });
    return null;
  }
};

const resolveTemplateSnapshot = (composed: Record<string, any>): TemplateSnapshot | null => {
  const snapshot = composed?.job?.template;
  if (!snapshot || typeof snapshot !== "object") return null;

  const rendererConfig = snapshot.renderer_config ?? snapshot.rendererConfig;
  if (!rendererConfig || typeof rendererConfig !== "object") return null;

  const schemaVersionRaw = snapshot.schema_version ?? snapshot.schemaVersion ?? 1;
  const schemaVersionNumeric = Number(schemaVersionRaw);
  const schemaVersion = Number.isFinite(schemaVersionNumeric) ? schemaVersionNumeric : 1;

  const assetRefs: TemplateAsset[] = [];
  if (Array.isArray(rendererConfig.assets)) {
    for (const asset of rendererConfig.assets) {
      if (asset && typeof asset === "object" && asset.path) {
        assetRefs.push(asset as TemplateAsset);
      }
    }
  }
  if (Array.isArray(snapshot.asset_refs)) {
    for (const asset of snapshot.asset_refs) {
      if (asset && typeof asset === "object" && asset.path) {
        assetRefs.push(asset as TemplateAsset);
      }
    }
  }

  return {
    template_id: snapshot.template_id ?? snapshot.templateId ?? undefined,
    template_key: snapshot.template_key ?? snapshot.templateKey ?? undefined,
    template_version: snapshot.template_version ?? snapshot.templateVersion ?? undefined,
    renderer_config: rendererConfig as TemplateRendererConfig,
    asset_refs: assetRefs,
    label_config: snapshot.label_config ?? snapshot.labelConfig ?? undefined,
    schema_version: schemaVersion,
  };
};

const asRecord = (value: unknown): Record<string, any> | null => {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, any>;
};

const resolveSettingsScope = (
  integration: IntegrationContext | null,
  organizationId?: string | null,
  clientId?: string | null,
  senderId?: string | null,
): SettingsScope => {
  if (integration?.kind === "source") {
    return { scopeType: "source", scopeId: integration.sourceId };
  }
  if (senderId) {
    return { scopeType: "sender", scopeId: senderId };
  }
  if (clientId) {
    return { scopeType: "client", scopeId: clientId };
  }
  if (organizationId) {
    return { scopeType: "tenant", scopeId: organizationId };
  }
  return { scopeType: "global", scopeId: null };
};

const fetchMergedSettings = async (category: string, scope: SettingsScope | null): Promise<Record<string, any> | null> => {
  const result = await callRpcWithPublicFallback<Record<string, any>>("resolve_settings_merged", {
    p_category: category,
    p_scope_type: scope?.scopeType ?? "global",
    p_scope_id: scope?.scopeId ?? null,
  });
  if (result.error || !result.data || typeof result.data !== "object") {
    return null;
  }
  return result.data;
};

const resolveRendererDefaults = async (
  integration: IntegrationContext | null,
  organizationId?: string | null,
  clientId?: string | null,
  senderId?: string | null,
): Promise<Record<string, any> | null> => {
  const scope = resolveSettingsScope(integration, organizationId, clientId, senderId);
  return fetchMergedSettings("renderer_defaults", scope);
};

const resolveLabelPrintPolicy = async (
  integration: IntegrationContext | null,
  organizationId: string | null,
  clientId?: string | null,
  senderId?: string | null,
): Promise<Record<string, any> | null> => {
  if (!organizationId) return null;
  const scope = resolveSettingsScope(integration, organizationId, clientId, senderId);
  return fetchMergedSettings("label_print_policy", scope);
};

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const readBooleanSetting = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
};

type BundleReturnMode = "file_path_only" | "signed_url";

const resolveBundleReturnMode = (
  policy: Record<string, any> | null,
  workflowOwned: boolean,
): BundleReturnMode => {
  const configured = normalizeString(policy?.print_sync_bundle_return_mode)?.toLowerCase();
  if (configured === "file_path_only" || configured === "signed_url") {
    return configured;
  }
  return workflowOwned ? "file_path_only" : "signed_url";
};

const resolveArtifactReturn = async (
  filePath: string,
  expiresSeconds: number,
  returnMode: BundleReturnMode,
) => {
  let signedUrl: string | null = null;
  let expiresAt: string | null = null;
  let signedMs = 0;
  if (returnMode === "signed_url") {
    const signedStart = performance.now();
    try {
      const { data: signedData, error: signedError } = await storageCreateSignedUrl(
        LABEL_BUCKET,
        filePath,
        expiresSeconds,
      );
      if (signedError) {
        logRenderer("warn", "artifact_url_signing_failed", { error: signedError });
      } else if (signedData) {
        const signedRecord = signedData as Record<string, unknown>;
        signedUrl =
          (signedRecord.signedUrl as string | undefined) ??
          (signedRecord.signedURL as string | undefined) ??
          (signedRecord.url as string | undefined) ??
          null;
        if (signedUrl) signedUrl = projectSignedStorageUrlForResponse(
          normalizeSignedStorageUrl(signedUrl),
          SUPABASE_URL,
          PUBLIC_SUPABASE_URL,
        );
        expiresAt =
          (signedRecord.expires_at as string | undefined) ??
          (signedRecord.expiration as string | undefined) ??
          null;
      }
    } catch (err) {
      logRenderer("warn", "artifact_url_signing_failed", { error: err });
    }
    signedMs = performance.now() - signedStart;
    if (!expiresAt && expiresSeconds > 0) {
      expiresAt = new Date(Date.now() + expiresSeconds * 1000).toISOString();
    }
  }
  return {
    file_path: filePath,
    file_url: filePath,
    signed_url: signedUrl,
    expires_at: expiresAt,
    signed_ms: Math.round(signedMs),
  };
};

const persistBundleArtifact = async (options: {
  filePath: string;
  outputName: string;
  bytes: Uint8Array;
  expiresSeconds: number;
  returnMode: BundleReturnMode;
}) => {
  const file = new File([options.bytes], options.outputName, { type: "application/pdf" });
  const uploadStart = performance.now();
  const { error: uploadError } = await storageUploadObject(LABEL_BUCKET, options.filePath, file, {
    contentType: "application/pdf",
    upsert: true,
  });
  const uploadMs = performance.now() - uploadStart;
  if (uploadError) {
    throw uploadError;
  }
  const artifactReturn = await resolveArtifactReturn(
    options.filePath,
    options.expiresSeconds,
    options.returnMode,
  );
  return {
    ...artifactReturn,
    upload_ms: Math.round(uploadMs),
    file_size_bytes: options.bytes.byteLength,
  };
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const normalizeUuid = (value: unknown): string | undefined => {
  const normalized = normalizeString(value);
  if (!normalized || !UUID_REGEX.test(normalized)) return undefined;
  return normalized;
};

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
};

type WorkflowStepProgress = {
  workflowRunId: string;
  workflowRunStepId: string;
  enabled: boolean;
  budgetMs: number;
  maxSteps: number;
};

const resolveWorkflowProgress = (
  requestInput: WorkflowProgressRequest | null,
): WorkflowStepProgress | null => {
  if (!requestInput || typeof requestInput !== "object") return null;
  const metadata = asRecord(requestInput.metadata);
  const workflowMeta = asRecord(metadata?.workflow);
  const workflowRunId =
    normalizeUuid(requestInput.workflow_run_id) ??
    normalizeUuid(metadata?.workflow_run_id) ??
    normalizeUuid(workflowMeta?.workflow_run_id);
  const workflowRunStepId =
    normalizeUuid(requestInput.workflow_run_step_id) ??
    normalizeUuid(metadata?.workflow_run_step_id) ??
    normalizeUuid(workflowMeta?.workflow_run_step_id);
  if (!workflowRunId || !workflowRunStepId) return null;
  const enabled = readBooleanSetting(
    requestInput.workflow_progress_enabled ??
      metadata?.workflow_progress_enabled ??
      workflowMeta?.progress_enabled,
    true,
  );
  return {
    workflowRunId,
    workflowRunStepId,
    enabled,
    budgetMs: clampInteger(
      requestInput.workflow_progress_budget_ms ??
        metadata?.workflow_progress_budget_ms ??
        workflowMeta?.progress_budget_ms,
      1200,
      25,
      5000,
    ),
    maxSteps: clampInteger(
      requestInput.workflow_progress_max_steps ??
        metadata?.workflow_progress_max_steps ??
        workflowMeta?.progress_max_steps,
      10,
      1,
      50,
    ),
  };
};

const deliverWorkflowStepResult = async (
  requestInput: WorkflowProgressRequest | null,
  operationResult: Record<string, unknown>,
  logLabel: string,
) => {
  const workflowProgress = resolveWorkflowProgress(requestInput);
  if (!workflowProgress || !workflowProgress.enabled) return null;

  const client = ensureSupabase();
  const { data, error } = await client.rpc("progress_workflow_run_step_result_v1", {
    p_workflow_run_id: workflowProgress.workflowRunId,
    p_workflow_run_step_id: workflowProgress.workflowRunStepId,
    p_operation_result: operationResult,
    p_budget_ms: workflowProgress.budgetMs,
    p_max_steps: workflowProgress.maxSteps,
  });
  if (error) {
    logRenderer("warn", "workflow_progress_failed", {
      operation: logLabel,
      workflow_run_id: workflowProgress.workflowRunId,
      workflow_run_step_id: workflowProgress.workflowRunStepId,
      error,
    });
    return null;
  }
  return data ?? null;
};

const deliverBundleWorkflowResult = async (
  bundleInput: BundleRequest | null,
  bundleResult: Record<string, unknown>,
) => {
  const bundlePayload = {
    ...(bundleResult || {}),
    status:
      normalizeString(bundleResult?.status) ??
      (normalizeString(bundleResult?.error) ? "failed" : "ok"),
  };
  return await deliverWorkflowStepResult(
    bundleInput,
    {
      status: bundlePayload.status === "failed" ? "failed" : "completed",
      source: "label_renderer_bundle_callback",
      bundle: bundlePayload,
    },
    "bundle",
  );
};

const deliverPrintWorkflowResult = async (
  printInput: PrintRequest | null,
  printResult: Record<string, unknown>,
) => {
  const executePayload = {
    ...(printResult || {}),
    status:
      normalizeString(printResult?.status) ??
      (normalizeString(printResult?.error) ? "failed" : "ok"),
  };
  const bundlePayload = asRecord(executePayload.bundle);
  return await deliverWorkflowStepResult(
    printInput,
    {
      status: executePayload.status === "failed" ? "failed" : "completed",
      source: "label_renderer_print_callback",
      print_mode: normalizeString(executePayload.mode) ?? "print_sync",
      artifact_kind:
        normalizeString(executePayload.artifact_kind) ??
        normalizeString(bundlePayload?.artifact_kind) ??
        null,
      execute: executePayload,
      bundle: bundlePayload ?? null,
    },
    "print",
  );
};

const scheduleBundleWorkflowResult = (
  bundleInput: BundleRequest | null,
  bundleResult: Record<string, unknown>,
) => {
  runBestEffortBackgroundTask("label_renderer.bundle_workflow_result", async () => {
    await deliverBundleWorkflowResult(bundleInput, bundleResult);
  });
};

const schedulePrintWorkflowResult = (
  printInput: PrintRequest | null,
  printResult: Record<string, unknown>,
) => {
  runBestEffortBackgroundTask("label_renderer.print_workflow_result", async () => {
    await deliverPrintWorkflowResult(printInput, printResult);
  });
};

const scheduleMetricEmit = (
  name: string,
  labels: Record<string, string | number | null | undefined>,
  extra?: Record<string, unknown>,
) => {
  runBestEffortBackgroundTask(`metric:${name}`, async () => {
    await emitMetric(name, labels, extra);
  });
};

const prepareDesignerPreviewSnapshot = async (
  template: Record<string, any>,
  labelType: string,
  orgId: string,
): Promise<{
  snapshot: TemplateSnapshot;
  assetsMissingRefs: string[];
  assetsUnknownRefs: string[];
}> => {
  const page = asRecord(template?.page) ?? {};
  const rawAssets = Array.isArray(template?.assets)
    ? template.assets.filter((asset: any) => asset && typeof asset === "object")
    : [];
  const rawBlocks = Array.isArray(template?.blocks)
    ? template.blocks.filter((block: any) => block && typeof block === "object")
    : [];

  const assetKeySet = new Set<string>();
  rawAssets.forEach((asset: any) => {
    const name = normalizeString(asset?.name);
    const path = normalizeString(asset?.path);
    if (name) assetKeySet.add(name);
    if (path) assetKeySet.add(path);
  });

  const missingKeySet = new Set<string>();
  const missingRefs = new Set<string>();
  const unknownRefs = new Set<string>();
  const dropKeys = new Set<string>();

  const isAllowedPath = (path: string) => {
    const normalized = path.trim();
    return (
      normalized.startsWith(`${orgId}/`) ||
      normalized.startsWith("fonts/") ||
      normalized.startsWith("global/")
    );
  };

  for (const asset of rawAssets) {
    const name = normalizeString(asset?.name);
    const path = normalizeString(asset?.path);
    const display = name ?? path ?? "";
    if (path && !isAllowedPath(path)) {
      if (display) unknownRefs.add(display);
      if (name) dropKeys.add(name);
      if (path) dropKeys.add(path);
      continue;
    }
    if (!path) {
      if (display) missingRefs.add(display);
      if (name) missingKeySet.add(name);
      continue;
    }
    // Designer uploads overwrite existing keys, so previews must refresh the
    // organization's mutable assets before the rendering pass reuses them.
    const bytes = await fetchAsset(path, path.startsWith(`${orgId}/`));
    if (!bytes) {
      if (display) missingRefs.add(display);
      if (name) missingKeySet.add(name);
      missingKeySet.add(path);
      dropKeys.add(path);
    }
  }

  for (const key of missingKeySet) dropKeys.add(key);

  const filteredBlocks = rawBlocks.filter((block: any) => {
    if (block.type !== "image") return true;
    const ref = normalizeString(block.asset_ref ?? block.value_path);
    if (!ref) return false;
    if (!assetKeySet.has(ref)) {
      unknownRefs.add(ref);
      return false;
    }
    if (dropKeys.has(ref)) return false;
    return true;
  });

  const filteredAssets = rawAssets.filter((asset: any) => {
    const name = normalizeString(asset?.name);
    const path = normalizeString(asset?.path);
    if (name && dropKeys.has(name)) return false;
    if (path && dropKeys.has(path)) return false;
    return true;
  });

  const rendererConfig: TemplateRendererConfig = {
    page,
    assets: filteredAssets as TemplateAsset[],
    blocks: filteredBlocks as TemplateBlock[],
  };

  const snapshot: TemplateSnapshot = {
    template_key: normalizeString(template?.template_key) ?? labelType,
    template_version: Number.isFinite(Number(template?.template_version))
      ? Number(template?.template_version)
      : undefined,
    renderer_config: rendererConfig,
    asset_refs: filteredAssets as TemplateAsset[],
    schema_version: Number.isFinite(Number(template?.schema_version))
      ? Number(template?.schema_version)
      : undefined,
  };

  return {
    snapshot,
    assetsMissingRefs: Array.from(missingRefs),
    assetsUnknownRefs: Array.from(unknownRefs),
  };
};

const parseColorInput = (input: unknown): { r: number; g: number; b: number } | null => {
  if (typeof input === "string") {
    const hex = input.trim().replace(/^#/, "");
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      if ([r, g, b].every((component) => Number.isFinite(component))) {
        return { r, g, b };
      }
    }
  }

  const record = asRecord(input);
  if (record) {
    const r = Number(record.r);
    const g = Number(record.g);
    const b = Number(record.b);
    if ([r, g, b].every((component) => Number.isFinite(component))) {
      const clamp = (value: number) => Math.min(Math.max(value, 0), 1);
      return { r: clamp(r), g: clamp(g), b: clamp(b) };
    }
  }

  return null;
};

const DEFAULT_BRAND_COLOR = { r: 0.05, g: 0.2, b: 0.45 };

const resolveFallbackBranding = (
  payload: Record<string, any>,
  templateSnapshot?: TemplateSnapshot | null,
  rendererDefaults?: Record<string, any> | null,
): { title: string; color: { r: number; g: number; b: number }; source: string } => {
  const labelConfig = asRecord(templateSnapshot?.label_config ?? templateSnapshot?.labelConfig);
  const metadata = asRecord(labelConfig?.metadata);
  const theme = asRecord(metadata?.theme ?? labelConfig?.theme);
  const targetType = normalizeLabelTargetType(payload?.target?.type ?? payload?.target_type);
  const targetLabel = normalizeString(payload?.target?.label);
  const targetCode = normalizeString(payload?.target?.code);
  const targetTitle =
    targetLabel ??
    targetCode ??
    (targetType ? {
      shipment: "Shipping Label",
      route_run: "Route Label",
      handling_unit: "Container Label",
      warehouse_transfer: "Transfer Label",
    }[targetType] : null);

  const candidates: Array<{ source: string; value?: string }> = [
    { source: "renderer_defaults.title", value: normalizeString(asRecord(rendererDefaults)?.fallback_title) },
    { source: "renderer_defaults.brand_name", value: normalizeString(asRecord(rendererDefaults)?.brand_name) },
    { source: "label_config.fallback_title", value: normalizeString(labelConfig?.fallback_title) },
    { source: "label_config.metadata.fallback_title", value: normalizeString(metadata?.fallback_title) },
    { source: "label_config.metadata.brand_name", value: normalizeString(metadata?.brand_name) },
    { source: "payload.target.label", value: targetLabel },
    { source: "payload.target.code", value: targetCode },
    { source: "payload.target.type", value: targetTitle ?? undefined },
    { source: "payload.sender_brand_name", value: normalizeString(payload.sender_brand_name) },
    { source: "payload.sender_name", value: normalizeString(payload.sender_name) },
    { source: "payload.client_name", value: normalizeString(payload.client_name) },
    { source: "payload.organization_name", value: normalizeString(payload.organization_name) },
  ];

  const chosen = candidates.find((candidate) => candidate.value);
  const title = chosen?.value ?? targetTitle ?? "Shipping Label";

  const color =
    parseColorInput(
      (asRecord(rendererDefaults)?.primary_color as any) ??
      metadata?.primary_color ??
      theme?.primary ??
      labelConfig?.primary_color,
    ) ?? DEFAULT_BRAND_COLOR;

  return {
    title,
    color,
    source: chosen?.source ?? "default",
  };
};

const resolvePathValue = (root: Record<string, any>, path?: string | null): unknown => {
  if (!root || !path || path.trim().length === 0) return undefined;
  const iterator = path.matchAll(/([^[.\]]+)|\[(\d+)\]/g);
  let current: any = root;
  for (const match of iterator) {
    if (current === undefined || current === null) return undefined;
    if (match[1] !== undefined) {
      current = current?.[match[1]];
    } else if (match[2] !== undefined) {
      const index = Number(match[2]);
      current = Array.isArray(current) ? current[index] : undefined;
    }
  }
  return current;
};

const stringifyValue = (value: unknown, fallback?: string): string => {
  if (value === undefined || value === null) {
    return fallback ?? "";
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => (item == null ? "" : String(item))).join(", ");
  }
  return fallback ?? "";
};

const sanitizePdfText = (value: string): string => value.replace(/\uFFFD/g, "?");
const ARABIC_CHAR_RE =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;


const hasArabic = (value: string): boolean => ARABIC_CHAR_RE.test(String(value ?? ""));

const stripNonAscii = (value: string): string =>
  String(value ?? "").replace(/[^\x20-\x7E]/g, "?");

const normalizeBidiDirection = (direction?: string) => {
  const d = String(direction || "").trim().toLowerCase();
  if (d === "rtl") return "rtl";
  if (d === "ltr") return "ltr";
  return undefined;
};

const toBidiVisualOrder = (value: string, direction?: string): string => {
  const input = String(value ?? "");
  if (!input) return input;
  try {
    const levels = bidi.getEmbeddingLevels(input, normalizeBidiDirection(direction));
    return bidi.getReorderedString(input, levels);
  } catch (_err) {
    return input;
  }
};

const resolveEdgeDbMode = (value: unknown): "rest_rpc" | "direct_pooler" =>
  hotpathModeEnabled(value) ? "direct_pooler" : "rest_rpc";

const wrapRpcError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(typeof error === "string" ? error : "rpc failed");

const callRendererRpc = async <T>(
  client: ReturnType<typeof ensureSupabase>,
  functionName: string,
  args: Record<string, unknown>,
  edgeDbMode: "rest_rpc" | "direct_pooler" = "rest_rpc",
): Promise<{ data: T | null; error: Error | null; transport: "rest_rpc" | "direct_pooler" }> => {
  if (edgeDbMode === "direct_pooler") {
    const directResult = await executeHotpathRpc<T>(edgeDbMode, functionName, args);
    if (!directResult.error) {
      return directResult;
    }
    logRenderer("warn", "direct_rpc_fallback", { rpc: functionName, error: directResult.error });
  }

  try {
    const { data, error } = await client.rpc(functionName, args);
    return {
      data: (data as T | null) ?? null,
      error: error ? new Error(error.message) : null,
      transport: "rest_rpc",
    };
  } catch (error) {
    return {
      data: null,
      error: wrapRpcError(error),
      transport: "rest_rpc",
    };
  }
};

const splitRunsByScript = (value: string) => {
  const input = String(value ?? "");
  if (!input) return [];
  const runs: Array<{ text: string; isArabic: boolean }> = [];
  let currentText = "";
  let currentIsArabic: boolean | null = null;
  for (const ch of input) {
    const arabic = hasArabic(ch);
    if (currentIsArabic === null) {
      currentIsArabic = arabic;
      currentText = ch;
      continue;
    }
    if (arabic === currentIsArabic) {
      currentText += ch;
      continue;
    }
    runs.push({ text: currentText, isArabic: currentIsArabic });
    currentIsArabic = arabic;
    currentText = ch;
  }
  runs.push({ text: currentText, isArabic: currentIsArabic ?? false });
  return runs;
};

const reverseByGrapheme = (value: string, locale = "ar"): string => {
  const input = String(value ?? "");
  if (!input) return input;
  try {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      const seg = new Intl.Segmenter(locale, { granularity: "grapheme" });
      const graphemes = Array.from(seg.segment(input), (s) => s.segment);
      graphemes.reverse();
      return graphemes.join("");
    }
  } catch (_err) {
    // Fall back to codepoint reversal.
  }
  return Array.from(input).reverse().join("");
};

const measureBidiVisualWidthWithFallback = (
  visualText: string,
  size: number,
  arabicFont: Awaited<EmbeddedFontPromise> | null,
  latinFont: Awaited<EmbeddedFontPromise> | null,
) => {
  const runs = splitRunsByScript(visualText);
  let total = 0;
  for (const run of runs) {
    if (run.isArabic) {
      const logical = reverseByGrapheme(run.text, "ar");
      if (arabicFont && typeof (arabicFont as any).widthOfTextAtSize === "function") {
        total += (arabicFont as any).widthOfTextAtSize(logical, size);
      }
      continue;
    }
    if (latinFont && typeof (latinFont as any).widthOfTextAtSize === "function") {
      total += (latinFont as any).widthOfTextAtSize(run.text, size);
    }
  }
  return total;
};

const drawBidiVisualRunsWithFallback = (
  page: PdfPage,
  visualText: string,
  opts: {
    x: number;
    y: number;
    size: number;
    arabicFont: Awaited<EmbeddedFontPromise> | null;
    latinFont: Awaited<EmbeddedFontPromise> | null;
    color: ReturnType<typeof rgb>;
    rotate?: ReturnType<typeof degrees>;
  },
) => {
  const { x, y, size, arabicFont, latinFont, color, rotate } = opts;
  const runs = splitRunsByScript(visualText);
  let cursorX = x;
  for (const run of runs) {
    if (run.isArabic) {
      if (!arabicFont) continue;
      const logical = reverseByGrapheme(run.text, "ar");
      page.drawText(logical, { x: cursorX, y, size, font: arabicFont, color, rotate });
      cursorX += (arabicFont as any).widthOfTextAtSize(logical, size);
      continue;
    }
    if (!latinFont) continue;
    page.drawText(run.text, { x: cursorX, y, size, font: latinFont, color, rotate });
    cursorX += (latinFont as any).widthOfTextAtSize(run.text, size);
  }
};

const normalizeColor = (color?: unknown) => {
  const parsed = parseColorInput(color);
  if (!parsed) return rgb(0, 0, 0);
  return rgb(parsed.r, parsed.g, parsed.b);
};

const normalizeOptionalColor = (color?: unknown) => {
  const parsed = parseColorInput(color);
  return parsed ? rgb(parsed.r, parsed.g, parsed.b) : null;
};

// Code128-B patterns (index 0-106). STOP (106) is 13 modules.
const CODE128_PATTERNS: string[] = [
  "11011001100",
  "11001101100",
  "11001100110",
  "10010011000",
  "10010001100",
  "10001001100",
  "10011001000",
  "10011000100",
  "10001100100",
  "11001001000",
  "11001000100",
  "11000100100",
  "10110011100",
  "10011011100",
  "10011001110",
  "10111001100",
  "10011101100",
  "10011100110",
  "11001110010",
  "11001011100",
  "11001001110",
  "11011100100",
  "11001110100",
  "11101101110",
  "11101001100",
  "11100101100",
  "11100100110",
  "11101100100",
  "11100110100",
  "11100110010",
  "11011011000",
  "11011000110",
  "11000110110",
  "10100011000",
  "10001011000",
  "10001000110",
  "10110001000",
  "10001101000",
  "10001100010",
  "11010001000",
  "11000101000",
  "11000100010",
  "10110111000",
  "10110001110",
  "10001101110",
  "10111011000",
  "10111000110",
  "10001110110",
  "11101110110",
  "11010001110",
  "11000101110",
  "11011101000",
  "11011100010",
  "11011101110",
  "11101011000",
  "11101000110",
  "11100010110",
  "11101101000",
  "11101100010",
  "11100011010",
  "11101111010",
  "11001000010",
  "11110001010",
  "10100110000",
  "10100001100",
  "10010110000",
  "10010000110",
  "10000101100",
  "10000100110",
  "10110010000",
  "10110000100",
  "10011010000",
  "10011000010",
  "10000110100",
  "10000110010",
  "11000010010",
  "11001010000",
  "11110111010",
  "11000010100",
  "10001111010",
  "10100111100",
  "10010111100",
  "10010011110",
  "10111100100",
  "10011110100",
  "10011110010",
  "11110100100",
  "11110010100",
  "11110010010",
  "11011011110",
  "11011110110",
  "11110110110",
  "10101111000",
  "10100011110",
  "10001011110",
  "10111101000",
  "10111100010",
  "11110101000",
  "11110100010",
  "10111011110",
  "10111101110",
  "11101011110",
  "11110101110",
  "11010000100",
  "11010010000",
  "11010011100",
  "1100011101011",
];

const encodeCode128B = (value: string): { pattern: string; modules: number } => {
  const codes: number[] = [104]; // START B
  let checksum = 104;

  for (let i = 0; i < value.length; i++) {
    const codePoint = value.charCodeAt(i);
    if (codePoint < 32 || codePoint > 126) {
      throw new TemplateError("render_failure", `Unsupported Code128-B character: ${value[i]}`, {
        char: value[i],
        code_point: codePoint,
      });
    }
    const code = codePoint - 32;
    codes.push(code);
    checksum += code * (i + 1);
  }

  const checksumCode = checksum % 103;
  codes.push(checksumCode);
  codes.push(106); // STOP

  const patterns: string[] = [];
  for (const code of codes) {
    const pattern = CODE128_PATTERNS[code];
    if (!pattern) {
      throw new TemplateError("render_failure", `Invalid Code128 pattern for code ${code}`);
    }
    patterns.push(pattern);
  }

  const patternString = patterns.join("");
  const moduleCount = patternString.length + 20; // include quiet zones (10 modules each side)
  return { pattern: patternString, modules: moduleCount };
};

const normalizeConditionValue = (value: unknown) => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return value;
};

const evaluateRenderCondition = (condition: unknown, payload: Record<string, any>): boolean => {
  const record = asRecord(condition);
  if (!record) return true;
  const path = typeof record.path === "string" ? record.path : null;
  if (!path) return true;

  let current = normalizeConditionValue(resolvePathValue(payload, path));
  if (current === null && Object.prototype.hasOwnProperty.call(record, "default")) {
    current = normalizeConditionValue(record.default);
  }

  if (Object.prototype.hasOwnProperty.call(record, "equals")) {
    return current === normalizeConditionValue(record.equals);
  }
  if (Object.prototype.hasOwnProperty.call(record, "not_equals")) {
    return current !== normalizeConditionValue(record.not_equals);
  }
  if (Array.isArray(record.in)) {
    return record.in.map(normalizeConditionValue).includes(current);
  }
  if (Array.isArray(record.not_in)) {
    return !record.not_in.map(normalizeConditionValue).includes(current);
  }
  if (Object.prototype.hasOwnProperty.call(record, "exists")) {
    const want = !!record.exists;
    const exists = current !== null && current !== "";
    return want ? exists : !exists;
  }
  if (Object.prototype.hasOwnProperty.call(record, "truthy")) {
    const want = !!record.truthy;
    return want ? !!current : !current;
  }

  return true;
};

const shouldRenderBlock = (block: TemplateBlock, payload: Record<string, any>): boolean => {
  const renderIf = block.render_if;
  if (!renderIf) return true;
  const list = Array.isArray(renderIf) ? renderIf : [renderIf];
  return list.every((cond) => evaluateRenderCondition(cond, payload));
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const fontHeightAtSize = (font: Awaited<EmbeddedFontPromise>, size: number) => {
  return typeof (font as any)?.heightAtSize === "function" ? (font as any).heightAtSize(size) : size;
};

const normalizeText = (text: string) => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const widestLineWidth = (
  font: Awaited<EmbeddedFontPromise>,
  lines: string[],
  size: number,
  measureTextWidth?: (text: string, size: number) => number,
) => {
  const measure = typeof measureTextWidth === "function" ? measureTextWidth : (t: string, s: number) => font.widthOfTextAtSize(t, s);
  let max = 0;
  for (const line of lines) {
    const w = measure(line, size);
    if (w > max) max = w;
  }
  return max;
};

const breakWordToWidth = (
  word: string,
  font: Awaited<EmbeddedFontPromise>,
  size: number,
  maxWidth: number,
  measureTextWidth?: (text: string, size: number) => number,
) => {
  const measure = typeof measureTextWidth === "function" ? measureTextWidth : (t: string, s: number) => font.widthOfTextAtSize(t, s);
  if (!maxWidth || maxWidth <= 0) return [word];
  const segments: string[] = [];
  let rest = word;
  while (rest.length > 0) {
    let lo = 1;
    let hi = rest.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidate = rest.slice(0, mid);
      if (measure(candidate, size) <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    const head = rest.slice(0, lo);
    if (!head) {
      segments.push(rest);
      break;
    }
    segments.push(head);
    rest = rest.slice(lo);
  }
  return segments;
};

const wrapTextToWidth = (
  text: string,
  font: Awaited<EmbeddedFontPromise>,
  size: number,
  maxWidth: number,
  measureTextWidth?: (text: string, size: number) => number,
) => {
  const measure = typeof measureTextWidth === "function" ? measureTextWidth : (t: string, s: number) => font.widthOfTextAtSize(t, s);
  const raw = normalizeText(text);
  if (!maxWidth || maxWidth <= 0) return [raw.replace(/\n/g, " ").trim()];

  const paragraphs = raw.split("\n");
  const lines: string[] = [];

  for (const paragraphRaw of paragraphs) {
    const paragraph = paragraphRaw.trim();
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measure(candidate, size) <= maxWidth) {
        current = candidate;
        continue;
      }

      if (current) {
        lines.push(current);
        current = "";
      }

      if (measure(word, size) <= maxWidth) {
        current = word;
        continue;
      }

      const segments = breakWordToWidth(word, font, size, maxWidth, measureTextWidth);
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        if (i === segments.length - 1) current = segment;
        else lines.push(segment);
      }
    }

    if (current) lines.push(current);
  }

  return lines.length ? lines : [""];
};

const fitTextSingleLine = (
  text: string,
  font: Awaited<EmbeddedFontPromise>,
  size: number,
  maxWidth: number | null,
  maxHeight: number | null,
  opts: {
    minSize: number;
    hardMinSize: number;
    overflow?: string;
    measureTextWidth?: (text: string, size: number) => number;
  },
) => {
  const hardMinSize = Number.isFinite(Number(opts.hardMinSize)) ? Number(opts.hardMinSize) : Math.max(0.01, Number(opts.minSize) || 0.01);
  const minSize = Number.isFinite(Number(opts.minSize)) ? Number(opts.minSize) : hardMinSize;
  const measure = typeof opts.measureTextWidth === "function" ? opts.measureTextWidth : (t: string, s: number) => font.widthOfTextAtSize(t, s);

  const raw = normalizeText(text).replace(/\n/g, " ").trim();
  const heightAt = (s: number) => fontHeightAtSize(font, s);
  const fitsAt = (s: number) => (
    (!maxWidth || maxWidth <= 0 || measure(raw, s) <= maxWidth) &&
    (!maxHeight || maxHeight <= 0 || heightAt(s) <= maxHeight)
  );

  const overflow = String(opts.overflow || "shrink").toLowerCase();

  let fittedSize = Number(size) || 12;
  if (fitsAt(fittedSize)) {
    const widths = [measure(raw, fittedSize)];
    const textHeight = heightAt(fittedSize);
    return {
      mode: "single",
      size: fittedSize,
      lines: [raw],
      widths,
      textHeight,
      lineHeight: textHeight,
      totalHeight: textHeight,
      fits: true,
    };
  }

  if (overflow === "clip") {
    const widths = [measure(raw, fittedSize)];
    const textHeight = heightAt(fittedSize);
    return {
      mode: "single",
      size: fittedSize,
      lines: [raw],
      widths,
      textHeight,
      lineHeight: textHeight,
      totalHeight: textHeight,
      fits: false,
    };
  }

  if (overflow === "truncate") {
    const ellipsis = "…";
    const maxChars = raw.length;
    let low = 0;
    let high = maxChars;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = raw.slice(0, mid) + ellipsis;
      if (!maxWidth || maxWidth <= 0 || measure(candidate, fittedSize) <= maxWidth) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    const cut = Math.max(0, Math.min(maxChars, low - 1));
    const truncated = cut >= maxChars ? raw : raw.slice(0, cut) + ellipsis;
    const widths = [measure(truncated, fittedSize)];
    const textHeight = heightAt(fittedSize);
    return {
      mode: "single",
      size: fittedSize,
      lines: [truncated],
      widths,
      textHeight,
      lineHeight: textHeight,
      totalHeight: textHeight,
      fits: fitsAt(fittedSize),
    };
  }

  // shrink (default)
  const w1 = maxWidth && maxWidth > 0 ? measure(raw, 1) : null;
  const h1 = maxHeight && maxHeight > 0 ? heightAt(1) : null;
  if (maxWidth && maxWidth > 0 && w1 && w1 > 0) fittedSize = Math.min(fittedSize, maxWidth / w1);
  if (maxHeight && maxHeight > 0 && h1 && h1 > 0) fittedSize = Math.min(fittedSize, maxHeight / h1);
  fittedSize = Math.max(hardMinSize, fittedSize * 0.995);

  while (fittedSize > hardMinSize && !fitsAt(fittedSize)) {
    fittedSize = Math.max(hardMinSize, fittedSize - 0.05);
  }

  const widths = [measure(raw, fittedSize)];
  const textHeight = heightAt(fittedSize);
  return {
    mode: "single",
    size: fittedSize,
    lines: [raw],
    widths,
    textHeight,
    lineHeight: textHeight,
    totalHeight: textHeight,
    fits: fitsAt(fittedSize),
  };
};

const fitTextWrap = (
  text: string,
  font: Awaited<EmbeddedFontPromise>,
  size: number,
  maxWidth: number | null,
  maxHeight: number | null,
  opts: {
    minSize: number;
    hardMinSize: number;
    overflow?: string;
    wrap?: boolean;
    lineHeightFactor?: number;
    measureTextWidth?: (text: string, size: number) => number;
  },
) => {
  const hardMinSize = Number.isFinite(Number(opts.hardMinSize)) ? Number(opts.hardMinSize) : Math.max(0.01, Number(opts.minSize) || 0.01);
  const minSize = Number.isFinite(Number(opts.minSize)) ? Number(opts.minSize) : hardMinSize;
  const lineHeightFactor = Number.isFinite(Number(opts.lineHeightFactor)) ? Number(opts.lineHeightFactor) : 1.1;
  const measure = typeof opts.measureTextWidth === "function" ? opts.measureTextWidth : (t: string, s: number) => font.widthOfTextAtSize(t, s);

  const measureAt = (s: number) => {
    const lines = wrapTextToWidth(text, font, s, maxWidth ?? 0, opts.measureTextWidth);
    const textHeight = fontHeightAtSize(font, s);
    const lineHeight = textHeight * lineHeightFactor;
    const totalHeight = lines.length * lineHeight;
    const widths = lines.map((line) => measure(line, s));
    const fitsWidth = !maxWidth || maxWidth <= 0 || widths.every((w) => w <= maxWidth + 0.01);
    const fitsHeight = !maxHeight || maxHeight <= 0 || totalHeight <= maxHeight + 0.01;
    return {
      mode: "wrap",
      size: s,
      lines,
      widths,
      textHeight,
      lineHeight,
      totalHeight,
      fits: fitsWidth && fitsHeight,
      fits_width: fitsWidth,
      fits_height: fitsHeight,
    };
  };

  const desired = Number(size) || 12;
  if (!maxHeight || maxHeight <= 0) return measureAt(desired);
  const desiredMeasure = measureAt(desired);
  if (desiredMeasure.fits) return desiredMeasure;

  const minMeasure = measureAt(hardMinSize);
  if (!minMeasure.fits_height) return minMeasure;

  let lo = hardMinSize;
  let hi = desired;
  let best = minMeasure;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const m = measureAt(mid);
    if (m.fits) {
      best = m;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
};

const fitTextToBox = (
  text: string,
  font: Awaited<EmbeddedFontPromise>,
  size: number,
  maxWidth: number | null,
  maxHeight: number | null,
  opts: {
    minSize: number;
    hardMinSize: number;
    overflow?: string;
    wrap?: boolean;
    lineHeightFactor?: number;
    measureTextWidth?: (text: string, size: number) => number;
  },
) => {
  const overflow = String(opts.overflow || "shrink").toLowerCase();
  const wrap = opts.wrap === true || overflow.includes("wrap");
  if (wrap) {
    return fitTextWrap(text, font, size, maxWidth, maxHeight, opts);
  }
  return fitTextSingleLine(text, font, size, maxWidth, maxHeight, opts);
};

const selectFont = (
  pdfDoc: PDFDocument,
  cache: Map<string, EmbeddedFontPromise>,
  fontName?: string,
) => {
  const normalized = (fontName ?? "helvetica").toLowerCase();
  if (!cache.has(normalized)) {
    const resolver = (async () => {
      switch (normalized) {
        case "helvetica-bold":
        case "helvetica_bold":
        case "bold":
          return await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        case "courier":
        case "barcode":
          return await pdfDoc.embedFont(StandardFonts.Courier);
        case "times":
        case "times-roman":
          return await pdfDoc.embedFont(StandardFonts.TimesRoman);
        default:
          return await pdfDoc.embedFont(StandardFonts.Helvetica);
      }
    })();
    cache.set(normalized, resolver);
  }
  return cache.get(normalized)!;
};

interface LoadedAsset {
  meta: TemplateAsset;
  bytes: Uint8Array;
  embed?: Awaited<ReturnType<PDFDocument["embedPng"]>>;
}

const registerAssetKeys = (
  map: Map<string, LoadedAsset>,
  asset: TemplateAsset,
  entry: LoadedAsset,
) => {
  const keys = new Set<string>();
  if (asset.name) keys.add(asset.name);
  keys.add(asset.path);
  for (const key of keys) {
    if (!map.has(key)) {
      map.set(key, entry);
    }
  }
};

const loadTemplateAssets = async (
  snapshot: TemplateSnapshot,
  rendererConfig: TemplateRendererConfig,
  missingAssets?: string[],
): Promise<Map<string, LoadedAsset>> => {
  const map = new Map<string, LoadedAsset>();
  const definitions: TemplateAsset[] = [];
  const missing = missingAssets ?? [];

  if (Array.isArray(rendererConfig.assets)) {
    definitions.push(...rendererConfig.assets.filter((asset): asset is TemplateAsset => !!asset?.path));
  }
  if (Array.isArray(snapshot.asset_refs)) {
    definitions.push(...snapshot.asset_refs.filter((asset): asset is TemplateAsset => !!asset?.path));
  }

  for (const asset of definitions) {
    const key = asset.name ?? asset.path;
    if (map.has(key) || map.has(asset.path)) continue;

    const bytes = await fetchAsset(asset.path);
    if (!bytes) {
      missing.push(key);
      continue;
    }

    const entry: LoadedAsset = { meta: asset, bytes };
    registerAssetKeys(map, asset, entry);
  }

  return map;
};

type PdfPage = ReturnType<PDFDocument["addPage"]>;

const renderTemplateBlocksToPage = async (
  payload: Record<string, any>,
  job: LabelJob,
  snapshot: TemplateSnapshot,
  options: {
    pdfDoc: PDFDocument;
    page: PdfPage;
    fontCache: Map<string, EmbeddedFontPromise>;
    getAssetEmbed: (ref?: string) => Promise<Awaited<ReturnType<PDFDocument["embedPng"]>> | null>;
    dotPt: number;
  },
): Promise<{ renderedBlocks: number; barcodeBlocks: number; barcodeValue: string | null }> => {
  const rendererConfig = snapshot.renderer_config ?? {};
  const blocks = Array.isArray(rendererConfig.blocks) ? rendererConfig.blocks : [];
  let renderedBlocks = 0;
  let barcodeBlocks = 0;
  let barcodeSample: string | null = null;
  const dotPt = options.dotPt;
  const pdfDoc = options.pdfDoc;
  const page = options.page;
  const labelRenderPolicy = asRecord(payload?.label_render_policy);
  const textDefaults = asRecord(labelRenderPolicy?.text_defaults) ?? {};
  const arabicPolicy = asRecord(labelRenderPolicy?.arabic) ?? {};
  const arabicEnabled = arabicPolicy?.enabled === true;
  const arabicDirection = normalizeString(arabicPolicy?.direction);
  const arabicFontRegularKey = normalizeString(arabicPolicy?.font_asset_regular);
  const arabicFontBoldKey = normalizeString(arabicPolicy?.font_asset_bold);
  let fontkitRegistered = false;

  const resolveFontName = (fontName?: string) => {
    const raw = String(fontName || "").trim();
    if (!raw) return normalizeString(textDefaults.font_regular) || "helvetica";
    const lower = raw.toLowerCase();
    if (lower === "regular") return normalizeString(textDefaults.font_regular) || "helvetica";
    if (lower === "bold") return normalizeString(textDefaults.font_bold) || "helvetica-bold";
    return raw;
  };

  const ensureFontkitRegistered = () => {
    if (fontkitRegistered) return;
    pdfDoc.registerFontkit(fontkit);
    fontkitRegistered = true;
  };

  const embedFontFromAsset = async (assetKey: string | null) => {
    const key = normalizeString(assetKey);
    if (!key) return null;
    const cacheKey = `asset_font:${key}`;
    if (options.fontCache.has(cacheKey)) {
      return options.fontCache.get(cacheKey) as Awaited<EmbeddedFontPromise> | null;
    }
    const resolver = (async () => {
      const bytes = await fetchAsset(key);
      if (!bytes) {
        logRenderer("warn", "font_asset_missing");
        return null;
      }
      ensureFontkitRegistered();
      return await pdfDoc.embedFont(bytes, { subset: true });
    })();
    options.fontCache.set(cacheKey, resolver as EmbeddedFontPromise);
    return resolver as Awaited<EmbeddedFontPromise> | null;
  };

  const selectArabicFont = async (fontName: string | undefined, rawText: string) => {
    if (!arabicEnabled || !hasArabic(rawText)) return null;
    const isBold =
      /bold/i.test(String(fontName || "")) ||
      String(fontName || "").trim().toLowerCase() === "bold";
    const key = isBold ? (arabicFontBoldKey || arabicFontRegularKey) : arabicFontRegularKey;
    return embedFontFromAsset(key || null);
  };

  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (!shouldRenderBlock(block, payload)) continue;
    const x = typeof block.x === "number" ? block.x : 0;
    const y = typeof block.y === "number" ? block.y : 0;

    if (block.type === "text") {
      const rawValue = resolvePathValue(payload, block.value_path) ??
        resolvePathValue({ job }, block.value_path);
      const rawText = stringifyValue(rawValue, block.fallback);
      if (!rawText) continue;

      const resolvedFontName = resolveFontName(block.font);
      const latinFont = await selectFont(pdfDoc, options.fontCache, resolvedFontName);
      const arabicFont = await selectArabicFont(resolvedFontName, rawText);
      const useArabic = !!arabicFont && hasArabic(rawText);
      const textBase = useArabic ? rawText : stripNonAscii(rawText);
      const textValue = sanitizePdfText(
        useArabic ? toBidiVisualOrder(textBase, arabicDirection || undefined) : textBase,
      );
      if (!textValue) continue;

      const font = useArabic ? arabicFont : latinFont;
      const baseSize = block.font_size ?? 12;
      const minSize = typeof block.min_font_size === "number" && block.min_font_size > 0 ? block.min_font_size : 6;
      const hardMinSize = typeof block.hard_min_font_size === "number" && block.hard_min_font_size > 0
        ? Math.min(block.hard_min_font_size, minSize)
        : Math.min(0.01, minSize);
      const maxWidth =
        typeof block.max_width === "number" && block.max_width > 0 ? block.max_width : (
          typeof block.width === "number" && block.width > 0 ? block.width : (page.getWidth() - 12)
        );
      const maxHeight =
        typeof block.max_height === "number" && block.max_height > 0 ? block.max_height : (
          typeof block.height === "number" && block.height > 0 ? block.height : null
        );
      const overflowRaw = typeof block.text_overflow === "string" ? block.text_overflow : "shrink";
      const overflowNormalized = overflowRaw.trim().toLowerCase();
      const lineHeightFactor =
        typeof block.line_height_factor === "number" && block.line_height_factor > 0
          ? block.line_height_factor
          : 1.1;
      const isFit = overflowNormalized === "fit";
      const fitBaseSize =
        isFit && maxHeight && maxHeight > 0
          ? Math.max(baseSize, maxHeight / Math.max(0.01, lineHeightFactor))
          : baseSize;

      const measureTextWidth = useArabic
        ? (text: string, size: number) =>
          measureBidiVisualWidthWithFallback(text, size, arabicFont, latinFont)
        : undefined;

      const fitted = fitTextToBox(textValue, font, fitBaseSize, maxWidth, maxHeight, {
        minSize,
        hardMinSize,
        overflow: isFit ? "shrink" : overflowRaw,
        wrap: !!block.wrap,
        lineHeightFactor,
        measureTextWidth,
      });

      let boxY = y;
      if (typeof block.height === "number" && block.height > 0) {
        if (block.valign === "top") boxY = y + Math.max(0, block.height - fitted.totalHeight);
        else if (block.valign === "middle") boxY = y + Math.max(0, (block.height - fitted.totalHeight) / 2);
      }

      const descentFactor = typeof block.baseline_descent_factor === "number" ? block.baseline_descent_factor : 0.2;
      const rotate = typeof block.rotation === "number" ? degrees(block.rotation) : undefined;
      const color = normalizeColor(block.color);

      if (fitted.lines.length <= 1) {
        const line = fitted.lines[0] || "";
        if (line) {
          const lineWidth = useArabic
            ? measureBidiVisualWidthWithFallback(line, fitted.size, arabicFont, latinFont)
            : font.widthOfTextAtSize(line, fitted.size);
          let drawX = x;
          if (block.align === "center") drawX = x - lineWidth / 2;
          else if (block.align === "right") drawX = x - lineWidth;
          const drawY = boxY + (fitted.textHeight * descentFactor);
          if (useArabic) {
            drawBidiVisualRunsWithFallback(page, line, {
              x: drawX,
              y: drawY,
              size: fitted.size,
              arabicFont,
              latinFont,
              color,
              rotate,
            });
          } else {
            const drawOpts: Record<string, unknown> = { x: drawX, y: drawY, size: fitted.size, font, color };
            if (rotate) drawOpts.rotate = rotate;
            page.drawText(line, drawOpts);
          }
          renderedBlocks += 1;
        }
      } else {
        for (let i = 0; i < fitted.lines.length; i++) {
          const line = fitted.lines[i] ?? "";
          const lineWidth = useArabic
            ? measureBidiVisualWidthWithFallback(line, fitted.size, arabicFont, latinFont)
            : font.widthOfTextAtSize(line, fitted.size);
          let drawX = x;
          if (block.align === "center") drawX = x - lineWidth / 2;
          else if (block.align === "right") drawX = x - lineWidth;
          const lineBoxBottom = boxY + fitted.totalHeight - (fitted.lineHeight * (i + 1));
          const drawY = lineBoxBottom + (fitted.textHeight * descentFactor);
          if (useArabic) {
            drawBidiVisualRunsWithFallback(page, line, {
              x: drawX,
              y: drawY,
              size: fitted.size,
              arabicFont,
              latinFont,
              color,
              rotate,
            });
          } else {
            const drawOpts: Record<string, unknown> = { x: drawX, y: drawY, size: fitted.size, font, color };
            if (rotate) drawOpts.rotate = rotate;
            page.drawText(line, drawOpts);
          }
        }
        renderedBlocks += 1;
      }
      continue;
    }

    if (block.type === "barcode") {
      barcodeBlocks += 1;
      const rawValue = resolvePathValue(payload, block.value_path) ??
        resolvePathValue({ job }, block.value_path);
      const barcodeValue = sanitizePdfText(stringifyValue(rawValue, block.fallback));
      if (!barcodeValue) continue;
      if (!barcodeSample) barcodeSample = barcodeValue;

      const barcodeTypeRaw =
        typeof block.barcode_type === "string" && block.barcode_type.trim()
          ? block.barcode_type
          : (rendererConfig.barcode?.type ?? "code128");
      const barcodeType = canonicalBarcodeType(String(barcodeTypeRaw));
      const MAX_BARCODE_CHARS = BARCODE_MAX_CHARS[barcodeType]!;
      if (barcodeValue.length > MAX_BARCODE_CHARS) {
        throw new TemplateError("render_failure", "Barcode value exceeds max length", {
          value_length: barcodeValue.length,
          max_length: MAX_BARCODE_CHARS,
          value_path: block.value_path,
        });
      }

      const baseModuleWidth =
        typeof block.module_width === "number" && block.module_width > 0 ? block.module_width : dotPt;
      const maxScale =
        typeof block.max_scale === "number" && block.max_scale > 0 ? block.max_scale : 1_000_000;
      const reservedBottom =
        typeof block.reserve_bottom === "number" && block.reserve_bottom > 0 ? block.reserve_bottom : 0;
      const totalHeight = typeof block.height === "number" && block.height > 0 ? block.height : 56;
      const availableHeight = Math.max(0, totalHeight - reservedBottom);
      const humanReadable = block.human_readable !== false;

      const maxWidth = typeof block.max_width === "number" && block.max_width > 0
        ? block.max_width
        : (typeof block.width === "number" && block.width > 0 ? block.width : 0);

      if (!Number.isFinite(maxWidth) || maxWidth <= 0 || availableHeight <= 0) continue;

      if (barcodeType === "qr" || barcodeType === "qrcode" || barcodeType === "qr_code") {
        const ecc = "M";
        const qr = qrcode(0, ecc);
        qr.addData(barcodeValue);
        qr.make();

        const moduleCount = qr.getModuleCount();
        const quietZoneModules = (() => {
          const fixed = typeof block.quiet_zone_modules === "number" && block.quiet_zone_modules >= 0
            ? Math.floor(block.quiet_zone_modules)
            : null;
          if (fixed != null) return fixed;
          const minQz = typeof block.min_quiet_zone_modules === "number" && block.min_quiet_zone_modules >= 0
            ? Math.floor(block.min_quiet_zone_modules)
            : null;
          return minQz != null ? minQz : 4;
        })();

        const totalModules = moduleCount + quietZoneModules * 2;
        const maxModuleWidthByFit = Math.min(maxWidth, availableHeight) / totalModules;
        const maxModuleWidthByScale = baseModuleWidth * maxScale;
        let moduleWidth = Math.min(
          maxModuleWidthByFit,
          maxModuleWidthByScale > 0 ? maxModuleWidthByScale : maxModuleWidthByFit,
        );
        if (moduleWidth / dotPt >= 1) {
          const moduleDots = Math.max(1, Math.floor(moduleWidth / dotPt));
          moduleWidth = moduleDots * dotPt;
        }
        moduleWidth = Math.max(moduleWidth, 0.1);

        const totalSize = totalModules * moduleWidth;
        let startX = x;
        if (block.align === "center") {
          startX = x - totalSize / 2;
        } else if (block.align === "right") {
          startX = x - totalSize;
        }

        let startY = y + reservedBottom;
        const valign = String(block.valign ?? "").trim().toLowerCase();
        if (valign === "top") startY = y + reservedBottom + Math.max(0, availableHeight - totalSize);
        else if (valign === "middle" || valign === "center") {
          startY = y + reservedBottom + Math.max(0, (availableHeight - totalSize) / 2);
        }

        const originX = startX + quietZoneModules * moduleWidth;
        const originY = startY + quietZoneModules * moduleWidth;
        const barColor = normalizeColor(block.color);
        for (let r = 0; r < moduleCount; r++) {
          for (let c = 0; c < moduleCount; c++) {
            if (!qr.isDark(r, c)) continue;
            page.drawRectangle({
              x: originX + c * moduleWidth,
              y: originY + (moduleCount - 1 - r) * moduleWidth,
              width: moduleWidth,
              height: moduleWidth,
              color: barColor,
            });
          }
        }

        renderedBlocks += 1;
        continue;
      }

      if (barcodeType !== "code128") {
        const symbol = encodeAdditionalBarcode(bwip.raw, barcodeType, barcodeValue);
        const quietZone = typeof block.quiet_zone_modules === "number" && block.quiet_zone_modules >= 0
          ? Math.floor(block.quiet_zone_modules)
          : typeof block.min_quiet_zone_modules === "number" && block.min_quiet_zone_modules >= 0
            ? Math.floor(block.min_quiet_zone_modules) : symbol.is2D ? 4 : 10;
        const fit = maxWidth / (symbol.width + quietZone * 2);
        let moduleWidth = Math.min(fit, baseModuleWidth * maxScale);
        if (symbol.is2D) moduleWidth = Math.min(moduleWidth, availableHeight / (symbol.height + quietZone * 2));
        if (moduleWidth >= dotPt) moduleWidth = Math.floor(moduleWidth / dotPt) * dotPt;
        const totalWidth = (symbol.width + quietZone * 2) * moduleWidth;
        const totalHeight = symbol.is2D ? (symbol.height + quietZone * 2) * moduleWidth : availableHeight;
        const startX = block.align === "center" ? x - totalWidth / 2 : block.align === "right" ? x - totalWidth : x;
        const valign = String(block.valign ?? "").trim().toLowerCase();
        const offsetY = valign === "top" ? availableHeight - totalHeight
          : valign === "middle" || valign === "center" ? (availableHeight - totalHeight) / 2 : 0;
        const startY = y + reservedBottom + offsetY;
        const color = normalizeColor(block.color);
        for (const rect of symbol.rectangles) {
          const position = rotateBarcodePoint({
            x: startX + (rect.x + quietZone) * moduleWidth,
            y: startY + (symbol.is2D ? (rect.y + quietZone) * moduleWidth : rect.y * availableHeight),
          }, { x, y }, block.rotation);
          page.drawRectangle({
            ...position,
            width: rect.width * moduleWidth,
            height: rect.height * (symbol.is2D ? moduleWidth : availableHeight),
            rotate: degrees(block.rotation ?? 0),
            color,
          });
        }
        if (humanReadable && !symbol.is2D) {
          const font = await selectFont(pdfDoc, options.fontCache, block.font);
          const size = block.font_size ?? 11;
          const textWidth = font.widthOfTextAtSize(symbol.humanReadableText, size);
          const position = rotateBarcodePoint({ x: block.align === "center" ? x - textWidth / 2 : block.align === "right" ? x - textWidth : x,
            y: startY - size - 4 }, { x, y }, block.rotation);
          page.drawText(symbol.humanReadableText, { ...position, rotate: degrees(block.rotation ?? 0), size, font, color });
        }
        renderedBlocks += 1;
        continue;
      }

      const { pattern, modules } = encodeCode128B(barcodeValue);
      const quietZoneModules = (() => {
        const fixed = typeof block.quiet_zone_modules === "number" && block.quiet_zone_modules >= 0
          ? Math.floor(block.quiet_zone_modules)
          : null;
        if (fixed != null) return fixed;
        const minQz = typeof block.min_quiet_zone_modules === "number" && block.min_quiet_zone_modules >= 0
          ? Math.floor(block.min_quiet_zone_modules)
          : null;
        return minQz != null ? minQz : 10;
      })();

      const totalModules = modules + quietZoneModules * 2;
      const maxModuleWidthByFit = maxWidth / totalModules;
      const maxModuleWidthByScale = baseModuleWidth * maxScale;
      let moduleWidth = Math.min(maxModuleWidthByFit, maxModuleWidthByScale > 0 ? maxModuleWidthByScale : maxModuleWidthByFit);
      if (moduleWidth / dotPt >= 1) {
        const moduleDots = Math.max(1, Math.floor(moduleWidth / dotPt));
        moduleWidth = moduleDots * dotPt;
      }
      moduleWidth = Math.max(moduleWidth, 0.1);

      const quiet = quietZoneModules * moduleWidth;
      const totalWidth = totalModules * moduleWidth;
      let startX = x;
      if (block.align === "center") {
        startX = x - totalWidth / 2;
      } else if (block.align === "right") {
        startX = x - totalWidth;
      }

      const barX = startX + quiet;
      const barHeight = availableHeight;
      let barY = y + reservedBottom;
      const valign = String(block.valign ?? "").trim().toLowerCase();
      if (valign === "top") barY = y + reservedBottom + Math.max(0, availableHeight - barHeight);
      else if (valign === "middle" || valign === "center") {
        barY = y + reservedBottom + Math.max(0, (availableHeight - barHeight) / 2);
      }
      const barColor = normalizeColor(block.color);

      let cursor = barX;
      let runWidth = 0;
      for (let i = 0; i < pattern.length; i++) {
        const bit = pattern[i];
        if (bit === "1") {
          runWidth += moduleWidth;
        }
        const isLast = i === pattern.length - 1;
        if (bit === "0" || isLast) {
          if (runWidth > 0) {
            page.drawRectangle({ x: cursor, y: barY, width: runWidth, height: barHeight, color: barColor });
            cursor += runWidth;
            runWidth = 0;
          }
          if (bit === "0") {
            cursor += moduleWidth;
          }
        }
      }

      if (humanReadable) {
        const font = await selectFont(pdfDoc, options.fontCache, block.font);
        const size = block.font_size ?? 11;
        const textWidth = font.widthOfTextAtSize(barcodeValue, size);
        let textX = x;
        if (block.align === "center") {
          textX = x - textWidth / 2;
        } else if (block.align === "right") {
          textX = x - textWidth;
        }
        page.drawText(barcodeValue, {
          x: textX,
          y: barY - size - 4,
          size,
          font,
          color: barColor,
        });
      }

      renderedBlocks += 1;
      continue;
    }

    if (block.type === "line") {
      const x2 = typeof block.width === "number" ? block.width : x;
      const y2 = typeof block.height === "number" ? block.height : y;
      page.drawLine({
        start: { x, y },
        end: { x: x2, y: y2 },
        thickness: block.stroke_width ?? 1,
        color: normalizeColor(block.color),
      });
      renderedBlocks += 1;
      continue;
    }

    if (block.type === "rect") {
      const width = block.width ?? 0;
      const height = block.height ?? 0;
      page.drawRectangle({
        x,
        y,
        width,
        height,
        borderWidth: block.stroke_width ?? 1,
        borderColor: normalizeOptionalColor(block.color) ?? rgb(0, 0, 0),
        color: normalizeOptionalColor(block.fill_color) ?? undefined,
      });
      renderedBlocks += 1;
      continue;
    }

    if (block.type === "image") {
      const assetRef = block.asset_ref ?? block.value_path;
      const embed = await options.getAssetEmbed(assetRef);
      if (!embed) {
        continue;
      }
      const targetWidth = block.width ?? embed.width;
      const targetHeight = block.height ?? embed.height;
      const ratio = Math.min(targetWidth / embed.width, targetHeight / embed.height);
      const allowUpscale = !!block.allow_upscale;
      const maxScale = typeof block.max_scale === "number" && block.max_scale > 0 ? block.max_scale : (allowUpscale ? 1_000_000 : 1);
      const scale = Math.min(allowUpscale ? ratio : Math.min(ratio, 1), maxScale);
      const drawWidth = embed.width * scale;
      const drawHeight = embed.height * scale;
      let drawX = x;
      if (block.align === "center") drawX = x - drawWidth / 2;
      else if (block.align === "right") drawX = x - drawWidth;
      let drawY = y;
      const valign = String(block.valign ?? "").trim().toLowerCase();
      if (typeof block.height === "number" && block.height > 0) {
        if (valign === "top") drawY = y + Math.max(0, block.height - drawHeight);
        else if (valign === "middle" || valign === "center") {
          drawY = y + Math.max(0, (block.height - drawHeight) / 2);
        }
      }
      const drawOptions: Record<string, unknown> = { x: drawX, y: drawY, width: drawWidth, height: drawHeight };
      if (typeof block.rotation === "number") {
        drawOptions.rotate = degrees(block.rotation);
      }
      page.drawImage(embed, drawOptions);
      renderedBlocks += 1;
      continue;
    }
  }

  return { renderedBlocks, barcodeBlocks, barcodeValue: barcodeSample };
};

const renderTemplatePdf = async (
  payload: Record<string, any>,
  job: LabelJob,
  snapshot: TemplateSnapshot,
): Promise<{ bytes: Uint8Array; rendererMetadata: Record<string, unknown> }> => {
  const rendererConfig = snapshot.renderer_config ?? {};
  const pageCfg = rendererConfig.page ?? {};
  const widthPoints = Math.max(72, Math.round((pageCfg.width_inch ?? 4) * 72));
  const heightPoints = Math.max(72, Math.round((pageCfg.height_inch ?? 6) * 72));
  const orientation = (pageCfg.orientation ?? "portrait") === "landscape" ? "landscape" : "portrait";

  await ensureRendererDeps();
  const pdfDoc = await PDFDocument.create();
  const pageSize: [number, number] = orientation === "landscape"
    ? [heightPoints, widthPoints]
    : [widthPoints, heightPoints];
  const page = pdfDoc.addPage(pageSize);

  const fontCache = new Map<string, EmbeddedFontPromise>();
  const missingAssets: string[] = [];
  const assets = await loadTemplateAssets(snapshot, rendererConfig, missingAssets);

  const getAssetEmbed = async (ref?: string) => {
    if (!ref) {
      return null;
    }
    const entry = assets.get(ref);
    if (!entry) {
      return null;
    }

    if (!entry.embed) {
      const contentType = entry.meta.content_type ?? "";
      const path = entry.meta.path.toLowerCase();
      if (contentType.includes("png") || path.endsWith(".png")) {
        entry.embed = await pdfDoc.embedPng(entry.bytes);
      } else if (contentType.includes("jpg") || contentType.includes("jpeg") || path.endsWith(".jpg") ||
        path.endsWith(".jpeg")) {
        entry.embed = await pdfDoc.embedJpg(entry.bytes);
      } else {
        entry.embed = await pdfDoc.embedPng(entry.bytes);
      }
    }

    return entry.embed;
  };

  const dpi = typeof pageCfg.dpi === "number" && pageCfg.dpi > 0 ? pageCfg.dpi : 203;
  const dotPt = 72 / dpi;
  const { renderedBlocks, barcodeBlocks, barcodeValue } = await renderTemplateBlocksToPage(payload, job, snapshot, {
    pdfDoc,
    page,
    fontCache,
    getAssetEmbed,
    dotPt,
  });

  const bytes = new Uint8Array(await pdfDoc.save());
  const rendererMetadata: Record<string, unknown> = {
    renderer: "edge/label-renderer",
    version: "2025-11-02",
    template_id: snapshot.template_id ?? null,
    template_version: snapshot.template_version ?? null,
    template_key: snapshot.template_key ?? null,
    schema_version: snapshot.schema_version ?? null,
    rendered_blocks: renderedBlocks,
    barcode_blocks: barcodeBlocks,
    barcode_mode: barcodeBlocks > 0 ? "code128b_vector" : null,
    barcode: barcodeValue ?? null,
    assets_loaded: new Set(assets.values()).size,
    assets_missing_count: missingAssets.length,
    assets_missing: missingAssets,
  };

  return { bytes, rendererMetadata };
};

const buildFallbackPdf = async (
  payload: Record<string, any>,
  job: LabelJob,
  templateSnapshot?: TemplateSnapshot | null,
  integration?: IntegrationContext | null,
): Promise<{ bytes: Uint8Array; rendererMetadata: Record<string, unknown> }> => {
  await ensureRendererDeps();
  const pdfDoc = await PDFDocument.create();
  const pageWidth = 4 * 72;
  const pageHeight = 6 * 72;
  const page = pdfDoc.addPage([pageWidth, pageHeight]);

  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const defaults = await resolveRendererDefaults(
    integration ?? null,
    job.organization_id,
    job.client_id ?? null,
    (payload as any)?.sender_id ?? null,
  );
  const branding = resolveFallbackBranding(payload, templateSnapshot, defaults);
  const headerColor = rgb(branding.color.r, branding.color.g, branding.color.b);

  const drawText = (
    text: string,
    x: number,
    y: number,
    font = helvetica,
    size = 12,
    color = rgb(0, 0, 0),
    ) => {
      page.drawText(sanitizePdfText(stripNonAscii(text)), { x, y, size, font, color });
    };

  drawText(branding.title, 24, pageHeight - 36, helveticaBold, 20, headerColor);
  drawText(`Label Job: ${job.id}`, 24, pageHeight - 60, helvetica, 10);
  let summaryY = pageHeight - 82;
  if (payload?.target) {
    drawText(
      `Target: ${payload.target.type ?? "unknown"} ${payload.target.code ?? payload.target.id ?? ""}`.trim(),
      24,
      summaryY,
      helveticaBold,
      12,
    );
    summaryY -= 18;
    if (payload.target.id) {
      drawText(`Target ID: ${payload.target.id}`, 24, summaryY, helvetica, 10);
      summaryY -= 18;
    }
    if (payload.target.box_id) {
      drawText(`Target Box: ${payload.target.box_id}`, 24, summaryY, helvetica, 10);
      summaryY -= 18;
    }
  }
  if (payload?.shipment?.tracking_number) {
    drawText(`Tracking: ${payload.shipment.tracking_number}`, 24, summaryY, helveticaBold, 14);
    summaryY -= 20;
  }
  if (payload?.recipient?.name) {
    drawText(`Recipient: ${payload.recipient.name}`, 24, summaryY);
    summaryY -= 18;
  }
  if (payload?.recipient?.phone) {
    drawText(`Phone: ${payload.recipient.phone}`, 24, summaryY);
    summaryY -= 18;
  }
  if (payload?.destination?.address_line1) {
    drawText(`Address: ${payload.destination.address_line1}`, 24, summaryY);
    summaryY -= 18;
  }
  if (payload?.destination?.city || payload?.destination?.province) {
    drawText(
      `City: ${payload.destination.city ?? ""} ${payload.destination.province ?? ""}`.trim(),
      24,
      summaryY,
    );
    summaryY -= 18;
  }
  if (payload?.destination?.postal_code) {
    drawText(`Postal: ${payload.destination.postal_code}`, 24, summaryY);
    summaryY -= 18;
  }

  drawText(`Box: ${payload?.box?.box_number ?? 1}`, 24, summaryY);
  summaryY -= 18;
  if (payload?.box?.weight_kg) {
    drawText(`Weight: ${payload.box.weight_kg} kg`, 24, summaryY);
    summaryY -= 18;
  }

  drawText("Payload Summary:", 24, 140, helveticaBold, 12);
  const payloadPreview = JSON.stringify(payload?.metadata ?? payload, null, 2).slice(0, 400);
  const previewLines = payloadPreview.split("\n");
  previewLines.forEach((line, index) => {
    drawText(line, 24, 120 - index * 12, helvetica, 8, rgb(0.2, 0.2, 0.2));
  });

  const bytes = new Uint8Array(await pdfDoc.save());
  return {
    bytes,
    rendererMetadata: {
      renderer: "edge/label-renderer",
      version: "2025-11-12",
      template_id: job.template_id,
      template_version: job.template_version,
      schema_version: 0,
      rendered_blocks: 0,
      fallback_brand: branding.title,
      fallback_brand_source: branding.source,
      fallback_brand_color: branding.color,
    },
  };
};

const completeProcessedLabelJobs = async (
  client: ReturnType<typeof ensureSupabase>,
  results: LabelJobProcessResult[],
) => {
  if (results.length === 0) return;
  const payload = results.map((result) => ({
    job_id: result.job_id,
    status: result.status === "ok" ? "succeeded" : "failed",
    file_url: result.file_url,
    file_size_bytes: result.file_size_bytes,
    renderer_metadata:
      result.metadata && typeof result.metadata === "object" ? result.metadata : {},
    error_reason: result.status === "ok" ? null : result.error ?? "label_render_failed",
  }));
  const { error } = await client.rpc("complete_label_jobs", {
    p_results: payload,
  });
  if (error) {
    throw new Error(`complete_label_jobs failed: ${error.message}`);
  }
};

type LabelJobProcessResult = {
  status: "ok" | "failed";
  job_id: string;
  file_url: string | null;
  file_size_bytes: number | null;
  metadata: Record<string, unknown> | null;
  error: string | null;
};

type ProcessLabelJobOptions = {
  onPdfBytes?: (filePath: string, bytes: Uint8Array) => void;
  completeInDb?: boolean;
};

type RenderAndUploadResult = LabelJobProcessResult;

const renderAndUploadLabelFromComposedPayload = async (
  typedJob: LabelJob,
  correlationId: string,
  integration: IntegrationContext,
  composedPayload: Record<string, any>,
  composeMs: number,
  options: ProcessLabelJobOptions = {},
): Promise<RenderAndUploadResult> => {
  const overallStart = performance.now();

  const payloadBody = (composedPayload?.payload ?? {}) as Record<string, any>;
  const templateSnapshot = resolveTemplateSnapshot(composedPayload);
  const settingsResolution = {
    label_render_policy: normalizeString(payloadBody?.label_render_policy_resolution?.settings_resolution_id) ?? null,
    label_print_profile: normalizeString(payloadBody?.label_print_profile_resolution?.settings_resolution_id) ?? null,
  };

  const canUseTemplate = !!(
    templateSnapshot &&
    Array.isArray(templateSnapshot.renderer_config?.blocks) &&
    templateSnapshot.renderer_config.blocks.length > 0
  );

  let renderResult: { bytes: Uint8Array; rendererMetadata: Record<string, unknown> };
  let renderMs = 0;
  try {
    const renderStart = performance.now();
    if (canUseTemplate && templateSnapshot) {
      renderResult = await renderTemplatePdf(payloadBody, typedJob, templateSnapshot);
    } else {
      logRenderer("warn", "template_snapshot_fallback", { job_id: typedJob.id });
      renderResult = await buildFallbackPdf(payloadBody, typedJob, templateSnapshot, integration);
    }
    renderMs = performance.now() - renderStart;
  } catch (renderErr) {
    if (renderErr instanceof TemplateError) {
      const totalMs = Math.max(0, performance.now() - overallStart) + Math.max(0, composeMs);
      const errorMetadata = {
        correlation_id: correlationId,
        stage: "render",
        template_id: templateSnapshot?.template_id ?? typedJob.template_id,
        template_version: templateSnapshot?.template_version ?? typedJob.template_version,
        error: renderErr.message,
        settings_resolution: settingsResolution,
        timings: { compose_ms: composeMs, render_ms: renderMs, total_ms: totalMs },
        ...renderErr.metadata,
      };
      return {
        status: "failed",
        job_id: typedJob.id,
        file_url: null,
        file_size_bytes: null,
        metadata: errorMetadata,
        error: renderErr.code,
      };
    }
    throw renderErr;
  }

  const pdfBytes = renderResult.bytes;
  const filePath = buildLabelOutputFilePath(typedJob.organization_id, typedJob.id);
  const file = new File([pdfBytes], `${typedJob.id}.pdf`, { type: "application/pdf" });

  const uploadStart = performance.now();
  const { error: uploadError } = await storageUploadObject(LABEL_BUCKET, filePath, file, {
    contentType: "application/pdf",
    upsert: true,
  });
  const uploadMs = performance.now() - uploadStart;

  if (uploadError) {
    const totalMs = Math.max(0, performance.now() - overallStart) + Math.max(0, composeMs);
    const errorMetadata = {
      correlation_id: correlationId,
      stage: "upload",
      error: uploadError.message,
      settings_resolution: settingsResolution,
      timings: { compose_ms: composeMs, render_ms: renderMs, upload_ms: uploadMs, total_ms: totalMs },
    };
    await emitMetric("label_upload.failed", {
      org: typedJob.organization_id,
      client: typedJob.client_id ?? null,
      integration: integration.kind,
      bucket: LABEL_BUCKET,
    }, { error: uploadError.message });
    return {
      status: "failed",
      job_id: typedJob.id,
      file_url: null,
      file_size_bytes: null,
      metadata: errorMetadata,
      error: uploadError.message,
    };
  }

  if (typeof options.onPdfBytes === "function") {
    try {
      options.onPdfBytes(filePath, pdfBytes);
    } catch (_err) {
      // non-blocking
    }
  }

  const totalMs = Math.max(0, performance.now() - overallStart) + Math.max(0, composeMs);
  const existingTimings = asRecord((renderResult.rendererMetadata as any)?.timings) ?? {};
  const metadata = {
    ...renderResult.rendererMetadata,
    correlation_id: correlationId,
    page_count: 1,
    attempts: typedJob.attempts + 1,
    settings_resolution: settingsResolution,
    timings: {
      ...existingTimings,
      compose_ms: composeMs,
      render_ms: renderMs,
      upload_ms: uploadMs,
      total_ms: totalMs,
    },
  };

  return {
    status: "ok",
    job_id: typedJob.id,
    file_url: filePath,
    file_size_bytes: pdfBytes.byteLength,
    metadata,
    error: null,
  };
};

const handleDesignerPreview = async (
  payload: any,
): Promise<{ statusCode: number; body: Record<string, unknown> }> => {
  const userJwt = normalizeString(payload?.user_jwt);
  const draftId = normalizeString(payload?.draft_id);
  const labelTypeInput = normalizeString(payload?.label_type);
  const shipmentId = normalizeString(payload?.shipment_id);
  const shipmentBoxId = normalizeString(payload?.shipment_box_id) ?? null;

  if (!userJwt) {
    return {
      statusCode: 401,
      body: { ok: false, error: { code: "auth_required", message: "Authentication required" } },
    };
  }
  if (!draftId) {
    return {
      statusCode: 400,
      body: { ok: false, error: { code: "draft_id_required", message: "draft_id is required" } },
    };
  }
  if (!shipmentId) {
    return {
      statusCode: 400,
      body: { ok: false, error: { code: "shipment_id_required", message: "shipment_id is required" } },
    };
  }

  let userClient;
  try {
    userClient = createUserClient(userJwt);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Preview configuration missing";
    return { statusCode: 500, body: { ok: false, error: { code: "config_missing", message } } };
  }

  const { data: who, error: whoErr } = await userClient.rpc("label_designer_whoami").single();
  if (whoErr || !who || (who as any).ok !== true) {
    const message =
      (who as any)?.error?.message ??
      whoErr?.message ??
      "Authentication required";
    return {
      statusCode: 403,
      body: { ok: false, error: { code: "auth_required", message } },
    };
  }
  const orgId = normalizeString((who as any).organization_id);
  if (!orgId) {
    return {
      statusCode: 403,
      body: { ok: false, error: { code: "org_required", message: "Organization context required" } },
    };
  }

  const { data: draft, error: draftErr } = await userClient
    .from("label_design_drafts")
    .select("id, organization_id, label_type, draft_value")
    .eq("id", draftId)
    .single();
  if (draftErr || !draft) {
    return {
      statusCode: 404,
      body: { ok: false, error: { code: "draft_not_found", message: draftErr?.message ?? "Draft not found" } },
    };
  }

  const draftValue = asRecord((draft as any).draft_value);
  const templates = asRecord(draftValue?.templates) ?? {};
  const templateKey =
    labelTypeInput ?? normalizeString((draft as any).label_type) ?? Object.keys(templates)[0] ?? "";
  const template = templateKey ? asRecord((templates as any)[templateKey]) : null;
  if (!template) {
    return {
      statusCode: 400,
      body: { ok: false, error: { code: "template_missing", message: "Template not found in draft" } },
    };
  }

  const { data: validationData, error: validationErr } = await userClient
    .rpc("label_designer_validate_label_design_draft", { p_draft_id: draftId })
    .single();
  const validation = validationErr
    ? { ok: false, error: { code: "validation_failed", message: validationErr.message } }
    : validationData ?? null;

  const { data: sampleData, error: sampleErr } = await userClient
    .rpc("label_designer_get_sample_payload", {
      p_shipment_id: shipmentId,
      p_shipment_box_id: shipmentBoxId,
    })
    .single();
  if (sampleErr || !sampleData || (sampleData as any).ok !== true) {
    const message =
      (sampleData as any)?.error?.message ??
      sampleErr?.message ??
      "Sample payload not available";
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: { code: "payload_missing", message },
        validation,
      },
    };
  }

  const samplePayload = asRecord((sampleData as any).payload) ?? {};
  const { snapshot, assetsMissingRefs, assetsUnknownRefs } =
    await prepareDesignerPreviewSnapshot(template, templateKey, orgId);

  const job: LabelJob = {
    id: draftId,
    organization_id: orgId,
    client_id: normalizeString((samplePayload as any)?.client_id) ?? null,
    shipment_id: shipmentId,
    shipment_box_id: shipmentBoxId,
    template_id: normalizeString(snapshot.template_key ?? templateKey) ?? null,
    template_version: Number.isFinite(Number(snapshot.template_version))
      ? Number(snapshot.template_version)
      : null,
    attempts: 0,
  };

  try {
    const renderResult = await renderTemplatePdf(samplePayload, job, snapshot);
    return {
      statusCode: 200,
      body: {
        ok: true,
        pdf_base64: bytesToBase64(renderResult.bytes),
        renderer_metadata: {
          ...renderResult.rendererMetadata,
          preview: true,
          assets_missing_refs: assetsMissingRefs,
          assets_unknown_refs: assetsUnknownRefs,
        },
        validation,
      },
    };
  } catch (err) {
    const code = err instanceof TemplateError ? err.code : "render_failure";
    const message = err instanceof Error ? err.message : "Preview render failed";
    return {
      statusCode: 200,
      body: {
        ok: false,
        error: { code, message },
        renderer_metadata: {
          assets_missing_refs: assetsMissingRefs,
          assets_unknown_refs: assetsUnknownRefs,
        },
        validation,
      },
    };
  }
};

const processLabelJob = async (
  client: ReturnType<typeof ensureSupabase>,
  typedJob: LabelJob,
  correlationId: string,
  integration: IntegrationContext,
  options: ProcessLabelJobOptions = {},
): Promise<LabelJobProcessResult> => {
  const completeInDb = options.completeInDb !== false;
  const startedAt = performance.now();
  try {
    const composeStart = performance.now();
    const { data: payloadData, error: payloadError } = await client
      .rpc("compose_label_payload", { p_job_id: typedJob.id })
      .single();
    const composeMs = performance.now() - composeStart;

    if (payloadError || !payloadData) {
      const reason = payloadError?.message ?? "compose_label_payload returned no data";
      const totalMs = performance.now() - startedAt;
      const errorMetadata = {
        correlation_id: correlationId,
        stage: "compose_payload",
        error: reason,
        timings: { compose_ms: composeMs, total_ms: totalMs },
      };
      if (completeInDb) {
        await completeProcessedLabelJobs(client, [{
          status: "failed",
          job_id: typedJob.id,
          file_url: null,
          file_size_bytes: null,
          metadata: errorMetadata,
          error: reason,
        }]);
      }
      return {
        status: "failed",
        job_id: typedJob.id,
        file_url: null,
        file_size_bytes: null,
        metadata: errorMetadata,
        error: reason,
      };
    }

    const composedPayload = payloadData as Record<string, any>;
    const renderResult = await renderAndUploadLabelFromComposedPayload(
      typedJob,
      correlationId,
      integration,
      composedPayload,
      composeMs,
      options,
    );

    const metadata = (renderResult.metadata && typeof renderResult.metadata === "object")
      ? renderResult.metadata
      : { correlation_id: correlationId, stage: "render_upload", error: renderResult.error ?? "label_render_failed" };

    if (renderResult.status === "ok") {
      if (completeInDb) {
        await completeProcessedLabelJobs(client, [{
          status: "ok",
          job_id: typedJob.id,
          file_url: renderResult.file_url,
          file_size_bytes: renderResult.file_size_bytes,
          metadata,
          error: null,
        }]);
      }
      return {
        status: "ok",
        job_id: typedJob.id,
        file_url: renderResult.file_url,
        file_size_bytes: renderResult.file_size_bytes,
        metadata,
        error: null,
      };
    }

    const errorReason = renderResult.error ?? "label_render_failed";
    if (completeInDb) {
      await completeProcessedLabelJobs(client, [{
        status: "failed",
        job_id: typedJob.id,
        file_url: null,
        file_size_bytes: null,
        metadata,
        error: errorReason,
      }]);
    }
    return {
      status: "failed",
      job_id: typedJob.id,
      file_url: null,
      file_size_bytes: null,
      metadata,
      error: errorReason,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await logLabelRenderFailure(typedJob, correlationId, "unhandled_error", { stage: "unhandled", error: message });
    } catch (_err) {
      // ignore
    }
    if (completeInDb) {
      try {
        await completeProcessedLabelJobs(client, [{
          status: "failed",
          job_id: typedJob.id,
          file_url: null,
          file_size_bytes: null,
          metadata: { stage: "unhandled", error: message },
          error: message,
        }]);
      } catch (_err) {
        // ignore
      }
    }
    return {
      status: "failed",
      job_id: typedJob.id,
      file_url: null,
      file_size_bytes: null,
      metadata: null,
      error: message,
    };
  }
};

const collectBundleTargets = async (bundle: BundleRequest): Promise<BundleTarget[]> => {
  const targets: BundleTarget[] = [];
  const directUrls = Array.isArray(bundle.file_urls) ? bundle.file_urls : [];
  if (directUrls.length > 0) {
    const { data, error } = await callRpcWithPublicFallback<Array<Record<string, unknown>>>(
      "resolve_label_bundle_targets_for_file_urls",
      {
      p_org_id: bundle.organization_id,
      p_file_urls: directUrls,
      p_client_id: bundle.client_id ?? null,
      p_sender_id: bundle.sender_id ?? null,
      },
    );
    if (error) {
      logRenderer("warn", "bundle_target_lookup_failed", { error });
      directUrls.forEach(() =>
        targets.push({ labelId: null, shipmentId: null, shipmentBoxId: null, fileUrl: null })
      );
      return targets;
    }

    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    const byPos = new Map<number, Record<string, unknown>>();
    rows.forEach((row) => {
      const raw = (row as any)?.input_index;
      const pos = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(pos)) return;
      byPos.set(pos, row);
    });

    for (let idx = 0; idx < directUrls.length; idx += 1) {
      const row = byPos.get(idx + 1) as any;
      const fileUrl = typeof row?.file_url === "string" ? (row.file_url as string) : null;
      const labelId = typeof row?.label_id === "string" ? (row.label_id as string) : null;
      const shipmentId = typeof row?.shipment_id === "string" ? (row.shipment_id as string) : null;
      const shipmentBoxId =
        typeof row?.shipment_box_id === "string" ? (row.shipment_box_id as string) : null;
      const targetType = typeof row?.target_type === "string" ? (row.target_type as string) : null;
      const targetId = typeof row?.target_id === "string" ? (row.target_id as string) : null;
      const targetBoxId = typeof row?.target_box_id === "string" ? (row.target_box_id as string) : null;

      if (fileUrl) {
        targets.push({ labelId, shipmentId, shipmentBoxId, targetType, targetId, targetBoxId, fileUrl });
      } else {
        targets.push({ labelId: null, shipmentId: null, shipmentBoxId: null, targetType: null, targetId: null, targetBoxId: null, fileUrl: null });
      }
    }
    return dedupeBundleTargets(targets);
  }

  const labelIds = Array.isArray(bundle.label_ids) && bundle.label_ids.length > 0 ? bundle.label_ids : null;
  const shipmentIds = Array.isArray(bundle.shipments)
    ? bundle.shipments
        .map((entry) => entry?.shipment_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0)
    : null;

  const { data, error } = await callRpcWithPublicFallback<Array<Record<string, unknown>>>(
    "resolve_label_files_for_bundle",
    {
    p_org_id: bundle.organization_id,
    p_label_ids: labelIds,
    p_shipment_ids: shipmentIds && shipmentIds.length > 0 ? shipmentIds : null,
    p_client_id: bundle.client_id ?? null,
    p_sender_id: bundle.sender_id ?? null,
    },
  );

  if (error) {
    logRenderer("warn", "bundle_file_lookup_failed", { error });
    return targets;
  }

  (data as Array<Record<string, unknown>> | null | undefined)?.forEach((row) => {
    targets.push({
      labelId: typeof row?.label_id === "string" ? (row.label_id as string) : null,
      shipmentId: typeof row?.shipment_id === "string" ? (row.shipment_id as string) : null,
      shipmentBoxId: typeof row?.shipment_box_id === "string" ? (row.shipment_box_id as string) : null,
      targetType: typeof row?.target_type === "string" ? (row.target_type as string) : null,
      targetId: typeof row?.target_id === "string" ? (row.target_id as string) : null,
      targetBoxId: typeof row?.target_box_id === "string" ? (row.target_box_id as string) : null,
      fileUrl: typeof row?.file_url === "string" ? (row.file_url as string) : null,
      boxNumber: typeof row?.box_number === "number" ? (row.box_number as number) : null,
    });
  });

  return dedupeBundleTargets(targets);
};

const downloadLabelPdf = async (filePath: string | null | undefined): Promise<Uint8Array | null> => {
  if (!filePath) return null;
  const { data, error } = await storageDownloadObject(LABEL_BUCKET, filePath);
  if (error || !data) {
    logRenderer("warn", "label_asset_download_failed", { error });
    return null;
  }
  return new Uint8Array(await data.arrayBuffer());
};

const downloadLabelPdfViaSignedUrl = async (
  filePath: string,
  signedUrl: string,
): Promise<Uint8Array | null> => {
  try {
    const response = await fetch(signedUrl);
    if (!response.ok) {
      logRenderer("warn", "signed_label_download_failed", { status: response.status });
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (err) {
    logRenderer("warn", "signed_label_download_failed", { error: err });
    return null;
  }
};

const createSignedUrlsForBundle = async (
  filePaths: string[],
  expiresSeconds: number,
): Promise<Map<string, string>> => {
  const resolved = new Map<string, string>();
  const deduped = Array.from(new Set(filePaths.filter((path) => typeof path === "string" && path.trim().length > 0)));
  if (deduped.length === 0) return resolved;

  try {
    const { data, error } = await storageCreateSignedUrls(LABEL_BUCKET, deduped, expiresSeconds);
    if (error) {
      logRenderer("warn", "bundle_chunk_url_signing_failed", { error });
      return resolved;
    }
    if (!Array.isArray(data)) return resolved;

    for (const row of data) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      const path =
        (record.path as string | undefined) ??
        (record.name as string | undefined) ??
        (record.filePath as string | undefined) ??
        (record.file_path as string | undefined) ??
        undefined;
      const signedUrl =
        (record.signedUrl as string | undefined) ??
        (record.signedURL as string | undefined) ??
        (record.url as string | undefined) ??
        (record.signed_url as string | undefined) ??
        undefined;
      if (typeof path === "string" && typeof signedUrl === "string" && path.length > 0 && signedUrl.length > 0) {
        resolved.set(path, signedUrl);
      }
    }
  } catch (err) {
    logRenderer("warn", "bundle_chunk_url_signing_failed", { error: err });
  }

  return resolved;
};

const mapWithConcurrency = async <T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(limit || 1), items.length));
  const workers = Array.from({ length: workerCount }).map(async () => {
    while (true) {
      const idx = next;
      next += 1;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
};

const buildBundleDocument = async (
  targets: BundleTarget[],
  options: {
    downloadConcurrency: number;
    chunkSize: number;
    signedUrlExpiresSeconds?: number;
    preloadedBytesByFilePath?: Map<string, Uint8Array>;
  },
) => {
  await ensureRendererDeps();
  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const bundled: BundleTarget[] = [];
  const placeholders: BundleTarget[] = [];

  const totalStart = performance.now();
  const downloadConcurrency = Number.isFinite(Number(options.downloadConcurrency))
    ? Math.max(1, Math.min(25, Math.floor(Number(options.downloadConcurrency))))
    : 8;
  const chunkSize = Number.isFinite(Number(options.chunkSize)) ? Math.max(1, Math.floor(Number(options.chunkSize))) : targets.length;
  const signedUrlExpiresSeconds = Number.isFinite(Number(options.signedUrlExpiresSeconds)) && Number(options.signedUrlExpiresSeconds) > 0
    ? Math.floor(Number(options.signedUrlExpiresSeconds))
    : 60;

  let signedUrlsMs = 0;
  let downloadMs = 0;
  let mergeMs = 0;
  let preloadedCount = 0;
  let downloadedCount = 0;

  const preloadedMap = options.preloadedBytesByFilePath instanceof Map
    ? options.preloadedBytesByFilePath
    : new Map<string, Uint8Array>();

  for (let start = 0; start < targets.length; start += chunkSize) {
    const chunk = targets.slice(start, start + chunkSize);
    const filePaths = chunk
      .map((target) => target.fileUrl)
      .filter((path): path is string => typeof path === "string" && path.length > 0);
    const pathsNeedingSignedUrls = filePaths.filter((path) => !preloadedMap.has(path));

    let signedUrlMap = new Map<string, string>();
    if (pathsNeedingSignedUrls.length > 0) {
      const signedUrlStart = performance.now();
      signedUrlMap = await createSignedUrlsForBundle(pathsNeedingSignedUrls, signedUrlExpiresSeconds);
      signedUrlsMs += performance.now() - signedUrlStart;
    }

    const chunkDownloadStart = performance.now();
    const bytesByIndex = await mapWithConcurrency(chunk, downloadConcurrency, async (target) => {
      const filePath = target.fileUrl ?? undefined;
      if (!filePath) return null;
      const preloaded = preloadedMap.get(filePath);
      if (preloaded) {
        preloadedCount += 1;
        return preloaded;
      }
      const signedUrl = signedUrlMap.get(filePath);
      if (signedUrl) {
        const bytes = await downloadLabelPdfViaSignedUrl(filePath, signedUrl);
        if (bytes) {
          downloadedCount += 1;
          return bytes;
        }
      }
      const fallback = await downloadLabelPdf(filePath);
      if (fallback) downloadedCount += 1;
      return fallback;
    });
    downloadMs += performance.now() - chunkDownloadStart;

    const chunkMergeStart = performance.now();
    for (let i = 0; i < chunk.length; i++) {
      const target = chunk[i];
      const bytes = bytesByIndex[i];
      if (bytes && bytes.byteLength > 0) {
        try {
          const src = await PDFDocument.load(bytes);
          const pages = await doc.copyPages(src, src.getPageIndices());
          for (const page of pages) {
            doc.addPage(page);
          }
          bundled.push(target);
          continue;
        } catch (err) {
          logRenderer("warn", "label_pdf_merge_failed", { error: err });
        }
      }

      placeholders.push(target);
      const page = doc.addPage([288, 432]);
      page.drawRectangle({ x: 20, y: 380, width: 248, height: 32, color: rgb(0.95, 0.95, 0.95) });
      page.drawText("Label Preview Unavailable", {
        x: 32,
        y: 392,
        font: helveticaBold,
        size: 12,
        color: rgb(0.2, 0.2, 0.2),
      });
      page.drawText(`Label: ${target.labelId ?? "n/a"}`, {
        x: 32,
        y: 360,
        font: helvetica,
        size: 10,
        color: rgb(0.2, 0.2, 0.2),
      });
      page.drawText(
        `Target: ${target.targetType ?? (target.shipmentId ? "shipment" : "unknown")} ${target.targetId ?? target.shipmentId ?? "n/a"}`,
        {
          x: 32,
          y: 340,
          font: helvetica,
          size: 10,
          color: rgb(0.25, 0.25, 0.25),
        },
      );
      if (target.targetBoxId ?? target.shipmentBoxId) {
        page.drawText(`Target Box: ${target.targetBoxId ?? target.shipmentBoxId ?? "n/a"}`, {
          x: 32,
          y: 322,
          font: helvetica,
          size: 10,
          color: rgb(0.25, 0.25, 0.25),
        });
      }
      if (target.shipmentId && target.targetType !== "shipment") {
        page.drawText(`Shipment: ${target.shipmentId}`, {
          x: 32,
          y: 304,
          font: helvetica,
          size: 10,
          color: rgb(0.25, 0.25, 0.25),
        });
      }
    }
    mergeMs += performance.now() - chunkMergeStart;
  }

  if (doc.getPageCount() === 0) {
    const page = doc.addPage([288, 432]);
    page.drawText("No labels available for bundling.", {
      x: 32,
      y: 360,
      font: helvetica,
      size: 12,
      color: rgb(0.2, 0.2, 0.2),
    });
  }

  const saveStart = performance.now();
  const bytes = new Uint8Array(await doc.save());
  const saveMs = performance.now() - saveStart;
  const totalMs = performance.now() - totalStart;
  return {
    bytes,
    bundled,
    placeholders,
    timings: {
      signed_urls_ms: signedUrlsMs,
      download_ms: downloadMs,
      merge_ms: mergeMs,
      save_ms: saveMs,
      total_ms: totalMs,
      preloaded_count: preloadedCount,
      downloaded_count: downloadedCount,
      download_concurrency: downloadConcurrency,
      chunk_size: chunkSize,
      signed_url_expires_seconds: signedUrlExpiresSeconds,
    },
  };
};

const buildBundleArtifactFromTargets = async (
  targets: BundleTarget[],
  options: {
    downloadConcurrency: number;
    chunkSize: number;
    signedUrlExpiresSeconds: number;
    preloadedBytesByFilePath?: Map<string, Uint8Array>;
  },
) => {
  return await buildBundleDocument(targets, options);
};

const logDecisionBestEffort = async (
  payload: Record<string, unknown>,
  context: string,
) => {
  const { error } = await callRpcWithPublicFallback<unknown>("log_decision", payload);
  if (error) {
    logRenderer("warn", "decision_log_failed", { operation: context, error });
  }
};

const handlePrintRequest = async (
  payload: any,
  correlationId: string,
  integration: IntegrationContext | null,
): Promise<{ statusCode: number; body: Record<string, unknown> }> => {
  if (!integration) {
    return { statusCode: 401, body: { status: "error", error: "Unauthorized token" } };
  }

  const printInput: PrintRequest | null =
    payload?.print && typeof payload.print === "object"
      ? ({ ...payload.print, organization_id: payload.print.organization_id ?? payload.organization_id } as PrintRequest)
      : payload && typeof payload === "object"
      ? (payload as PrintRequest)
      : null;

  const incomingOrgId = typeof printInput?.organization_id === "string"
    ? printInput.organization_id
    : null;
  const incomingClientId = typeof (printInput as any)?.client_id === "string" ? (printInput as any).client_id : null;
  const incomingSenderId = typeof (printInput as any)?.sender_id === "string" ? (printInput as any).sender_id : null;

  if (!printInput || !incomingOrgId) {
    return { statusCode: 400, body: { status: "error", error: "organization_id and print payload are required" } };
  }

  const shipments = Array.isArray(printInput.shipments) ? printInput.shipments : [];
  const normalizedShipments = shipments
    .map((entry) => ({
      shipment_id: typeof entry?.shipment_id === "string" ? entry.shipment_id : "",
      box_ids: Array.isArray(entry?.box_ids)
        ? entry.box_ids.filter((value): value is string => typeof value === "string" && value.length > 0)
        : undefined,
    }))
    .filter((entry) => entry.shipment_id.length > 0);

  const labelTypeRaw = typeof (printInput as any)?.label_type === "string" ? (printInput as any).label_type : "shipping";
  const labelType = labelTypeRaw.trim().toLowerCase() || "shipping";
  const targetEntries = Array.isArray((printInput as any)?.targets) ? (printInput as any).targets : [];
  const normalizedTargets = targetEntries
    .map((entry) => {
      const targetType = normalizeLabelTargetType(entry?.target_type);
      const targetId = normalizeString(entry?.target_id) ?? normalizeString(entry?.shipment_id);
      const targetBoxId = normalizeString(entry?.target_box_id);
      const entryLabelType = normalizeString(entry?.label_type);
      const resolvedLabelType =
        entryLabelType ?? (labelType !== "shipping" ? labelType : defaultLabelTypeForTargetType(targetType));
      return {
        target_type: targetType,
        target_id: targetId,
        target_box_id: targetBoxId,
        label_type: resolvedLabelType,
      };
    })
    .filter(
      (entry) =>
        typeof entry.target_type === "string" &&
        entry.target_type.length > 0 &&
        typeof entry.target_id === "string" &&
        entry.target_id.length > 0,
    );

  if (normalizedTargets.length > 0 && normalizedShipments.length > 0) {
    return { statusCode: 400, body: { status: "error", error: "use either targets or shipments, not both" } };
  }

  if (normalizedTargets.length === 0 && normalizedShipments.length === 0) {
    return { statusCode: 400, body: { status: "error", error: "shipments array is required" } };
  }

  const workflowStepProgress = resolveWorkflowProgress(printInput);
  const workflowRunStepId = workflowStepProgress?.workflowRunStepId ?? null;
  const workflowManagedPrint = Boolean(workflowRunStepId);

  const policy = await resolveLabelPrintPolicy(integration, incomingOrgId, incomingClientId, incomingSenderId);
  const edgeDbMode = resolveEdgeDbMode((policy as any)?.edge_db_mode);
  const bundleReturnMode = resolveBundleReturnMode(policy, workflowManagedPrint);
  const expiresSecondsRaw = Number((printInput as any)?.expires_seconds);
  const requestedExpiresSeconds =
    Number.isFinite(expiresSecondsRaw) && expiresSecondsRaw >= 60
      ? Math.floor(expiresSecondsRaw)
      : null;
  const policyDefaultTtlRaw = Number((policy as any)?.default_expires_seconds);
  const policyDefaultTtl =
    Number.isFinite(policyDefaultTtlRaw) && policyDefaultTtlRaw >= 60
      ? Math.floor(policyDefaultTtlRaw)
      : requestedExpiresSeconds;
  if (!Number.isFinite(policyDefaultTtl ?? Number.NaN) || (policyDefaultTtl ?? 0) < 60) {
    const responseBody = {
      status: "failed",
      error: "label_print_policy default_expires_seconds missing and expires_seconds not provided",
      reason: "label_print_policy_invalid",
    };
    return await returnPrintResponse(500, responseBody);
  }
  const freshGenerationRequired = readBooleanSetting(
    (policy as any)?.fresh_generation_required,
    true,
  );
  const requestedJobPurpose = normalizeString(printInput.job_purpose)?.toLowerCase();
  // Fresh-generation policy forbids primary reuse, but preserves explicit manual/reprint intent.
  const jobPurpose = requestedJobPurpose === "manual" || requestedJobPurpose === "reprint"
    ? requestedJobPurpose
    : freshGenerationRequired ? "reprint" : "primary";
  const printSyncCompactEnabled = readBooleanSetting(
    (policy as any)?.print_sync_compact_enabled,
    true,
  );
  const singleFilePassthroughEnabled = readBooleanSetting(
    (policy as any)?.single_file_passthrough_enabled,
    true,
  );
  const singleFilePassthroughMaxBytesRaw = Number((policy as any)?.single_file_passthrough_max_bytes);
  const singleFilePassthroughMaxBytes =
    Number.isFinite(singleFilePassthroughMaxBytesRaw) && singleFilePassthroughMaxBytesRaw > 0
      ? Math.max(1024, Math.min(104857600, Math.floor(singleFilePassthroughMaxBytesRaw)))
      : 4194304;
  const printRequestSource = `label_print_sync:${correlationId}`;

  const runStartMs = Date.now();
  const startedAt = new Date(runStartMs).toISOString();
  const steps: Array<Record<string, unknown>> = [];
  const recordStep = (name: string, startMs: number, extra: Record<string, unknown> = {}) => {
    steps.push({
      step: name,
      started_at: new Date(startMs).toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: Date.now() - startMs,
      ...extra,
    });
  };
  const resolveRecordedStep = (name: string) =>
    steps.find((step) => step.step === name) as Record<string, unknown> | undefined;
  const resolveRecordedDuration = (name: string) => {
    const duration = Number(resolveRecordedStep(name)?.duration_ms);
    return Number.isFinite(duration) ? Math.round(duration) : null;
  };
  const buildPrintTimingSummary = (totalMs: number, completeMs?: number | null) => ({
    total_ms: totalMs,
    enqueue_ms: resolveRecordedDuration("enqueue_label_jobs"),
    render_ms: resolveRecordedDuration("render_label_jobs"),
    bundle_ms: resolveRecordedDuration("bundle_labels"),
    complete_ms:
      typeof completeMs === "number" && Number.isFinite(completeMs)
        ? Math.round(completeMs)
        : null,
  });
  const returnPrintResponse = async (
    statusCode: number,
    body: Record<string, unknown>,
  ) => {
    const responseBody = { ...body, job_purpose: jobPurpose };
    schedulePrintWorkflowResult(printInput, responseBody);
    return { statusCode, body: responseBody };
  };

  const expiresSeconds = Math.min(
    Math.max(requestedExpiresSeconds ?? policyDefaultTtl, 60),
    Math.max(policyDefaultTtl, 60),
  );

  const renderMaxJobsRaw = Number((policy as any)?.render_max_jobs);
  const renderJobConcurrencyRaw = Number((policy as any)?.render_job_concurrency);
  const renderLeaseSecondsRaw = Number((policy as any)?.render_lease_seconds);
  const renderMaxCallsRaw = Number((policy as any)?.render_max_calls);
  const maxWaitSecondsRaw = Number((policy as any)?.max_wait_seconds);
  const leaseRecoveryMaxAttemptsRaw = Number((policy as any)?.print_sync_lease_recovery_max_attempts);
  const leaseRecoveryPollMsRaw = Number((policy as any)?.print_sync_lease_recovery_poll_ms);

  const renderMaxJobs =
    Number.isFinite(renderMaxJobsRaw) && renderMaxJobsRaw > 0 ? Math.floor(renderMaxJobsRaw) : 25;
  const renderJobConcurrency =
    Number.isFinite(renderJobConcurrencyRaw) && renderJobConcurrencyRaw > 0 ? Math.floor(renderJobConcurrencyRaw) : 10;
  const renderLeaseSeconds =
    Number.isFinite(renderLeaseSecondsRaw) && renderLeaseSecondsRaw > 0 ? Math.floor(renderLeaseSecondsRaw) : 60;
  const renderMaxCalls =
    Number.isFinite(renderMaxCallsRaw) && renderMaxCallsRaw > 0 ? Math.floor(renderMaxCallsRaw) : 20;
  const maxWaitSeconds =
    Number.isFinite(maxWaitSecondsRaw) && maxWaitSecondsRaw > 0 ? Math.floor(maxWaitSecondsRaw) : 900;
  const leaseRecoveryMaxAttempts =
    Number.isFinite(leaseRecoveryMaxAttemptsRaw) && leaseRecoveryMaxAttemptsRaw > 0
      ? Math.floor(leaseRecoveryMaxAttemptsRaw)
      : 8;
  const leaseRecoveryPollMs =
    Number.isFinite(leaseRecoveryPollMsRaw) && leaseRecoveryPollMsRaw > 0
      ? Math.floor(leaseRecoveryPollMsRaw)
      : 250;

  const clampedRenderMaxJobs = Math.max(1, Math.min(100, renderMaxJobs));
  const clampedRenderConcurrency = Math.max(1, Math.min(25, renderJobConcurrency));
  const clampedLeaseSeconds = Math.max(60, Math.min(600, renderLeaseSeconds));
  const clampedMaxCalls = Math.max(1, Math.min(50, renderMaxCalls));
  const clampedLeaseRecoveryMaxAttempts = Math.max(1, Math.min(40, leaseRecoveryMaxAttempts));
  const clampedLeaseRecoveryPollMs = Math.max(50, Math.min(5000, leaseRecoveryPollMs));
  const deadlineMs = Date.now() + Math.max(60, Math.min(3600, maxWaitSeconds)) * 1000;

  const client = ensureSupabase();

  const enqueueStart = Date.now();
  const jobIds: string[] = [];
  const orderedJobIds: string[] = [];
  let enqueueInsertedCount: number | null = null;
  let enqueueReusedCount: number | null = null;
  try {
    if (normalizedTargets.length > 0) {
      for (const target of normalizedTargets) {
        const enqueueRpc = workflowRunStepId
          ? "request_label_generation_target_for_step_v1"
          : "request_label_generation_target_v1";
        const enqueueArgs = workflowRunStepId
          ? {
              p_workflow_run_step_id: workflowRunStepId,
              p_target_type: target.target_type,
              p_target_id: target.target_id,
              p_label_type: target.label_type,
              p_requested_by: null,
              p_requested_source: printRequestSource,
              p_target_box_id: target.target_box_id,
              p_job_purpose: jobPurpose,
            }
          : {
              p_target_type: target.target_type,
              p_target_id: target.target_id,
              p_label_type: target.label_type,
              p_requested_by: null,
              p_requested_source: printRequestSource,
              p_target_box_id: target.target_box_id,
              p_job_purpose: jobPurpose,
            };
        const { data, error } = await callRendererRpc<string | { job_id?: string }>(
          client,
          enqueueRpc,
          enqueueArgs,
          edgeDbMode,
        );
        if (error) {
          throw new Error(`${enqueueRpc} failed: ${error.message}`);
        }
        const jobId = typeof data === "string" ? data : typeof (data as any)?.job_id === "string" ? (data as any).job_id : null;
        if (!jobId) {
          throw new Error(`${enqueueRpc} returned no job id`);
        }
        jobIds.push(jobId);
        orderedJobIds.push(jobId);
      }
    } else {
      const enqueueRpc = workflowRunStepId
        ? "request_label_generation_bulk_compact_for_step_v1"
        : "request_label_generation_bulk_compact_v1";
      const enqueueArgs = workflowRunStepId
        ? {
            p_workflow_run_step_id: workflowRunStepId,
            p_shipments: normalizedShipments,
            p_label_type: labelType,
            p_requested_by: null,
            p_requested_source: printRequestSource,
            p_job_purpose: jobPurpose,
          }
        : {
            p_shipments: normalizedShipments,
            p_label_type: labelType,
            p_requested_by: null,
            p_requested_source: printRequestSource,
            p_job_purpose: jobPurpose,
          };
      const { data, error } = await callRendererRpc<any>(
        client,
        enqueueRpc,
        enqueueArgs,
        edgeDbMode,
      );
      if (error) {
        throw new Error(`${enqueueRpc} failed: ${error.message}`);
      }
      const jobIdValues = Array.isArray((data as any)?.job_ids)
        ? (data as any).job_ids
        : Array.isArray(data)
        ? (data as any[]).map((row) => row?.job_id)
        : [];
      const insertedCount = Number((data as any)?.inserted_count);
      const reusedCount = Number((data as any)?.reused_count);
      enqueueInsertedCount = Number.isFinite(insertedCount) ? Math.max(0, Math.floor(insertedCount)) : null;
      enqueueReusedCount = Number.isFinite(reusedCount) ? Math.max(0, Math.floor(reusedCount)) : null;
      jobIdValues.forEach((value) => {
        const id = typeof value === "string" ? value : null;
        if (!id) return;
        jobIds.push(id);
        orderedJobIds.push(id);
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to enqueue label jobs";
    recordStep("enqueue_label_jobs", enqueueStart, { ok: false, error: message });
    return await returnPrintResponse(500, { status: "error", error: message, steps });
  }

  const uniqueJobIds = Array.from(new Set(jobIds));
  const uniqueOrderedJobIds: string[] = [];
  const orderedSeen = new Set<string>();
  orderedJobIds.forEach((jobId) => {
    if (!orderedSeen.has(jobId)) {
      uniqueOrderedJobIds.push(jobId);
      orderedSeen.add(jobId);
    }
  });
  uniqueJobIds.forEach((jobId) => {
    if (!orderedSeen.has(jobId)) {
      uniqueOrderedJobIds.push(jobId);
      orderedSeen.add(jobId);
    }
  });
  recordStep("enqueue_label_jobs", enqueueStart, {
    ok: true,
    shipments: normalizedShipments.length,
    targets: normalizedTargets.length,
    job_count: uniqueJobIds.length,
    inserted_count: enqueueInsertedCount,
    reused_count: enqueueReusedCount,
    edge_db_mode: edgeDbMode,
    concurrency: Math.max(1, Math.min(25, clampedRenderConcurrency)),
    label_type: labelType,
    fresh_generation_required: freshGenerationRequired,
    job_purpose: jobPurpose,
    requested_source: printRequestSource,
  });

  const printSyncBundleStrategy =
    normalizeString((policy as any)?.print_sync_bundle_strategy) ?? "merge";
  if (printSyncBundleStrategy === "direct") {
    const renderStart = Date.now();
    const renderCalls: Array<Record<string, unknown>> = [];

    try {
      await assertLabelBucketAvailable();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Label bucket unavailable";
      recordStep("render_label_jobs", renderStart, { ok: false, error: message });
      return await returnPrintResponse(503, {
        status: "error",
        error: message,
        artifact_kind: "bundle",
        steps,
      });
    }

    const orderedIds = uniqueOrderedJobIds;
    const bundleId = crypto.randomUUID();
    const safeOutputName = ((printInput as any)?.output_name ?? `labels_bundle_${bundleId}.pdf`)
      .replace(/[^A-Za-z0-9_.-]/g, "-");
    const filePath = `${incomingOrgId}/bundles/${bundleId}.pdf`;

    if (singleFilePassthroughEnabled && orderedIds.length === 1) {
      const singleJobId = orderedIds[0];
      let leaseMs = 0;
      let composeMs = 0;
      let renderMs = 0;
      let signedMs = 0;
      let completeMs = 0;
      let compactComposeUsed = false;
      let compactComposeFallbackReason: string | null = null;
      const passthroughStart = Date.now();
      try {
        let leasedJob: LabelJob | null = null;
        let composedPayload: Record<string, any> | null = null;
        let resolvedComposeMs = 0;

        const compactStart = performance.now();
        const { data: compactRows, error: compactError } = await callRendererRpc<any[]>(
          client,
          "lease_and_compose_label_payloads_compact",
          {
            p_job_ids: [singleJobId],
            p_lease_seconds: clampedLeaseSeconds,
            p_max_jobs: 1,
          },
          edgeDbMode,
        );
        const compactMs = performance.now() - compactStart;
        if (!compactError && Array.isArray(compactRows) && compactRows.length === 1) {
          const compactRow = compactRows[0] as Record<string, unknown>;
          const compactComposed = asRecord(compactRow?.composed);
          const compactJob = asRecord(compactComposed?.job);
          const compactPayload = asRecord(compactComposed?.payload);
          if (compactComposed && compactJob && compactPayload) {
            const compactTemplate = asRecord(compactJob.template);
            const compactTemplateVersionRaw = Number(
              compactTemplate?.template_version ?? compactJob.template_version,
            );
            const compactAttemptsRaw = Number(compactJob.attempts);
            leasedJob = {
              id: normalizeString(compactJob.id) ?? singleJobId,
              organization_id: normalizeString(compactJob.organization_id) ?? incomingOrgId,
              client_id: normalizeString(compactJob.client_id),
              target_type: normalizeString(compactJob.target_type),
              target_id:
                normalizeString(compactJob.target_id) ??
                normalizedTargets[0]?.target_id ??
                normalizedShipments[0]?.shipment_id ??
                null,
              target_box_id:
                normalizeString(compactJob.target_box_id) ??
                normalizedTargets[0]?.target_box_id ??
                null,
              target_metadata: asRecord(compactJob.target_metadata) ?? null,
              shipment_id:
                normalizeString(compactJob.shipment_id) ??
                normalizedTargets[0]?.target_id ??
                normalizedShipments[0]?.shipment_id ??
                null,
              shipment_box_id: normalizeString(compactJob.shipment_box_id),
              label_id: normalizeString(compactJob.label_id),
              label_type: normalizeString(compactJob.label_type),
              job_purpose: normalizeString(compactJob.job_purpose),
              renderer_hint: normalizeString(compactJob.renderer_hint),
              template_id:
                normalizeString(compactTemplate?.template_id) ??
                normalizeString(compactJob.template_id),
              template_version: Number.isFinite(compactTemplateVersionRaw)
                ? Math.max(0, Math.trunc(compactTemplateVersionRaw))
                : null,
              attempts: Number.isFinite(compactAttemptsRaw)
                ? Math.max(0, Math.trunc(compactAttemptsRaw))
                : 0,
            };
            composedPayload = compactComposed;
            const compactComposeMsRaw = Number(compactRow?.compose_ms);
            resolvedComposeMs = Number.isFinite(compactComposeMsRaw) && compactComposeMsRaw > 0
              ? compactComposeMsRaw
              : compactMs;
            leaseMs = compactMs;
            composeMs = resolvedComposeMs;
            compactComposeUsed = true;
          } else {
            compactComposeFallbackReason = "lease_and_compose_label_payloads_compact missing composed payload";
          }
        } else if (compactError) {
          compactComposeFallbackReason = `lease_and_compose_label_payloads_compact failed: ${compactError.message}`;
        } else {
          const count = Array.isArray(compactRows) ? compactRows.length : 0;
          compactComposeFallbackReason = `lease_and_compose_label_payloads_compact returned ${count}/1 rows`;
        }

        if (!compactComposeUsed) {
          const leaseStart = performance.now();
          const { data: leasedRows, error: leaseError } = await callRendererRpc<LabelJob[]>(
            client,
            "lease_label_jobs_by_ids",
            {
              p_job_ids: [singleJobId],
              p_lease_seconds: clampedLeaseSeconds,
              p_max_jobs: 1,
            },
            edgeDbMode,
          );
          leaseMs = performance.now() - leaseStart;
          if (leaseError) {
            throw new Error(`lease_label_jobs_by_ids failed: ${leaseError.message}`);
          }
          leasedJob = Array.isArray(leasedRows) && leasedRows.length > 0
            ? (leasedRows[0] as LabelJob)
            : null;
          if (!leasedJob) {
            throw new Error("single-file passthrough lease returned no rows");
          }

          const composeStart = performance.now();
          const { data: composedRows, error: composeError } = await callRendererRpc<any[]>(
            client,
            "compose_label_payloads",
            {
              p_job_ids: [singleJobId],
            },
            edgeDbMode,
          );
          composeMs = performance.now() - composeStart;
          if (composeError) {
            throw new Error(`compose_label_payloads failed: ${composeError.message}`);
          }
          const composedRow = Array.isArray(composedRows)
            ? (composedRows as any[]).find((row) => normalizeString(row?.job_id) === singleJobId) ??
              (composedRows as any[])[0]
            : null;
          if (!composedRow || !composedRow.composed || typeof composedRow.composed !== "object") {
            throw new Error("single-file passthrough composed payload missing");
          }
          const composedMsRaw = Number(composedRow.compose_ms);
          resolvedComposeMs =
            Number.isFinite(composedMsRaw) && composedMsRaw > 0 ? composedMsRaw : composeMs;
          composedPayload = composedRow.composed as Record<string, any>;
        }

        if (!leasedJob || !composedPayload) {
          throw new Error("single-file passthrough missing leased job or composed payload");
        }

        const renderStartMs = performance.now();
        const rendered = await renderAndUploadLabelFromComposedPayload(
          leasedJob,
          correlationId,
          integration,
          composedPayload,
          resolvedComposeMs,
        );
        renderMs = performance.now() - renderStartMs;
        if (rendered.status !== "ok" || !rendered.file_url) {
          const failPayload = [
            {
              job_id: singleJobId,
              status: "failed",
              file_url: null,
              file_size_bytes: null,
              renderer_metadata: rendered.metadata ?? {},
              error_reason: rendered.error ?? "single_file_passthrough_failed",
            },
          ];
          const { error: completeFailError } = await callRendererRpc(
            client,
            "complete_label_jobs",
            { p_results: failPayload },
            edgeDbMode,
          );
          if (completeFailError) {
            logRenderer("warn", "complete_failed_label_job_failed", { error: completeFailError });
          }
          throw new Error(rendered.error ?? "single-file passthrough render failed");
        }

        if (
          Number.isFinite(singleFilePassthroughMaxBytes) &&
          singleFilePassthroughMaxBytes > 0 &&
          Number.isFinite(rendered.file_size_bytes ?? NaN) &&
          Number(rendered.file_size_bytes) > singleFilePassthroughMaxBytes
        ) {
          throw new Error(
            `single-file passthrough max bytes exceeded (${rendered.file_size_bytes} > ${singleFilePassthroughMaxBytes})`,
          );
        }

        const completionPayload = [
          {
            job_id: singleJobId,
            status: "succeeded",
            file_url: rendered.file_url,
            file_size_bytes: rendered.file_size_bytes,
            renderer_metadata: {
              ...(rendered.metadata ?? {}),
              bundle: {
                bundle_id: bundleId,
                file_path: rendered.file_url,
                page_index: 1,
                page_count: 1,
                output_name: safeOutputName,
                strategy: "single_file_passthrough",
                passthrough: true,
              },
            },
            error_reason: null,
          },
        ];

        const artifactReturn = await resolveArtifactReturn(
          rendered.file_url,
          expiresSeconds,
          bundleReturnMode,
        );
        signedMs = artifactReturn.signed_ms;
        const signedUrl: string | null = artifactReturn.signed_url;
        const expiresAt: string | null = artifactReturn.expires_at;
        const jobCompletionPending = false;
        const completeStart = performance.now();
        const { error: completeError } = await callRendererRpc(
          client,
          "complete_label_jobs",
          { p_results: completionPayload },
          edgeDbMode,
        );
        completeMs = performance.now() - completeStart;
        if (completeError) {
          throw new Error(`complete_label_jobs failed: ${completeError.message}`);
        }

        recordStep("render_label_jobs", renderStart, {
          requested_jobs: 1,
          pending_remaining: jobCompletionPending ? 1 : 0,
          failed_jobs: 0,
          max_jobs: 1,
          concurrency: 1,
          lease_seconds: clampedLeaseSeconds,
          max_calls: 1,
          calls: [
            {
              call_index: 1,
              leased: 1,
              lease_ms: Math.round(leaseMs),
              compose_ms: Math.round(composeMs),
              render_ms: Math.round(renderMs),
              signed_url_ms: Math.round(signedMs),
              complete_ms: jobCompletionPending ? null : Math.round(completeMs),
              strategy: "single_file_passthrough",
              compact_compose_used: compactComposeUsed,
              compact_compose_fallback_reason: compactComposeFallbackReason ?? undefined,
            },
          ],
          bundle_strategy: "direct",
          single_file_passthrough_enabled: true,
          single_file_passthrough_max_bytes: singleFilePassthroughMaxBytes,
          fresh_generation_required: freshGenerationRequired,
          job_purpose: jobPurpose,
          rendered_pages: 1,
        });

        const completedAt = new Date().toISOString();
        const totalMs = Date.now() - runStartMs;
        const bundleBody: Record<string, unknown> = {
          status: "ok",
          artifact_kind: "single_file",
          organization_id: incomingOrgId,
          client_id: incomingClientId ?? null,
          bundle_id: bundleId,
          file_path: rendered.file_url,
          file_url: rendered.file_url,
          signed_url: signedUrl,
          expires_seconds: expiresSeconds,
          expires_at: expiresAt,
          started_at: new Date(runStartMs).toISOString(),
          completed_at: completedAt,
          output_name: safeOutputName,
          counts: {
            requested: 1,
            bundled: 1,
            placeholders: 0,
          },
          timings: {
            lease_ms: Math.round(leaseMs),
            compose_ms: Math.round(composeMs),
            render_ms: Math.round(renderMs),
            signed_url_ms: Math.round(signedMs),
            complete_ms: jobCompletionPending ? null : Math.round(completeMs),
            total_ms: totalMs,
          },
          job_completion_pending: jobCompletionPending,
          bundled_labels: [],
          placeholder_labels: [],
          metadata: printInput.metadata ?? null,
        };

        if (!workflowManagedPrint) {
          try {
            await client.rpc("log_decision", {
              p_organization_id: incomingOrgId,
              p_decision_category: "label_print",
              p_resource_type: "label_bundle",
              p_resource_id: bundleId,
              p_decision_point: "bundle_edge",
              p_decision_outcome: "completed",
              p_performed_by_system: "label_renderer",
              p_correlation_id: correlationId,
              p_decision_inputs: {
                counts: { requested: 1, bundled: 1, placeholders: 0 },
                expires_seconds: expiresSeconds,
                signed_url: signedUrl,
                started_at: new Date(runStartMs).toISOString(),
                completed_at: completedAt,
                output_name: safeOutputName,
                bucket: LABEL_BUCKET,
                bundle_size_bytes: rendered.file_size_bytes ?? null,
                strategy: "single_file_passthrough",
                timings: (bundleBody as any).timings,
                client_id: incomingClientId ?? null,
                sender_id: incomingSenderId ?? null,
                integration_kind: integration.kind,
                source_id: integration.kind === "source" ? integration.sourceId : null,
                provider_name: integration.kind === "provider" ? integration.providerName : null,
              },
              p_decision_reason: null,
            });
          } catch (_err) {
            // ignore
          }
        }

        scheduleMetricEmit("label_bundle.completed", {
          org: incomingOrgId,
          client: incomingClientId ?? null,
          sender: incomingSenderId ?? null,
          integration: integration.kind,
          bucket: LABEL_BUCKET,
        }, {
          requested: 1,
          bundled: 1,
          placeholders: 0,
          bundle_size_bytes: rendered.file_size_bytes ?? null,
          strategy: "single_file_passthrough",
        });

        recordStep("bundle_labels", passthroughStart, {
          status: 200,
          outcome: "ok",
          strategy: "single_file_passthrough",
          job_completion_pending: jobCompletionPending,
        });

        return await returnPrintResponse(200, {
          status: "ok",
          mode: "print_sync",
          artifact_kind: "single_file",
          organization_id: incomingOrgId,
          client_id: incomingClientId ?? null,
          sender_id: incomingSenderId ?? null,
          job_completion_pending: jobCompletionPending,
          started_at: startedAt,
          completed_at: completedAt,
          counts: bundleBody.counts,
          timings: buildPrintTimingSummary(totalMs, jobCompletionPending ? null : completeMs),
          steps,
          bundle: bundleBody,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        renderCalls.push({
          call_index: renderCalls.length + 1,
          leased: 1,
          lease_ms: Math.round(leaseMs),
          compose_ms: Math.round(composeMs),
          render_ms: Math.round(renderMs),
          signed_url_ms: Math.round(signedMs),
          complete_ms: Math.round(completeMs),
          strategy: "single_file_passthrough",
          compact_compose_used: compactComposeUsed,
          compact_compose_fallback_reason: compactComposeFallbackReason ?? undefined,
          fallback_reason: message,
        });
      }
    }

    const batches: string[][] = [];
    for (let i = 0; i < orderedIds.length; i += clampedRenderMaxJobs) {
      batches.push(orderedIds.slice(i, i + clampedRenderMaxJobs));
    }

    const composedByJobId = new Map<string, { composed: Record<string, any>; composeMs: number }>();
    const perJob = new Map<
      string,
      {
        composeMs: number;
        renderMs: number;
        rendererMetadata: Record<string, unknown>;
        settingsResolution: Record<string, unknown>;
        pageIndex: number;
        attempts: number;
      }
    >();

    await ensureRendererDeps();
    const pdfDoc = await PDFDocument.create();
    const fontCache = new Map<string, EmbeddedFontPromise>();
    const templateCache = new Map<
      string,
      {
        assets: Map<string, LoadedAsset>;
        assetsLoaded: number;
        dotPt: number;
        getAssetEmbed: (ref?: string) => Promise<Awaited<ReturnType<PDFDocument["embedPng"]>> | null>;
        assetsMissing?: string[];
      }
    >();

    let pageIndex = 0;
    for (const batchIds of batches) {
      let leaseMs = 0;
      let composeBatchMs = 0;
      let leaseRecoveryCount = 0;
      let leaseRecoveryMs = 0;
      let leaseWarning: string | null = null;
      let compactComposeUsed = false;
      let compactComposeFallbackReason: string | null = null;
      let rows: any[] = [];

      if (printSyncCompactEnabled) {
        const compactStart = performance.now();
        const { data: compactRows, error: compactError } = await callRendererRpc<any[]>(
          client,
          "lease_and_compose_label_payloads_compact",
          {
            p_job_ids: batchIds,
            p_lease_seconds: clampedLeaseSeconds,
            p_max_jobs: batchIds.length,
          },
          edgeDbMode,
        );
        const compactMs = performance.now() - compactStart;
        if (!compactError && Array.isArray(compactRows) && compactRows.length === batchIds.length) {
          compactComposeUsed = true;
          composeBatchMs = compactMs;
          rows = compactRows as any[];
        } else if (compactError) {
          compactComposeFallbackReason = compactError.message;
        } else {
          const count = Array.isArray(compactRows) ? compactRows.length : 0;
          compactComposeFallbackReason = `lease_and_compose_label_payloads_compact returned ${count}/${batchIds.length} rows`;
        }
      }

      if (!compactComposeUsed) {
        const leaseStart = performance.now();
        const { data: leasedRows, error: leaseError } = await callRendererRpc<any[]>(
          client,
          "lease_label_jobs_by_ids_compact",
          {
            p_job_ids: batchIds,
            p_lease_seconds: clampedLeaseSeconds,
            p_max_jobs: batchIds.length,
          },
          edgeDbMode,
        );
        leaseMs = performance.now() - leaseStart;

        let leasedIds = Array.isArray(leasedRows)
          ? (leasedRows as any[])
            .map((row) => normalizeString(row?.job_id) ?? normalizeString(row?.id))
            .filter((id): id is string => !!id)
          : [];
        let legacyLeaseRecovered = 0;
        if (leaseError) {
        recordStep("render_label_jobs", renderStart, {
          ok: false,
          error: `lease_label_jobs_by_ids_compact failed: ${leaseError.message}`,
          calls: renderCalls,
        });
          return await returnPrintResponse(500, {
            status: "error",
            error: `lease_label_jobs_by_ids_compact failed: ${leaseError.message}`,
            artifact_kind: "bundle",
            steps,
          });
        }

        if (leasedIds.length !== batchIds.length) {
          let recoveryAttempts = 0;
          let stillMissing: string[] = [];
          let recoveryStatusError: string | null = null;
          let statusProbeMs = 0;
          const compactLeasedSet = new Set(leasedIds);
          const initiallyMissing = batchIds.filter((id) => !compactLeasedSet.has(id));
          if (initiallyMissing.length > 0) {
            const legacyLeaseStart = performance.now();
            const { data: legacyRows, error: legacyLeaseError } = await callRendererRpc<any[]>(
              client,
              "lease_label_jobs_by_ids",
              {
                p_job_ids: initiallyMissing,
                p_lease_seconds: clampedLeaseSeconds,
                p_max_jobs: initiallyMissing.length,
              },
              edgeDbMode,
            );
            leaseRecoveryMs += performance.now() - legacyLeaseStart;
            if (legacyLeaseError) {
              recoveryStatusError = legacyLeaseError.message;
            } else {
              const legacyLeasedIds = Array.isArray(legacyRows)
                ? (legacyRows as any[])
                  .map((row) => normalizeString(row?.id) ?? normalizeString(row?.job_id))
                  .filter((id): id is string => !!id)
                : [];
              if (legacyLeasedIds.length > 0) {
                legacyLeaseRecovered = legacyLeasedIds.length;
                leaseRecoveryCount += legacyLeasedIds.length;
                leasedIds = [...leasedIds, ...legacyLeasedIds];
              }
            }
          }
          while (true) {
            const leasedSet = new Set(leasedIds);
            const missing = batchIds.filter((id) => !leasedSet.has(id));
            if (missing.length === 0) {
              break;
            }
            stillMissing = missing;

            const statusStart = performance.now();
            const { data: statusRows, error: statusError } = await callRendererRpc<any[]>(
              client,
              "get_label_jobs_status",
              { p_job_ids: missing },
              edgeDbMode,
            );
            statusProbeMs += performance.now() - statusStart;
            if (statusError) {
              recoveryStatusError = statusError.message;
            }

            const nowMs = Date.now();
            const leaseWindowMs = Math.max(1, clampedLeaseSeconds) * 1000;
            const recoveredByStatus = Array.isArray(statusRows)
              ? (statusRows as any[])
                .map((row) => {
                  const jobId = normalizeString(row?.job_id) ?? normalizeString(row?.id);
                  const status = normalizeString(row?.status);
                  const updatedAtRaw = row?.updated_at ? String(row.updated_at) : "";
                  const updatedAtMs = updatedAtRaw ? Date.parse(updatedAtRaw) : NaN;
                  if (!jobId) return undefined;
                  if (status === "succeeded") return jobId;
                  if (status !== "in_progress") return undefined;
                  if (!Number.isFinite(updatedAtMs)) return undefined;
                  if (nowMs - updatedAtMs > leaseWindowMs) return undefined;
                  return jobId;
                })
                .filter((id): id is string => !!id)
              : [];
            if (recoveredByStatus.length > 0) {
              leaseRecoveryCount += recoveredByStatus.length;
              leasedIds = [...leasedIds, ...recoveredByStatus];
              continue;
            }

            recoveryAttempts += 1;
            if (recoveryAttempts >= clampedLeaseRecoveryMaxAttempts) {
              break;
            }

            const delayMs = Math.min(
              clampedLeaseRecoveryPollMs * recoveryAttempts,
              Math.max(clampedLeaseRecoveryPollMs, 2000),
            );
            const recoveryStart = performance.now();
            await sleep(delayMs);
            const { data: retryRows, error: retryLeaseError } = await callRendererRpc<any[]>(
              client,
              "lease_label_jobs_by_ids_compact",
              {
                p_job_ids: missing,
                p_lease_seconds: clampedLeaseSeconds,
                p_max_jobs: missing.length,
              },
              edgeDbMode,
            );
            leaseRecoveryMs += performance.now() - recoveryStart;
            if (retryLeaseError) {
              recoveryStatusError = retryLeaseError.message;
            }
            const retryLeasedIds = Array.isArray(retryRows)
              ? (retryRows as any[])
                .map((row) => normalizeString(row?.job_id) ?? normalizeString(row?.id))
                .filter((id): id is string => !!id)
              : [];
            if (retryLeasedIds.length > 0) {
              leaseRecoveryCount += retryLeasedIds.length;
              leasedIds = [...leasedIds, ...retryLeasedIds];
            }
          }

          const finalLeasedSet = new Set(leasedIds);
          stillMissing = batchIds.filter((id) => !finalLeasedSet.has(id));
          if (stillMissing.length > 0) {
            recordStep("render_label_jobs", renderStart, {
              ok: false,
              error: "lease_label_jobs_by_ids_compact missing rows",
              missing_jobs: stillMissing.slice(0, 20),
              missing_jobs_count: stillMissing.length,
              lease_recovery_attempts: clampedLeaseRecoveryMaxAttempts,
              lease_recovery_status_error: recoveryStatusError,
              lease_recovery_status_probe_ms: Math.round(statusProbeMs),
              calls: renderCalls,
            });
            return await returnPrintResponse(500, {
              status: "error",
              error: "lease_label_jobs_by_ids_compact missing rows",
              missing_jobs: stillMissing,
              artifact_kind: "bundle",
              steps,
            });
          }
          leaseWarning = legacyLeaseRecovered > 0
            ? "lease_label_jobs_by_ids_compact returned fewer rows; recovered via legacy lease + status checks"
            : "lease_label_jobs_by_ids_compact returned fewer rows; recovered via retry/status checks";
          leaseRecoveryMs += statusProbeMs;
        }

        const composeBatchStart = performance.now();
        const { data: composedRows, error: composeError } = await callRendererRpc<any[]>(
          client,
          "compose_label_payloads",
          {
            p_job_ids: batchIds,
          },
          edgeDbMode,
        );
        composeBatchMs = performance.now() - composeBatchStart;

        if (composeError) {
          recordStep("render_label_jobs", renderStart, {
            ok: false,
            error: `compose_label_payloads failed: ${composeError.message}`,
            calls: renderCalls,
          });
          return await returnPrintResponse(500, {
            status: "error",
            error: `compose_label_payloads failed: ${composeError.message}`,
            artifact_kind: "bundle",
            steps,
          });
        }

        rows = Array.isArray(composedRows) ? (composedRows as any[]) : [];
      }

      const composeMsFallback = batchIds.length > 0 ? composeBatchMs / batchIds.length : 0;
      rows.forEach((row) => {
        const jobId = typeof row?.job_id === "string" ? String(row.job_id) : null;
        if (!jobId) return;
        const composeMsRaw = Number(row.compose_ms);
        const composeMs = Number.isFinite(composeMsRaw) && composeMsRaw > 0 ? composeMsRaw : composeMsFallback;
        composedByJobId.set(jobId, {
          composed: (row.composed && typeof row.composed === "object") ? (row.composed as Record<string, any>) : {},
          composeMs,
        });
      });

      const missingComposed = batchIds.filter((id) => !composedByJobId.has(id));
        if (missingComposed.length) {
        recordStep("render_label_jobs", renderStart, {
          ok: false,
          error: "compose_label_payloads missing rows",
          missing_jobs: missingComposed.slice(0, 20),
          missing_jobs_count: missingComposed.length,
          compact_compose_fallback_reason: compactComposeFallbackReason ?? undefined,
          calls: renderCalls,
        });
        return await returnPrintResponse(500, {
          status: "error",
          error: "compose_label_payloads missing rows",
          missing_jobs: missingComposed,
          artifact_kind: "bundle",
          steps,
        });
      }

      const renderBatchStart = performance.now();
      try {
        for (let idx = 0; idx < batchIds.length; idx += 1) {
          const jobId = batchIds[idx];
          const composedEntry = composedByJobId.get(jobId);
          if (!composedEntry) {
            throw new Error(`Missing composed entry for job ${jobId}`);
          }

          const composed = composedEntry.composed;
          const jobForTemplate = {
            ...(asRecord(composed?.job) ?? {}),
            id: jobId,
          } as LabelJob;
          const payloadBody = (composed?.payload ?? {}) as Record<string, any>;
          const templateSnapshot = resolveTemplateSnapshot(composed);
          const canUseTemplate = !!(
            templateSnapshot &&
            Array.isArray(templateSnapshot.renderer_config?.blocks) &&
            templateSnapshot.renderer_config.blocks.length > 0
          );
          if (!templateSnapshot || !canUseTemplate) {
            throw new Error(`Template snapshot unavailable or incomplete for job ${typedJob.id}`);
          }

          const rendererConfig = templateSnapshot.renderer_config ?? {};
          const pageCfg = rendererConfig.page ?? {};
          const widthPoints = Math.max(72, Math.round((pageCfg.width_inch ?? 4) * 72));
          const heightPoints = Math.max(72, Math.round((pageCfg.height_inch ?? 6) * 72));
          const orientation = (pageCfg.orientation ?? "portrait") === "landscape" ? "landscape" : "portrait";
          const pageSize: [number, number] = orientation === "landscape"
            ? [heightPoints, widthPoints]
            : [widthPoints, heightPoints];

          const cacheKey = `${templateSnapshot.template_id ?? templateSnapshot.template_key ?? "template"}:${
            templateSnapshot.template_version ?? 0
          }`;
          let template = templateCache.get(cacheKey);
          if (!template) {
            const missingAssets: string[] = [];
            const assets = await loadTemplateAssets(templateSnapshot, rendererConfig, missingAssets);
            const assetsLoaded = new Set(assets.values()).size;
            const dpi = typeof pageCfg.dpi === "number" && pageCfg.dpi > 0 ? pageCfg.dpi : 203;
            const dotPt = 72 / dpi;

            const getAssetEmbed = async (ref?: string) => {
              if (!ref) return null;
              const entry = assets.get(ref);
              if (!entry) return null;

              if (!entry.embed) {
                const contentType = entry.meta.content_type ?? "";
                const path = entry.meta.path.toLowerCase();
                if (contentType.includes("png") || path.endsWith(".png")) {
                  entry.embed = await pdfDoc.embedPng(entry.bytes);
                } else if (contentType.includes("jpg") || contentType.includes("jpeg") || path.endsWith(".jpg") ||
                  path.endsWith(".jpeg")) {
                  entry.embed = await pdfDoc.embedJpg(entry.bytes);
                } else {
                  entry.embed = await pdfDoc.embedPng(entry.bytes);
                }
              }
              return entry.embed;
            };

            template = { assets, assetsLoaded, dotPt, getAssetEmbed, assetsMissing: missingAssets };
            templateCache.set(cacheKey, template);
          }

          const page = pdfDoc.addPage(pageSize);
          const pageRenderStart = performance.now();
          const { renderedBlocks, barcodeBlocks, barcodeValue } = await renderTemplateBlocksToPage(payloadBody, jobForTemplate, templateSnapshot, {
            pdfDoc,
            page,
            fontCache,
            getAssetEmbed: template.getAssetEmbed,
            dotPt: template.dotPt,
          });
          const pageRenderMs = performance.now() - pageRenderStart;

          const settingsResolution = {
            label_render_policy: normalizeString(payloadBody?.label_render_policy_resolution?.settings_resolution_id) ??
              null,
            label_print_profile: normalizeString(payloadBody?.label_print_profile_resolution?.settings_resolution_id) ??
              null,
          };

          pageIndex += 1;
          const composedAttemptsRaw = (asRecord(composed?.job) as any)?.attempts;
          const composedAttempts = Number(composedAttemptsRaw);
          const attempts = Number.isFinite(composedAttempts) ? composedAttempts : 0;
          perJob.set(jobId, {
            composeMs: composedEntry.composeMs,
            renderMs: pageRenderMs,
            rendererMetadata: {
              renderer: "edge/label-renderer",
              version: "2025-11-02",
              template_id: templateSnapshot.template_id ?? null,
              template_version: templateSnapshot.template_version ?? null,
              template_key: templateSnapshot.template_key ?? null,
              schema_version: templateSnapshot.schema_version ?? null,
              rendered_blocks: renderedBlocks,
              barcode_blocks: barcodeBlocks,
              barcode_mode: barcodeBlocks > 0 ? "code128b_vector" : null,
              barcode: barcodeValue ?? null,
              assets_loaded: template.assetsLoaded,
              assets_missing_count: template.assetsMissing?.length ?? 0,
              assets_missing: template.assetsMissing ?? [],
            },
            settingsResolution,
            pageIndex,
            attempts,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordStep("render_label_jobs", renderStart, {
          ok: false,
          error: message,
          calls: renderCalls,
        });
        return await returnPrintResponse(500, {
          status: "error",
          error: message,
          artifact_kind: "bundle",
          steps,
        });
      }

      const renderBatchMs = performance.now() - renderBatchStart;
      renderCalls.push({
        call_index: renderCalls.length + 1,
        leased: batchIds.length,
        lease_ms: Math.round(leaseMs),
        lease_recovered: leaseRecoveryCount || 0,
        lease_recovery_ms: leaseRecoveryCount ? Math.round(leaseRecoveryMs) : 0,
        lease_warning: leaseWarning ?? undefined,
        compose_ms: Math.round(composeBatchMs),
        compact_compose_used: compactComposeUsed,
        compact_compose_fallback_reason: compactComposeFallbackReason ?? undefined,
        render_ms: Math.round(renderBatchMs),
        pending_after: orderedIds.length - pageIndex,
      });
    }

    recordStep("render_label_jobs", renderStart, {
      requested_jobs: orderedIds.length,
      pending_remaining: orderedIds.length - pageIndex,
      failed_jobs: 0,
      max_jobs: clampedRenderMaxJobs,
      concurrency: 1,
      lease_seconds: clampedLeaseSeconds,
      max_calls: clampedMaxCalls,
      calls: renderCalls,
      bundle_strategy: "direct",
      print_sync_compact_enabled: printSyncCompactEnabled,
      fresh_generation_required: freshGenerationRequired,
      job_purpose: jobPurpose,
      rendered_pages: pageIndex,
    });

    if (pageIndex < orderedIds.length) {
      return await returnPrintResponse(504, {
        status: "failed",
        reason: "label_jobs_timeout",
        pending_jobs: orderedIds.length - pageIndex,
        artifact_kind: "bundle",
        steps,
      });
    }

    const bundleStart = Date.now();
    const saveStart = performance.now();
    const bytes = new Uint8Array(await pdfDoc.save());
    const saveMs = performance.now() - saveStart;

    let artifactReturn: Awaited<ReturnType<typeof persistBundleArtifact>>;
    try {
      artifactReturn = await persistBundleArtifact({
        filePath,
        outputName: safeOutputName,
        bytes,
        expiresSeconds,
        returnMode: bundleReturnMode,
      });
    } catch (uploadError) {
      const uploadMessage =
        uploadError instanceof Error ? uploadError.message : "bundle_upload_failed";
      try {
        if (!workflowManagedPrint) {
          await client.rpc("log_decision", {
            p_organization_id: incomingOrgId,
            p_decision_category: "label_print",
            p_resource_type: "label_bundle",
            p_resource_id: bundleId,
            p_decision_point: "bundle_edge",
            p_decision_outcome: "failed",
            p_performed_by_system: "label_renderer",
            p_correlation_id: correlationId,
            p_decision_inputs: {
              error: uploadMessage,
              bucket: LABEL_BUCKET,
              client_id: incomingClientId ?? null,
              sender_id: incomingSenderId ?? null,
              strategy: "direct",
            },
            p_decision_reason: "upload_failed",
          });
        }
      } catch (_err) {
        // ignore
      }
      recordStep("bundle_labels", bundleStart, { ok: false, error: uploadMessage });
      return await returnPrintResponse(500, {
        status: "error",
        error: uploadMessage,
        artifact_kind: "bundle",
        steps,
      });
    }
    const signedUrl: string | null = artifactReturn.signed_url;
    const expiresAt: string | null = artifactReturn.expires_at;
    const signedMs = artifactReturn.signed_ms;

    const completionPayload = orderedIds.map((jobId) => {
      const info = perJob.get(jobId)!;
      const existingTimings = asRecord((info.rendererMetadata as any)?.timings) ?? {};
      return {
        job_id: jobId,
        status: "succeeded",
        file_url: filePath,
        file_size_bytes: bytes.byteLength,
        renderer_metadata: {
          ...info.rendererMetadata,
          correlation_id: correlationId,
          page_count: 1,
          attempts: info.attempts,
          settings_resolution: info.settingsResolution,
          bundle: {
            bundle_id: bundleId,
            file_path: filePath,
            page_index: info.pageIndex,
            page_count: orderedIds.length,
            output_name: safeOutputName,
            strategy: "direct",
          },
          timings: {
            ...existingTimings,
            compose_ms: info.composeMs,
            render_ms: info.renderMs,
            bundle_save_ms: Math.round(saveMs),
            bundle_upload_ms: artifactReturn.upload_ms,
            bundle_signed_url_ms: Math.round(signedMs),
            total_ms: info.composeMs + info.renderMs,
          },
        },
        error_reason: null,
      };
    });

    let completeMs: number | null = null;
    const jobCompletionPending = false;
    const completeStart = performance.now();
    const { error: completeError } = await callRendererRpc(
      client,
      "complete_label_jobs",
      { p_results: completionPayload },
      edgeDbMode,
    );
    completeMs = performance.now() - completeStart;
    if (completeError) {
      recordStep("bundle_labels", bundleStart, { ok: false, error: `complete_label_jobs failed: ${completeError.message}` });
      return await returnPrintResponse(500, {
        status: "error",
        error: `complete_label_jobs failed: ${completeError.message}`,
        artifact_kind: "bundle",
        steps,
      });
    }

    const completedAt = new Date().toISOString();
    const totalMs = Date.now() - runStartMs;
    const bundleBody: Record<string, unknown> = {
      status: "ok",
      artifact_kind: "bundle",
      organization_id: incomingOrgId,
      client_id: incomingClientId ?? null,
      bundle_id: bundleId,
      file_path: artifactReturn.file_path,
      file_url: artifactReturn.file_url,
      signed_url: signedUrl,
      expires_seconds: expiresSeconds,
      expires_at: expiresAt,
      started_at: new Date(runStartMs).toISOString(),
      completed_at: completedAt,
      output_name: safeOutputName,
      counts: {
        requested: orderedIds.length,
        bundled: orderedIds.length,
        placeholders: 0,
      },
      timings: {
        build_bundle_ms: Math.round(renderCalls.reduce((sum, c) => sum + Number((c as any)?.render_ms || 0), 0)),
        build_save_ms: Math.round(saveMs),
        upload_ms: artifactReturn.upload_ms,
        signed_url_ms: Math.round(signedMs),
        complete_ms: completeMs === null ? null : Math.round(completeMs),
        build_preloaded_count: orderedIds.length,
        build_downloaded_count: 0,
        total_ms: totalMs,
      },
      job_completion_pending: jobCompletionPending,
      bundled_labels: [],
      placeholder_labels: [],
      metadata: printInput.metadata ?? null,
    };

    if (!workflowManagedPrint) {
      await logDecisionBestEffort(
        {
          p_organization_id: incomingOrgId,
          p_decision_category: "label_print",
          p_resource_type: "label_bundle",
          p_resource_id: bundleId,
          p_decision_point: "bundle_edge",
          p_decision_outcome: "completed",
          p_performed_by_system: "label_renderer",
          p_correlation_id: correlationId,
          p_decision_inputs: {
            counts: { requested: orderedIds.length, bundled: orderedIds.length, placeholders: 0 },
            expires_seconds: expiresSeconds,
            signed_url: signedUrl,
            started_at: new Date(runStartMs).toISOString(),
            completed_at: completedAt,
            output_name: safeOutputName,
            bucket: LABEL_BUCKET,
            bundle_size_bytes: bytes.byteLength,
            strategy: "direct",
            timings: (bundleBody as any).timings,
            client_id: incomingClientId ?? null,
            sender_id: incomingSenderId ?? null,
            integration_kind: integration.kind,
            source_id: integration.kind === "source" ? integration.sourceId : null,
            provider_name: integration.kind === "provider" ? integration.providerName : null,
          },
          p_decision_reason: null,
        },
        "Unable to log print_sync direct bundle completion decision",
      );
    }

    scheduleMetricEmit("label_bundle.completed", {
      org: incomingOrgId,
      client: incomingClientId ?? null,
      sender: incomingSenderId ?? null,
      integration: integration.kind,
      bucket: LABEL_BUCKET,
    }, {
      requested: orderedIds.length,
      bundled: orderedIds.length,
      placeholders: 0,
      bundle_size_bytes: bytes.byteLength,
      strategy: "direct",
    });

    recordStep("bundle_labels", bundleStart, {
      status: 200,
      outcome: "ok",
      job_completion_pending: jobCompletionPending,
    });

    return await returnPrintResponse(200, {
      status: "ok",
      mode: "print_sync",
      artifact_kind: "bundle",
      organization_id: incomingOrgId,
      client_id: incomingClientId ?? null,
      sender_id: incomingSenderId ?? null,
      job_completion_pending: jobCompletionPending,
      started_at: startedAt,
      completed_at: completedAt,
      counts: bundleBody.counts,
      timings: buildPrintTimingSummary(totalMs, completeMs),
      steps,
      bundle: bundleBody,
    });
  }

  const renderStart = Date.now();
  const pending = new Set(uniqueJobIds);
  const renderCalls: Array<Record<string, unknown>> = [];
  const renderResults: Array<Record<string, unknown>> = [];
  let failedJobs = 0;

  const preloadedPdfBytesByPath = new Map<string, Uint8Array>();
  const onPdfBytes = (filePath: string, bytes: Uint8Array) => {
    preloadedPdfBytesByPath.set(filePath, bytes);
  };

  while (pending.size > 0 && renderCalls.length < clampedMaxCalls && Date.now() < deadlineMs) {
    const pendingIds = Array.from(pending);
    const leaseStart = performance.now();
    const { data: leasedJobs, error: leaseError } = await client.rpc("lease_label_jobs_by_ids", {
      p_job_ids: pendingIds,
      p_lease_seconds: clampedLeaseSeconds,
      p_max_jobs: Math.min(clampedRenderMaxJobs, pendingIds.length),
    });
    const leaseMs = performance.now() - leaseStart;

    const leased = Array.isArray(leasedJobs) ? (leasedJobs as LabelJob[]) : [];
    if (leaseError) {
      recordStep("render_label_jobs", renderStart, {
        ok: false,
        error: `lease_label_jobs_by_ids failed: ${leaseError.message}`,
        calls: renderCalls,
        results: renderResults,
      });
      return await returnPrintResponse(500, {
        status: "error",
        error: `lease_label_jobs_by_ids failed: ${leaseError.message}`,
        artifact_kind: "bundle",
        steps,
      });
    }

    if (leased.length === 0) {
      const statusStart = performance.now();
      const { data: statuses, error: statusError } = await client.rpc("get_label_jobs_status", { p_job_ids: pendingIds });
      const statusMs = performance.now() - statusStart;
      if (!statusError && Array.isArray(statuses)) {
        for (const row of statuses as any[]) {
          const jobId = typeof row?.job_id === "string" ? row.job_id : null;
          const status = typeof row?.status === "string" ? row.status : null;
          if (!jobId || !status) continue;
          if (status === "succeeded") {
            pending.delete(jobId);
          } else if (status === "failed") {
            pending.delete(jobId);
            failedJobs += 1;
          }
        }
      }

      renderCalls.push({
        call_index: renderCalls.length + 1,
        leased: 0,
        lease_ms: Math.round(leaseMs),
        status_check_ms: Math.round(statusMs),
        pending_after: pending.size,
      });
      continue;
    }

    const composeBatchStart = performance.now();
    const leasedJobIds = leased.map((job) => job.id);
    const composedByJobId = new Map<string, { composed: Record<string, any>; composeMs: number }>();

    const { data: composedRows, error: composeError } = await client.rpc("compose_label_payloads", {
      p_job_ids: leasedJobIds,
    });
    const composeBatchMs = performance.now() - composeBatchStart;
    const composeMsFallback = leasedJobIds.length > 0 ? composeBatchMs / leasedJobIds.length : 0;

    if (composeError) {
      recordStep("render_label_jobs", renderStart, {
        ok: false,
        error: `compose_label_payloads failed: ${composeError.message}`,
        calls: renderCalls,
        results: renderResults,
      });
      return await returnPrintResponse(500, {
        status: "error",
        error: `compose_label_payloads failed: ${composeError.message}`,
        artifact_kind: "bundle",
        steps,
      });
    }

    if (Array.isArray(composedRows)) {
      for (const row of composedRows as any[]) {
        const jobId = typeof row?.job_id === "string" ? row.job_id : null;
        const composed = row?.composed && typeof row.composed === "object" ? (row.composed as Record<string, any>) : null;
        const composeMs = Number(row?.compose_ms);
        if (!jobId || !composed) continue;
        const resolvedComposeMs = Number.isFinite(composeMs) && composeMs > 0 ? composeMs : composeMsFallback;
        composedByJobId.set(jobId, { composed, composeMs: resolvedComposeMs });
      }
    }

    if (composedByJobId.size !== leasedJobIds.length) {
      const missing = leasedJobIds.filter((id) => !composedByJobId.has(id));
      recordStep("render_label_jobs", renderStart, {
        ok: false,
        error: "compose_label_payloads missing rows",
        missing_jobs: missing.slice(0, 20),
        missing_jobs_count: missing.length,
        calls: renderCalls,
        results: renderResults,
      });
      return await returnPrintResponse(500, {
        status: "error",
        error: "compose_label_payloads missing rows",
        missing_jobs: missing,
        artifact_kind: "bundle",
        steps,
      });
    }

    const renderUploadStart = performance.now();
    const results = await mapWithConcurrency(leased, clampedRenderConcurrency, async (job) => {
      const entry = composedByJobId.get(job.id);
      if (!entry) {
        return {
          status: "failed",
          job_id: job.id,
          file_url: null,
          file_size_bytes: null,
          metadata: { correlation_id: correlationId, stage: "compose_payload", error: "compose_label_payloads_missing" },
          error: "compose_label_payloads_missing",
        } as RenderAndUploadResult;
      }
      return await renderAndUploadLabelFromComposedPayload(
        job,
        correlationId,
        integration,
        entry.composed,
        entry.composeMs,
        { onPdfBytes },
      );
    });
    const renderUploadMs = performance.now() - renderUploadStart;

    const completionPayload = results.map((result) => ({
      job_id: result.job_id,
      status: result.status === "ok" ? "succeeded" : "failed",
      file_url: result.file_url,
      file_size_bytes: result.file_size_bytes,
      renderer_metadata: result.metadata ?? {},
      error_reason: result.error,
    }));

    let completeMs: number | null = null;
    const completeStart = performance.now();
    const { error: completeError } = await callRendererRpc(
      client,
      "complete_label_jobs",
      { p_results: completionPayload },
      edgeDbMode,
    );
    completeMs = performance.now() - completeStart;

    if (completeError) {
      recordStep("render_label_jobs", renderStart, {
        ok: false,
        error: `complete_label_jobs failed: ${completeError.message}`,
        calls: renderCalls,
        results: renderResults,
      });
      return await returnPrintResponse(500, {
        status: "error",
        error: `complete_label_jobs failed: ${completeError.message}`,
        artifact_kind: "bundle",
        steps,
      });
    }

    results.forEach((result) => {
      pending.delete(result.job_id);
      renderResults.push({
        job_id: result.job_id,
        status: result.status,
        file_url: result.file_url ?? null,
        reason: result.error ?? null,
      });
      if (result.status !== "ok") failedJobs += 1;
    });

    renderCalls.push({
      call_index: renderCalls.length + 1,
      leased: leased.length,
      lease_ms: Math.round(leaseMs),
      compose_ms: Math.round(composeBatchMs),
      render_ms: Math.round(renderUploadMs),
      complete_ms: completeMs === null ? null : Math.round(completeMs),
      ok: results.filter((r) => r.status === "ok").length,
      failed: results.filter((r) => r.status !== "ok").length,
      pending_after: pending.size,
    });
  }

  recordStep("render_label_jobs", renderStart, {
    requested_jobs: uniqueJobIds.length,
    pending_remaining: pending.size,
    failed_jobs: failedJobs,
    max_jobs: clampedRenderMaxJobs,
    concurrency: clampedRenderConcurrency,
    lease_seconds: clampedLeaseSeconds,
    max_calls: clampedMaxCalls,
    calls: renderCalls,
    preloaded_pdfs: preloadedPdfBytesByPath.size,
  });

  if (failedJobs > 0) {
    return await returnPrintResponse(500, {
      status: "failed",
      reason: "label_jobs_failed",
      failed_jobs: failedJobs,
      artifact_kind: "bundle",
      steps,
    });
  }

  if (pending.size > 0) {
    return await returnPrintResponse(504, {
      status: "failed",
      reason: "label_jobs_timeout",
      pending_jobs: pending.size,
      artifact_kind: "bundle",
      steps,
    });
  }

  const fileUrlsForBundle = uniqueOrderedJobIds.map((jobId) => buildLabelOutputFilePath(incomingOrgId, jobId));
  const bundleStart = Date.now();
  const bundleResult = await handleBundleRequest({
    organization_id: incomingOrgId,
    bundle: {
      organization_id: incomingOrgId,
      client_id: incomingClientId ?? undefined,
      sender_id: incomingSenderId ?? undefined,
      shipments: normalizedShipments,
      file_urls: fileUrlsForBundle,
      output_name: (printInput as any)?.output_name,
      expires_seconds: expiresSeconds,
      workflow_progress_enabled: false,
      metadata: printInput.metadata ?? null,
    },
  }, integration, { preloadedPdfBytesByPath });
  recordStep("bundle_labels", bundleStart, {
    status: bundleResult.statusCode,
    outcome: bundleResult.body?.status ?? null,
  });

  const totalMs = Date.now() - runStartMs;
  return await returnPrintResponse(bundleResult.statusCode, {
    status: bundleResult.body?.status ?? "ok",
    mode: "print_sync",
    artifact_kind:
      normalizeString((bundleResult.body as Record<string, unknown> | undefined)?.artifact_kind) ?? "bundle",
    organization_id: incomingOrgId,
    client_id: incomingClientId ?? null,
    sender_id: incomingSenderId ?? null,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    timings: buildPrintTimingSummary(totalMs),
    steps,
    bundle: bundleResult.body,
  });
};

const handleBundleRequest = async (
  payload: any,
  integration: IntegrationContext | null,
  options: { preloadedPdfBytesByPath?: Map<string, Uint8Array> } = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> => {
  if (!integration) {
    return { statusCode: 401, body: { status: "error", error: "Unauthorized token" } };
  }

  const bundleInput: BundleRequest | null = payload?.bundle && typeof payload.bundle === "object"
    ? ({ ...payload.bundle, organization_id: payload.bundle.organization_id ?? payload.organization_id } as BundleRequest)
    : payload && typeof payload === "object"
    ? (payload as BundleRequest)
    : null;

  const incomingOrgId = typeof bundleInput?.organization_id === "string" ? bundleInput.organization_id : null;
  const incomingClientId = typeof bundleInput?.client_id === "string" ? bundleInput.client_id : null;
  const incomingSenderId = typeof bundleInput?.sender_id === "string" ? bundleInput.sender_id : null;
  const effectiveOrgId = incomingOrgId;
  if (!bundleInput || !effectiveOrgId) {
    return { statusCode: 400, body: { status: "error", error: "organization_id and bundle payload are required" } };
  }

  const effectiveClientId = incomingClientId ?? null;
  const effectiveSenderId = incomingSenderId ?? null;
  function returnBundleResponse(
    statusCode: number,
    body: Record<string, unknown>,
  ) {
    scheduleBundleWorkflowResult(bundleInput, body);
    return { statusCode, body };
  }
  const policy = await resolveLabelPrintPolicy(integration, effectiveOrgId, effectiveClientId, effectiveSenderId);
  const workflowManagedBundle = Boolean(resolveWorkflowProgress(bundleInput)?.workflowRunStepId);
  const bundleReturnMode = resolveBundleReturnMode(policy, workflowManagedBundle);
  const expiresSecondsRaw = Number(bundleInput.expires_seconds);
  const requestedExpiresSeconds =
    Number.isFinite(expiresSecondsRaw) && expiresSecondsRaw >= 60
      ? Math.floor(expiresSecondsRaw)
      : null;
  const policyDefaultTtlRaw = Number(policy?.default_expires_seconds);
  const policyDefaultTtl =
    Number.isFinite(policyDefaultTtlRaw) && policyDefaultTtlRaw >= 60
      ? Math.floor(policyDefaultTtlRaw)
      : requestedExpiresSeconds;
  if (!Number.isFinite(policyDefaultTtl ?? Number.NaN) || (policyDefaultTtl ?? 0) < 60) {
    const responseBody = {
      status: "failed",
      error: "label_print_policy default_expires_seconds missing and expires_seconds not provided",
      reason: "label_print_policy_invalid",
    };
    return returnBundleResponse(500, responseBody);
  }

  bundleInput.organization_id = effectiveOrgId;
  bundleInput.client_id = effectiveClientId ?? undefined;
  bundleInput.sender_id = effectiveSenderId ?? undefined;

  const startedAt = new Date().toISOString();
  const overallStart = performance.now();

  try {
    await assertLabelBucketAvailable();
    scheduleMetricEmit("label_bundle.bucket_ready", {
      org: effectiveOrgId,
      client: effectiveClientId ?? null,
      sender: effectiveSenderId ?? null,
      integration: integration.kind,
      bucket: LABEL_BUCKET,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Label bucket unavailable";
    scheduleMetricEmit("label_bundle.bucket_missing", {
      org: effectiveOrgId,
      client: effectiveClientId ?? null,
      sender: effectiveSenderId ?? null,
      integration: integration.kind,
      bucket: LABEL_BUCKET,
    });
    const responseBody = { status: "failed", error: message, reason: "label_bucket_unavailable" };
    return returnBundleResponse(503, responseBody);
  }

  const targetsStart = performance.now();
  const targets = await collectBundleTargets(bundleInput);
  const targetsMs = performance.now() - targetsStart;
  if (targets.length === 0) {
    const responseBody = {
      status: "ok",
      organization_id: bundleInput.organization_id,
      bundle_id: crypto.randomUUID(),
      counts: { requested: 0, bundled: 0, placeholders: 0 },
      bundled_labels: [],
      placeholder_labels: [],
      metadata: bundleInput.metadata ?? null,
    };
    return returnBundleResponse(200, responseBody);
  }

  const expiresSeconds = Math.min(
    Math.max(requestedExpiresSeconds ?? policyDefaultTtl, 60),
    Math.max(policyDefaultTtl, 60),
  );

  const singleFilePassthroughEnabled = readBooleanSetting(
    (policy as Record<string, unknown> | null)?.single_file_passthrough_enabled,
    true,
  );
  const passthroughPath =
    singleFilePassthroughEnabled && targets.length === 1
      ? normalizeBundleFilePathCandidate(targets[0]?.fileUrl ?? null)
      : null;

  if (passthroughPath) {
    const client = ensureSupabase();
    const bundleId = crypto.randomUUID();
    const safeOutputName = (bundleInput.output_name ?? `labels_bundle_${bundleId}.pdf`).replace(/[^A-Za-z0-9_.-]/g, "-");
    const artifactReturn = await resolveArtifactReturn(
      passthroughPath,
      expiresSeconds,
      bundleReturnMode,
    );
    const signedUrl: string | null = artifactReturn.signed_url;
    const expiresAt: string | null = artifactReturn.expires_at;
    const signedMs = artifactReturn.signed_ms;
    const completedAt = new Date().toISOString();
    const totalMs = performance.now() - overallStart;
    const passthroughTarget = {
      ...targets[0],
      fileUrl: passthroughPath,
    };
    try {
      await client.rpc("log_decision", {
        p_organization_id: bundleInput.organization_id,
        p_decision_category: "label_print",
        p_resource_type: "label_bundle",
        p_resource_id: bundleId,
        p_decision_point: "bundle_edge",
        p_decision_outcome: "completed",
        p_performed_by_system: "label_renderer",
        p_correlation_id: null,
        p_decision_inputs: {
          counts: {
            requested: 1,
            bundled: 1,
            placeholders: 0,
          },
          expires_seconds: expiresSeconds,
          signed_url: signedUrl,
          started_at: startedAt,
          completed_at: completedAt,
          output_name: safeOutputName,
          bucket: LABEL_BUCKET,
          strategy: "single_file_passthrough",
          timings: {
            collect_targets_ms: targetsMs,
            build_bundle_ms: 0,
            build_signed_urls_ms: 0,
            build_download_ms: 0,
            build_merge_ms: 0,
            build_save_ms: 0,
            build_total_ms: 0,
            build_preloaded_count: 1,
            build_downloaded_count: 0,
            build_download_concurrency: 1,
            build_chunk_size: 1,
            upload_ms: 0,
            signed_url_ms: signedMs,
            total_ms: totalMs,
          },
          client_id: bundleInput.client_id ?? null,
          sender_id: bundleInput.sender_id ?? null,
          integration_kind: integration.kind,
          source_id: integration.kind === "source" ? integration.sourceId : null,
          provider_name: integration.kind === "provider" ? integration.providerName : null,
        },
        p_decision_reason: null,
      });
    } catch (err) {
      logRenderer("warn", "passthrough_bundle_decision_log_failed", { error: err });
    }
    scheduleMetricEmit(
      "label_bundle.completed",
      {
        org: bundleInput.organization_id,
        client: bundleInput.client_id ?? null,
        sender: bundleInput.sender_id ?? null,
        integration: integration.kind,
        bucket: LABEL_BUCKET,
      },
      {
        requested: 1,
        bundled: 1,
        placeholders: 0,
        bundle_size_bytes: null,
        strategy: "single_file_passthrough",
      },
    );
    const responseBody = {
      status: "ok",
      organization_id: bundleInput.organization_id,
      client_id: bundleInput.client_id ?? null,
      bundle_id: bundleId,
      file_path: artifactReturn.file_path,
      file_url: artifactReturn.file_url,
      signed_url: signedUrl,
      expires_seconds: expiresSeconds,
      expires_at: expiresAt,
      started_at: startedAt,
      completed_at: completedAt,
      output_name: safeOutputName,
      counts: {
        requested: 1,
        bundled: 1,
        placeholders: 0,
      },
      timings: {
        collect_targets_ms: targetsMs,
        build_bundle_ms: 0,
        build_signed_urls_ms: 0,
        build_download_ms: 0,
        build_merge_ms: 0,
        build_save_ms: 0,
        build_total_ms: 0,
        build_preloaded_count: 1,
        build_downloaded_count: 0,
        build_download_concurrency: 1,
        build_chunk_size: 1,
        upload_ms: 0,
        signed_url_ms: signedMs,
        total_ms: totalMs,
      },
      bundled_labels: [passthroughTarget],
      placeholder_labels: [],
      metadata: bundleInput.metadata ?? null,
    };
    return returnBundleResponse(200, responseBody);
  }

  const buildStart = performance.now();
  const policyDownloadConcurrency = Number((policy as any)?.bundle_download_concurrency);
  const policyChunkSize = Number((policy as any)?.bundle_chunk_size);
  const bundleDownloadConcurrency =
    Number.isFinite(policyDownloadConcurrency) && policyDownloadConcurrency > 0
      ? Math.floor(policyDownloadConcurrency)
      : 8;
  const bundleChunkSize =
    Number.isFinite(policyChunkSize) && policyChunkSize > 0 ? Math.floor(policyChunkSize) : targets.length;

  const { bytes, bundled, placeholders, timings: bundleTimings } = await buildBundleArtifactFromTargets(targets, {
    downloadConcurrency: bundleDownloadConcurrency,
    chunkSize: bundleChunkSize,
    signedUrlExpiresSeconds: expiresSeconds,
    preloadedBytesByFilePath: options.preloadedPdfBytesByPath,
  });
  const buildMs = performance.now() - buildStart;
  const bundleSizeBytes = bytes.byteLength;
  const bundleId = crypto.randomUUID();
  const safeOutputName = (bundleInput.output_name ?? `labels_bundle_${bundleId}.pdf`).replace(/[^A-Za-z0-9_.-]/g, "-");
  const filePath = `${bundleInput.organization_id}/bundles/${bundleId}.pdf`;

  let artifactReturn: Awaited<ReturnType<typeof persistBundleArtifact>>;
  try {
    artifactReturn = await persistBundleArtifact({
      filePath,
      outputName: safeOutputName,
      bytes,
      expiresSeconds,
      returnMode: bundleReturnMode,
    });
  } catch (uploadError) {
    const uploadMessage =
      uploadError instanceof Error ? uploadError.message : "upload_failed";
    await logDecisionBestEffort(
      {
        p_organization_id: bundleInput.organization_id,
        p_decision_category: "label_print",
        p_resource_type: "label_bundle",
        p_resource_id: bundleId,
        p_decision_point: "bundle_edge",
        p_decision_outcome: "failed",
        p_performed_by_system: "label_renderer",
        p_correlation_id: null,
        p_decision_inputs: {
          error: uploadMessage,
          bucket: LABEL_BUCKET,
          client_id: bundleInput.client_id ?? null,
          sender_id: bundleInput.sender_id ?? null,
        },
        p_decision_reason: "upload_failed",
      },
      "Unable to log bundle failure decision",
    );
    logRenderer("error", "bundle_pdf_upload_failed", { error: uploadError });
    scheduleMetricEmit("label_bundle.upload_failed", {
      org: bundleInput.organization_id,
      client: bundleInput.client_id ?? null,
      sender: bundleInput.sender_id ?? null,
      integration: integration.kind,
      bucket: LABEL_BUCKET,
    }, { error: uploadMessage });
    const responseBody = { status: "failed", error: uploadMessage, reason: "upload_failed" };
    return returnBundleResponse(500, responseBody);
  }
  const signedUrl: string | null = artifactReturn.signed_url;
  const expiresAt: string | null = artifactReturn.expires_at;
  const signedMs = artifactReturn.signed_ms;

  const totalMs = performance.now() - overallStart;
  const completedAt = new Date().toISOString();

  const decisionInputs = {
    counts: {
      requested: targets.length,
      bundled: bundled.length,
      placeholders: placeholders.length,
    },
    expires_seconds: expiresSeconds,
    signed_url: signedUrl,
    started_at: startedAt,
    completed_at: completedAt,
    output_name: safeOutputName,
    bucket: LABEL_BUCKET,
    bundle_size_bytes: bundleSizeBytes,
    timings: {
      collect_targets_ms: targetsMs,
      build_bundle_ms: buildMs,
      build_signed_urls_ms: Number((bundleTimings as any)?.signed_urls_ms) || 0,
      build_download_ms: Number((bundleTimings as any)?.download_ms) || 0,
      build_merge_ms: Number((bundleTimings as any)?.merge_ms) || 0,
      build_save_ms: Number((bundleTimings as any)?.save_ms) || 0,
      build_total_ms: Number((bundleTimings as any)?.total_ms) || 0,
      build_preloaded_count: Number((bundleTimings as any)?.preloaded_count) || 0,
      build_downloaded_count: Number((bundleTimings as any)?.downloaded_count) || 0,
      build_download_concurrency: (bundleTimings as any)?.download_concurrency ?? bundleDownloadConcurrency,
      build_chunk_size: (bundleTimings as any)?.chunk_size ?? bundleChunkSize,
      upload_ms: artifactReturn.upload_ms,
      signed_url_ms: signedMs,
      total_ms: totalMs,
    },
    client_id: bundleInput.client_id ?? null,
    sender_id: bundleInput.sender_id ?? null,
    integration_kind: integration.kind,
    source_id: integration.kind === "source" ? integration.sourceId : null,
    provider_name: integration.kind === "provider" ? integration.providerName : null,
  };

  await logDecisionBestEffort(
    {
      p_organization_id: bundleInput.organization_id,
      p_decision_category: "label_print",
      p_resource_type: "label_bundle",
      p_resource_id: bundleId,
      p_decision_point: "bundle_edge",
      p_decision_outcome: "completed",
      p_performed_by_system: "label_renderer",
      p_correlation_id: null,
      p_decision_inputs: decisionInputs,
      p_decision_reason: null,
    },
    "Unable to log label bundle decision",
  );

  scheduleMetricEmit("label_bundle.completed", {
    org: bundleInput.organization_id,
    client: bundleInput.client_id ?? null,
    sender: bundleInput.sender_id ?? null,
    integration: integration.kind,
    bucket: LABEL_BUCKET,
  }, {
    requested: targets.length,
    bundled: bundled.length,
    placeholders: placeholders.length,
    bundle_size_bytes: bundleSizeBytes,
  });

  const responseBody = {
    status: "ok",
    organization_id: bundleInput.organization_id,
    client_id: bundleInput.client_id ?? null,
    bundle_id: bundleId,
    file_path: artifactReturn.file_path,
    file_url: artifactReturn.file_url,
    signed_url: signedUrl,
    expires_seconds: expiresSeconds,
    expires_at: expiresAt,
    started_at: startedAt,
    completed_at: completedAt,
    output_name: safeOutputName,
    counts: {
      requested: targets.length,
      bundled: bundled.length,
      placeholders: placeholders.length,
    },
    timings: {
      collect_targets_ms: targetsMs,
      build_bundle_ms: buildMs,
      build_signed_urls_ms: Number((bundleTimings as any)?.signed_urls_ms) || 0,
      build_download_ms: Number((bundleTimings as any)?.download_ms) || 0,
      build_merge_ms: Number((bundleTimings as any)?.merge_ms) || 0,
      build_save_ms: Number((bundleTimings as any)?.save_ms) || 0,
      build_total_ms: Number((bundleTimings as any)?.total_ms) || 0,
      build_preloaded_count: Number((bundleTimings as any)?.preloaded_count) || 0,
      build_downloaded_count: Number((bundleTimings as any)?.downloaded_count) || 0,
      build_download_concurrency: (bundleTimings as any)?.download_concurrency ?? bundleDownloadConcurrency,
      build_chunk_size: (bundleTimings as any)?.chunk_size ?? bundleChunkSize,
      upload_ms: artifactReturn.upload_ms,
      signed_url_ms: signedMs,
      total_ms: totalMs,
    },
    bundled_labels: bundled,
    placeholder_labels: placeholders,
    metadata: bundleInput.metadata ?? null,
  };
  return returnBundleResponse(200, responseBody);
};

const withCors = (res: Response, corsHeaders: Record<string, string>) => {
  const headers = new Headers(res.headers);
  Object.entries(corsHeaders).forEach(([key, value]) => {
    headers.set(key, value);
  });
  headers.set("x-masarx-edge-function", "label-renderer");
  headers.set("x-masarx-renderer-transport", "1");
  return new Response(res.body, { status: res.status, headers });
};

Deno.serve(async (req: Request): Promise<Response> => {
  const { headers: corsHeaders } = resolveCorsPolicy(req, {
    hostedAllowedOrigins: readEnv("LABEL_RENDERER_CORS_ALLOW_ORIGINS"),
    localAllowedOrigins: readEnv("PUBLIC_INGRESS_LOCAL_CORS_ALLOW_ORIGINS"),
    allowedMethods: "POST, OPTIONS",
  });
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  // Optional smoke-test bypass: only when explicitly enabled by env
  const smokeAllow = Deno.env.get("EDGE_SMOKE_ALLOW");
  const smokeHeader = req.headers.get("x-smoke-test");
  if (smokeAllow === "1" && smokeHeader === "edge-allow") {
    // Return 204 to indicate idle/successful no-op
    return withCors(new Response(null, { status: 204 }), corsHeaders);
  }
  try {
    const payload = await parseRequest(req);
    if (
      payload &&
      typeof payload === "object" &&
      (payload as any).mode === "designer_preview"
    ) {
      const previewResult = await handleDesignerPreview(payload);
      return withCors(new Response(JSON.stringify(previewResult.body), {
        status: previewResult.statusCode,
        headers: { "content-type": "application/json" },
      }), corsHeaders);
    }

    const operation = resolveLabelRendererOperation(payload);
    const authorization = authorizeLabelRendererRequest(req, operation, {
      requireDbJwt: true,
      rendererTokenOnly: true,
    });
    if (!authorization.ok) {
      return withCors(new Response(JSON.stringify({ error: authorization.message }), {
        status: authorization.status,
        headers: { "content-type": "application/json" },
      }), corsHeaders);
    }
    const verification = await verifyLabelRendererToken(req, readEnv("LABEL_RENDERER_SIGNING_KEY"));
    if (!verification.ok) {
      return withCors(new Response(JSON.stringify({ error: verification.message }), {
        status: verification.status,
        headers: { "content-type": "application/json" },
      }), corsHeaders);
    }

    const correlationId =
      req.headers.get("x-correlation-id") && req.headers.get("x-correlation-id")!.trim() !== ""
        ? req.headers.get("x-correlation-id")!
        : crypto.randomUUID();

    const integration = INTERNAL_INTEGRATION;

    if (operation === "print") {
      const printResult = await handlePrintRequest(payload, correlationId, integration);
      return withCors(new Response(JSON.stringify(printResult.body), {
        status: printResult.statusCode,
        headers: { "content-type": "application/json" },
      }), corsHeaders);
    }

    if (operation === "bundle") {
      const bundleResult = await handleBundleRequest(payload, integration);
      return withCors(new Response(JSON.stringify(bundleResult.body), {
        status: bundleResult.statusCode,
        headers: { "content-type": "application/json" },
      }), corsHeaders);
    }

    const client = ensureSupabase();

    const payloadOrgId = typeof (payload as LeaseRequest).organization_id === "string"
      ? (payload as LeaseRequest).organization_id
      : null;
    const targetedJobIds = Array.isArray((payload as LeaseRequest).job_ids)
      ? Array.from(
        new Set(
          (payload as LeaseRequest).job_ids
            .map((value) => normalizeString(value))
            .filter((value): value is string => !!value),
        ),
      )
      : [];
    const targetedMode = targetedJobIds.length > 0;
    const leaseParams: Record<string, unknown> = {
      p_lease_seconds: (payload as LeaseRequest).lease_seconds ?? 120,
    };
    const effectiveOrgId = payloadOrgId ?? null;
    if (effectiveOrgId) {
      leaseParams.p_organization_id = effectiveOrgId;
    }
    if ((payload as LeaseRequest).job_id) leaseParams.p_job_id = (payload as LeaseRequest).job_id;

    const maxJobsRaw = Number((payload as LeaseRequest).max_jobs);
    const jobConcurrencyRaw = Number((payload as LeaseRequest).job_concurrency);
    const requestedMaxJobs =
      Number.isFinite(maxJobsRaw) && maxJobsRaw > 0
        ? Math.max(1, Math.min(100, Math.floor(maxJobsRaw)))
        : (targetedMode ? Math.max(1, Math.min(100, targetedJobIds.length)) : 1);
    const maxJobs =
      !(payload as LeaseRequest).job_id && requestedMaxJobs > 1
        ? requestedMaxJobs
        : 1;
    const jobConcurrency =
      Number.isFinite(jobConcurrencyRaw) && jobConcurrencyRaw > 0
        ? Math.max(1, Math.min(25, Math.floor(jobConcurrencyRaw)))
        : (maxJobs > 1 ? Math.min(4, maxJobs) : 1);

    const overallStart = performance.now();
    const leaseStart = performance.now();
    const leasedJobs: LabelJob[] = [];

    if (targetedMode) {
      const { data: targetedJobs, error: targetedError } = await client.rpc("lease_label_jobs_by_ids", {
        p_job_ids: targetedJobIds,
        p_lease_seconds: leaseParams.p_lease_seconds,
        p_max_jobs: Math.min(maxJobs, targetedJobIds.length),
      });
      if (targetedError) {
        throw new Error(`lease_label_jobs_by_ids failed: ${targetedError.message}`);
      }
      if (Array.isArray(targetedJobs)) {
        targetedJobs.forEach((job) => {
          if (job && typeof job === "object" && (job as Record<string, unknown>)?.["id"]) {
            leasedJobs.push(job as LabelJob);
          }
        });
      }
    } else if (maxJobs > 1 && !(payload as LeaseRequest).job_id) {
      try {
        const { data: batchJobs, error: batchError } = await client.rpc("lease_label_jobs", {
          p_organization_id: effectiveOrgId ?? null,
          p_lease_seconds: leaseParams.p_lease_seconds,
          p_max_jobs: maxJobs,
        });
        if (batchError) {
          logRenderer("warn", "batch_lease_fallback", { error: batchError });
        } else if (Array.isArray(batchJobs)) {
          batchJobs.forEach((job) => {
            if (job && typeof job === "object" && (job as Record<string, unknown>)?.["id"]) {
              leasedJobs.push(job as LabelJob);
            }
          });
        }
      } catch (err) {
        logRenderer("warn", "batch_lease_fallback", { error: err });
      }
    }

    if (!targetedMode && leasedJobs.length === 0) {
      for (let i = 0; i < maxJobs; i += 1) {
        const { data: job, error: leaseError } = await client.rpc("lease_label_job", leaseParams).single();
        if (leaseError) {
          throw new Error(`Failed to lease label job: ${leaseError.message}`);
        }
        if (!job || !(job as Record<string, unknown>)?.["id"]) {
          break;
        }
        leasedJobs.push(job as LabelJob);
      }
    }
    const leaseMs = performance.now() - leaseStart;

    if (leasedJobs.length === 0) {
      return withCors(new Response(null, { status: 204 }), corsHeaders);
    }

    await assertLabelBucketAvailable();

    if (leasedJobs.length === 1 && maxJobs === 1) {
      const result = await processLabelJob(client, leasedJobs[0], correlationId, integration, {
        completeInDb: false,
      });
      await completeProcessedLabelJobs(client, [result]);
      if (result.status === "ok") {
        return withCors(new Response(JSON.stringify({
          status: "ok",
          job_id: result.job_id,
          file_url: result.file_url,
          metadata: result.metadata,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }), corsHeaders);
      }

      const message = typeof (result.metadata as any)?.error === "string"
        ? String((result.metadata as any).error)
        : result.error ?? "label_render_failed";
      return withCors(new Response(JSON.stringify({
        status: "failed",
        job_id: result.job_id,
        reason: result.error ?? "label_render_failed",
        message,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }), corsHeaders);
    }

    const jobsStart = performance.now();
    const results = await mapWithConcurrency(leasedJobs, jobConcurrency, async (job) => {
      return await processLabelJob(client, job, correlationId, integration, {
        completeInDb: false,
      });
    });
    await completeProcessedLabelJobs(client, results);
    const jobsMs = performance.now() - jobsStart;
    const totalMs = performance.now() - overallStart;

    const okCount = results.filter((r) => r.status === "ok").length;
    const failedCount = results.length - okCount;

    await emitMetric("label_worker.completed", {
      org: effectiveOrgId ?? null,
      integration: integration.kind,
      max_jobs: maxJobs,
      concurrency: jobConcurrency,
      targeted: targetedMode,
    }, {
      leased: leasedJobs.length,
      ok: okCount,
      failed: failedCount,
    });

    return withCors(new Response(JSON.stringify({
      status: "ok",
      mode: "worker",
      requested_max_jobs: maxJobs,
      job_concurrency: jobConcurrency,
      requested_job_ids: targetedMode ? targetedJobIds.length : null,
      targeted: targetedMode,
      counts: {
        leased: leasedJobs.length,
        ok: okCount,
        failed: failedCount,
      },
      timings: {
        lease_ms: leaseMs,
        jobs_ms: jobsMs,
        total_ms: totalMs,
      },
      jobs: results,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }), corsHeaders);
  } catch (err) {
    logRenderer("error", "request_failed", { error: err });
    return withCors(new Response(JSON.stringify({
      error: err instanceof Error ? err.message : "Unknown error",
    }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }), corsHeaders);
  }
});

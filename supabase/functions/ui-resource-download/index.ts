import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@^2.45.4";
import { extractToken, parseRequestBody, readEnv } from "../_shared/mod.mjs";
import { buildCorsHeaders, withCorsJson } from "../_shared/cors.mjs";

type JsonRecord = Record<string, unknown>;

type DownloadConfig = {
  capability?: string | null;
  bucket?: string | null;
  path_column?: string | null;
  expires_seconds?: number | string | null;
};

type DownloadResult = {
  bucket: string;
  path: string;
};

type WorkflowOutputStatus = {
  output_url?: unknown;
  output_file_path?: unknown;
  output_bucket?: unknown;
  output_ready?: unknown;
  status_checked_at?: unknown;
};

const SUPABASE_URL = readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]);
const SUPABASE_ANON_KEY = readEnv("EDGE_SUPABASE_ANON_KEY", ["SUPABASE_ANON_KEY"]);
const SUPABASE_SERVICE_ROLE_KEY = readEnv("EDGE_SUPABASE_SERVICE_ROLE_KEY", [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE_KEY",
]);

const DEFAULT_BUCKET = readEnv("LABEL_DOWNLOAD_BUCKET", ["LABEL_RENDER_BUCKET"])
  .trim();

const DEFAULT_EXPIRES_SECONDS = Number.parseInt(
  readEnv("LABEL_DOWNLOAD_EXPIRES_SECONDS", ["LABEL_SIGNED_URL_EXPIRES_SECONDS"]),
  10,
);

const parsePositiveInt = (value: number, fallback: number) => {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(Math.floor(value), 60), 3600);
};

const normalizeStoragePath = (
  rawPath: string,
  bucketFallback: string,
): DownloadResult | null => {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      const patterns = [
        "/storage/v1/object/",
        "/storage/v1/object/public/",
        "/storage/v1/object/sign/",
      ];
      const matched = patterns.find((pattern) => url.pathname.includes(pattern));
      if (matched) {
        const rest = url.pathname.split(matched)[1] ?? "";
        const parts = rest.split("/").filter(Boolean);
        const bucket = parts.shift();
        const path = parts.join("/");
        if (bucket && path) {
          return { bucket, path };
        }
      }
    } catch (_err) {
      // ignore malformed urls
    }
  }

  const normalized = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  if (bucketFallback && normalized.startsWith(`${bucketFallback}/`)) {
    return {
      bucket: bucketFallback,
      path: normalized.slice(bucketFallback.length + 1),
    };
  }

  if (!bucketFallback) return null;
  return { bucket: bucketFallback, path: normalized };
};

const ensureConfig = () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("ui-resource-download missing Supabase configuration");
    return false;
  }
  return true;
};

const asRecord = (value: unknown): JsonRecord | null => {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) return null;
  return value as JsonRecord;
};

const getString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return withCorsJson(405, { error: "Method not allowed." }, corsHeaders);
  }

  if (!ensureConfig()) {
    return withCorsJson(500, { error: "Missing Supabase configuration." }, corsHeaders);
  }

  const token = extractToken(req, { prefer: "authorization", allowQueryParam: false, allowWebhookHeader: false });
  if (!token) {
    return withCorsJson(401, { error: "Missing authorization token." }, corsHeaders);
  }

  let body: JsonRecord = {};
  if (req.method !== "GET") {
    try {
      const parsed = await parseRequestBody(req);
      if (parsed?.json && typeof parsed.json === "object") {
        body = parsed.json as JsonRecord;
      }
    } catch (error) {
      return withCorsJson(
        400,
        { error: error instanceof Error ? error.message : "Invalid JSON." },
        corsHeaders,
      );
    }
  }

  const url = new URL(req.url);
  const workflowRunId = getString(url.searchParams.get("workflow_run_id") ?? body.workflow_run_id);
  const resource = getString(url.searchParams.get("resource") ?? body.resource);
  const id = getString(url.searchParams.get("id") ?? body.id);
  const shipmentId = getString(url.searchParams.get("shipment_id") ?? body.shipment_id);
  const outputUrlPaths = Array.isArray(body.output_url_paths)
    ? body.output_url_paths.map((entry) => getString(entry)).filter(Boolean)
    : null;

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    db: { schema: "api" },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const expiresRaw = Number.parseInt(String(body.expires_seconds ?? url.searchParams.get("expires_seconds") ?? ""), 10);
  const expiresSeconds = parsePositiveInt(
    Number.isFinite(expiresRaw) ? expiresRaw : DEFAULT_EXPIRES_SECONDS,
    900,
  );

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    db: { schema: "api" },
  });

  if (workflowRunId) {
    const { data: status, error: statusError } = await userClient.rpc(
      "ui_get_workflow_run_output_status_v1",
      {
        p_workflow_run_id: workflowRunId,
        p_output_url_paths: outputUrlPaths && outputUrlPaths.length > 0 ? outputUrlPaths : null,
      },
    );
    if (statusError || !status) {
      return withCorsJson(404, {
        error: statusError?.message ?? "Workflow output not available.",
      }, corsHeaders);
    }

    const statusRecord = asRecord(status as WorkflowOutputStatus);
    const readyUrl = getString(statusRecord?.output_url);
    if (readyUrl) {
      return withCorsJson(200, {
        url: readyUrl,
        expires_at:
          typeof statusRecord?.status_checked_at === "string"
            ? statusRecord.status_checked_at
            : null,
      }, corsHeaders);
    }

    const readyFilePath = getString(statusRecord?.output_file_path);
    const readyBucket = getString(statusRecord?.output_bucket) || DEFAULT_BUCKET;
    const readyOutput =
      Boolean(statusRecord?.output_ready) || Boolean(readyFilePath);
    if (!readyOutput || !readyFilePath) {
      return withCorsJson(409, { error: "Workflow output is not ready." }, corsHeaders);
    }

    const { data: signedData, error: signedError } = await serviceClient.storage
      .from(readyBucket)
      .createSignedUrl(readyFilePath, expiresSeconds);
    if (signedError) {
      return withCorsJson(502, { error: signedError.message }, corsHeaders);
    }

    const signedRecord = asRecord(signedData);
    const signedUrl = getString(
      signedRecord?.signedUrl ?? signedRecord?.signedURL ?? signedRecord?.url,
    );
    if (!signedUrl) {
      return withCorsJson(502, { error: "Signed URL missing." }, corsHeaders);
    }

    return withCorsJson(200, {
      url: signedUrl,
      expires_at: signedRecord?.expires_at ?? signedRecord?.expiration ?? null,
    }, corsHeaders);
  }

  if (!resource || !id) {
    return withCorsJson(400, { error: "resource and id are required." }, corsHeaders);
  }

  if (resource === "shipment_pod_asset") {
    if (!shipmentId) {
      return withCorsJson(400, { error: "shipment_id is required for shipment POD asset downloads." }, corsHeaders);
    }

    const { data: podAssetDownload, error: podAssetError } = await userClient.rpc(
      "ui_get_shipment_pod_asset_download_v1",
      {
        p_shipment_id: shipmentId,
        p_artifact_id: id,
      },
    );

    if (podAssetError) {
      return withCorsJson(404, { error: podAssetError.message }, corsHeaders);
    }

    const podAssetRecord = asRecord(Array.isArray(podAssetDownload) ? podAssetDownload[0] : podAssetDownload);
    const podAssetBucket = getString(podAssetRecord?.storage_bucket);
    const podAssetPath = getString(podAssetRecord?.storage_key);
    if (!podAssetBucket || !podAssetPath) {
      return withCorsJson(404, { error: "Shipment POD asset download path is unavailable." }, corsHeaders);
    }

    const { data: signedData, error: signedError } = await serviceClient.storage
      .from(podAssetBucket)
      .createSignedUrl(podAssetPath, expiresSeconds);

    if (signedError) {
      return withCorsJson(502, { error: signedError.message }, corsHeaders);
    }

    const signedRecord = asRecord(signedData);
    const signedUrl = getString(
      signedRecord?.signedUrl ?? signedRecord?.signedURL ?? signedRecord?.url,
    );
    if (!signedUrl) {
      return withCorsJson(502, { error: "Signed URL missing." }, corsHeaders);
    }

    return withCorsJson(200, {
      url: signedUrl,
      expires_at: signedRecord?.expires_at ?? signedRecord?.expiration ?? null,
      file_name: getString(podAssetRecord?.file_name) || null,
      mime_type: getString(podAssetRecord?.mime_type) || null,
      asset_kind: getString(podAssetRecord?.asset_kind) || null,
    }, corsHeaders);
  }

  const { data: registry, error: registryError } = await userClient.rpc("ui_read_registry_v1");
  if (registryError || !registry) {
    return withCorsJson(403, { error: registryError?.message ?? "Unable to load registry." }, corsHeaders);
  }

  const registryRecord = asRecord(registry);
  const resources = Array.isArray(registryRecord?.resources) ? registryRecord?.resources : [];
  const match = resources.find((entry) => asRecord(entry)?.key === resource) as JsonRecord | undefined;
  if (!match) {
    return withCorsJson(404, { error: "Resource not registered." }, corsHeaders);
  }

  const download = asRecord(match.download) as DownloadConfig | null;
  const capability = getString(download?.capability ?? match.capability_read);
  const pathColumn = getString(download?.path_column);

  if (!download || !pathColumn) {
    return withCorsJson(400, { error: "Resource does not define download settings." }, corsHeaders);
  }

  if (capability) {
    const { error: capabilityError } = await userClient.rpc("assert_capability_v1", {
      p_capability_key: capability,
      p_scope_type: null,
      p_scope_id: null,
    });
    if (capabilityError) {
      return withCorsJson(403, { error: capabilityError.message }, corsHeaders);
    }
  }

  const { data: record, error: recordError } = await userClient.rpc("ui_get_resource_v1", {
    p_resource: resource,
    p_id: id,
  });

  if (recordError) {
    return withCorsJson(404, { error: recordError.message }, corsHeaders);
  }

  const recordData = asRecord(record);
  const filePath = getString(recordData?.[pathColumn]);
  if (!filePath) {
    return withCorsJson(404, { error: "Download path missing." }, corsHeaders);
  }

  const bucket = getString(download?.bucket) || DEFAULT_BUCKET;
  const normalized = normalizeStoragePath(filePath, bucket);
  if (!normalized) {
    return withCorsJson(500, { error: "Unable to resolve storage path." }, corsHeaders);
  }

  const resourceExpiresRaw = Number.parseInt(String(download?.expires_seconds ?? ""), 10);
  const resourceExpiresSeconds = parsePositiveInt(
    Number.isFinite(resourceExpiresRaw) ? resourceExpiresRaw : expiresSeconds,
    900,
  );

  const { data: signedData, error: signedError } = await serviceClient.storage
    .from(normalized.bucket)
    .createSignedUrl(normalized.path, resourceExpiresSeconds);

  if (signedError) {
    return withCorsJson(502, { error: signedError.message }, corsHeaders);
  }

  const signedRecord = asRecord(signedData);
  const urlValue = getString(
    signedRecord?.signedUrl ?? signedRecord?.signedURL ?? signedRecord?.url,
  );

  if (!urlValue) {
    return withCorsJson(502, { error: "Signed URL missing." }, corsHeaders);
  }

  return withCorsJson(200, {
    url: urlValue,
    expires_at: signedRecord?.expires_at ?? signedRecord?.expiration ?? null,
  }, corsHeaders);
});

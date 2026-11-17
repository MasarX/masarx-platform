import { type NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Workbook } from "exceljs";
import { getVerifiedAccessToken, validateTrustedBrowserRequest } from "@masarx/auth";
import {
  buildTabularHeaderFingerprint,
  detectWorkbookVisibleSheets,
  matrixToTabularData,
  parseCsvTextMatrix,
  resolveWorkbookWorksheet,
  worksheetToMatrix,
} from "@masarx/api";
import { getPublicConfig } from "@masarx/config";
import {
  getRequestIdFromHeaders,
  jsonResponseWithRequestId,
} from "./request-meta";

const IMPORT_BUCKET = "tabular-imports";
const SIGNED_URL_TTL_SECONDS = 60 * 60;
const EDGE_RPC_SCHEMA =
  process.env.RESOURCE_IMPORT_RPC_SCHEMA ||
  process.env.EDGE_RPC_SCHEMA ||
  process.env.API_RPC_SCHEMA ||
  "api";

type JsonRecord = Record<string, unknown>;

type ResourceImportAction = "prepare" | "start" | "get_run" | "cancel";

const asRecord = (value: unknown): JsonRecord | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
};

const firstRecord = <T extends JsonRecord = JsonRecord>(value: unknown): T | null => {
  if (Array.isArray(value)) {
    const first = value[0];
    return asRecord(first) as T | null;
  }
  return asRecord(value) as T | null;
};

const asString = (value: unknown) => {
  if (typeof value !== "string") return "";
  return value.trim();
};

const maybeUuid = (value: unknown): string | null => {
  const text = asString(value);
  if (!text) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    return text;
  }
  return null;
};

const isJwtLike = (value: string) => String(value || "").trim().split(".").length === 3;

const sanitizeFileName = (value: string, fallback = "import.csv") => {
  const normalized = value
    .trim()
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
};

const resolveUploadMimeType = (fileName: string, rawMimeType: string | null | undefined) => {
  const explicit = asString(rawMimeType);
  if (explicit) return explicit;
  const extension = fileName.split(".").pop()?.trim().toLowerCase() || "";
  if (extension === "csv") return "text/csv";
  if (extension === "xlsx") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  return "application/octet-stream";
};

function createServiceClient() {
  const { supabaseUrl, supabaseAnonKey } = getPublicConfig();
  const serviceKey = [
    process.env.SUPABASE_SECRET_KEY,
    process.env.EDGE_SUPABASE_SECRET_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SERVICE_ROLE_KEY,
    process.env.SUPABASE_SERVICE_KEY,
  ]
    .map((entry) => String(entry || "").trim())
    .find(Boolean);

  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing Supabase service configuration for resource imports.");
  }

  const apiKeyHeader = isJwtLike(serviceKey)
    ? String(process.env.SUPABASE_ANON_KEY || "").trim() || supabaseAnonKey || serviceKey
    : serviceKey;

  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: EDGE_RPC_SCHEMA },
    global: {
      headers: {
        apikey: apiKeyHeader,
      },
    },
  });
}

async function hydrateArtifacts(
  serviceClient: SupabaseClient<any, any, any>,
  run: JsonRecord,
) {
  const rawArtifacts = Array.isArray(run.artifacts) ? run.artifacts : [];
  const artifacts = await Promise.all(
    rawArtifacts.map(async (artifact) => {
      const record = asRecord(artifact) ?? {};
      const bucket = asString(record.storage_bucket);
      const key = asString(record.storage_key);
      if (!bucket || !key) return record;
      try {
        const { data, error } = await serviceClient.storage
          .from(bucket)
          .createSignedUrl(key, SIGNED_URL_TTL_SECONDS);
        if (!error && data?.signedUrl) {
          return {
            ...record,
            signed_url: data.signedUrl,
          };
        }
      } catch {
        return record;
      }
      return record;
    }),
  );

  return {
    ...run,
    artifacts,
  };
}

async function loadCurrentUiContext(userClient: SupabaseClient<any, any, any>) {
  const { data, error } = await userClient.rpc("ui_me_v1");
  if (error) {
    throw new Error(error.message || "Unable to load UI context");
  }
  const me = asRecord(data) ?? {};
  const organization = asRecord(me.org);
  const user = asRecord(me.user);
  return {
    me,
    organizationId: maybeUuid(organization?.id) ?? null,
    userId: maybeUuid(user?.id) ?? null,
  };
}

function parseRules(value: FormDataEntryValue | null): unknown[] {
  if (typeof value !== "string") return [];
  if (!value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new Error("rules must be valid JSON");
  }
}

function parseJsonObject(value: FormDataEntryValue | null, fieldName: string): JsonRecord {
  if (typeof value !== "string") return {};
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonRecord) : {};
  } catch {
    throw new Error(`${fieldName} must be valid JSON`);
  }
}

async function resolveImportScopeContext(
  userClient: SupabaseClient<any, any, any>,
  resourceKey: string,
  scopeContext: JsonRecord,
) {
  const { data, error } = await userClient.rpc("ui_resolve_import_scope_context_v1", {
    p_payload: {
      resource_key: resourceKey,
      scope_context: scopeContext,
    },
  });
  if (error) {
    throw new Error(error.message || "Unable to resolve import scope.");
  }
  return asRecord(data) ?? {};
}

async function parseWorkbookFromFile(file: File, requestedSheet?: string | null) {
  const extension = file.name.split(".").pop()?.trim().toLowerCase() || "csv";
  if (extension === "xls") {
    throw new Error("Legacy .xls workbooks are not supported. Upload a CSV or XLSX file.");
  }

  if (extension === "csv") {
    const parsed = matrixToTabularData(parseCsvTextMatrix(await file.text()));
    return {
      headers: parsed.headers,
      rows: parsed.rows,
      selectedSheet: "Sheet1",
      visibleSheets: ["Sheet1"],
    };
  }

  if (extension !== "xlsx") {
    throw new Error("Unsupported file format. Upload a CSV or XLSX file.");
  }

  const workbook = new Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const visibleSheets = detectWorkbookVisibleSheets(workbook as never);
  const selectedSheet =
    (requestedSheet && visibleSheets.includes(requestedSheet) ? requestedSheet : null) ??
    visibleSheets[0] ??
    workbook.worksheets[0]?.name ??
    "";

  if (!selectedSheet) {
    throw new Error("The uploaded workbook did not contain a readable worksheet.");
  }

  const sheet = resolveWorkbookWorksheet(workbook as never, selectedSheet);
  if (!sheet) {
    throw new Error(`Worksheet ${selectedSheet} could not be read.`);
  }

  const parsed = matrixToTabularData(worksheetToMatrix(sheet as never));

  return {
    headers: parsed.headers,
    rows: parsed.rows,
    selectedSheet,
    visibleSheets,
  };
}

async function uploadSourceArtifact(params: {
  serviceClient: SupabaseClient<any, any, any>;
  organizationId: string;
  userId: string | null;
  file: File;
  resourceKey: string;
  sheetName: string;
  headerFingerprint: string;
}) {
  const safeName = sanitizeFileName(params.file.name || "import.csv");
  const storageKey = `${params.organizationId}/imports/${params.resourceKey}/${Date.now()}-${safeName}`;
  const bytes = await params.file.arrayBuffer();
  const mimeType = resolveUploadMimeType(params.file.name, params.file.type);
  const { error: uploadError } = await params.serviceClient.storage
    .from(IMPORT_BUCKET)
    .upload(storageKey, new Blob([bytes], { type: mimeType }), {
      upsert: true,
      contentType: mimeType,
    });

  if (uploadError) {
    throw new Error(uploadError.message || "Failed to upload source file");
  }

  const { data, error } = await params.serviceClient.rpc("register_artifact_v1", {
    p_artifact: {
      organization_id: params.organizationId,
      storage_bucket: IMPORT_BUCKET,
      storage_key: storageKey,
      mime_type: mimeType,
      size_bytes: params.file.size,
      created_by_user_id: params.userId,
      source_system: "resource_import_route",
      metadata: {
        file_name: safeName,
        resource_key: params.resourceKey,
        sheet_name: params.sheetName,
        header_fingerprint: params.headerFingerprint,
      },
    },
  });

  if (error) {
    throw new Error(error.message || "Failed to register source artifact");
  }

  const artifact = firstRecord<{ artifact_id?: string | null }>(data);
  return {
    artifactId: artifact?.artifact_id ?? null,
    fileName: safeName,
  };
}

async function resolveAction(request: NextRequest) {
  const contentType = request.headers.get("content-type") || "";
  if (
    contentType.includes("multipart/form-data") ||
    contentType.includes("application/x-www-form-urlencoded")
  ) {
    const form = await request.formData();
    const action = asString(form.get("action")).toLowerCase();
    return {
      action:
        action === "prepare" || action === "start" || action === "get_run" || action === "cancel"
          ? (action as ResourceImportAction)
          : null,
      body: {} as JsonRecord,
      form,
    };
  }

  const body = asRecord(await request.json().catch(() => null)) ?? {};
  const action = asString(body.action).toLowerCase();
  return {
    action:
      action === "prepare" || action === "start" || action === "get_run" || action === "cancel"
        ? (action as ResourceImportAction)
        : null,
    body,
    form: null,
  };
}

export async function handleResourceImportRequest(request: NextRequest) {
  const requestId = getRequestIdFromHeaders(request);

  if (request.method !== "POST") {
    return jsonResponseWithRequestId(
      { error: "Method not allowed.", requestId },
      405,
      requestId,
    );
  }

  const trustedRequest = validateTrustedBrowserRequest(request);
  if (!trustedRequest.ok) {
    return jsonResponseWithRequestId(
      { error: trustedRequest.message, code: trustedRequest.code, requestId },
      trustedRequest.status,
      requestId,
    );
  }

  const {
    client: userClient,
    error: sessionError,
  } = await getVerifiedAccessToken({ allowCookieSet: false });
  if (sessionError) {
    return jsonResponseWithRequestId({ error: "Unauthorized.", requestId }, 401, requestId);
  }

  let payload: Awaited<ReturnType<typeof resolveAction>>;
  try {
    payload = await resolveAction(request);
  } catch (error) {
    return jsonResponseWithRequestId(
      {
        error: error instanceof Error ? error.message : "Invalid request body.",
        requestId,
      },
      400,
      requestId,
    );
  }

  if (!payload.action) {
    return jsonResponseWithRequestId(
      {
        error: "Expected one of prepare, start, get_run, or cancel.",
        requestId,
      },
      400,
      requestId,
    );
  }

  let serviceClient: SupabaseClient<any, any, any>;
  try {
    serviceClient = createServiceClient();
  } catch (error) {
    return jsonResponseWithRequestId(
      {
        error: error instanceof Error ? error.message : "Missing service configuration.",
        requestId,
      },
      500,
      requestId,
    );
  }

  try {
    if (payload.action === "prepare") {
      const form = payload.form;
      if (!form) {
        return jsonResponseWithRequestId(
          { error: "Prepare requires multipart form data.", requestId },
          400,
          requestId,
        );
      }

      const file = form.get("file");
      if (!(file instanceof File)) {
        return jsonResponseWithRequestId(
          { error: "Prepare requires a CSV or XLSX file.", requestId },
          400,
          requestId,
        );
      }

      const resourceKey = asString(form.get("resource_key"));
      if (!resourceKey) {
        return jsonResponseWithRequestId(
          { error: "Prepare requires resource_key.", requestId },
          400,
          requestId,
        );
      }

      const workbook = await parseWorkbookFromFile(file, asString(form.get("sheet_name")) || null);
      const scopeContext = parseJsonObject(form.get("scope_context"), "scope_context");
      const scopeResolution = await resolveImportScopeContext(userClient, resourceKey, scopeContext);
      const organizationId = maybeUuid(scopeResolution.organization_id);
      const normalizedScopeContext = asRecord(scopeResolution.scope_context) ?? scopeContext;
      const { userId } = await loadCurrentUiContext(userClient);
      if (!organizationId) {
        return jsonResponseWithRequestId(
          {
            error: "Choose an import organization, client, or sender before uploading the file.",
            requestId,
          },
          400,
          requestId,
        );
      }

      const headerFingerprint = buildTabularHeaderFingerprint(workbook.headers);
      const uploaded = await uploadSourceArtifact({
        serviceClient,
        organizationId,
        userId,
        file,
        resourceKey,
        sheetName: workbook.selectedSheet,
        headerFingerprint,
      });

      const { data, error } = await userClient.rpc("tabular_import_prepare_v1", {
        p_payload: {
          resource_key: resourceKey,
          write_mode: asString(form.get("write_mode")) || "create",
          rule_source: asString(form.get("rule_source")) || "auto",
          source_format: file.name.split(".").pop()?.trim().toLowerCase() || "csv",
          source_file_name: uploaded.fileName,
          source_artifact_id: uploaded.artifactId,
          sheet_name: workbook.selectedSheet,
          header_fingerprint: headerFingerprint,
          headers: workbook.headers,
          rows: workbook.rows,
          rules: parseRules(form.get("rules")),
          row_overrides: parseJsonObject(form.get("row_overrides"), "row_overrides"),
          scope_context: normalizedScopeContext,
        },
      });

      if (error) {
        throw new Error(error.message || "Failed to prepare import run");
      }

      const dryRun = asRecord(data) ?? {};
      return jsonResponseWithRequestId(
        {
          ok: true,
          dry_run: dryRun,
          profile_match: asRecord(dryRun.profile) ?? null,
          available_profiles: Array.isArray(dryRun.available_profiles) ? dryRun.available_profiles : [],
          resolved_rules: Array.isArray(dryRun.resolved_rules) ? dryRun.resolved_rules : [],
          correlation_id: requestId,
          requestId,
        },
        200,
        requestId,
      );
    }

    if (payload.action === "start") {
      const runId = maybeUuid(payload.body.run_id);
      if (!runId) {
        return jsonResponseWithRequestId(
          { error: "Start requires a valid run_id.", requestId },
          400,
          requestId,
        );
      }

      const { data, error } = await userClient.rpc("ui_start_tabular_import_run_v1", {
        p_run_id: runId,
        p_save_profile: asRecord(payload.body.save_profile) ?? null,
      });
      if (error) {
        throw new Error(error.message || "Failed to start import run");
      }

      const run = (await hydrateArtifacts(serviceClient, asRecord(data) ?? {})) as JsonRecord;
      return jsonResponseWithRequestId(
        {
          ok: true,
          run,
          report: asRecord(run.report) ?? null,
          correlation_id: requestId,
          requestId,
        },
        200,
        requestId,
      );
    }

    if (payload.action === "get_run") {
      const runId = maybeUuid(payload.body.run_id);
      if (!runId) {
        return jsonResponseWithRequestId(
          { error: "get_run requires a valid run_id.", requestId },
          400,
          requestId,
        );
      }

      const { data, error } = await userClient.rpc("ui_get_tabular_import_run_v1", {
        p_run_id: runId,
      });
      if (error) {
        throw new Error(error.message || "Failed to load import run");
      }

      const run = (await hydrateArtifacts(serviceClient, asRecord(data) ?? {})) as JsonRecord;
      return jsonResponseWithRequestId(run, 200, requestId);
    }

    const runId = maybeUuid(payload.body.run_id);
    if (!runId) {
      return jsonResponseWithRequestId(
        { error: "Cancel requires a valid run_id.", requestId },
        400,
        requestId,
      );
    }

    const { data, error } = await userClient.rpc("ui_cancel_tabular_import_run_v1", {
      p_run_id: runId,
    });
    if (error) {
      throw new Error(error.message || "Failed to cancel import run");
    }

    const run = (await hydrateArtifacts(serviceClient, asRecord(data) ?? {})) as JsonRecord;
    return jsonResponseWithRequestId(
      {
        ok: true,
        run,
        correlation_id: requestId,
        requestId,
      },
      200,
      requestId,
    );
  } catch (error) {
    return jsonResponseWithRequestId(
      {
        error: error instanceof Error ? error.message : "Resource import request failed.",
        requestId,
      },
      400,
      requestId,
    );
  }
}

import JSZip from "npm:jszip@3.10.2";
import { ImportLimitError, matrixToTabularData, assertMatrixDimensions, assertRequestSize, assertUploadSize, assertXlsxExpansionLimits, parseBoundedCsv } from "./upload-limits.ts";
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { Workbook, type Worksheet } from "./_vendor/exceljs.mjs";
import {
  ImportPreparationError,
  loadImportPreparation,
  processStartedImport,
  validateImportFile,
  validateImportWorkbook,
} from "./preparation.ts";
import {
  buildErrorEnvelope,
  canonicalStorageKey,
  extractToken,
  isStorageBucketId,
  logStructured,
  parseRequestBody,
  readEnv,
  resolveCorrelationId,
  resolveTraceContext,
} from "./_shared/mod.mjs";

type JsonRecord = Record<string, unknown>;
type ResourceImportAction = "prepare" | "start" | "get_run" | "cancel";

const SERVICE_NAME = "resource-import-studio";
const IMPORT_BUCKET = "tabular-imports";
const SIGNED_URL_TTL_SECONDS = 60 * 60;

const SUPABASE_URL = readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]);
const SUPABASE_ANON_KEY = readEnv("EDGE_SUPABASE_ANON_KEY", ["SUPABASE_ANON_KEY"]);
const SUPABASE_SERVICE_KEY = readEnv("EDGE_SUPABASE_SERVICE_ROLE_KEY", [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE_KEY",
]);
const EDGE_SUPABASE_SECRET_KEY = readEnv("EDGE_SUPABASE_SECRET_KEY", [
  "SUPABASE_SECRET_KEY",
]);
const EDGE_RPC_SCHEMA =
  readEnv("RESOURCE_IMPORT_RPC_SCHEMA", ["EDGE_RPC_SCHEMA", "API_RPC_SCHEMA"]) || "api";

const DEFAULT_ALLOWED_HEADERS =
  "authorization,content-type,traceparent,tracestate,x-correlation-id";
const DEFAULT_ALLOWED_METHODS = "POST,OPTIONS";

const asRecord = (value: unknown): JsonRecord | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
};

const asString = (value: unknown): string => {
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

const isJwtLike = (value: string): boolean => String(value || "").trim().split(".").length === 3;
const LOCAL_EDGE_SUPABASE_HOSTS = new Set(["kong", "rvzwwjlztwwisjthghnipgjr.example.invalid"]);

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

const normalizeHeader = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const buildHeaderFingerprint = (headers: string[]) =>
  headers.map(normalizeHeader).filter(Boolean).sort().join("|");

const normalizeTabularCellValue = (value: unknown) => {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
};

const detectVisibleSheets = (workbook: Workbook) => {
  const sheetNames = workbook.worksheets
    .map((sheet) => String(sheet?.name ?? "").trim())
    .filter(Boolean);
  const visible = workbook.worksheets
    .filter((sheet) => String(sheet?.state || "visible") === "visible")
    .map((sheet) => String(sheet?.name ?? "").trim())
    .filter(Boolean);
  return visible.length > 0 ? visible : sheetNames;
};

const worksheetToMatrix = (worksheet: Worksheet | null | undefined) => {
  const matrix: Array<Array<unknown>> = [];
  if (!worksheet) return matrix;

  const rowCount = Math.max(0, Number(worksheet.rowCount || 0));
  const worksheetColumnCount = Math.max(0, Number(worksheet.columnCount || 0));
  assertMatrixDimensions(rowCount, worksheetColumnCount);
  for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
    const row = worksheet.getRow(rowIndex);
    const columnCount = Math.max(
      worksheetColumnCount,
      Number(row?.actualCellCount || 0),
      Number(row?.cellCount || 0),
    );
    assertMatrixDimensions(rowCount, columnCount);
    const values: Array<unknown> = [];
    for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
      const cell = row.getCell(columnIndex);
      values.push(cell.text || normalizeTabularCellValue(cell.value));
    }
    while (values.length > 0 && normalizeTabularCellValue(values[values.length - 1]) === "") {
      values.pop();
    }
    if (values.length > 0) matrix.push(values);
  }
  return matrix;
};


const firstRecord = <T extends JsonRecord = JsonRecord>(value: unknown): T | null => {
  if (Array.isArray(value)) {
    const first = value[0];
    return asRecord(first) as T | null;
  }
  return asRecord(value) as T | null;
};

const corsHeaders = (
  origin: string | null,
  correlationId: string,
  trace: { traceparent?: string; tracestate?: string | null },
) => {
  const headers = new Headers({
    "content-type": "application/json",
    "access-control-allow-origin": origin?.trim() || "*",
    "access-control-allow-methods": DEFAULT_ALLOWED_METHODS,
    "access-control-allow-headers": DEFAULT_ALLOWED_HEADERS,
    "x-correlation-id": correlationId,
  });
  if (trace.traceparent) headers.set("traceparent", trace.traceparent);
  if (trace.tracestate) headers.set("tracestate", trace.tracestate);
  return headers;
};

const jsonResponse = (
  status: number,
  body: Record<string, unknown>,
  origin: string | null,
  correlationId: string,
  trace: { traceparent?: string; tracestate?: string | null },
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(origin, correlationId, trace),
  });

const errorResponse = (
  status: number,
  code: string,
  message: string,
  origin: string | null,
  correlationId: string,
  trace: { traceparent?: string; tracestate?: string | null; trace_id?: string | null },
  details?: Record<string, unknown>,
) =>
  jsonResponse(
    status,
    buildErrorEnvelope({
      status,
      code,
      message,
      correlationId,
      traceId: trace.trace_id ?? null,
      details,
    }),
    origin,
    correlationId,
    trace,
  );

const resolveSupabaseUrl = (req: Request) => {
  const rawUrl = asString(SUPABASE_URL);
  if (!rawUrl) return "";
  try {
    const configured = new URL(rawUrl);
    const requestUrl = new URL(req.url);
    if (
      /^(127\.0\.0\.1|localhost)$/i.test(requestUrl.hostname) &&
      LOCAL_EDGE_SUPABASE_HOSTS.has(configured.hostname.toLowerCase())
    ) {
      return requestUrl.origin;
    }
    return configured.origin;
  } catch {
    return rawUrl.replace(/\/+$/g, "");
  }
};

const createUserClient = (req: Request, token: string) => {
  const supabaseUrl = resolveSupabaseUrl(req);
  if (!supabaseUrl || !SUPABASE_ANON_KEY) {
    throw new Error("missing_supabase_public_configuration");
  }
  return createClient(supabaseUrl, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    db: { schema: EDGE_RPC_SCHEMA },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
};

const createServiceClient = (req: Request) => {
  const serviceKey = asString(EDGE_SUPABASE_SECRET_KEY) || asString(SUPABASE_SERVICE_KEY);
  const anonKey = asString(SUPABASE_ANON_KEY);
  const supabaseUrl = resolveSupabaseUrl(req);
  if (!supabaseUrl || !serviceKey) {
    throw new Error("missing_supabase_service_configuration");
  }

  const apiKeyHeader = isJwtLike(serviceKey) ? (anonKey || serviceKey) : serviceKey;

  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
    db: { schema: EDGE_RPC_SCHEMA },
    global: {
      headers: {
        apikey: apiKeyHeader,
      },
    },
  });
};

const resolveAction = async (
  req: Request,
): Promise<{ action: ResourceImportAction | null; body: JsonRecord; form: FormData | null }> => {
  assertRequestSize(req.headers);
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
    const form = await req.formData();
    const action = asString(form.get("action")).toLowerCase();
    return {
      action: action === "prepare" || action === "start" || action === "get_run" || action === "cancel"
        ? (action as ResourceImportAction)
        : null,
      body: {},
      form,
    };
  }

  const body = asRecord((await parseRequestBody(req)).json) ?? {};
  const action = asString(body.action).toLowerCase();
  return {
    action: action === "prepare" || action === "start" || action === "get_run" || action === "cancel"
      ? (action as ResourceImportAction)
      : null,
    body,
    form: null,
  };
};

const loadCurrentUiContext = async (userClient: ReturnType<typeof createClient>) => {
  const { data, error } = await userClient.rpc("ui_me_v1");
  if (error) {
    throw new Error(error.message || "Unable to load UI context");
  }
  const me = asRecord(data) ?? {};
  const org = asRecord(me.org);
  const user = asRecord(me.user);
  return {
    me,
    organizationId: maybeUuid(org?.id) ?? null,
    userId: maybeUuid(user?.id) ?? null,
  };
};

const hydrateArtifacts = async (
  serviceClient: ReturnType<typeof createClient>,
  run: JsonRecord,
) => {
  const rawArtifacts = Array.isArray(run.artifacts) ? run.artifacts : [];
  const artifacts = await Promise.all(
    rawArtifacts.map(async (artifact) => {
      const record = asRecord(artifact) ?? {};
      const bucket = asString(record.storage_bucket);
      const key = canonicalStorageKey(record.storage_key, run.organization_id);
      if (!isStorageBucketId(bucket) || !key) return record;
      try {
        const { data, error } = await serviceClient.storage.from(bucket).createSignedUrls([key], SIGNED_URL_TTL_SECONDS);
        const signed = data?.[0];
        if (!error && signed?.signedUrl) {
          return {
            ...record,
            signed_url: signed.signedUrl,
          };
        }
      } catch {
        // Ignore signed URL failures; the canonical artifact link still exists.
      }
      return record;
    }),
  );
  return {
    ...run,
    artifacts,
  };
};

const parseRules = (value: FormDataEntryValue | null): unknown[] => {
  if (typeof value !== "string") return [];
  if (!value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new Error("rules must be valid JSON");
  }
};

const parseJsonObject = (value: FormDataEntryValue | null, fieldName: string): JsonRecord => {
  if (typeof value !== "string") return {};
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : {};
  } catch {
    throw new Error(`${fieldName} must be valid JSON`);
  }
};

const parseWorkbookFromFile = async (file: File, requestedSheet?: string | null) => {
  assertUploadSize(file);
  const extension = file.name.split(".").pop()?.trim().toLowerCase() || "csv";
  if (extension === "xls") {
    throw new Error("Legacy .xls workbooks are not supported. Upload a CSV or XLSX file.");
  }

  if (extension === "csv") {
    const parsed = matrixToTabularData(await parseBoundedCsv(file));
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

  const bytes = await file.arrayBuffer();
  await assertXlsxExpansionLimits(bytes, JSZip);
  const workbook = new Workbook();
  await workbook.xlsx.load(bytes);
  const visibleSheets = detectVisibleSheets(workbook);
  const selectedSheet =
    (requestedSheet && visibleSheets.includes(requestedSheet) ? requestedSheet : null) ??
    visibleSheets[0] ??
    workbook.worksheets[0]?.name ??
    "";

  if (!selectedSheet) {
    throw new Error("The uploaded workbook did not contain a readable worksheet.");
  }

  const sheet = workbook.getWorksheet(selectedSheet);
  if (!sheet) {
    throw new Error(`Worksheet ${selectedSheet} could not be read.`);
  }

  const parsed = matrixToTabularData(worksheetToMatrix(sheet));

  return {
    headers: parsed.headers,
    rows: parsed.rows,
    selectedSheet,
    visibleSheets,
  };
};

const uploadSourceArtifact = async (params: {
  serviceClient: ReturnType<typeof createClient>;
  organizationId: string;
  userId: string | null;
  file: File;
  resourceKey: string;
  sheetName: string;
  headerFingerprint: string;
  correlationId: string;
}) => {
  const safeName = sanitizeFileName(params.file.name || "import.csv");
  const storageKey = `${params.organizationId}/imports/${params.resourceKey}/${params.correlationId}/${Date.now()}-${safeName}`;
  const fileBytes = await params.file.arrayBuffer();
  const mimeType = resolveUploadMimeType(params.file.name, params.file.type);
  const { error: uploadError } = await params.serviceClient.storage
    .from(IMPORT_BUCKET)
    .upload(storageKey, new Blob([fileBytes], { type: mimeType }), {
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
      source_system: SERVICE_NAME,
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
  if (!artifact?.artifact_id) throw new Error("The uploaded source artifact could not be registered.");
  return {
    artifactId: artifact.artifact_id,
    storageKey,
    fileName: safeName,
  };
};

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");
  const correlationId = resolveCorrelationId(req);
  const trace = resolveTraceContext(req, correlationId);

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(origin, correlationId, trace),
    });
  }

  if (req.method !== "POST") {
    return errorResponse(405, "method_not_allowed", "Only POST is supported.", origin, correlationId, trace);
  }

  const token = extractToken(req, {
    prefer: "authorization",
    allowWebhookHeader: false,
    allowQueryParam: false,
  });
  if (!token) {
    return errorResponse(401, "missing_authorization", "Authenticated session is required.", origin, correlationId, trace);
  }

  let actionPayload: { action: ResourceImportAction | null; body: JsonRecord; form: FormData | null };
  try {
    actionPayload = await resolveAction(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    return errorResponse(error instanceof ImportLimitError ? error.status : 400, error instanceof ImportLimitError ? error.code : "invalid_body", message, origin, correlationId, trace);
  }

  if (!actionPayload.action) {
    return errorResponse(400, "invalid_action", "Expected one of prepare, start, get_run, or cancel.", origin, correlationId, trace);
  }

  let userClient;
  let serviceClient;
  try {
    userClient = createUserClient(req, token);
    serviceClient = createServiceClient(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Supabase client configuration missing";
    return errorResponse(500, "server_misconfigured", message, origin, correlationId, trace);
  }

  try {
    if (actionPayload.action === "prepare") {
      const form = actionPayload.form;
      if (!form) {
        return errorResponse(400, "invalid_prepare_request", "Prepare requires multipart form data.", origin, correlationId, trace);
      }

      const file = form.get("file");
      if (!(file instanceof File)) {
        return errorResponse(400, "missing_file", "Prepare requires a CSV or XLSX file.", origin, correlationId, trace);
      }
      assertUploadSize(file);
      validateImportFile(file);

      const resourceKey = asString(form.get("resource_key"));
      if (!resourceKey) {
        return errorResponse(400, "missing_resource_key", "Prepare requires resource_key.", origin, correlationId, trace);
      }

      const writeMode = asString(form.get("write_mode")) || "create";
      const ruleSource = asString(form.get("rule_source")) || "auto";
      const requestedSheet = asString(form.get("sheet_name")) || null;
      const rules = parseRules(form.get("rules"));
      const rowOverrides = parseJsonObject(form.get("row_overrides"), "row_overrides");
      const scopeContext = parseJsonObject(form.get("scope_context"), "scope_context");
      const preparation = await loadImportPreparation(userClient, resourceKey, scopeContext);
      validateImportFile(file, preparation.maxFileBytes);
      const workbook = await parseWorkbookFromFile(file, requestedSheet);
      const headerFingerprint = buildHeaderFingerprint(workbook.headers);
      const resolvedRules = validateImportWorkbook(preparation, workbook, headerFingerprint, rules, ruleSource);
      const organizationId = maybeUuid(preparation.organizationId);
      const normalizedScopeContext = preparation.scopeContext;
      const { userId } = await loadCurrentUiContext(userClient);
      if (!organizationId) {
        return errorResponse(
          400,
          "missing_org_context",
          "Choose an import organization, client, or sender before uploading the file.",
          origin,
          correlationId,
          trace,
        );
      }

      const uploaded = await uploadSourceArtifact({
        serviceClient,
        organizationId,
        userId,
        file,
        resourceKey,
        sheetName: workbook.selectedSheet,
        headerFingerprint,
        correlationId,
      });

      const { data, error } = await userClient.rpc("tabular_import_prepare_v1", {
        p_payload: {
          resource_key: resourceKey,
          write_mode: writeMode,
          rule_source: ruleSource,
          source_format: file.name.split(".").pop()?.trim().toLowerCase() || "csv",
          source_file_name: uploaded.fileName,
          source_artifact_id: uploaded.artifactId,
          sheet_name: workbook.selectedSheet,
          header_fingerprint: headerFingerprint,
          headers: workbook.headers,
          rows: workbook.rows,
          rules: resolvedRules,
          row_overrides: rowOverrides,
          scope_context: normalizedScopeContext,
        },
      });

      if (error) {
        throw new Error(error.message || "Failed to prepare import run");
      }

      const dryRun = asRecord(data) ?? {};
      return jsonResponse(
        200,
        {
          ok: true,
          dry_run: dryRun,
          profile_match: asRecord(dryRun.profile) ?? null,
          available_profiles: Array.isArray(dryRun.available_profiles) ? dryRun.available_profiles : [],
          resolved_rules: Array.isArray(dryRun.resolved_rules) ? dryRun.resolved_rules : [],
          correlation_id: correlationId,
        },
        origin,
        correlationId,
        trace,
      );
    }

    if (actionPayload.action === "start") {
      const runId = maybeUuid(actionPayload.body.run_id);
      if (!runId) {
        return errorResponse(400, "invalid_run_id", "Start requires a valid run_id.", origin, correlationId, trace);
      }

      const { error } = await userClient.rpc("ui_start_tabular_import_run_v1", {
        p_run_id: runId,
        p_save_profile: asRecord(actionPayload.body.save_profile) ?? null,
      });
      if (error) {
        throw new Error(error.message || "Failed to start import run");
      }

      const processed = await processStartedImport(userClient, serviceClient, runId,
        readEnv("RESOURCE_IMPORT_START_PROCESS_BATCH_SIZE", ["TABULAR_IMPORT_START_PROCESS_BATCH_SIZE"]));
      const run = await hydrateArtifacts(serviceClient, processed.run);
      return jsonResponse(
        200,
        {
          ok: true,
          run,
          report: asRecord(run.report) ?? null,
          processing_warning: processed.processingWarning,
          correlation_id: correlationId,
        },
        origin,
        correlationId,
        trace,
      );
    }

    if (actionPayload.action === "get_run") {
      const runId = maybeUuid(actionPayload.body.run_id);
      if (!runId) {
        return errorResponse(400, "invalid_run_id", "get_run requires a valid run_id.", origin, correlationId, trace);
      }

      const { data, error } = await userClient.rpc("ui_get_tabular_import_run_v1", {
        p_run_id: runId,
      });
      if (error) {
        throw new Error(error.message || "Failed to load import run");
      }

      const run = await hydrateArtifacts(serviceClient, asRecord(data) ?? {});
      return jsonResponse(200, run, origin, correlationId, trace);
    }

    const runId = maybeUuid(actionPayload.body.run_id);
    if (!runId) {
      return errorResponse(400, "invalid_run_id", "Cancel requires a valid run_id.", origin, correlationId, trace);
    }
    const reason = asString(actionPayload.body.reason);
    if (!reason) {
      return errorResponse(400, "missing_cancel_reason", "Cancel requires a non-empty operator reason.", origin, correlationId, trace);
    }

    const { data, error } = await userClient.rpc("ui_cancel_tabular_import_run_v1", {
      p_run_id: runId,
      p_cancel_reason: reason,
    });
    if (error) {
      throw new Error(error.message || "Failed to cancel import run");
    }

    const run = await hydrateArtifacts(serviceClient, asRecord(data) ?? {});
    return jsonResponse(
      200,
      {
        ok: true,
        run,
        correlation_id: correlationId,
      },
      origin,
      correlationId,
      trace,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "resource import request failed";
    logStructured("warn", "edge.resource_import_studio.failed", {
      service: SERVICE_NAME,
      correlation_id: correlationId,
      trace_id: trace.trace_id,
      action: actionPayload.action,
      error: message,
    });
    return errorResponse(
      (error instanceof ImportPreparationError || error instanceof ImportLimitError) ? error.status : 400,
      (error instanceof ImportPreparationError || error instanceof ImportLimitError) ? error.code : "resource_import_failed",
      message, origin, correlationId, trace,
    );
  }
});

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@^2.45.4";
import * as xlsx from "./vendor/sheetjs-xlsx-0.20.3/xlsx.mjs";
import * as cpexcel from "./vendor/sheetjs-xlsx-0.20.3/cpexcel.full.mjs";
import {
  buildErrorEnvelope,
  extractToken,
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

xlsx.set_cptable(cpexcel);

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
const LOCAL_EDGE_SUPABASE_HOSTS = new Set(["kong"]);

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
  if (extension === "xls") return "application/vnd.ms-excel";
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

const normalizeMappingToken = (value: unknown) => normalizeHeader(value);

const jsonArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const stringArray = (value: unknown): string[] =>
  jsonArray(value)
    .map((entry) => asString(entry))
    .filter(Boolean);

const positiveInteger = (value: unknown): number | null => {
  const numeric = typeof value === "number" ? value : Number(asString(value));
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
};

const columnImportConfig = (column: JsonRecord): JsonRecord =>
  asRecord(column.import) ?? {};

const columnImportEnabled = (column: JsonRecord): boolean => {
  const config = columnImportConfig(column);
  return config.enabled === true;
};

const columnMappingTokens = (column: JsonRecord): string[] => {
  const config = columnImportConfig(column);
  return Array.from(
    new Set(
      [
        asString(column.key),
        asString(column.label),
        ...stringArray(config.aliases),
      ]
        .map(normalizeMappingToken)
        .filter(Boolean),
    ),
  );
};

const columnDefaultValue = (column: JsonRecord): unknown => {
  const config = columnImportConfig(column);
  if (Object.prototype.hasOwnProperty.call(config, "default_value")) return config.default_value;
  const lookup = asRecord(config.lookup) ?? {};
  const options = jsonArray(lookup.options).map((entry) => asRecord(entry)).filter(Boolean) as JsonRecord[];
  const defaultOption = options.find((option) => option.is_default === true);
  return defaultOption && Object.prototype.hasOwnProperty.call(defaultOption, "value")
    ? defaultOption.value
    : undefined;
};

const registryResources = (registry: JsonRecord): JsonRecord[] =>
  jsonArray(registry.resources).map((entry) => asRecord(entry)).filter(Boolean) as JsonRecord[];

const findRegistryResource = (registry: JsonRecord, key: string): JsonRecord | null =>
  registryResources(registry).find((entry) => asString(entry.key) === key) ?? null;

const importPolicyLimit = (
  registry: JsonRecord,
  resourceKey: string,
  key: "max_file_bytes" | "max_rows",
): number | null => {
  const resource = findRegistryResource(registry, resourceKey);
  const importPolicy = asRecord(resource?.import) ?? {};
  return positiveInteger(importPolicy[key]);
};

const prefixedTokens = (prefixes: string[], tokens: string[]) => {
  const out = new Set<string>();
  for (const prefix of prefixes) {
    const normalizedPrefix = normalizeMappingToken(prefix);
    if (!normalizedPrefix) continue;
    for (const token of tokens) {
      if (!token) continue;
      out.add(normalizeMappingToken(`${normalizedPrefix}_${token}`));
    }
  }
  return out;
};

const inferHeaderRulesFromRegistry = (
  registry: JsonRecord,
  resourceKey: string,
  headers: string[],
): JsonRecord[] => {
  const resource = findRegistryResource(registry, resourceKey);
  const primaryColumns = jsonArray(resource?.columns).map((entry) => asRecord(entry)).filter(Boolean) as JsonRecord[];
  const normalizedHeaders = headers
    .map((header) => ({ source: header, normalized: normalizeMappingToken(header) }))
    .filter((entry) => entry.normalized);
  const rules: JsonRecord[] = [];
  const seenTargets = new Set<string>();

  const addRule = (source: string, target: string) => {
    const sourceText = asString(source);
    const targetText = asString(target);
    if (!sourceText || !targetText || seenTargets.has(targetText)) return;
    seenTargets.add(targetText);
    rules.push({
      source_column: sourceText,
      target_field: targetText,
      enabled: true,
    });
  };
  const addDefaultRule = (target: string, fixedValue: unknown) => {
    const targetText = asString(target);
    if (!targetText || fixedValue === undefined || seenTargets.has(targetText)) return;
    seenTargets.add(targetText);
    rules.push({
      source_column: `__default__${targetText.replace(/[^a-z0-9_.-]+/gi, "_")}`,
      target_field: targetText,
      enabled: true,
      value_mode: "fixed",
      fixed_value: fixedValue,
    });
  };

  for (const header of normalizedHeaders) {
    for (const column of primaryColumns) {
      if (!columnImportEnabled(column)) continue;
      const key = asString(column.key);
      if (!key) continue;
      if (columnMappingTokens(column).includes(header.normalized)) {
        addRule(header.source, key);
      }
    }
  }

  for (const column of primaryColumns) {
    if (!columnImportEnabled(column)) continue;
    const key = asString(column.key);
    if (!key) continue;
    if (columnImportConfig(column).required === true) addDefaultRule(key, columnDefaultValue(column));
  }

  const inlineRefs = primaryColumns
    .map((column) => ({
      key: asString(column.key),
      reference: asRecord(columnImportConfig(column).reference) ?? {},
    }))
    .filter((entry) => entry.reference.allow_inline_node === true);
  const targetResourceCounts = inlineRefs.reduce<Record<string, number>>((acc, entry) => {
    const targetResource = asString(entry.reference.resource);
    if (targetResource) acc[targetResource] = (acc[targetResource] ?? 0) + 1;
    return acc;
  }, {});

  for (const ref of inlineRefs) {
    const nodeKey = asString(ref.reference.inline_node_key) || ref.key.replace(/_id$/i, "");
    const targetResource = asString(ref.reference.resource);
    const relatedResource = targetResource ? findRegistryResource(registry, targetResource) : null;
    const relatedColumns = jsonArray(relatedResource?.columns)
      .map((entry) => asRecord(entry))
      .filter(Boolean) as JsonRecord[];
    const prefixes = stringArray(ref.reference.mapping_prefixes);
    const allowDirectRelatedMatch =
      (targetResourceCounts[targetResource] ?? 0) <= 1 || nodeKey === "destination_address";

    for (const header of normalizedHeaders) {
      for (const column of relatedColumns) {
        if (!columnImportEnabled(column)) continue;
        const key = asString(column.key);
        if (!key) continue;
        const tokens = columnMappingTokens(column);
        const prefixed = prefixedTokens(prefixes, tokens);
        if (prefixed.has(header.normalized) || (allowDirectRelatedMatch && tokens.includes(header.normalized))) {
          addRule(header.source, `${nodeKey}.${key}`);
        }
      }
    }

    const hasNodeRule = rules.some((rule) => asString(rule.target_field).startsWith(`${nodeKey}.`));
    if (hasNodeRule) {
      for (const column of relatedColumns) {
        if (!columnImportEnabled(column)) continue;
        const key = asString(column.key);
        if (!key) continue;
        if (columnImportConfig(column).required === true) {
          addDefaultRule(`${nodeKey}.${key}`, columnDefaultValue(column));
        }
      }
    }
  }

  return rules;
};

const loadImportRegistry = async (userClient: ReturnType<typeof createClient>) => {
  const { data, error } = await userClient.rpc("ui_read_registry_v1");
  if (error) {
    throw new Error(error.message || "Unable to load import registry.");
  }
  return asRecord(data) ?? {};
};

const loadMatchingImportProfile = async (
  userClient: ReturnType<typeof createClient>,
  resourceKey: string,
  scopeContext: JsonRecord,
  headerFingerprint: string,
) => {
  if (!headerFingerprint) return null;
  const { data, error } = await userClient.rpc("ui_match_tabular_import_profile_v1", {
    p_resource: resourceKey,
    p_scope_context: scopeContext,
    p_header_fingerprint: headerFingerprint,
  });
  if (error) {
    throw new Error(error.message || "Unable to load matching import mapping profile.");
  }
  return asRecord(data);
};

const detectVisibleSheets = (workbook: {
  SheetNames?: string[];
  Workbook?: { Sheets?: Array<{ Hidden?: number }> };
}) => {
  const sheetNames = Array.isArray(workbook?.SheetNames) ? workbook.SheetNames : [];
  const visibility = Array.isArray(workbook?.Workbook?.Sheets) ? workbook.Workbook.Sheets : [];
  const visible = sheetNames.filter((name, index) => {
    const state = visibility[index];
    return !state || state.Hidden !== 1;
  });
  return visible.length > 0 ? visible : sheetNames;
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

const resolveImportScopeContext = async (
  userClient: ReturnType<typeof createClient>,
  resourceKey: string,
  scopeContext: JsonRecord,
) => {
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
      const key = asString(record.storage_key);
      if (!bucket || !key) return record;
      try {
        const { data, error } = await serviceClient.storage.from(bucket).createSignedUrl(key, SIGNED_URL_TTL_SECONDS);
        if (!error && data?.signedUrl) {
          return {
            ...record,
            signed_url: data.signedUrl,
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
  const bytes = await file.arrayBuffer();
  const workbook = xlsx.read(bytes, { type: "array", raw: false, cellDates: true });
  const visibleSheets = detectVisibleSheets(workbook);
  const selectedSheet =
    (requestedSheet && visibleSheets.includes(requestedSheet) ? requestedSheet : null) ??
    visibleSheets[0] ??
    workbook.SheetNames?.[0] ??
    "";

  if (!selectedSheet) {
    throw new Error("The uploaded workbook did not contain a readable worksheet.");
  }

  const sheet = workbook.Sheets[selectedSheet];
  if (!sheet) {
    throw new Error(`Worksheet ${selectedSheet} could not be read.`);
  }

  const matrix = xlsx.utils.sheet_to_json<Array<unknown>>(sheet, {
    header: 1,
    defval: "",
    blankrows: false,
  });
  const headerRow = Array.isArray(matrix[0]) ? matrix[0] : [];
  const headers = headerRow
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry.length > 0);
  const rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  return {
    headers,
    rows,
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
  return {
    artifactId: artifact?.artifact_id ?? null,
    storageKey,
    fileName: safeName,
  };
};

serve(async (req: Request): Promise<Response> => {
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
    return errorResponse(400, "invalid_body", message, origin, correlationId, trace);
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
        return errorResponse(400, "missing_file", "Prepare requires a CSV/XLS/XLSX file.", origin, correlationId, trace);
      }
      if (file.size <= 0) {
        return errorResponse(
          400,
          "empty_import_file",
          "The selected import file is empty. Add a header row and at least one data row before preparing it.",
          origin,
          correlationId,
          trace,
        );
      }

      const resourceKey = asString(form.get("resource_key"));
      if (!resourceKey) {
        return errorResponse(400, "missing_resource_key", "Prepare requires resource_key.", origin, correlationId, trace);
      }
      const registry = await loadImportRegistry(userClient);
      const maxFileBytes = importPolicyLimit(registry, resourceKey, "max_file_bytes");
      if (maxFileBytes !== null && file.size > maxFileBytes) {
        return errorResponse(
          413,
          "import_file_too_large",
          `The selected import file is larger than the configured ${maxFileBytes} byte limit for ${resourceKey}. Split the file and try again.`,
          origin,
          correlationId,
          trace,
          {
            resource_key: resourceKey,
            source_file_name: file.name,
            size_bytes: file.size,
            max_file_bytes: maxFileBytes,
          },
        );
      }

      const writeMode = asString(form.get("write_mode")) || "create";
      const ruleSource = asString(form.get("rule_source")) || "auto";
      const requestedSheet = asString(form.get("sheet_name")) || null;
      const rules = parseRules(form.get("rules"));
      const rowOverrides = parseJsonObject(form.get("row_overrides"), "row_overrides");
      const scopeContext = parseJsonObject(form.get("scope_context"), "scope_context");
      const workbook = await parseWorkbookFromFile(file, requestedSheet);
      if (workbook.headers.length === 0) {
        return errorResponse(
          422,
          "no_readable_column_headers",
          "No readable column headers were found. Add a header row or choose a file with mapped import columns.",
          origin,
          correlationId,
          trace,
          {
            resource_key: resourceKey,
            source_file_name: file.name,
            sheet_name: workbook.selectedSheet,
            visible_sheets: workbook.visibleSheets,
          },
        );
      }
      const maxRows = importPolicyLimit(registry, resourceKey, "max_rows");
      if (maxRows !== null && workbook.rows.length > maxRows) {
        return errorResponse(
          413,
          "import_row_limit_exceeded",
          `The selected import file has ${workbook.rows.length} rows, which is larger than the configured ${maxRows} row limit for ${resourceKey}. Split the file and try again.`,
          origin,
          correlationId,
          trace,
          {
            resource_key: resourceKey,
            source_file_name: file.name,
            sheet_name: workbook.selectedSheet,
            row_count: workbook.rows.length,
            max_rows: maxRows,
          },
        );
      }
      const headerFingerprint = buildHeaderFingerprint(workbook.headers);
      let resolvedRules = rules;
      let resolvedRuleSource = ruleSource;

      const scopeResolution = await resolveImportScopeContext(userClient, resourceKey, scopeContext);
      const organizationId = maybeUuid(scopeResolution.organization_id);
      const normalizedScopeContext = asRecord(scopeResolution.scope_context) ?? scopeContext;

      if (resolvedRules.length === 0) {
        resolvedRules = inferHeaderRulesFromRegistry(registry, resourceKey, workbook.headers);
        if (resolvedRules.length > 0) {
          resolvedRuleSource = "manual";
        }
      }

      if (resolvedRules.length === 0) {
        const profileMatch = await loadMatchingImportProfile(
          userClient,
          resourceKey,
          normalizedScopeContext,
          headerFingerprint,
        );
        if (!profileMatch) {
          return errorResponse(
            422,
            "unmapped_import_headers",
            "No import columns matched this file. Check the file headers or create a mapping profile before preparing it.",
            origin,
            correlationId,
            trace,
            {
              resource_key: resourceKey,
              source_file_name: file.name,
              header_fingerprint: headerFingerprint,
              headers: workbook.headers,
            },
          );
        }
      }

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
          rule_source: resolvedRuleSource,
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

      const { data, error } = await userClient.rpc("ui_start_tabular_import_run_v1", {
        p_run_id: runId,
        p_save_profile: asRecord(actionPayload.body.save_profile) ?? null,
      });
      if (error) {
        throw new Error(error.message || "Failed to start import run");
      }

      const processBatchSize = positiveInteger(
        readEnv("RESOURCE_IMPORT_START_PROCESS_BATCH_SIZE", ["TABULAR_IMPORT_START_PROCESS_BATCH_SIZE"]),
      ) ?? 100;
      const { data: processedData, error: processError } = await serviceClient.rpc(
        "process_tabular_import_run_v1",
        {
          p_run_id: runId,
          p_batch_size: processBatchSize,
        },
      );
      if (processError) {
        throw new Error(processError.message || "Failed to process started import run");
      }

      const run = await hydrateArtifacts(serviceClient, asRecord(processedData) ?? asRecord(data) ?? {});
      return jsonResponse(
        200,
        {
          ok: true,
          run,
          report: asRecord(run.report) ?? null,
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
    return errorResponse(400, "resource_import_failed", message, origin, correlationId, trace);
  }
});

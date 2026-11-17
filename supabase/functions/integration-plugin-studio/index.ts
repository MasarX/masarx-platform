import { createClient } from "npm:@supabase/supabase-js@2.111.0";
import { previewRuntimeMapping } from "./studio-mapping-preview.mjs";
import { submitStudioTest } from "./studio-test-submit.mjs";
import { readStudioTest } from "./studio-test-readback.mjs";
import { projectStudioPayload } from "./studio-response.mjs";
import { isPublicIpAddress } from "../api-caller/egress.mjs";
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
type StudioHttpError = Error & {
  status?: number;
  code?: string;
  details?: Record<string, unknown>;
};
type StudioEndpoint = "parse" | "infer" | "preview" | "save" | "test_request" | "test_status";
type MappingArtifact = "tabular_import" | "webhook_inbound" | "api_outbound" | "integration_plugin";
type MappingDiagnosticLevel = "error" | "warning" | "info";

type MappingDiagnostic = {
  level: MappingDiagnosticLevel;
  blocking: boolean;
  code: string;
  fieldPath?: string | null;
  message: string;
  why: string;
  recommended_fix: string;
  source_policy?: string | null;
  settings_resolution_id?: string | null;
};

type MappingCoercion = {
  target_field: string;
  source_path: string | null;
  original_type: string;
  original_value: unknown;
  converted_type: string;
  converted_value: unknown;
  reason: string;
  can_override: boolean;
};

type NormalizedContract = {
  source_type: string;
  plugin_kind: "webhook" | "api";
  route?: {
    method: string;
    path_template: string;
    upstream_path_template?: string;
    upstream_method?: string;
    headers?: Record<string, string>;
    body_sample?: unknown;
  };
  webhook?: {
    sample_payload?: unknown;
    source_identifier?: string;
    name?: string;
  };
  sample_schema?: unknown;
  metadata?: JsonRecord;
};

const SERVICE_NAME = "integration-plugin-studio";
const LOCAL_EDGE_SUPABASE_HOSTS = new Set(["kong", "rvzwwjlztwwisjthghnipgjr.example.invalid"]);

const SUPABASE_URL = readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]);
const SUPABASE_ANON_KEY = readEnv("EDGE_SUPABASE_ANON_KEY", ["SUPABASE_ANON_KEY"]);

const DEFAULT_ALLOWED_HEADERS =
  "authorization,content-type,traceparent,tracestate,x-correlation-id";
const DEFAULT_ALLOWED_METHODS = "POST,OPTIONS";

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

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
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
    return text;
  }
  return null;
};

const createHttpError = (
  status: number,
  message: string,
  code = "edge.integration_plugin_studio.failed",
  details?: Record<string, unknown>,
): StudioHttpError => {
  const error = new Error(message) as StudioHttpError;
  error.status = status;
  error.code = code;
  if (details) error.details = details;
  return error;
};

const getHttpErrorStatus = (error: unknown): number => {
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (code === "42501" || /^Capability denied:/i.test(message)) return 403;
  return 400;
};

const getHttpErrorCode = (error: unknown): string => {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "edge.integration_plugin_studio.failed";
};

const getHttpErrorDetails = (
  error: unknown,
  fallback: Record<string, unknown>,
): Record<string, unknown> => {
  const details =
    error && typeof error === "object" && "details" in error && error.details && typeof error.details === "object"
      ? (error.details as Record<string, unknown>)
      : {};
  return { ...details, ...fallback };
};

const isInvalidJwtMessage = (message: string): boolean => {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("jwt") ||
    normalized.includes("token") ||
    normalized.includes("expected 3 parts in jwt")
  );
};

const createUserClient = (supabaseUrl: string, token: string) =>
  createClient(supabaseUrl, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    db: { schema: "api" },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
      },
    },
  });

const parseBoolean = (value: unknown, fallback = false): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
};

const corsHeaders = (
  origin: string | null,
  correlationId: string,
  trace: { traceparent?: string; tracestate?: string | null },
): Headers => {
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
): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(origin, correlationId, trace),
  });
};

const errorResponse = (
  status: number,
  code: string,
  message: string,
  origin: string | null,
  correlationId: string,
  trace: { traceparent?: string; tracestate?: string | null; trace_id?: string | null },
  details?: Record<string, unknown>,
): Response => {
  return jsonResponse(
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
};

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

const resolveEndpoint = (req: Request, body: JsonRecord): StudioEndpoint | null => {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const index = parts.indexOf("integration-plugin-studio");
  if (index >= 0 && parts.length > index + 1) {
    const maybeEndpoint = (parts[index + 1] || "").toLowerCase();
    if (maybeEndpoint === "parse" || maybeEndpoint === "infer" || maybeEndpoint === "preview" || maybeEndpoint === "save" || maybeEndpoint === "test_request" || maybeEndpoint === "test_status") {
      return maybeEndpoint;
    }
  }

  const action = asString(body.action).toLowerCase();
  if (action === "parse" || action === "infer" || action === "preview" || action === "save" || action === "test_request" || action === "test_status") return action;
  return null;
};

const tokenizeShellLike = (value: string): string[] => {
  const matches = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  return matches ? matches.map((token) => token.trim()).filter(Boolean) : [];
};

const stripQuotes = (value: string): string => {
  if (!value) return "";
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
};

const parseJsonIfPossible = (value: string): unknown => {
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch (_err) {
    return trimmed;
  }
};

const parseCurlContract = (rawCommand: string): NormalizedContract => {
  const command = rawCommand.trim();
  if (!command) {
    throw new Error("cURL payload is empty");
  }

  const tokens = tokenizeShellLike(command);
  const headers: Record<string, string> = {};
  let method = "";
  let url = "";
  let body: unknown = {};

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const next = tokens[i + 1] ?? "";

    if (token === "curl") continue;

    if (token === "-X" || token === "--request") {
      method = stripQuotes(next).toUpperCase();
      i += 1;
      continue;
    }

    if (token === "-H" || token === "--header") {
      const rawHeader = stripQuotes(next);
      const idx = rawHeader.indexOf(":");
      if (idx > 0) {
        const key = rawHeader.slice(0, idx).trim();
        const value = rawHeader.slice(idx + 1).trim();
        if (key) headers[key] = value;
      }
      i += 1;
      continue;
    }

    if (token === "-d" || token === "--data" || token === "--data-raw" || token === "--data-binary") {
      body = parseJsonIfPossible(stripQuotes(next));
      if (!method) method = "POST";
      i += 1;
      continue;
    }

    const tokenValue = stripQuotes(token);
    if (!url && /^https?:\/\//i.test(tokenValue)) {
      url = tokenValue;
    }
  }

  if (!url) {
    throw new Error("Unable to extract URL from cURL payload");
  }

  const parsed = new URL(url);
  const routeMethod = HTTP_METHODS.has(method) ? method : "POST";

  return {
    source_type: "curl",
    plugin_kind: "api",
    route: {
      method: routeMethod,
      path_template: parsed.pathname || "/",
      upstream_method: routeMethod,
      upstream_path_template: parsed.pathname || "/",
      headers,
      body_sample: body,
    },
    sample_schema: inferSchemaShape(body),
    metadata: {
      source_url: `${parsed.protocol}//${parsed.host}`,
      query_string: parsed.searchParams.toString(),
    },
  };
};

const parseOpenApiContract = (value: unknown): NormalizedContract => {
  let document: JsonRecord | null = asRecord(value);
  if (!document && typeof value === "string") {
    const parsed = parseJsonIfPossible(value);
    document = asRecord(parsed);
  }

  if (!document) {
    throw new Error("OpenAPI payload must be a JSON object");
  }

  const paths = asRecord(document.paths);
  if (!paths) {
    throw new Error("OpenAPI payload missing paths");
  }

  let selectedPath = "";
  let selectedMethod = "";

  for (const [pathTemplate, rawMethods] of Object.entries(paths)) {
    const methods = asRecord(rawMethods);
    if (!methods) continue;
    for (const candidate of ["get", "post", "put", "patch", "delete", "head", "options"]) {
      if (methods[candidate]) {
        selectedPath = pathTemplate;
        selectedMethod = candidate.toUpperCase();
        break;
      }
    }
    if (selectedPath) break;
  }

  if (!selectedPath || !selectedMethod) {
    throw new Error("OpenAPI payload must include at least one HTTP operation");
  }

  const servers = Array.isArray(document.servers) ? document.servers : [];
  const serverUrl = asRecord(servers[0]) ? asString((servers[0] as JsonRecord).url) : "";

  return {
    source_type: "openapi",
    plugin_kind: "api",
    route: {
      method: selectedMethod,
      path_template: selectedPath,
      upstream_method: selectedMethod,
      upstream_path_template: selectedPath,
    },
    sample_schema: inferSchemaShape(document),
    metadata: {
      server_url: serverUrl || null,
      document_kind: asString(document.openapi || document.swagger) || "openapi",
    },
  };
};

const inferSchemaShape = (value: unknown, depth = 0): unknown => {
  if (depth > 6) {
    return { type: "unknown" };
  }

  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    const first = value.length > 0 ? inferSchemaShape(value[0], depth + 1) : { type: "unknown" };
    return { type: "array", items: first };
  }

  if (typeof value === "object") {
    const record = asRecord(value);
    const properties: Record<string, unknown> = {};
    if (record) {
      for (const [key, child] of Object.entries(record)) {
        properties[key] = inferSchemaShape(child, depth + 1);
      }
    }
    return { type: "object", properties };
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
  }

  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "string") return { type: "string" };

  return { type: "unknown" };
};

const collectLeafPaths = (value: unknown, prefix = "$"): string[] => {
  if (value === null || value === undefined) return [prefix];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}[*]`];
    return collectLeafPaths(value[0], `${prefix}[*]`);
  }

  if (typeof value === "object") {
    const record = asRecord(value);
    if (!record) return [prefix];
    const keys = Object.keys(record);
    if (keys.length === 0) return [prefix];
    const output: string[] = [];
    for (const key of keys) {
      output.push(...collectLeafPaths(record[key], `${prefix}.${key}`));
    }
    return output;
  }

  return [prefix];
};

const pickPathByKeywords = (paths: string[], keywords: string[]): string | null => {
  for (const path of paths) {
    const lowered = path.toLowerCase();
    if (keywords.some((keyword) => lowered.includes(keyword))) {
      return path;
    }
  }
  return null;
};

const buildDeterministicMapping = (contract: NormalizedContract): JsonRecord => {
  const payloadSample = contract.plugin_kind === "api"
    ? contract.route?.body_sample
    : contract.webhook?.sample_payload;
  const sample = payloadSample ?? {};
  const paths = collectLeafPaths(sample);

  const mapRules = [
    { target: "tracking_number", keywords: ["tracking_number", "tracking", "waybill", "awb", "barcode"] },
    { target: "external_id", keywords: ["id", "external", "reference", "ref"] },
    { target: "event_type", keywords: ["event", "type", "action"] },
    { target: "status", keywords: ["status", "state"] },
    { target: "occurred_at", keywords: ["timestamp", "created", "updated", "date", "time"] },
    { target: "customer_phone", keywords: ["phone", "mobile", "msisdn"] },
  ];

  const fields: JsonRecord[] = [];
  for (const rule of mapRules) {
    const selected = pickPathByKeywords(paths, rule.keywords);
    if (!selected) continue;
    fields.push({
      target_field: rule.target,
      source_path: selected,
      confidence: 0.75,
      source: "deterministic",
    });
  }

  const mapping: JsonRecord = {
    version: 1,
    mode: "deterministic",
    plugin_kind: contract.plugin_kind,
    fields,
  };
  if (contract.plugin_kind === "webhook") {
    mapping.target = "shipments.create";
    mapping.enabled = true;
    mapping.transforms = buildWebhookShipmentTransforms(paths);
    mapping.metadata = {
      canonical_intent: "shipment.create",
      mapping_profile: "plugin_studio_webhook_shipment_create_v1",
    };
  }
  return mapping;
};

const buildWebhookShipmentTransforms = (paths: string[]): JsonRecord => {
  const pick = (keywords: string[], fallbacks: string[]) => {
    const selected = pickPathByKeywords(paths, keywords)?.replace(/^\$\.?/, "");
    return selected ? [selected, ...fallbacks.filter((path) => path !== selected)] : fallbacks;
  };
  return {
    shipment: {
      tracking_number: pick(["tracking_number", "tracking", "waybill", "awb", "barcode"],
        ["shipment.tracking_number", "tracking_number", "awb", "waybill", "barcode"]),
      external_id: pick(["shipment.external_id", "external_id", "shipment.reference", "reference", "ref"],
        ["shipment.external_id", "shipment.reference", "external_id", "id", "reference"]),
      reference_number: pick(["shipment.reference_number", "reference_number", "shipment.reference", "reference", "ref"],
        ["shipment.reference_number", "shipment.reference", "reference_number", "reference"]),
      service_type: pick(["service_type", "shipment_type"], ["shipment.service_type", "service_type"]),
      service_level: pick(["service_level", "shipping_service"], ["shipment.service_level", "service_level"]),
      cod_amount: pick(["cod_amount", "cash_on_delivery_amount", "amount"], ["shipment.cod_amount", "cod_amount"]),
      currency: pick(["cod_currency", "currency"], ["shipment.cod_currency", "currency"]),
    },
    recipient: {
      external_id: pick(["recipient.external_id", "recipient_id", "customer_id"],
        ["shipment.recipient.external_id", "recipient.external_id", "customer.external_id"]),
      name: pick(["recipient.name", "customer.name", "customer_name", "name"],
        ["Example Entity ntvplorhukthpmnmvgrstqzp", "recipient.name", "customer.name", "customer_name"]),
      phone: pick(["recipient.phone", "customer.phone", "phone_number", "phone", "mobile", "msisdn"],
        ["shipment.recipient.phone", "recipient.phone", "customer.phone", "phone", "mobile"]),
      email: pick(["recipient.email", "customer.email", "email"],
        ["shipment.recipient.email", "recipient.email", "customer.email", "email"]),
    },
    address: {
      line1: pick(["destination.line1", "address.line1", "line1", "address_line_1"],
        ["shipment.destination.line1", "destination.line1", "address.line1", "line1", "address_line_1"]),
      line2: pick(["destination.line2", "address.line2", "line2", "address_line_2"],
        ["shipment.destination.line2", "destination.line2", "address.line2", "line2", "address_line_2"]),
      district: pick(["destination.district", "address.district", "district"],
        ["shipment.destination.district", "destination.district", "address.district", "district"]),
      city: pick(["destination.city", "address.city", "city"],
        ["shipment.destination.city", "destination.city", "address.city", "city"]),
      province: pick(["destination.province", "address.province", "province", "region"],
        ["shipment.destination.province", "destination.province", "address.province", "province", "region"]),
      country_code: pick(["country_code", "destination.country", "address.country", "country"],
        ["shipment.destination.country", "destination.country", "address.country", "country_code", "country"]),
      lat: pick(["destination.lat", "address.lat", "latitude", "lat"],
        ["shipment.destination.lat", "destination.lat", "address.lat", "latitude", "lat"]),
      lng: pick(["destination.lng", "address.lng", "longitude", "lng"],
        ["shipment.destination.lng", "destination.lng", "address.lng", "longitude", "lng"]),
    },
  };
};

const normalizeContract = (body: JsonRecord): NormalizedContract => {
  const sourceType = asString(body.source_type).toLowerCase() || "manual";
  const sourcePayload = asRecord(body.source_payload) ?? body.source_payload ?? {};
  const explicitKind = asString(body.plugin_kind).toLowerCase();

  if (sourceType === "curl") {
    const curl = asRecord(sourcePayload)
      ? asString((sourcePayload as JsonRecord).curl || (sourcePayload as JsonRecord).raw)
      : asString(sourcePayload);
    const parsed = parseCurlContract(curl);
    if (explicitKind === "webhook") parsed.plugin_kind = "webhook";
    return parsed;
  }

  if (sourceType === "openapi") {
    const sourceRecord = asRecord(sourcePayload);
    const openapiPayload = sourceRecord && !asRecord(sourceRecord.paths)
      ? asRecord(sourceRecord.openapi) ?? sourcePayload
      : sourcePayload;
    const parsed = parseOpenApiContract(openapiPayload);
    if (explicitKind === "webhook") parsed.plugin_kind = "webhook";
    return parsed;
  }

  if (sourceType === "webhook_sample") {
    const record = asRecord(sourcePayload);
    const samplePayload =
      (record?.sample as unknown) ??
      (record?.payload as unknown) ??
      sourcePayload;

    return {
      source_type: sourceType,
      plugin_kind: explicitKind === "api" ? "api" : "webhook",
      webhook: {
        sample_payload: samplePayload,
        source_identifier: record ? asString(record.source_identifier) || undefined : undefined,
        name: record ? asString(record.name) || undefined : undefined,
      },
      sample_schema: inferSchemaShape(samplePayload),
      metadata: {},
    };
  }

  if (sourceType === "manual") {
    const inboundConfig = asRecord(body.inbound_config);
    const route = asRecord(inboundConfig?.route);
    const webhook = asRecord(inboundConfig?.webhook);

    if (route) {
      return {
        source_type: sourceType,
        plugin_kind: explicitKind === "webhook" ? "webhook" : "api",
        route: {
          method: asString(route.method).toUpperCase() || "POST",
          path_template: asString(route.path_template) || "/",
          upstream_method: asString(route.upstream_method).toUpperCase() || asString(route.method).toUpperCase() || "POST",
          upstream_path_template: asString(route.upstream_path_template) || asString(route.path_template) || "/",
          headers: asRecord(route.headers) as Record<string, string> | undefined,
          body_sample: route.body_sample ?? {},
        },
        sample_schema: inferSchemaShape(route.body_sample ?? {}),
        metadata: {},
      };
    }

    return {
      source_type: sourceType,
      plugin_kind: explicitKind === "api" ? "api" : "webhook",
      webhook: {
        sample_payload: webhook?.sample_payload ?? {},
        source_identifier: asString(webhook?.source_identifier) || undefined,
        name: asString(webhook?.name) || undefined,
      },
      sample_schema: inferSchemaShape(webhook?.sample_payload ?? {}),
      metadata: {},
    };
  }

  throw new Error(`Unsupported source_type=${sourceType}`);
};

const buildInboundConfigFromContract = (contract: NormalizedContract): JsonRecord => {
  if (contract.plugin_kind === "api") {
    const upstreamBaseUrl = resolveProviderBaseUrl(contract);
    return {
      route: {
        method: contract.route?.method || "POST",
        path_template: contract.route?.path_template || "/",
        upstream_method: contract.route?.upstream_method || contract.route?.method || "POST",
        upstream_path_template: contract.route?.upstream_path_template || contract.route?.path_template || "/",
        ...(upstreamBaseUrl ? { upstream_base_url: upstreamBaseUrl } : {}),
      },
    };
  }

  return {
    webhook: {
      source_identifier: contract.webhook?.source_identifier || null,
      name: contract.webhook?.name || null,
      sample_payload: contract.webhook?.sample_payload ?? {},
    },
  };
};

const resolveProviderBaseUrl = (contract: NormalizedContract): string => {
  for (const candidate of [contract.metadata?.source_url, contract.metadata?.server_url]) {
    const value = asString(candidate);
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password) {
        return parsed.origin;
      }
    } catch {
      // Try the alternate contract URL before using the explicit placeholder.
    }
  }
  return "";
};

const buildOutboundSuggestions = (contract: NormalizedContract): JsonRecord[] => {
  if (contract.plugin_kind !== "api") return [];
  const providerBaseUrl = resolveProviderBaseUrl(contract);
  const upstreamPath = contract.route?.upstream_path_template || contract.route?.path_template || "/";
  const path = upstreamPath.startsWith("/") ? upstreamPath : `/${upstreamPath}`;

  return [
    {
      operation_name: "forward_event",
      method: contract.route?.method || "POST",
      url_template: providerBaseUrl ? `${providerBaseUrl}${path}` : `https://example-provider.invalid${path}`,
      headers_template: {
        "content-type": "application/json",
      },
      body_template: {
        payload: "$.payload",
      },
      request_mappings: {
        body: {
          payload: "$.payload",
        },
      },
      auth: {
        mode: "bearer_token_header",
      },
      timeout_seconds: 30,
    },
  ];
};

const asJsonArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const normalizeArtifact = (value: unknown): MappingArtifact | null => {
  const normalized = asString(value).toLowerCase();
  if (
    normalized === "tabular_import" ||
    normalized === "webhook_inbound" ||
    normalized === "api_outbound" ||
    normalized === "integration_plugin"
  ) {
    return normalized;
  }
  return null;
};

const normalizeJsonSchema = (value: unknown): JsonRecord | null => asRecord(value);

const resolveSchemaType = (schema: JsonRecord | null): string | null => {
  if (!schema) return null;
  const raw = schema.type;
  if (typeof raw === "string" && raw.trim()) return raw.trim().toLowerCase();
  if (Array.isArray(raw)) {
    const candidate = raw.find((entry) => typeof entry === "string" && entry.trim().toLowerCase() !== "null");
    return typeof candidate === "string" ? candidate.trim().toLowerCase() : null;
  }
  return null;
};

const resolveSchemaProperties = (schema: JsonRecord | null): Record<string, JsonRecord> => {
  const raw = asRecord(schema?.properties);
  if (!raw) return {};
  const out: Record<string, JsonRecord> = {};
  for (const [key, value] of Object.entries(raw)) {
    const record = asRecord(value);
    if (record) out[key] = record;
  }
  return out;
};

const resolveSchemaRequired = (schema: JsonRecord | null): Set<string> => {
  const required = asJsonArray(schema?.required);
  return new Set(required.filter((value): value is string => typeof value === "string" && value.trim().length > 0));
};

const typeOfValue = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
};

const normalizeJsonPathTokens = (path: string): string[] => {
  const cleaned = path
    .trim()
    .replace(/^\$\.?/, "")
    .replace(/\[\*\]/g, ".0")
    .replace(/\[(\d+)\]/g, ".$1");
  return cleaned.split(".").map((part) => part.trim()).filter(Boolean);
};

const readPathValue = (source: unknown, path: string | null): unknown => {
  if (!path) return undefined;
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("column:")) {
    const key = trimmed.slice("column:".length).trim();
    const record = asRecord(source);
    return record && Object.hasOwn(record, key) ? record[key] : undefined;
  }

  const tokens = normalizeJsonPathTokens(trimmed);
  let current: unknown = source;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(token, 10);
      if (!Number.isFinite(index)) return undefined;
      current = current[index];
      continue;
    }
    const record = asRecord(current);
    if (!record) return undefined;
    if (!Object.hasOwn(record, token)) return undefined;
    current = record[token];
  }
  return current;
};

const normalizeFieldRules = (mappingConfig: JsonRecord | null): JsonRecord[] => {
  if (!mappingConfig) return [];

  if (Array.isArray(mappingConfig.fields)) {
    return mappingConfig.fields
      .map((entry) => asRecord(entry))
      .filter((entry): entry is JsonRecord => Boolean(entry));
  }

  if (Array.isArray(mappingConfig.column_mappings)) {
    return mappingConfig.column_mappings
      .map((entry) => asRecord(entry))
      .filter((entry): entry is JsonRecord => Boolean(entry));
  }

  const fieldMappings = asRecord(mappingConfig.field_mappings);
  if (fieldMappings) {
    return Object.entries(fieldMappings).map(([target, rawValue]) => {
      const values = Array.isArray(rawValue)
        ? rawValue.filter((entry): entry is string => typeof entry === "string")
        : typeof rawValue === "string"
          ? [rawValue]
          : [];
      return {
        target_field: target,
        source_path: values[0] ?? null,
        source_paths: values,
        confidence: 1,
        source: "field_mappings",
      };
    });
  }

  return [];
};

const coerceValueToSchema = (
  value: unknown,
  schema: JsonRecord | null,
): { value: unknown; coercion: MappingCoercion | null } => {
  const schemaType = resolveSchemaType(schema);
  if (!schemaType) return { value, coercion: null };
  const originalType = typeOfValue(value);

  if (value === undefined) {
    return { value: undefined, coercion: null };
  }

  if (schemaType === "array" && !Array.isArray(value)) {
    const nextValue = value === null || value === "" ? [] : [value];
    return {
      value: nextValue,
      coercion: {
        target_field: "",
        source_path: null,
        original_type: originalType,
        original_value: value,
        converted_type: "array",
        converted_value: nextValue,
        reason: "Schema expects an array; wrapped scalar value in a singleton array.",
        can_override: true,
      },
    };
  }

  if ((schemaType === "integer" || schemaType === "number") && typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        const nextValue = schemaType === "integer" ? Math.trunc(numeric) : numeric;
        return {
          value: nextValue,
          coercion: {
            target_field: "",
            source_path: null,
            original_type: originalType,
            original_value: value,
            converted_type: schemaType,
            converted_value: nextValue,
            reason: `Converted numeric string to ${schemaType}.`,
            can_override: true,
          },
        };
      }
    }
  }

  if (schemaType === "boolean" && typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true" || lowered === "false") {
      const nextValue = lowered === "true";
      return {
        value: nextValue,
        coercion: {
          target_field: "",
          source_path: null,
          original_type: originalType,
          original_value: value,
          converted_type: "boolean",
          converted_value: nextValue,
          reason: "Converted boolean-like string to boolean.",
          can_override: true,
        },
      };
    }
  }

  if ((schemaType === "string" || schemaType === "date" || schemaType === "datetime") && value != null) {
    const format = typeof schema?.format === "string" ? schema.format.toLowerCase() : "";
    if (format === "date" || format === "date-time") {
      if (typeof value === "string") {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) {
          const nextValue = format === "date"
            ? parsed.toISOString().slice(0, 10)
            : parsed.toISOString();
          if (nextValue !== value) {
            return {
              value: nextValue,
              coercion: {
                target_field: "",
                source_path: null,
                original_type: originalType,
                original_value: value,
                converted_type: "string",
                converted_value: nextValue,
                reason: `Normalized ${format} string to ISO format.`,
                can_override: true,
              },
            };
          }
        }
      }
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed !== value) {
        return {
          value: trimmed,
          coercion: {
            target_field: "",
            source_path: null,
            original_type: originalType,
            original_value: value,
            converted_type: "string",
            converted_value: trimmed,
            reason: "Trimmed surrounding whitespace.",
            can_override: true,
          },
        };
      }
    }
  }

  if (schemaType === "string" && value === null) {
    return {
      value: "",
      coercion: {
        target_field: "",
        source_path: null,
        original_type: originalType,
        original_value: value,
        converted_type: "string",
        converted_value: "",
        reason: "Normalized null to empty string for an optional text field.",
        can_override: true,
      },
    };
  }

  const enumValues = Array.isArray(schema?.enum)
    ? schema.enum.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (enumValues.length > 0 && typeof value === "string") {
    const match = enumValues.find((entry) => entry.toLowerCase() === value.trim().toLowerCase());
    if (match && match !== value) {
      return {
        value: match,
        coercion: {
          target_field: "",
          source_path: null,
          original_type: originalType,
          original_value: value,
          converted_type: "string",
          converted_value: match,
          reason: "Matched value to an allowed enum entry.",
          can_override: true,
        },
      };
    }
  }

  return { value, coercion: null };
};

const containsSecretLikeKey = (key: string): boolean => {
  const lowered = key.toLowerCase();
  if (["public_token", "plugin_key", "mapping_key", "handler_key", "sort_key",
    "idempotency_key", "public_key", "publishable_key", "max_tokens", "token_type", "credential_type",
    "next_page_token", "page_token"].includes(lowered)) return false;
  return /token|secret|password|passwd|passphrase|pwd|credential|apikey|privatekey|cookie|signature|hmac/.test(lowered.replace(/[^a-z0-9]/g, ""))
    || /^(key|(api|access|master|license|secret|private|client|auth)key)$/.test(lowered)
    || /[_. -]key$/.test(lowered) || /[a-z0-9]Key$/.test(key) || lowered.includes("authorization");
};


const isCredentialReference = (value: unknown, input: unknown): boolean => {
  if (typeof value === "string") {
    if (value.trim() === "" || /^((Bearer|Basic)\s+)?\{\{[A-Za-z0-9_.$\[\]-]+\}\}$/i.test(value)) return true;
    const reference = value.replace(/^(Bearer|Basic)\s+/i, "");
    return /^\$(\.[A-Za-z0-9_$-]+|\[([0-9]+|\*)\])+$/.test(reference)
      && readPathValue(input, reference) !== undefined;
  }
  const reference = asRecord(value);
  return reference?.type === "SecretRef" && Object.keys(reference).length === 2 && maybeUuid(reference.id) !== null;
};

const collectSecretDiagnostics = (
  value: unknown,
  prefix: string,
  diagnostics: MappingDiagnostic[],
  input: unknown,
  sensitive = false,
) => {
  if (sensitive && isCredentialReference(value, input)) return;
  if (typeof value === "string") {
    if (sensitive) diagnostics.push({
      level: "warning", blocking: false, code: "secret_like_value_detected", fieldPath: prefix,
      message: "Potential secret-like sample value detected at " + prefix + ".",
      why: "Samples and saved reports are redacted; executable credentials require a binding.",
      recommended_fix: "Use a credential binding or a known input reference.",
    });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectSecretDiagnostics(entry, prefix + "[" + index + "]", diagnostics, input, sensitive));
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, entry] of Object.entries(record)) {
    collectSecretDiagnostics(entry, prefix ? prefix + "." + key : key, diagnostics, input, sensitive || containsSecretLikeKey(key));
  }
};

const isPrivateOrLocalHost = (host: string): boolean => {
  const lowered = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (lowered === "localhost" || lowered.endsWith(".localhost") || lowered.endsWith(".local")) return true;
  return (lowered.includes(":") || /^[\d.]+$/.test(lowered)) && !isPublicIpAddress(lowered);
};

const hostMatchesPolicy = (host: string, pattern: string, deny = false): boolean => {
  const name = host.toLowerCase().replace(/\.$/, "");
  const rule = pattern.trim().toLowerCase().replace(/\.$/, "");
  if (rule === "*") return true;
  const suffix = rule.startsWith("*.") ? rule.slice(2) : rule;
  return deny
    ? name === suffix || name.endsWith(`.${suffix}`)
    : rule.startsWith("*.") ? name.endsWith(`.${suffix}`) : name === rule;
};

const resolveStudioEgressPreview = async (
  userClient: ReturnType<typeof createClient>, organizationId: string | null,
): Promise<JsonRecord | null> => {
  try {
    let tenantId = organizationId;
    if (!tenantId) {
      const { data, error } = await userClient.rpc("ui_me_v1");
      if (error) return null;
      tenantId = maybeUuid(asRecord(asRecord(data)?.org)?.id);
    }
    if (!tenantId) return null;
    const { data, error } = await userClient.rpc("ui_settings_preview_v1", {
      p_category: "integration_plugin_egress_policy", p_scope_type: "tenant", p_scope_id: tenantId,
    });
    const preview = error ? null : asRecord(data);
    const policy = asRecord(preview?.value);
    const headerList = policy && Object.prototype.hasOwnProperty.call(policy, "header_allowlist")
      ? policy.header_allowlist : policy?.headers_allowlist;
    const lists = [policy?.domain_allowlist, policy?.domain_denylist, headerList];
    if (!policy || !lists.every((list) => list === undefined || (Array.isArray(list) &&
      list.every((entry) => typeof entry === "string" && entry.trim().length > 0)))) return null;
    return { ...preview, value: { ...policy,
      // Match api-caller's bounded legacy default; an explicit [] still means no headers.
      header_allowlist: headerList ?? ["accept", "content-type", "authorization", "x-api-key", "api-key", "user-agent"],
    } };
  } catch {
    return null;
  }
};

const pushDiagnostic = (
  diagnostics: MappingDiagnostic[],
  diagnostic: MappingDiagnostic,
) => {
  diagnostics.push(diagnostic);
};

const buildStudioReview = async (
  userClient: ReturnType<typeof createClient>,
  body: JsonRecord,
  artifact: MappingArtifact,
  organizationId: string | null,
  normalizedContract: NormalizedContract | null,
  mappingSuggestion: JsonRecord,
) => {
  const diagnostics: MappingDiagnostic[] = [];
  const coercions: MappingCoercion[] = [];
  const requestConfig = asRecord(body.request_config) ?? {};
  const targetSchema = normalizeJsonSchema(body.target_schema);
  const requiredFields = resolveSchemaRequired(targetSchema);
  const properties = resolveSchemaProperties(targetSchema);
  const mappingConfig = asRecord(body.mapping_config) ?? mappingSuggestion;
  const runtimeMapping = artifact !== "tabular_import" &&
    (Object.prototype.hasOwnProperty.call(mappingConfig, "field_mappings") ||
      Object.prototype.hasOwnProperty.call(mappingConfig, "transforms"));
  const tabularSource = asRecord(body.source_payload);
  const tabularSample = Array.isArray(tabularSource?.sample_rows) && tabularSource.sample_rows.length > 0
    ? tabularSource.sample_rows[0]
    : null;
  const sampleSource = artifact === "tabular_import"
    ? tabularSample
    : normalizedContract?.plugin_kind === "api"
      ? normalizedContract.route?.body_sample ?? {}
      : normalizedContract?.webhook?.sample_payload ?? {};

  const outboundRequests: Array<{ config: JsonRecord; fieldPrefix: string }> = [];
  if (artifact === "api_outbound") {
    outboundRequests.push({ config: { ...requestConfig, url_template: requestConfig.url_template ?? body.url_template },
      fieldPrefix: "request_config" });
  }
  if (artifact === "integration_plugin") {
    const rows = Array.isArray(body.outbound_operations) ? body.outbound_operations
      : normalizedContract ? buildOutboundSuggestions(normalizedContract) : [];
    rows.forEach((row, index) => outboundRequests.push({ config: asRecord(row) ?? {},
      fieldPrefix: `outbound_operations[${index}]` }));
    if (normalizedContract?.plugin_kind === "api" && rows.length === 0) {
      pushDiagnostic(diagnostics, { level: "error", blocking: true, code: "outbound_operation_required",
        fieldPath: "outbound_operations", message: "API plugins require an outbound operation.",
        why: "A provider request needs a concrete target before save.",
        recommended_fix: "Add the provider operation and retry preview." });
    }
  }
  const egressPreview = outboundRequests.length > 0
    ? await resolveStudioEgressPreview(userClient, organizationId) : null;
  const egressPolicy = asRecord((egressPreview as JsonRecord | null)?.value);
  const egressResolutionId = asString((egressPreview as JsonRecord | null)?.settings_resolution_id) || null;
  const domainAllowlist = (egressPolicy?.domain_allowlist ?? []) as string[];
  const domainDenylist = (egressPolicy?.domain_denylist ?? []) as string[];
  const headersAllowlist = ((egressPolicy?.header_allowlist ?? egressPolicy?.headers_allowlist ?? []) as string[])
    .map((name) => name.trim().toLowerCase());


  collectSecretDiagnostics(sampleSource, "sample", diagnostics, sampleSource);
  // Preview and persistence share one validator, including definitions and serialized bodies.
  try {
    const { data, error } = await userClient.rpc("integration_plugin_validate_config_v1", {
      p_value: {
        mapping_config: mappingConfig,
        response_mapping_config: asRecord(body.response_mapping_config) ?? {},
        request_config: requestConfig,
        outbound_operations: outboundRequests.map(({ config }) => config),
        ...(artifact === "integration_plugin" && normalizedContract ? {
          inbound_config: asRecord(body.inbound_config) ?? buildInboundConfigFromContract(normalizedContract),
        } : {}),
      },
      p_input: sampleSource,
    });
    if (error || data !== true) {
      diagnostics.push({
        level: "error", blocking: true,
        code: error?.code === "23514" ? "secret_like_value_detected" : "credential_validation_unavailable",
        fieldPath: "request_config",
        message: error?.code === "23514"
          ? "Inline credentials are not allowed in executable configuration; use an auth binding."
          : "Credential validation is unavailable.",
        why: "The database credential boundary must accept the same configuration before it can be saved.",
        recommended_fix: error?.code === "23514"
          ? "Remove inline credentials or use a binding or a known input reference."
          : "Restore credential validation and retry preview.",
      });
    }
  } catch {
    diagnostics.push({ level: "error", blocking: true, code: "credential_validation_unavailable",
      fieldPath: "request_config", message: "Credential validation is unavailable.",
      why: "The persistence validator could not be reached.", recommended_fix: "Retry when validation is available." });
  }

  // The caller has already checked the actor's tenant capability. This RPC is pure
  // and service-only; it uses the same evaluator as actual mapping execution.
  let runtimePreview: JsonRecord | null = null;
  if (runtimeMapping) {
    const key = readEnv("EDGE_SUPABASE_SECRET_KEY", ["SUPABASE_SECRET_KEY"]) ||
      readEnv("EDGE_SUPABASE_SERVICE_ROLE_KEY", ["SUPABASE_SERVICE_ROLE_KEY", "SERVICE_ROLE_KEY"]);
    if (!SUPABASE_URL || !key) throw createHttpError(503, "Mapping preview unavailable", "studio.preview.unavailable");
    const privateClient = createClient(SUPABASE_URL, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      db: { schema: "api" },
    });
    runtimePreview = await previewRuntimeMapping(privateClient, sampleSource, mappingConfig);
  }
  const fieldRules: JsonRecord[] = runtimePreview !== null
    ? Object.keys(runtimePreview).map((target_field) => ({ target_field }))
    : normalizeFieldRules(mappingConfig);
  const coercedPreview: JsonRecord = runtimePreview ?? {};
  const seenTargets = new Set<string>();
  for (const rule of fieldRules) {
    const targetField = asString(rule.target_field);
    const sourcePath = asString(rule.source_path) || asString(rule.source_column ? `column:${rule.source_column}` : "");
    if (!targetField) {
      pushDiagnostic(diagnostics, {
        level: "error",
        blocking: true,
        code: "target_field_required",
        fieldPath: null,
        message: "A mapping rule is missing target_field.",
        why: "The studio cannot save or preview a rule without a target field.",
        recommended_fix: "Choose a target field for the rule or remove the incomplete rule.",
      });
      continue;
    }

    seenTargets.add(targetField);
    const rawValue = runtimePreview !== null
      ? runtimePreview[targetField]
      : rule.sample_value ?? readPathValue(sampleSource, sourcePath || null);
    const propertySchema = properties[targetField] ?? null;
    const coerced = coerceValueToSchema(rawValue, propertySchema);
    if (runtimePreview === null) coercedPreview[targetField] = coerced.value;
    if (coerced.coercion) {
      coercions.push({
        ...coerced.coercion,
        target_field: targetField,
        source_path: sourcePath || null,
      });
    }

    if (propertySchema) {
      const schemaType = resolveSchemaType(propertySchema);
      if (rawValue !== undefined && rawValue !== null && schemaType) {
        const rawType = typeOfValue(rawValue);
        const nextType = typeOfValue(coerced.value);
        const runtimeTypeMismatch = runtimePreview !== null && rawType !== schemaType &&
          !(schemaType === "number" && rawType === "integer");
        if (runtimeTypeMismatch || (schemaType !== "array" && rawType !== nextType &&
          coercions.every((entry) => entry.target_field !== targetField))) {
          pushDiagnostic(diagnostics, {
            level: "error",
            blocking: true,
            code: "schema_type_mismatch",
            fieldPath: targetField,
            message: `Value for ${targetField} does not match the target schema type.`,
            why: `Expected ${schemaType} but inferred ${rawType}.`,
            recommended_fix: "Adjust the mapping, provide a compatible sample value, or edit the target schema.",
          });
        }
      }
    }
  }

  for (const requiredField of requiredFields) {
    if (!seenTargets.has(requiredField)) {
      pushDiagnostic(diagnostics, {
        level: "error",
        blocking: true,
        code: "required_field_unmapped",
        fieldPath: requiredField,
        message: `Required field ${requiredField} is not mapped.`,
        why: "The target schema marks this field as required.",
        recommended_fix: "Add a mapping rule or remove the field from the required list in the target schema.",
      });
    }
  }

  if (artifact === "tabular_import") {
    const sourceColumns = asJsonArray(tabularSource?.columns).filter((entry): entry is string => typeof entry === "string");
    if (sourceColumns.length === 0) {
      pushDiagnostic(diagnostics, {
        level: "error",
        blocking: true,
        code: "spreadsheet_columns_missing",
        fieldPath: "source_payload.columns",
        message: "No spreadsheet columns were detected.",
        why: "Tabular import requires at least one detected column.",
        recommended_fix: "Upload a CSV/XLSX file with a header row or provide columns explicitly.",
      });
    }
  }

  if (outboundRequests.length > 0 && !egressPolicy) {
    pushDiagnostic(diagnostics, { level: "error", blocking: true, code: "egress_policy_unavailable",
      fieldPath: "integration_plugin_egress_policy", message: "Outbound egress policy could not be resolved.",
      why: "Missing or malformed tenant policy cannot be treated as permission to save.",
      recommended_fix: "Resolve the tenant policy through settings review and retry preview.",
      source_policy: "integration_plugin_egress_policy", settings_resolution_id: egressResolutionId });
  }
  for (const outbound of outboundRequests) {
    const urlTemplate = asString(outbound.config.url_template);
    if (urlTemplate) {
      try {
        const parsed = new URL(urlTemplate);
        if (parsed.username || parsed.password) throw new Error("URL userinfo is not permitted");
        if (/[{}]/.test(parsed.hostname) && domainAllowlist.length === 0) {
          pushDiagnostic(diagnostics, { level: "error", blocking: true, code: "egress_domain_not_allowlisted",
            fieldPath: `${outbound.fieldPrefix}.url_template`, message: "Templated provider hosts require an explicit tenant allowlist.",
            why: "An unrestricted dynamic hostname cannot be approved before execution.",
            recommended_fix: "Use an approved literal provider host or configure a bounded tenant allowlist.",
            source_policy: "integration_plugin_egress_policy", settings_resolution_id: egressResolutionId });
        }
        if (parsed.protocol !== "https:") {
          pushDiagnostic(diagnostics, {
            level: "error",
            blocking: true,
            code: "egress_requires_https",
            fieldPath: `${outbound.fieldPrefix}.url_template`,
            message: "Only https:// targets are allowed for outbound requests.",
            why: "Outbound policy blocks non-HTTPS traffic.",
            recommended_fix: "Change the target URL to HTTPS.",
            source_policy: "integration_plugin_egress_policy",
            settings_resolution_id: egressResolutionId,
          });
        }
        if (isPrivateOrLocalHost(parsed.hostname)) {
          pushDiagnostic(diagnostics, {
            level: "error",
            blocking: true,
            code: "egress_private_network_blocked",
            fieldPath: `${outbound.fieldPrefix}.url_template`,
            message: `Private or local network target is blocked (${parsed.hostname}).`,
            why: "Outbound policy blocks localhost and private-network destinations.",
            recommended_fix: "Use a public HTTPS hostname that is allowed by policy.",
            source_policy: "integration_plugin_egress_policy",
            settings_resolution_id: egressResolutionId,
          });
        }
        if (domainDenylist.some((pattern) => hostMatchesPolicy(parsed.hostname, pattern, true))) {
          pushDiagnostic(diagnostics, { level: "error", blocking: true, code: "egress_domain_denied",
            fieldPath: `${outbound.fieldPrefix}.url_template`, message: `Provider host is denied (${parsed.hostname}).`,
            why: "The tenant egress denylist takes precedence over the allowlist.",
            recommended_fix: "Choose an approved provider host or request a policy review.",
            source_policy: "integration_plugin_egress_policy", settings_resolution_id: egressResolutionId });
        }
        if (domainAllowlist.length > 0 && !domainAllowlist.some((pattern) => hostMatchesPolicy(parsed.hostname, pattern))) {
          pushDiagnostic(diagnostics, { level: "error", blocking: true, code: "egress_domain_not_allowlisted",
            fieldPath: `${outbound.fieldPrefix}.url_template`, message: `Provider host is not allowlisted (${parsed.hostname}).`,
            why: "The tenant egress policy restricts outbound requests to approved hosts.",
            recommended_fix: "Choose an approved provider host or request a policy review.",
            source_policy: "integration_plugin_egress_policy", settings_resolution_id: egressResolutionId });
        }
      } catch {
        pushDiagnostic(diagnostics, {
          level: "error",
          blocking: true,
          code: "egress_invalid_url",
          fieldPath: `${outbound.fieldPrefix}.url_template`,
          message: "Outbound URL template is not a valid absolute URL.",
          why: "The request target cannot be validated or executed safely.",
          recommended_fix: "Provide a full absolute HTTPS URL.",
          source_policy: "integration_plugin_egress_policy",
          settings_resolution_id: egressResolutionId,
        });
      }
    } else {
      pushDiagnostic(diagnostics, { level: "error", blocking: true, code: "egress_url_required",
        fieldPath: `${outbound.fieldPrefix}.url_template`, message: "Outbound URL is required.",
        why: "Every outbound operation needs a reviewable target.",
        recommended_fix: "Provide an absolute HTTPS provider URL.",
        source_policy: "integration_plugin_egress_policy", settings_resolution_id: egressResolutionId });
    }

    const headersTemplate = asRecord(outbound.config.headers_template);
    if (headersTemplate && egressPolicy) {
      for (const key of Object.keys(headersTemplate)) {
        if (!headersAllowlist.includes(key.toLowerCase())) {
          pushDiagnostic(diagnostics, {
            level: "error",
            blocking: true,
            code: "header_not_allowlisted",
            fieldPath: `${outbound.fieldPrefix}.headers_template.${key}`,
            message: `Header ${key} is not in the outbound allowlist.`,
            why: "The egress policy allows only a bounded header set.",
            recommended_fix: "Remove the header or update the allowlist via policy review.",
            source_policy: "integration_plugin_egress_policy",
            settings_resolution_id: egressResolutionId,
          });
        }
      }
    }
  }

  const workflowBinding = asRecord(body.workflow_binding);
  if (workflowBinding) {
    const bindingMode = asString(workflowBinding.mode).toLowerCase();
    const workflowTemplateId = maybeUuid(workflowBinding.workflow_template_id);
    const templateName = asString(workflowBinding.template_name);
    if (bindingMode === "create_new" && !templateName) {
      pushDiagnostic(diagnostics, {
        level: "error",
        blocking: true,
        code: "workflow_template_name_required",
        fieldPath: "workflow_binding.template_name",
        message: "Workflow template name is required when creating a new workflow.",
        why: "The studio cannot create a workflow template without a name.",
        recommended_fix: "Provide a template name or switch to attach_existing.",
      });
    }
    if (bindingMode === "attach_existing" && !workflowTemplateId) {
      pushDiagnostic(diagnostics, {
        level: "error",
        blocking: true,
        code: "workflow_template_id_required",
        fieldPath: "workflow_binding.workflow_template_id",
        message: "An existing workflow template id is required for attach_existing.",
        why: "The studio needs a target workflow id to bind to.",
        recommended_fix: "Choose an existing workflow template or switch to create_new.",
      });
    }
  }

  const blockingCount = diagnostics.filter((entry) => entry.blocking).length;
  const warningCount = diagnostics.filter((entry) => entry.level === "warning" && !entry.blocking).length;
  const nextSteps = Array.from(new Set(
    diagnostics
      .filter((entry) => entry.blocking || entry.level === "warning")
      .map((entry) => entry.recommended_fix)
      .filter(Boolean),
  ));

  return {
    mapping_config: mappingConfig,
    preview_mode: runtimeMapping ? "runtime" : artifact === "tabular_import" ? "tabular_proposal" : "draft_proposal",
    coerced_preview: coercedPreview,
    coercions,
    diagnostics,
    review_summary: {
      blocking_count: blockingCount,
      warning_count: warningCount,
      coercion_count: coercions.length,
      next_steps: nextSteps,
      egress_policy_resolution_id: egressResolutionId,
    },
  };
};

const canCapability = async (
  userClient: ReturnType<typeof createClient>,
  capabilityKey: string,
  organizationId: string | null,
) => {
  const { error } = await userClient.rpc("assert_capability_v1", {
    p_capability_key: capabilityKey,
    p_scope_type: organizationId ? "tenant" : null,
    p_scope_id: organizationId,
  });
  return !error;
};

const assertAnyCapability = async (
  userClient: ReturnType<typeof createClient>,
  capabilityKeys: string[],
  organizationId: string | null,
) => {
  for (const capabilityKey of capabilityKeys) {
    if (await canCapability(userClient, capabilityKey, organizationId)) {
      return;
    }
  }
  throw new Error(`Capability denied: expected one of ${capabilityKeys.join(", ")}`);
};

const resolveDirectCapability = (artifact: MappingArtifact): string | null => {
  if (artifact === "tabular_import") return "mappings.write";
  if (artifact === "webhook_inbound") return "mappings.write";
  if (artifact === "api_outbound") return "system.write";
  return null;
};

const persistOperationReport = async (
  userClient: ReturnType<typeof createClient>,
  report: JsonRecord,
) => {
  const { data, error } = await userClient.rpc("ui_create_mapping_operation_report_v1", {
    p_report: report,
  });
  if (error) {
    throw new Error(error.message || "Failed to persist mapping operation report");
  }
  return asRecord(data);
};

const assertCapability = async (
  userClient: ReturnType<typeof createClient>,
  capabilityKey: string,
  organizationId: string | null,
) => {
  const { error } = await userClient.rpc("assert_capability_v1", {
    p_capability_key: capabilityKey,
    p_scope_type: organizationId ? "tenant" : null,
    p_scope_id: organizationId,
  });

  if (error) {
    const message = error.message || `Capability denied: ${capabilityKey}`;
    if (isInvalidJwtMessage(message)) {
      throw createHttpError(400, message, "edge.auth.invalid_token");
    }
    throw createHttpError(
      403,
      message,
      "edge.integration_plugin_studio.capability_denied",
      { capability_key: capabilityKey },
    );
  }
};

const maybeCreateDraft = async (
  userClient: ReturnType<typeof createClient>,
  body: JsonRecord,
  normalizedContract: NormalizedContract,
  mappingSuggestion: JsonRecord,
  completedReview?: JsonRecord,
): Promise<JsonRecord | null> => {
  if (!parseBoolean(body.persist_draft, false)) return null;

  const review = completedReview ?? await buildStudioReview(
    userClient, body, "integration_plugin", maybeUuid(body.organization_id), normalizedContract, mappingSuggestion,
  );
  if (Number(asRecord(review.review_summary)?.blocking_count ?? 0) > 0) {
    throw createHttpError(400, "Submit blocked by review diagnostics.", "mapping_studio.review.blocked", { review });
  }

  const pluginName = asString(body.plugin_name) || `Integration Plugin ${new Date().toISOString()}`;
  const pluginKind = normalizedContract.plugin_kind;
  const organizationId = maybeUuid(body.organization_id);

  const { data, error } = await userClient.rpc("integration_plugin_generate_draft_v1", {
    p_plugin_name: pluginName,
    p_plugin_kind: pluginKind,
    p_source_type: normalizedContract.source_type,
    p_source_payload: asRecord(body.source_payload) ?? body.source_payload ?? {},
    p_inbound_config: asRecord(body.inbound_config) ?? buildInboundConfigFromContract(normalizedContract),
    p_mapping_config: asRecord(body.mapping_config) ?? mappingSuggestion,
    p_workflow_binding: asRecord(body.workflow_binding) ?? {},
    p_outbound_operations: Array.isArray(body.outbound_operations)
      ? body.outbound_operations
      : buildOutboundSuggestions(normalizedContract),
    p_plugin_id: maybeUuid(body.plugin_id),
    p_plugin_key: asString(body.plugin_key) || null,
    p_description: asString(body.description) || null,
    p_organization_id: organizationId,
    p_metadata: {
      managed_by: "integration_plugin_studio_edge",
      endpoint: "integration-plugin-studio",
      created_at: new Date().toISOString(),
    },
  });

  if (error) {
    throw new Error(error.message || "Failed to create plugin draft");
  }

  const record = asRecord(data);
  if (!record) return null;
  if (!record.plugin_version_id && record.version_id) {
    record.plugin_version_id = record.version_id;
  }
  return record;
};

const buildOperationReportPayload = (params: {
  artifact: MappingArtifact;
  saveMode: "direct" | "draft";
  status: "succeeded" | "failed";
  organizationId: string | null;
  correlationId: string;
  review: JsonRecord | null;
  result: JsonRecord | null;
  normalizedContract?: NormalizedContract | null;
  errorMessage?: string | null;
}): JsonRecord => {
  const nextSteps =
    Array.isArray(params.review?.review_summary?.next_steps)
      ? params.review?.review_summary?.next_steps
      : [];
  const primaryResourceType = asString(params.result?.primary_resource_type) || null;
  const primaryResourceId =
    maybeUuid(params.result?.primary_resource_id) ||
    maybeUuid(params.result?.mapping_config_id) ||
    maybeUuid(params.result?.plugin_version_id) ||
    null;
  const workflowTemplateId =
    maybeUuid(params.result?.workflow_template_id) ||
    maybeUuid(params.result?.workflow_binding_outcome && asRecord(params.result.workflow_binding_outcome)?.workflow_template_id) ||
    null;

  return {
    organization_id: params.organizationId,
    artifact_type: params.artifact,
    save_mode: params.saveMode,
    status: params.status,
    primary_resource_type: primaryResourceType,
    primary_resource_id: primaryResourceId,
    workflow_template_id: workflowTemplateId,
    correlation_id: params.correlationId,
    request_summary: {
      artifact: params.artifact,
      save_mode: params.saveMode,
      source_type: params.normalizedContract?.source_type ?? null,
      plugin_kind: params.normalizedContract?.plugin_kind ?? null,
    },
    conversion_summary: params.review?.review_summary
      ? {
          coercion_count: params.review.review_summary.coercion_count ?? 0,
          coercions: params.review.coercions ?? [],
        }
      : {},
    diagnostics_summary: params.review
      ? {
          blocking_count: params.review.review_summary?.blocking_count ?? 0,
          warning_count: params.review.review_summary?.warning_count ?? 0,
          diagnostics: params.review.diagnostics ?? [],
          error_message: params.errorMessage ?? null,
        }
      : {
          diagnostics: [],
          error_message: params.errorMessage ?? null,
        },
    result_payload: {
      ...(params.result ?? {}),
      error_message: params.errorMessage ?? null,
    },
    decision_refs: {
      correlation_id: params.correlationId,
      egress_policy_resolution_id: params.review?.review_summary?.egress_policy_resolution_id ?? null,
    },
    next_steps: nextSteps,
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

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return errorResponse(
      500,
      "edge.config.missing_env",
      "Missing Supabase edge configuration",
      origin,
      correlationId,
      trace,
      { service: SERVICE_NAME },
    );
  }

  if (req.method !== "POST") {
    return errorResponse(
      405,
      "edge.request.method_not_allowed",
      "Method not allowed",
      origin,
      correlationId,
      trace,
      { method: req.method },
    );
  }

  const token = extractToken(req, {
    prefer: "authorization",
    allowQueryParam: false,
    allowWebhookHeader: false,
  });

  if (!token) {
    return errorResponse(
      401,
      "edge.auth.missing_token",
      "Missing Authorization bearer token",
      origin,
      correlationId,
      trace,
    );
  }

  let body: JsonRecord = {};
  try {
    const parsed = await parseRequestBody(req);
    const record = asRecord(parsed?.json);
    body = record ?? {};
  } catch {
    return errorResponse(
      400,
      "edge.request.invalid_json",
      "Invalid JSON payload",
      origin,
      correlationId,
      trace,
    );
  }

  const endpoint = resolveEndpoint(req, body);
  if (!endpoint) {
    return errorResponse(
      404,
      "edge.request.invalid_endpoint",
      "Endpoint must be parse, infer, preview, save, test_request, or test_status",
      origin,
      correlationId,
      trace,
    );
  }

  const supabaseUrl = resolveSupabaseUrl(req);
  const userClient = createUserClient(supabaseUrl, token);
  const studioResponse = async (
    status: number, payload: JsonRecord, responseOrigin: string | null,
    responseCorrelationId: string, responseTrace: { traceparent?: string; tracestate?: string | null },
  ): Promise<Response> => {
    try {
      const projected = await projectStudioPayload(userClient, payload);
      return jsonResponse(status, projected, responseOrigin, responseCorrelationId, responseTrace);
    } catch {
      const denied = status === 403 ? asRecord(payload.error) : null;
      if (denied) {
        const deniedCode = asString(denied.code);
        return errorResponse(403, /^[a-z0-9_.-]+$/i.test(deniedCode) ? deniedCode : "edge.integration_plugin_studio.capability_denied",
          "Capability denied", responseOrigin, responseCorrelationId, responseTrace);
      }
      return errorResponse(500, "edge.integration_plugin_studio.redaction_failed",
        "Studio response projection failed", responseOrigin, responseCorrelationId, responseTrace);
    }
  };

  const organizationId = maybeUuid(body.organization_id);
  let completedReview: JsonRecord | null = null;

  try {
    if (endpoint === "test_status") {
      const result = await readStudioTest({ body, userClient });
      return studioResponse(200, { ok: true, endpoint, ...result, correlation_id: correlationId }, origin, correlationId, trace);
    }
    if (endpoint === "test_request") {
      const key = readEnv("EDGE_SUPABASE_SECRET_KEY", ["SUPABASE_SECRET_KEY"]) ||
        readEnv("EDGE_SUPABASE_SERVICE_ROLE_KEY", ["SUPABASE_SERVICE_ROLE_KEY", "SERVICE_ROLE_KEY"]);
      if (!SUPABASE_URL || !key) throw createHttpError(503, "Test service unavailable", "studio.test.configuration_missing");
      const functionsBaseUrl = readEnv("EDGE_FUNCTIONS_URL",
        ["SUPABASE_FUNCTIONS_INTERNAL_URL", "SUPABASE_FUNCTIONS_URL"]) ||
        `${supabaseUrl.replace(/\/+$/g, "")}/functions/v1`;
      // Match the existing Edge secret/JWT key-plane contract. Never return this client or material.
      const privateClient = createClient(SUPABASE_URL, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        db: { schema: "api" },
      });
      const result = await submitStudioTest({ body, bearer: token, userClient,
        serviceClient: privateClient, functionsBaseUrl });
      return studioResponse(result.pending ? 202 : 400, { ok: result.pending, endpoint,
        ...result, correlation_id: correlationId }, origin, correlationId, trace);
    }
    if (endpoint === "parse") {
      await assertAnyCapability(
        userClient,
        ["integration_plugins.write", "mappings.write", "webhooks.write", "system.write"],
        organizationId,
      );

      const normalizedContract = normalizeContract(body);
      const mappingSuggestion = buildDeterministicMapping(normalizedContract);
      const draftResult = await maybeCreateDraft(userClient, body, normalizedContract, mappingSuggestion);

      return studioResponse(
        200,
        {
          ok: true,
          endpoint,
          normalized_contract: normalizedContract,
          mapping_suggestion: mappingSuggestion,
          draft: draftResult,
          correlation_id: correlationId,
        },
        origin,
        correlationId,
        trace,
      );
    }

    if (endpoint === "infer") {
      await assertAnyCapability(
        userClient,
        ["integration_plugins.write", "mappings.write", "webhooks.write", "system.write"],
        organizationId,
      );

      const normalizedContract = asRecord(body.normalized_contract)
        ? (body.normalized_contract as NormalizedContract)
        : normalizeContract(body);
      const mappingSuggestion = buildDeterministicMapping(normalizedContract);
      const outboundSuggestions = buildOutboundSuggestions(normalizedContract);
      const draftResult = await maybeCreateDraft(userClient, body, normalizedContract, mappingSuggestion);

      return studioResponse(
        200,
        {
          ok: true,
          endpoint,
          mapping_suggestion: mappingSuggestion,
          outbound_suggestions: outboundSuggestions,
          normalized_contract: normalizedContract,
          draft: draftResult,
          correlation_id: correlationId,
        },
        origin,
        correlationId,
        trace,
      );
    }

    const artifact = normalizeArtifact(body.artifact);
    if (artifact) {
      const normalizedContract = artifact === "tabular_import"
        ? null
        : (asRecord(body.normalized_contract)
          ? (body.normalized_contract as NormalizedContract)
          : normalizeContract(body));
      const mappingSuggestion = artifact === "tabular_import"
        ? (asRecord(body.mapping_config) ?? { fields: [] })
        : buildDeterministicMapping(normalizedContract as NormalizedContract);

      const directCapability = resolveDirectCapability(artifact);
      const directAllowed = directCapability
        ? await canCapability(userClient, directCapability, organizationId)
        : false;
      const draftAllowed = artifact !== "tabular_import"
        ? await canCapability(userClient, "integration_plugins.write", organizationId)
        : false;
      const requestedSaveMode = asString(body.save_mode).toLowerCase();
      const recommendedSaveMode =
        artifact === "integration_plugin"
          ? "draft"
          : requestedSaveMode === "draft" && draftAllowed
            ? "draft"
            : requestedSaveMode === "direct" && directAllowed
              ? "direct"
              : directAllowed
                ? "direct"
                : draftAllowed
                  ? "draft"
                  : null;

      // Admission precedes any private evaluator call, including save requests.
      if (endpoint !== "preview" &&
        (!recommendedSaveMode || (recommendedSaveMode === "draft" && !draftAllowed))) {
        throw createHttpError(403, "No eligible save mode is available for this user and artifact.", "mapping_studio.save.no_mode");
      }
      if (endpoint === "preview") {
        await assertAnyCapability(
          userClient,
          [
            "integration_plugins.read",
            "integration_plugins.write",
            "mappings.read",
            "mappings.write",
            "webhooks.read",
            "webhooks.write",
            "api_routes.read",
            "system.write",
          ],
          organizationId,
        );
      }
      const review = await buildStudioReview(
        userClient, body, artifact, organizationId, normalizedContract, mappingSuggestion,
      );
      completedReview = review;

      if (endpoint === "preview") {
        return studioResponse(
          200,
          {
            ok: true,
            endpoint,
            artifact,
            normalized_contract: normalizedContract,
            mapping_suggestion: mappingSuggestion,
            review,
            save_modes: {
              direct_allowed: directAllowed,
              draft_allowed: draftAllowed,
              recommended: recommendedSaveMode,
            },
            correlation_id: correlationId,
          },
          origin,
          correlationId,
          trace,
        );
      }

      if (artifact === "tabular_import" && !directAllowed) {
        const report = await persistOperationReport(
          userClient,
          buildOperationReportPayload({
            artifact,
            saveMode: "direct",
            status: "failed",
            organizationId,
            correlationId,
            review: review as JsonRecord,
            result: null,
            normalizedContract,
            errorMessage: "Direct save requires mappings.write for tabular_import.",
          }),
        ).catch(() => null);

        return studioResponse(
          400,
          {
            ok: false,
            endpoint,
            artifact,
            review,
            report,
            error: {
              code: "mapping_studio.save.capability_denied",
              message: "Direct save requires mappings.write for tabular_import.",
            },
            correlation_id: correlationId,
          },
          origin,
          correlationId,
          trace,
        );
      }

      if (!recommendedSaveMode) {
        const report = await persistOperationReport(
          userClient,
          buildOperationReportPayload({
            artifact,
            saveMode: "direct",
            status: "failed",
            organizationId,
            correlationId,
            review: review as JsonRecord,
            result: null,
            normalizedContract,
            errorMessage: "No eligible save mode is available for this user and artifact.",
          }),
        ).catch(() => null);

        return studioResponse(
          403,
          {
            ok: false,
            endpoint,
            artifact,
            review,
            report,
            error: {
              code: "mapping_studio.save.no_mode",
              message: "No eligible save mode is available for this user and artifact.",
            },
            correlation_id: correlationId,
          },
          origin,
          correlationId,
          trace,
        );
      }

      const reviewSummary = asRecord((review as JsonRecord).review_summary);
      const blockingCount = Number(reviewSummary?.blocking_count ?? 0) || 0;
      if (blockingCount > 0) {
        const report = await persistOperationReport(
          userClient,
          buildOperationReportPayload({
            artifact,
            saveMode: recommendedSaveMode as "direct" | "draft",
            status: "failed",
            organizationId,
            correlationId,
            review: review as JsonRecord,
            result: null,
            normalizedContract,
            errorMessage: "Submit blocked by review diagnostics.",
          }),
        ).catch(() => null);

        return studioResponse(
          400,
          {
            ok: false,
            endpoint,
            artifact,
            review,
            report,
            error: {
              code: "mapping_studio.review.blocked",
              message: "Submit blocked by review diagnostics.",
            },
            correlation_id: correlationId,
          },
          origin,
          correlationId,
          trace,
        );
      }

      let saveResult: JsonRecord | null = null;
      if (recommendedSaveMode === "direct") {
        const { data, error } = await userClient.rpc("ui_upsert_mapping_artifact_v1", {
          p_artifact: {
            ...body,
            artifact,
            organization_id: organizationId,
            mapping_config: (review as JsonRecord).mapping_config ?? mappingSuggestion,
            normalized_contract: normalizedContract,
          },
        });
        if (error) {
          throw new Error(error.message || "Direct mapping artifact save failed");
        }
        saveResult = asRecord(data);
      } else {
        if (!normalizedContract) {
          throw new Error("Draft save requires a normalized contract");
        }
        saveResult = await maybeCreateDraft(
          userClient,
          {
            ...body,
            organization_id: organizationId,
            persist_draft: true,
            mapping_config: (review as JsonRecord).mapping_config ?? mappingSuggestion,
          },
          normalizedContract,
          mappingSuggestion,
          review as JsonRecord,
        );
      }

      const report = await persistOperationReport(
        userClient,
        buildOperationReportPayload({
          artifact,
          saveMode: recommendedSaveMode as "direct" | "draft",
          status: "succeeded",
          organizationId,
          correlationId,
          review: review as JsonRecord,
          result: saveResult,
          normalizedContract,
        }),
      );

      return studioResponse(
        200,
        {
          ok: true,
          endpoint,
          artifact,
          save_mode: recommendedSaveMode,
          normalized_contract: normalizedContract,
          review,
          result: saveResult,
          report,
          correlation_id: correlationId,
        },
        origin,
        correlationId,
        trace,
      );
    }

    await assertCapability(userClient, "integration_plugins.test", organizationId);

    let pluginVersionId = maybeUuid(body.plugin_version_id);
    let draftResult: JsonRecord | null = null;

    if (!pluginVersionId) {
      const normalizedContract = asRecord(body.normalized_contract)
        ? (body.normalized_contract as NormalizedContract)
        : normalizeContract(body);
      const mappingSuggestion = buildDeterministicMapping(normalizedContract);
      draftResult = await maybeCreateDraft(
        userClient,
        {
          ...body,
          persist_draft: true,
        },
        normalizedContract,
        mappingSuggestion,
      );

      pluginVersionId = maybeUuid(draftResult?.plugin_version_id ?? draftResult?.version_id);
    }

    if (!pluginVersionId) {
      throw new Error("preview requires plugin_version_id or enough payload to create a draft version");
    }

    const { data: validationResult, error: validationError } = await userClient.rpc("integration_plugin_validate_v1", {
      p_plugin_version_id: pluginVersionId,
      p_preview_payload: asRecord(body.preview_payload) ?? {},
      p_allow_external_side_effects: parseBoolean(body.allow_external_side_effects, false),
    });

    if (validationError) {
      throw new Error(validationError.message || "Failed to validate plugin version");
    }

    return studioResponse(
      200,
      {
        ok: true,
        endpoint,
        plugin_version_id: pluginVersionId,
        validation: validationResult,
        draft: draftResult,
        correlation_id: correlationId,
      },
      origin,
      correlationId,
      trace,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    const status = getHttpErrorStatus(error);
    const code = getHttpErrorCode(error);
    const artifact = normalizeArtifact(body.artifact);
    if (code === "edge.auth.invalid_token") {
      return errorResponse(status, code, "Invalid authentication token", origin, correlationId, trace);
    }
    logStructured("warn", "edge.integration_plugin_studio.failed", {
      service: SERVICE_NAME,
      correlation_id: correlationId,
      trace_id: trace.trace_id,
      endpoint,
      status,
      code,
      error: "Studio request failed",
    });

    if (artifact && completedReview && endpoint !== "test_request" && endpoint !== "test_status") {
      try {
        const normalizedContract = artifact === "tabular_import"
          ? null
          : (asRecord(body.normalized_contract)
            ? (body.normalized_contract as NormalizedContract)
            : normalizeContract(body));
        await persistOperationReport(
          userClient,
          buildOperationReportPayload({
            artifact,
            saveMode: (asString(body.save_mode).toLowerCase() === "draft" ? "draft" : "direct"),
            status: "failed",
            organizationId,
            correlationId,
            review: completedReview,
            result: null,
            normalizedContract,
            errorMessage: message,
          }),
        );
      } catch (_persistError) {
        // Best effort only; report persistence must never hide the original failure.
      }
    }

    return studioResponse(status, buildErrorEnvelope({ status, code, message,
      correlationId, traceId: trace.trace_id ?? null,
      details: getHttpErrorDetails(error, { endpoint }),
    }), origin, correlationId, trace);
  }
});

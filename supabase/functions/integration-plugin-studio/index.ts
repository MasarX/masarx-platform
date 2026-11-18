import {
  buildErrorEnvelope,
  extractToken,
  logStructured,
  parseRequestBody,
  readEnv,
  resolveCorrelationId,
  resolveTraceContext,
  toResponseBody,
} from "../_shared/mod.mjs";

type JsonRecord = Record<string, unknown>;
type EdgeRpcError = {
  message?: string | null;
  code?: string | null;
  details?: unknown;
  hint?: string | null;
  status?: number | null;
};
type EdgeRpcResult = { data: unknown | null; error: EdgeRpcError | null };
type EdgeSupabaseClient = {
  rpc: (fn: string, args?: JsonRecord) => PromiseLike<EdgeRpcResult>;
};
type StudioEndpoint = "parse" | "infer" | "preview" | "save";
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
const LOCAL_EDGE_SUPABASE_HOSTS = new Set(["kong"]);

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
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    return text;
  }
  return null;
};

const parseBoolean = (value: unknown, fallback = false): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
};

const SENSITIVE_KEY_PATTERN =
  /(?:authorization|api[_-]?key|apikey|credential|password|private[_-]?key|secret|signature|token)/i;

const redactSensitiveText = (value: string): string => {
  return value
    .replace(/("[^"]*(?:authorization|x-api-key|api[_-]?key|apikey|credential|password|private[_-]?key|secret|signature|token)[^"]*"\s*:\s*")[^"]*(")/gi, "$1REDACTED$2")
    .replace(/(bearer\s+)[^\s"',;]+/gi, "$1REDACTED")
    .replace(/(basic\s+)[^\s"',;]+/gi, "$1REDACTED")
    .replace(/((?:authorization|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|signature)\s*[:=]\s*)[^&\r\n"',;}]+/gi, "$1REDACTED")
    .replace(/([?&](?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|signature|password)=)[^&\s"']+/gi, "$1REDACTED");
};

const redactSensitiveValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValue(entry));
  const record = asRecord(value);
  if (record) {
    const redacted: JsonRecord = {};
    for (const [key, entry] of Object.entries(record)) {
      redacted[key] = SENSITIVE_KEY_PATTERN.test(key) ? "REDACTED" : redactSensitiveValue(entry);
    }
    return redacted;
  }
  if (typeof value === "string") return redactSensitiveText(value);
  return value;
};

const redactRecord = (value: unknown): JsonRecord => asRecord(redactSensitiveValue(value)) ?? {};

const redactNormalizedContract = (value: NormalizedContract): NormalizedContract =>
  redactSensitiveValue(value) as NormalizedContract;

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

const rpcErrorFromResponse = (status: number, body: unknown): EdgeRpcError => {
  const record = asRecord(body);
  const message =
    asString(record?.message) ||
    asString(record?.error) ||
    asString(record?.msg) ||
    (typeof body === "string" ? body : "") ||
    `RPC request failed with HTTP ${status}`;

  return {
    message,
    code: asString(record?.code) || null,
    details: record?.details ?? null,
    hint: asString(record?.hint) || null,
    status,
  };
};

const createEdgeSupabaseClient = (
  supabaseUrl: string,
  supabaseAnonKey: string,
  token: string,
): EdgeSupabaseClient => {
  const baseUrl = supabaseUrl.replace(/\/+$/g, "");

  return {
    rpc: async (fn: string, args: JsonRecord = {}): Promise<EdgeRpcResult> => {
      try {
        const response = await fetch(`${baseUrl}/rest/v1/rpc/${encodeURIComponent(fn)}`, {
          method: "POST",
          headers: {
            accept: "application/json",
            "accept-profile": "api",
            apikey: supabaseAnonKey,
            authorization: `Bearer ${token}`,
            "content-profile": "api",
            "content-type": "application/json",
          },
          body: JSON.stringify(args ?? {}),
        });
        const data = await toResponseBody(response);
        if (!response.ok) {
          return { data: null, error: rpcErrorFromResponse(response.status, data) };
        }
        return { data, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : "RPC request failed";
        return {
          data: null,
          error: {
            message,
            code: "edge.rpc.fetch_failed",
            status: null,
          },
        };
      }
    },
  };
};

const resolveEndpoint = (req: Request, body: JsonRecord): StudioEndpoint | null => {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const index = parts.indexOf("integration-plugin-studio");
  if (index >= 0 && parts.length > index + 1) {
    const maybeEndpoint = (parts[index + 1] || "").toLowerCase();
    if (maybeEndpoint === "parse" || maybeEndpoint === "infer" || maybeEndpoint === "preview" || maybeEndpoint === "save") {
      return maybeEndpoint;
    }
  }

  const action = asString(body.action).toLowerCase();
  if (action === "parse" || action === "infer" || action === "preview" || action === "save") return action;
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
      headers: redactRecord(headers) as Record<string, string>,
      body_sample: redactSensitiveValue(body),
    },
    sample_schema: inferSchemaShape(redactSensitiveValue(body)),
    metadata: {
      source_url: `${parsed.protocol}//${parsed.host}`,
      query_string: redactSensitiveText(parsed.searchParams.toString()),
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
    sample_schema: inferSchemaShape(redactSensitiveValue(document)),
    metadata: {
      server_url: serverUrl ? redactSensitiveText(serverUrl) : null,
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

const normalizeMappingPath = (path: string | null): string | null => {
  if (!path) return null;
  return path.replace(/^\$\./, "").replace(/^\$/, "");
};

const buildWebhookShipmentTransforms = (paths: string[]): JsonRecord => {
  const pick = (keywords: string[]) => normalizeMappingPath(pickPathByKeywords(paths, keywords));
  const pickWithFallback = (keywords: string[], fallback: string | string[]) => {
    const selected = pick(keywords);
    const fallbacks = Array.isArray(fallback) ? fallback : [fallback];
    if (!selected) return fallback;
    return [selected, ...fallbacks.filter((candidate) => candidate !== selected)];
  };

  return {
    shipment: {
      tracking_number: pickWithFallback(
        ["tracking_number", "tracking", "waybill", "awb", "barcode"],
        ["shipment.tracking_number", "tracking_number", "awb", "waybill", "barcode"],
      ),
      external_id: pickWithFallback(
        ["shipment.external_id", "external_id", "shipment.reference", "reference", "ref"],
        ["shipment.external_id", "shipment.reference", "external_id", "id", "reference"],
      ),
      reference_number: pickWithFallback(
        ["shipment.reference_number", "reference_number", "shipment.reference", "reference", "ref"],
        ["shipment.reference_number", "shipment.reference", "reference_number", "reference"],
      ),
      service_type: pickWithFallback(["service_type", "shipment_type"], ["shipment.service_type", "service_type"]),
      service_level: pickWithFallback(["service_level", "shipping_service"], ["shipment.service_level", "service_level"]),
      cod_amount: pickWithFallback(["cod_amount", "cash_on_delivery_amount", "amount"], ["shipment.cod_amount", "cod_amount"]),
      currency: pickWithFallback(["cod_currency", "currency"], ["shipment.cod_currency", "currency"]),
    },
    recipient: {
      external_id: pickWithFallback(
        ["recipient.external_id", "recipient_id", "customer_id"],
        ["shipment.recipient.external_id", "recipient.external_id", "customer.external_id"],
      ),
      name: pickWithFallback(
        ["recipient.name", "customer.name", "customer_name", "name"],
        ["Example Entity ntvplorhukthpmnmvgrstqzp", "recipient.name", "customer.name", "customer_name"],
      ),
      phone: pickWithFallback(
        ["recipient.phone", "customer.phone", "phone_number", "phone", "mobile", "msisdn"],
        ["shipment.recipient.phone", "recipient.phone", "customer.phone", "phone", "mobile"],
      ),
      email: pickWithFallback(
        ["recipient.email", "customer.email", "email"],
        ["shipment.recipient.email", "recipient.email", "customer.email", "email"],
      ),
    },
    address: {
      line1: pickWithFallback(
        ["destination.line1", "address.line1", "line1", "address_line_1"],
        ["shipment.destination.line1", "destination.line1", "address.line1", "line1", "address_line_1"],
      ),
      line2: pickWithFallback(
        ["destination.line2", "address.line2", "line2", "address_line_2"],
        ["shipment.destination.line2", "destination.line2", "address.line2", "line2", "address_line_2"],
      ),
      district: pickWithFallback(
        ["destination.district", "address.district", "district"],
        ["shipment.destination.district", "destination.district", "address.district", "district"],
      ),
      city: pickWithFallback(
        ["destination.city", "address.city", "city"],
        ["shipment.destination.city", "destination.city", "address.city", "city"],
      ),
      province: pickWithFallback(
        ["destination.province", "address.province", "province", "region"],
        ["shipment.destination.province", "destination.province", "address.province", "province", "region"],
      ),
      country_code: pickWithFallback(
        ["country_code", "destination.country", "address.country", "country"],
        ["shipment.destination.country", "destination.country", "address.country", "country_code", "country"],
      ),
      lat: pickWithFallback(
        ["destination.lat", "address.lat", "latitude", "lat"],
        ["shipment.destination.lat", "destination.lat", "address.lat", "latitude", "lat"],
      ),
      lng: pickWithFallback(
        ["destination.lng", "address.lng", "longitude", "lng"],
        ["shipment.destination.lng", "destination.lng", "address.lng", "longitude", "lng"],
      ),
    },
  };
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
    const openapiPayload =
      sourceRecord && !asRecord(sourceRecord.paths)
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
        sample_payload: redactSensitiveValue(samplePayload),
        source_identifier: record ? asString(record.source_identifier) || undefined : undefined,
        name: record ? asString(record.name) || undefined : undefined,
      },
      sample_schema: inferSchemaShape(redactSensitiveValue(samplePayload)),
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
          headers: asRecord(redactSensitiveValue(route.headers)) as Record<string, string> | undefined,
          body_sample: redactSensitiveValue(route.body_sample ?? {}),
        },
        sample_schema: inferSchemaShape(redactSensitiveValue(route.body_sample ?? {})),
        metadata: {},
      };
    }

    return {
      source_type: sourceType,
      plugin_kind: explicitKind === "api" ? "api" : "webhook",
      webhook: {
        sample_payload: redactSensitiveValue(webhook?.sample_payload ?? {}),
        source_identifier: asString(webhook?.source_identifier) || undefined,
        name: asString(webhook?.name) || undefined,
      },
      sample_schema: inferSchemaShape(redactSensitiveValue(webhook?.sample_payload ?? {})),
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
  const candidates = [
    asString(contract.metadata?.source_url),
    asString(contract.metadata?.server_url),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.origin.replace(/\/+$/g, "");
      }
    } catch (_err) {
      continue;
    }
  }

  return "";
};

const buildOutboundSuggestions = (contract: NormalizedContract): JsonRecord[] => {
  if (contract.plugin_kind !== "api") return [];
  const providerBaseUrl = resolveProviderBaseUrl(contract);
  const upstreamPath = contract.route?.upstream_path_template || contract.route?.path_template || "/";
  const normalizedPath = upstreamPath.startsWith("/") ? upstreamPath : `/${upstreamPath}`;
  const urlTemplate = providerBaseUrl
    ? `${providerBaseUrl}${normalizedPath}`
    : "https://example-provider.invalid{{path}}".replace("{{path}}", contract.route?.path_template || "/");

  return [
    {
      operation_name: "forward_event",
      method: contract.route?.method || "POST",
      url_template: urlTemplate,
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
    return record?.[key];
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
  return (
    lowered.includes("token") ||
    lowered.includes("secret") ||
    lowered.includes("password") ||
    lowered.includes("apikey") ||
    lowered.includes("api_key") ||
    lowered.includes("authorization")
  );
};

const collectSecretDiagnostics = (
  value: unknown,
  prefix: string,
  diagnostics: MappingDiagnostic[],
) => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectSecretDiagnostics(entry, `${prefix}[${index}]`, diagnostics));
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  for (const [key, entry] of Object.entries(record)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (containsSecretLikeKey(key)) {
      diagnostics.push({
        level: "warning",
        blocking: false,
        code: "secret_like_value_detected",
        fieldPath: path,
        message: `Potential secret-like value detected at ${path}.`,
        why: "Samples and saved reports are redacted, but embedded credentials should still be moved to credential bindings or auth configuration.",
        recommended_fix: "Remove the inline secret from the sample/config and use a credential binding or auth-specific field.",
      });
    }
    collectSecretDiagnostics(entry, path, diagnostics);
  }
};

const isPrivateOrLocalHost = (host: string): boolean => {
  const lowered = host.toLowerCase();
  if (lowered === "localhost" || lowered.endsWith(".local")) return true;
  if (/^127\./.test(lowered) || /^10\./.test(lowered) || /^192\.168\./.test(lowered)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(lowered)) return true;
  return false;
};

const jsonTextArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

const hostMatchesPattern = (host: string, pattern: string): boolean => {
  const loweredHost = host.toLowerCase();
  const loweredPattern = pattern.trim().toLowerCase();
  if (!loweredPattern) return false;
  if (loweredPattern.startsWith("*.")) {
    const suffix = loweredPattern.slice(1);
    return loweredHost.endsWith(suffix) && loweredHost.length > suffix.length;
  }
  if (loweredPattern.startsWith(".")) {
    return loweredHost.endsWith(loweredPattern) || loweredHost === loweredPattern.slice(1);
  }
  return loweredHost === loweredPattern;
};

const hostMatchesAnyPattern = (host: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => hostMatchesPattern(host, pattern));

const reviewSummaryOf = (review: JsonRecord | null | undefined): JsonRecord => {
  return asRecord(review?.review_summary) ?? {};
};

const pushDiagnostic = (
  diagnostics: MappingDiagnostic[],
  diagnostic: MappingDiagnostic,
) => {
  diagnostics.push(diagnostic);
};

const buildStudioReview = async (
  userClient: EdgeSupabaseClient,
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
  const fieldRules = normalizeFieldRules(mappingConfig);
  const tabularSource = asRecord(body.source_payload);
  const tabularSample = Array.isArray(tabularSource?.sample_rows) && tabularSource.sample_rows.length > 0
    ? tabularSource.sample_rows[0]
    : null;
  const sampleSource = artifact === "tabular_import"
    ? tabularSample
    : normalizedContract?.plugin_kind === "api"
      ? normalizedContract.route?.body_sample ?? {}
      : normalizedContract?.webhook?.sample_payload ?? {};

  let egressPreview: JsonRecord | null = null;
  try {
    const { data, error } = await userClient.rpc("integration_plugin_egress_policy_preview_v1", {
      p_organization_id: organizationId,
    });
    if (!error) {
      egressPreview = asRecord(data);
    }
  } catch (_error) {
    egressPreview = null;
  }
  const egressPolicy = asRecord((egressPreview as JsonRecord | null)?.value);
  const egressResolutionId = asString((egressPreview as JsonRecord | null)?.settings_resolution_id) || null;
  const domainDenylist = jsonTextArray(egressPolicy?.domain_denylist);
  const domainAllowlist = jsonTextArray(egressPolicy?.domain_allowlist);
  const headersAllowlist = Array.isArray(egressPolicy?.headers_allowlist)
    ? egressPolicy?.headers_allowlist.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.toLowerCase())
    : Array.isArray(egressPolicy?.header_allowlist)
      ? egressPolicy?.header_allowlist.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.toLowerCase())
      : [];

  collectSecretDiagnostics(sampleSource, "sample", diagnostics);
  collectSecretDiagnostics(requestConfig, "request_config", diagnostics);

  const coercedPreview: JsonRecord = {};
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
    const rawValue = rule.sample_value ?? readPathValue(sampleSource, sourcePath || null);
    const propertySchema = properties[targetField] ?? null;
    const coerced = coerceValueToSchema(rawValue, propertySchema);
    coercedPreview[targetField] = coerced.value;
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
        if (schemaType !== "array" && rawType !== nextType && coercions.every((entry) => entry.target_field !== targetField)) {
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

  const outboundRequestConfigs: Array<{ config: JsonRecord; fieldPrefix: string }> = [];
  if (artifact === "api_outbound") {
    outboundRequestConfigs.push({
      config: {
        ...requestConfig,
        url_template: requestConfig.url_template ?? body.url_template,
      },
      fieldPrefix: "request_config",
    });
  }
  if (artifact === "integration_plugin" && normalizedContract?.plugin_kind === "api") {
    const operationRows = Array.isArray(body.outbound_operations)
      ? body.outbound_operations.map((entry) => asRecord(entry)).filter((entry): entry is JsonRecord => Boolean(entry))
      : buildOutboundSuggestions(normalizedContract);
    if (operationRows.length === 0) {
      pushDiagnostic(diagnostics, {
        level: "error",
        blocking: true,
        code: "outbound_operation_required",
        fieldPath: "outbound_operations",
        message: "API plugins require at least one outbound operation.",
        why: "Activated API plugins need a concrete provider request target.",
        recommended_fix: "Add a provider outbound operation before saving the plugin.",
        source_policy: "integration_plugin_egress_policy",
        settings_resolution_id: egressResolutionId,
      });
    }
    operationRows.forEach((operation, index) => {
      outboundRequestConfigs.push({
        config: operation,
        fieldPrefix: `outbound_operations[${index}]`,
      });
    });
  }

  if (outboundRequestConfigs.length > 0 && !egressPolicy) {
    pushDiagnostic(diagnostics, {
      level: "error",
      blocking: true,
      code: "egress_policy_unavailable",
      fieldPath: "integration_plugin_egress_policy",
      message: "Outbound egress policy could not be resolved.",
      why: "API plugin authoring must be governed by tenant egress policy before save or activation.",
      recommended_fix: "Configure integration_plugin_egress_policy for this tenant and retry preview.",
      source_policy: "integration_plugin_egress_policy",
      settings_resolution_id: egressResolutionId,
    });
  }

  for (const outbound of outboundRequestConfigs) {
    const urlTemplate = asString(outbound.config.url_template);
    if (urlTemplate) {
      try {
        const parsed = new URL(urlTemplate);
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
        if (hostMatchesAnyPattern(parsed.hostname, domainDenylist)) {
          pushDiagnostic(diagnostics, {
            level: "error",
            blocking: true,
            code: "egress_placeholder_host_blocked",
            fieldPath: `${outbound.fieldPrefix}.url_template`,
            message: `Placeholder or reserved provider host is blocked (${parsed.hostname}).`,
            why: "Plugin Studio samples must be replaced before an API plugin can be saved or activated.",
            recommended_fix: "Replace the sample URL with the provider's real HTTPS endpoint.",
            source_policy: "integration_plugin_egress_policy",
            settings_resolution_id: egressResolutionId,
          });
        }
        if (domainAllowlist.length > 0 && !hostMatchesAnyPattern(parsed.hostname, domainAllowlist)) {
          pushDiagnostic(diagnostics, {
            level: "error",
            blocking: true,
            code: "egress_domain_not_allowlisted",
            fieldPath: `${outbound.fieldPrefix}.url_template`,
            message: `Provider host is not in the egress allowlist (${parsed.hostname}).`,
            why: "The tenant egress policy restricts outbound plugin traffic to approved hosts.",
            recommended_fix: "Choose an approved provider host or update the egress policy through governance.",
            source_policy: "integration_plugin_egress_policy",
            settings_resolution_id: egressResolutionId,
          });
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
    }

    const headersTemplate = asRecord(outbound.config.headers_template);
    if (headersTemplate && headersAllowlist.length > 0) {
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
  userClient: EdgeSupabaseClient,
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
  userClient: EdgeSupabaseClient,
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
  userClient: EdgeSupabaseClient,
  report: JsonRecord,
) => {
  const { data, error } = await userClient.rpc("ui_create_mapping_operation_report_v1", {
    p_report: redactRecord(report),
  });
  if (error) {
    throw new Error(error.message || "Failed to persist mapping operation report");
  }
  return asRecord(data);
};

const assertCapability = async (
  userClient: EdgeSupabaseClient,
  capabilityKey: string,
  organizationId: string | null,
) => {
  const { error } = await userClient.rpc("assert_capability_v1", {
    p_capability_key: capabilityKey,
    p_scope_type: organizationId ? "tenant" : null,
    p_scope_id: organizationId,
  });

  if (error) {
    throw new Error(error.message || `Capability denied: ${capabilityKey}`);
  }
};

const maybeCreateDraft = async (
  userClient: EdgeSupabaseClient,
  body: JsonRecord,
  normalizedContract: NormalizedContract,
  mappingSuggestion: JsonRecord,
  correlationId: string,
): Promise<JsonRecord | null> => {
  if (!parseBoolean(body.persist_draft, false)) return null;

  const pluginName = asString(body.plugin_name) || `Integration Plugin ${new Date().toISOString()}`;
  const safeNormalizedContract = redactNormalizedContract(normalizedContract);
  const safeMappingSuggestion = redactRecord(mappingSuggestion);
  const pluginKind = safeNormalizedContract.plugin_kind;
  const organizationId = maybeUuid(body.organization_id);

  const { data, error } = await userClient.rpc("integration_plugin_generate_draft_v1", {
    p_plugin_name: pluginName,
    p_plugin_kind: pluginKind,
    p_source_type: safeNormalizedContract.source_type,
    p_source_payload: redactSensitiveValue(asRecord(body.source_payload) ?? body.source_payload ?? {}),
    p_inbound_config: redactRecord(asRecord(body.inbound_config) ?? buildInboundConfigFromContract(safeNormalizedContract)),
    p_mapping_config: redactRecord(asRecord(body.mapping_config) ?? safeMappingSuggestion),
    p_workflow_binding: asRecord(body.workflow_binding) ?? {},
    p_outbound_operations: Array.isArray(body.outbound_operations)
      ? redactSensitiveValue(body.outbound_operations)
      : redactSensitiveValue(buildOutboundSuggestions(safeNormalizedContract)),
    p_plugin_id: maybeUuid(body.plugin_id),
    p_plugin_key: asString(body.plugin_key) || null,
    p_description: asString(body.description) || null,
    p_organization_id: organizationId,
    p_metadata: redactRecord({
      managed_by: "integration_plugin_studio_edge",
      endpoint: "integration-plugin-studio",
      created_at: new Date().toISOString(),
      correlation_id: correlationId,
      normalized_contract: safeNormalizedContract,
    }),
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
  const reviewSummary = reviewSummaryOf(params.review);
  const reviewCoercions = Array.isArray(params.review?.coercions) ? params.review.coercions : [];
  const reviewDiagnostics = Array.isArray(params.review?.diagnostics) ? params.review.diagnostics : [];
  const nextSteps =
    Array.isArray(reviewSummary.next_steps)
      ? reviewSummary.next_steps
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

  const payload: JsonRecord = {
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
    conversion_summary: Object.keys(reviewSummary).length > 0
      ? {
          coercion_count: reviewSummary.coercion_count ?? 0,
          coercions: reviewCoercions,
        }
      : {},
    diagnostics_summary: params.review
      ? {
          blocking_count: reviewSummary.blocking_count ?? 0,
          warning_count: reviewSummary.warning_count ?? 0,
          diagnostics: reviewDiagnostics,
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
      egress_policy_resolution_id: reviewSummary.egress_policy_resolution_id ?? null,
    },
    next_steps: nextSteps,
  };

  return redactRecord(payload);
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
  } catch (error) {
    return errorResponse(
      400,
      "edge.request.invalid_json",
      error instanceof Error ? error.message : "Invalid JSON payload",
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
      "Endpoint must be parse, infer, preview, or save",
      origin,
      correlationId,
      trace,
    );
  }

  const supabaseUrl = resolveSupabaseUrl(req);
  const userClient = await createEdgeSupabaseClient(supabaseUrl, SUPABASE_ANON_KEY, token);

  const organizationId = maybeUuid(body.organization_id);

  try {
    if (endpoint === "parse") {
      await assertAnyCapability(
        userClient,
        ["integration_plugins.write", "mappings.write", "webhooks.write", "system.write"],
        organizationId,
      );

      const normalizedContract = redactNormalizedContract(normalizeContract(body));
      const mappingSuggestion = redactRecord(buildDeterministicMapping(normalizedContract));
      const draftResult = await maybeCreateDraft(userClient, body, normalizedContract, mappingSuggestion, correlationId);

      return jsonResponse(
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

      const normalizedContract = redactNormalizedContract(asRecord(body.normalized_contract)
        ? (body.normalized_contract as NormalizedContract)
        : normalizeContract(body));
      const mappingSuggestion = redactRecord(buildDeterministicMapping(normalizedContract));
      const outboundSuggestions = redactSensitiveValue(buildOutboundSuggestions(normalizedContract)) as JsonRecord[];
      const draftResult = await maybeCreateDraft(userClient, body, normalizedContract, mappingSuggestion, correlationId);

      return jsonResponse(
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
        : redactNormalizedContract(asRecord(body.normalized_contract)
          ? (body.normalized_contract as NormalizedContract)
          : normalizeContract(body));
      const mappingSuggestion = artifact === "tabular_import"
        ? redactRecord(asRecord(body.mapping_config) ?? { fields: [] })
        : redactRecord(buildDeterministicMapping(normalizedContract as NormalizedContract));
      const review = redactRecord(await buildStudioReview(
        userClient,
        body,
        artifact,
        organizationId,
        normalizedContract,
        mappingSuggestion,
      ));

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

        return jsonResponse(
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

        return jsonResponse(
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

        return jsonResponse(
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

        return jsonResponse(
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
          p_artifact: redactRecord({
            ...body,
            artifact,
            organization_id: organizationId,
            mapping_config: (review as JsonRecord).mapping_config ?? mappingSuggestion,
          }),
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
          correlationId,
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

      return jsonResponse(
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
      const normalizedContract = redactNormalizedContract(asRecord(body.normalized_contract)
        ? (body.normalized_contract as NormalizedContract)
        : normalizeContract(body));
      const mappingSuggestion = redactRecord(buildDeterministicMapping(normalizedContract));
      draftResult = await maybeCreateDraft(
        userClient,
        {
          ...body,
          persist_draft: true,
        },
        normalizedContract,
        mappingSuggestion,
        correlationId,
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

    return jsonResponse(
      200,
      {
        ok: true,
        endpoint,
        plugin_version_id: pluginVersionId,
        validation: redactSensitiveValue(validationResult),
        draft: draftResult,
        correlation_id: correlationId,
      },
      origin,
      correlationId,
      trace,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    const artifact = normalizeArtifact(body.artifact);
    logStructured("warn", "edge.integration_plugin_studio.failed", {
      service: SERVICE_NAME,
      correlation_id: correlationId,
      trace_id: trace.trace_id,
      endpoint,
      error: message,
    });

    if (artifact) {
      try {
        const normalizedContract = artifact === "tabular_import"
          ? null
          : redactNormalizedContract(asRecord(body.normalized_contract)
            ? (body.normalized_contract as NormalizedContract)
            : normalizeContract(body));
        const mappingSuggestion = artifact === "tabular_import"
          ? redactRecord(asRecord(body.mapping_config) ?? { fields: [] })
          : redactRecord(buildDeterministicMapping(normalizedContract as NormalizedContract));
        const review = redactRecord(await buildStudioReview(
          userClient,
          body,
          artifact,
          organizationId,
          normalizedContract,
          mappingSuggestion,
        ));
        await persistOperationReport(
          userClient,
          buildOperationReportPayload({
            artifact,
            saveMode: (asString(body.save_mode).toLowerCase() === "draft" ? "draft" : "direct"),
            status: "failed",
            organizationId,
            correlationId,
            review: review as JsonRecord,
            result: null,
            normalizedContract,
            errorMessage: message,
          }),
        );
      } catch (_persistError) {
        // Best effort only; report persistence must never hide the original failure.
      }
    }

    return errorResponse(
      400,
      "edge.integration_plugin_studio.failed",
      message,
      origin,
      correlationId,
      trace,
      { endpoint },
    );
  }
});

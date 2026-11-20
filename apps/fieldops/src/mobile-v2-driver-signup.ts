import type { MobileV2SignupRoleOption } from "./mobile-v2-signup-screen";

export const MOBILE_V2_DRIVER_SIGNUP_LOCAL_TURNSTILE_TOKEN = "EXAMPLE_PASSWORD";

export type MobileV2DriverSignupDraft = {
  readonly email: string;
  readonly fullName: string;
  readonly phone: string;
  readonly organizationName: string;
  readonly employeeOrContractorId: string;
  readonly selectedRoleIds: ReadonlyArray<string>;
};

export type MobileV2DriverSignupEndpoints = {
  readonly signupEndpoint: string;
  readonly statusEndpoint: string;
};

export type MobileV2DriverSignupResult = {
  readonly id: string;
  readonly status: string;
  readonly deduped: boolean;
  readonly dedupeReason: string;
  readonly applicationStatusToken: string;
};

export type MobileV2DriverApplicationStatus = {
  readonly status: string;
  readonly applicationState: string;
  readonly participantTypeKey: string;
  readonly reviewDecision: string;
  readonly reviewedAt: string;
  readonly inviteEmailSentAt: string;
  readonly inviteRedirectTo: string;
  readonly reviewReason: string;
  readonly requestedDocuments: ReadonlyArray<string>;
  readonly profileHandoff: {
    readonly ready: boolean;
    readonly organizationId: string;
    readonly userId: string;
    readonly participantProfileId: string;
    readonly driverProfileId: string;
    readonly fleetDriverStatus: string;
    readonly fleetHandoffReady: boolean;
    readonly fleetDocumentCount: number;
    readonly fleetComplianceEventCount: number;
    readonly inviteRedirectTo: string;
    readonly inviteEmailSentAt: string;
  };
};

export type MobileV2DriverApplicationFollowUp = {
  readonly title: string;
  readonly tone: "danger" | "warning" | "info";
  readonly reason: string;
  readonly requestedDocuments: ReadonlyArray<string>;
};

type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

type JsonRecord = Record<string, unknown>;

const DEFAULT_ROLE_OPTIONS: ReadonlyArray<MobileV2SignupRoleOption> = Object.freeze([
  Object.freeze({
    id: "last_mile_driver",
    icon: "truck" as const,
    label: "Last-mile driver",
    sub: "Route delivery, POD, COD",
  }),
]);

const DEFAULT_DRIVER_SIGNUP_REQUEST_TIMEOUT_MS = 15000;

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function asNonNegativeInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function parseJson(text: string): JsonRecord {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const value = JSON.parse(trimmed);
    return asRecord(value);
  } catch {
    return {};
  }
}

function trimTrailingSlashes(value: string) {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end--;
  }
  return value.slice(0, end);
}

function normalizeUrl(value: unknown): string {
  const raw = trim(value);
  if (!raw) return "";
  try {
    return trimTrailingSlashes(new URL(raw).toString());
  } catch {
    return "";
  }
}

function originFromUrl(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function buildFunctionEndpoint(baseUrl: string, fnName: string): string {
  const normalized = normalizeUrl(baseUrl);
  if (!normalized) return "";
  return `${normalized}/functions/v1/${fnName}`;
}

function readJsonString(record: JsonRecord, key: string): string {
  return trim(record[key]);
}

function normalizeRoleOption(value: unknown): MobileV2SignupRoleOption | null {
  const record = asRecord(value);
  const id = readJsonString(record, "id");
  const label = readJsonString(record, "label");
  const sub = readJsonString(record, "sub");
  const icon = readJsonString(record, "icon") || "truck";
  if (!id || !label || !sub) return null;
  return {
    id,
    label,
    sub,
    icon: icon as MobileV2SignupRoleOption["icon"],
  };
}

export function parseMobileV2DriverSignupRoleOptions(
  raw: string | null | undefined,
): ReadonlyArray<MobileV2SignupRoleOption> {
  const text = trim(raw);
  if (!text) return DEFAULT_ROLE_OPTIONS;

  try {
    const parsed = JSON.parse(text);
    const source = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.roles) ? parsed.roles : [];
    const roles = source
      .map((item: unknown) => normalizeRoleOption(item))
      .filter((item: MobileV2SignupRoleOption | null): item is MobileV2SignupRoleOption => item !== null);
    return roles.length ? Object.freeze(roles) : DEFAULT_ROLE_OPTIONS;
  } catch {
    return DEFAULT_ROLE_OPTIONS;
  }
}

export function resolveMobileV2DriverSignupEndpoints(input: {
  readonly supabaseUrl: string;
  readonly supabaseFunctionsUrl?: string | null;
  readonly signupEndpoint?: string | null;
  readonly statusEndpoint?: string | null;
}): MobileV2DriverSignupEndpoints {
  const functionsBase =
    normalizeUrl(input.supabaseFunctionsUrl) ||
    buildFunctionEndpoint(input.supabaseUrl, "").replace(/\/functions\/v1\/?$/g, "/functions/v1");

  return {
    signupEndpoint:
      normalizeUrl(input.signupEndpoint) ||
      (functionsBase ? `${functionsBase}/driver-signup-intake` : ""),
    statusEndpoint:
      normalizeUrl(input.statusEndpoint) ||
      (functionsBase ? `${functionsBase}/driver-application-status` : ""),
  };
}

export function resolveMobileV2DriverSignupOrigin(input: {
  readonly configuredOrigin?: string | null;
  readonly signupEndpoint: string;
  readonly supabaseUrl: string;
}): string {
  return originFromUrl(normalizeUrl(input.configuredOrigin)) ||
    originFromUrl(input.signupEndpoint) ||
    originFromUrl(input.supabaseUrl);
}

export function shouldUseLocalDriverSignupTurnstileToken(input: {
  readonly endpoint: string;
  readonly origin: string;
}): boolean {
  const candidates = [input.endpoint, input.origin];
  return candidates.some((candidate) => {
    try {
      const parsed = new URL(candidate);
      return ["127.0.0.1", "localhost", "192.0.2.10", "rvzwwjlztwwisjthghnipgjr.example.invalid"].includes(
        parsed.hostname.toLowerCase(),
      );
    } catch {
      return false;
    }
  });
}

export function buildMobileV2DriverSignupPayload(
  draft: MobileV2DriverSignupDraft,
  options: {
    readonly locale?: string | null;
    readonly turnstileToken?: string | null;
  } = {},
): JsonRecord {
  const selectedRoleIds = Array.from(new Set(draft.selectedRoleIds.map((id) => trim(id)).filter(Boolean)));
  return {
    email: trim(draft.email).toLowerCase(),
    full_name: trim(draft.fullName),
    organization_name: trim(draft.organizationName) || trim(draft.fullName),
    phone: trim(draft.phone) || null,
    locale: trim(options.locale) || null,
    capabilities_requested: selectedRoleIds,
    verification_documents: [],
    marketing: {
      source: "fieldops_mobile_v2",
      app_surface: "fieldops_mobile_v2_native_signup",
      employee_or_contractor_id: trim(draft.employeeOrContractorId),
      selected_role_ids: selectedRoleIds,
    },
    ...(trim(options.turnstileToken) ? { turnstile_token: trim(options.turnstileToken) } : {}),
  };
}

function buildDriverSignupHeaders(input: {
  readonly anonKey: string;
  readonly origin: string;
}): Record<string, string> {
  const anonKey = trim(input.anonKey);
  return {
    accept: "application/json",
    "content-type": "application/json",
    "x-client-info": "fieldops-mobile-v2-driver-signup",
    ...(input.origin ? { origin: input.origin } : {}),
    ...(anonKey ? { apikey: anonKey, authorization: `Bearer ${anonKey}` } : {}),
  };
}

async function fetchDriverSignupWithTimeout(
  fetchImpl: FetchLike,
  endpoint: string,
  init: Parameters<FetchLike>[1],
  timeoutErrorCode: string,
): ReturnType<FetchLike> {
  const controller =
    typeof AbortController === "function" ? new AbortController() : null;
  let didTimeOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    const request = fetchImpl(endpoint, {
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        didTimeOut = true;
        controller?.abort();
        reject(new Error(timeoutErrorCode));
      }, DEFAULT_DRIVER_SIGNUP_REQUEST_TIMEOUT_MS);
    });
    return await Promise.race([request, timeoutPromise]);
  } catch (error) {
    if (didTimeOut) throw new Error(timeoutErrorCode);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function readErrorMessage(status: number, body: JsonRecord): string {
  const error = asRecord(body.error);
  const message = trim(error.message);
  const code = trim(error.code);
  return message || code || `request_failed_${status}`;
}

function parseSignupResult(body: JsonRecord): MobileV2DriverSignupResult {
  return {
    id: trim(body.id),
    status: trim(body.status) || "pending",
    deduped: body.deduped === true,
    dedupeReason: trim(body.dedupe_reason),
    applicationStatusToken: trim(body.application_status_token),
  };
}

function parseStatusResult(body: JsonRecord): MobileV2DriverApplicationStatus {
  const requestedDocuments = Array.isArray(body.requested_documents)
    ? body.requested_documents.map((item) => trim(item)).filter(Boolean)
    : [];
  const handoff = asRecord(body.profile_handoff);
  return {
    status: trim(body.status) || "pending",
    applicationState: trim(body.application_state) || "pending_review",
    participantTypeKey: trim(body.participant_type_key),
    reviewDecision: trim(body.review_decision),
    reviewedAt: trim(body.reviewed_at),
    inviteEmailSentAt: trim(body.invite_email_sent_at),
    inviteRedirectTo: trim(body.invite_redirect_to),
    reviewReason: trim(body.review_reason),
    requestedDocuments,
    profileHandoff: {
      ready: handoff.ready === true,
      organizationId: trim(handoff.organization_id),
      userId: trim(handoff.user_id),
      participantProfileId: trim(handoff.participant_profile_id),
      driverProfileId: trim(handoff.driver_profile_id),
      fleetDriverStatus: trim(handoff.fleet_driver_status),
      fleetHandoffReady: handoff.fleet_handoff_ready === true,
      fleetDocumentCount: asNonNegativeInteger(handoff.fleet_document_count),
      fleetComplianceEventCount: asNonNegativeInteger(handoff.fleet_compliance_event_count),
      inviteRedirectTo: trim(handoff.invite_redirect_to),
      inviteEmailSentAt: trim(handoff.invite_email_sent_at),
    },
  };
}

export function formatMobileV2DriverApplicationStatusCopy(
  status: MobileV2DriverApplicationStatus | null,
): string {
  if (!status) return "Status update pending.";
  if (status.status === "approved") {
    return status.profileHandoff.ready
      ? "Approved. Profile handoff is ready. Check your invite email, then sign in."
      : "Approved. Invite handoff is still being prepared.";
  }
  if (status.status === "rejected") return "Rejected. Review the decision details below.";
  if (status.applicationState === "additional_documents_requested") {
    const docs = status.requestedDocuments.length ? `: ${status.requestedDocuments.join(", ")}` : "";
    return `More documents requested${docs}. Check your application email.`;
  }
  return "Under review. You can check this status again from this screen.";
}

export function buildMobileV2DriverApplicationFollowUp(
  status: MobileV2DriverApplicationStatus | null,
): MobileV2DriverApplicationFollowUp | null {
  if (!status) return null;
  if (status.status === "rejected") {
    return {
      title: "Application rejected",
      tone: "danger",
      reason: status.reviewReason,
      requestedDocuments: [],
    };
  }
  if (status.applicationState === "additional_documents_requested") {
    return {
      title: "Documents requested",
      tone: "warning",
      reason: status.reviewReason,
      requestedDocuments: status.requestedDocuments,
    };
  }
  if (status.status !== "approved" && status.reviewReason) {
    return {
      title: "Reviewer note",
      tone: "info",
      reason: status.reviewReason,
      requestedDocuments: status.requestedDocuments,
    };
  }
  return null;
}

export async function submitMobileV2DriverSignup(input: {
  readonly endpoint: string;
  readonly anonKey: string;
  readonly origin: string;
  readonly draft: MobileV2DriverSignupDraft;
  readonly locale?: string | null;
  readonly fetchImpl?: FetchLike;
}): Promise<MobileV2DriverSignupResult> {
  const endpoint = normalizeUrl(input.endpoint);
  if (!endpoint) throw new Error("driver_signup_endpoint_missing");
  const turnstileToken = shouldUseLocalDriverSignupTurnstileToken({
    endpoint,
    origin: input.origin,
  })
    ? MOBILE_V2_DRIVER_SIGNUP_LOCAL_TURNSTILE_TOKEN
    : "";
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchDriverSignupWithTimeout(
    fetchImpl,
    endpoint,
    {
      method: "POST",
      headers: buildDriverSignupHeaders({ anonKey: input.anonKey, origin: input.origin }),
      body: JSON.stringify(
        buildMobileV2DriverSignupPayload(input.draft, {
          locale: input.locale,
          turnstileToken,
        }),
      ),
    },
    "driver_signup_request_timeout",
  );
  const body = parseJson(await response.text());
  if (!response.ok || body.ok === false) {
    throw new Error(readErrorMessage(response.status, body));
  }
  const result = parseSignupResult(body);
  if (!result.id || !result.applicationStatusToken) {
    throw new Error("driver_signup_readback_missing");
  }
  return result;
}

export async function readMobileV2DriverApplicationStatus(input: {
  readonly endpoint: string;
  readonly anonKey: string;
  readonly origin: string;
  readonly token: string;
  readonly fetchImpl?: FetchLike;
}): Promise<MobileV2DriverApplicationStatus> {
  const endpoint = normalizeUrl(input.endpoint);
  const token = trim(input.token);
  if (!endpoint) throw new Error("driver_application_status_endpoint_missing");
  if (!token) throw new Error("driver_application_status_token_missing");
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchDriverSignupWithTimeout(
    fetchImpl,
    endpoint,
    {
      method: "POST",
      headers: buildDriverSignupHeaders({ anonKey: input.anonKey, origin: input.origin }),
      body: JSON.stringify({ token }),
    },
    "driver_application_status_request_timeout",
  );
  const body = parseJson(await response.text());
  if (!response.ok || body.ok === false) {
    throw new Error(readErrorMessage(response.status, body));
  }
  return parseStatusResult(body);
}

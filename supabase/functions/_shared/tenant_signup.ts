import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { isLoopbackHostname } from "./cors.mjs";

export type JsonRecord = Record<string, unknown>;

type EdgeRpcClient = SupabaseClient<any, any, any, any, any>;

export type TenantSignupRequestRow = {
  id: string;
  status: string;
  email: string;
  full_name: string;
  organization_name: string;
  organization_slug?: string | null;
};

export const asString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const decodeHex = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
};

export const sha256Hex = async (value: string): Promise<string> => {
  const input = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", input);
  return decodeHex(hash);
};

export const readClientIp = (req: Request): string => {
  const candidates = [
    req.headers.get("cf-connecting-ip"),
    req.headers.get("x-real-ip"),
    req.headers.get("x-forwarded-for"),
  ]
    .filter(Boolean)
    .map((v) => String(v));

  for (const headerValue of candidates) {
    const first = headerValue.split(",")[0]?.trim() ?? "";
    if (first) return first;
  }

  return "";
};

export const normalizeOrigin = (value: string): string => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.origin;
  } catch {
    return "";
  }
};

const isDisallowedRedirectHost = (host: string): boolean => {
  const normalized = String(host || "").trim().toLowerCase().replace(/\.+$/, "");
  if (!normalized) return true;
  // objectives:allow LOCALHOST Justification: explicit denylist guard so invite redirects cannot target loopback/local domains.
  return (
    isLoopbackHostname(normalized) ||
    normalized === "0.0.0.0" ||
    normalized.endsWith(".local")
  );
};

const isLocalRedirectHost = (host: string): boolean => {
  const normalized = String(host || "").trim().toLowerCase();
  // objectives:allow LOCALHOST Justification: local invite proof must explicitly recognize loopback callback hosts while production remains hosted-only.
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
};

export const normalizeHostedRedirectUrl = (value: string): string => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const protocol = String(parsed.protocol || "").toLowerCase();
    if (protocol !== "https:") return "";
    if (isDisallowedRedirectHost(parsed.hostname)) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
};

export const normalizeLocalInviteRedirectUrl = (
  value: string,
  allowedOrigins: string[] = [],
): string => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const protocol = String(parsed.protocol || "").toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return "";
    if (!isLocalRedirectHost(parsed.hostname)) return "";
    if (parsed.pathname !== "/auth/callback") return "";
    const allowed = new Set(
      allowedOrigins
        .map((origin) => normalizeOrigin(origin))
        .filter(Boolean),
    );
    if (allowed.size === 0 || !allowed.has(parsed.origin)) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
};

export const normalizeInviteRedirectUrl = (
  value: string,
  options: { allowLocalInviteRedirect?: boolean; localInviteRedirectOrigins?: string[] } = {},
): string => {
  const hosted = normalizeHostedRedirectUrl(value);
  if (hosted) return hosted;
  if (!options.allowLocalInviteRedirect) return "";
  return normalizeLocalInviteRedirectUrl(value, options.localInviteRedirectOrigins || []);
};

export const parseOriginAllowlist = (
  raw: string,
): { origins: Set<string>; invalid: string[] } => {
  const invalid: string[] = [];
  const origins = new Set<string>();
  const parts = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    const normalized = normalizeOrigin(part);
    if (!normalized) invalid.push(part);
    else origins.add(normalized);
  }

  return { origins, invalid };
};

const getObject = (value: unknown): JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonRecord;
};

const policyGet = (policy: JsonRecord, path: string[]): unknown => {
  let cursor: unknown = policy;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as JsonRecord)[segment];
  }
  return cursor;
};

export const policyBool = (
  policy: JsonRecord,
  path: string[],
  defaultValue: boolean,
): boolean => {
  const raw = policyGet(policy, path);
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return defaultValue;
};

export const policyString = (
  policy: JsonRecord,
  path: string[],
): string => {
  return asString(policyGet(policy, path));
};

export const loadTenantSignupPolicy = async (
  serviceClient: EdgeRpcClient,
): Promise<JsonRecord> => {
  const { data, error } = await serviceClient.rpc("tenant_signup_policy_v1");
  if (error) {
    throw new Error(error.message || "tenant_signup_policy_load_failed");
  }
  return getObject(data);
};

export const getTenantSignupRequest = async (
  serviceClient: EdgeRpcClient,
  requestId: string,
): Promise<TenantSignupRequestRow | null> => {
  const { data, error } = await serviceClient
    .from("tenant_signup_requests")
    .select("id,status,email,full_name,organization_name,organization_slug")
    .eq("id", requestId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "tenant_signup_request_lookup_failed");
  }

  if (!data) return null;

  const id = asString(data.id);
  const status = asString(data.status);
  const email = asString(data.email).toLowerCase();
  const fullName = asString(data.full_name);
  const organizationName = asString(data.organization_name);
  const organizationSlug = asString(data.organization_slug);

  if (!id || !status || !email || !fullName || !organizationName) {
    return null;
  }

  return {
    id,
    status,
    email,
    full_name: fullName,
    organization_name: organizationName,
    organization_slug: organizationSlug || null,
  };
};

const isUserAlreadyRegisteredError = (message: string): boolean => {
  const text = message.toLowerCase();
  return text.includes("already") && (text.includes("registered") || text.includes("exists"));
};

export const findAuthUserIdByEmail = async (
  serviceClient: EdgeRpcClient,
  email: string,
): Promise<string> => {
  const target = email.trim().toLowerCase();
  if (!target) return "";

  const { data: rpcData, error: rpcError } = await serviceClient.rpc(
    "tenant_signup_find_auth_user_id_by_email_v1",
    { p_email: target },
  );
  if (!rpcError) {
    const rpcMatch = asString(rpcData);
    if (rpcMatch) return rpcMatch;
  }

  const perPage = 200;
  for (let page = 1; ; page += 1) {
    const { data, error } = await serviceClient.auth.admin.listUsers({
      page,
      perPage,
    });

    if (error) {
      throw new Error(error.message || "tenant_signup_auth_user_lookup_failed");
    }

    const users = Array.isArray(data?.users) ? data.users : [];
    const matched = users.find(
      (candidate) => asString(candidate?.email).toLowerCase() === target,
    );

    if (matched?.id) {
      return asString(matched.id);
    }

    if (users.length < perPage) {
      break;
    }
  }

  return "";
};

const ensureAuthUserForApproval = async (
  serviceClient: EdgeRpcClient,
  params: {
    email: string;
    fullName: string;
    organizationName: string;
    inviteRedirectTo: string | null;
    sendInviteEmail: boolean;
  },
): Promise<{ authUserId: string; inviteEmailSent: boolean; inviteError: string | null }> => {
  const metadata = {
    full_name: params.fullName,
    organization_name: params.organizationName,
    signup_source: "tenant_signup_review",
  };

  let inviteErrorMessage: string | null = null;

  if (params.sendInviteEmail) {
    if (!params.inviteRedirectTo) {
      throw new Error("invite_redirect_required");
    }
    const { data, error } = await serviceClient.auth.admin.inviteUserByEmail(
      params.email,
      {
        ...(params.inviteRedirectTo ? { redirectTo: params.inviteRedirectTo } : {}),
        data: metadata,
      },
    );

    if (!error && data?.user?.id) {
      return {
        authUserId: asString(data.user.id),
        inviteEmailSent: true,
        inviteError: null,
      };
    }

    inviteErrorMessage = error?.message || "invite_user_failed";
  }

  const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
    email: params.email,
    email_confirm: true,
    user_metadata: {
      ...metadata,
      invite_fallback: params.sendInviteEmail,
    },
  });

  if (!createError && created?.user?.id) {
    return {
      authUserId: asString(created.user.id),
      inviteEmailSent: false,
      inviteError: inviteErrorMessage,
    };
  }

  if (createError && isUserAlreadyRegisteredError(createError.message || "")) {
    const existing = await findAuthUserIdByEmail(serviceClient, params.email);
    if (existing) {
      return {
        authUserId: existing,
        inviteEmailSent: false,
        inviteError: inviteErrorMessage || createError.message || null,
      };
    }
  }

  throw new Error(createError?.message || inviteErrorMessage || "create_auth_user_failed");
};

type ApprovalParams = {
  serviceClient: EdgeRpcClient;
  reviewClient?: EdgeRpcClient;
  requestId: string;
  reviewerUserId: string | null;
  decisionReason?: string | null;
  decisionMetadata?: JsonRecord;
  inviteRedirectOverride?: string | null;
  allowLocalInviteRedirect?: boolean;
  localInviteRedirectOrigins?: string[];
};

export const approveTenantSignupRequest = async (
  params: ApprovalParams,
): Promise<JsonRecord> => {
  const request = await getTenantSignupRequest(params.serviceClient, params.requestId);
  if (!request) {
    return { ok: false, error: { code: "request_not_found" } };
  }

  if (request.status !== "pending") {
    return {
      ok: true,
      id: request.id,
      status: request.status,
      already_processed: true,
    };
  }

  const policy = await loadTenantSignupPolicy(params.serviceClient);
  const sendInviteEmail = policyBool(policy, ["notifications", "requester_approved_email"], true);
  const inviteRedirect = normalizeInviteRedirectUrl(
    asString(params.inviteRedirectOverride) ||
      policyString(policy, ["onboarding", "invite_redirect_to"]),
    {
      allowLocalInviteRedirect: params.allowLocalInviteRedirect === true,
      localInviteRedirectOrigins: params.localInviteRedirectOrigins || [],
    },
  );

  if (sendInviteEmail && !inviteRedirect) {
    return {
      ok: false,
      error: {
        code: "invite_redirect_required",
        message: "Invite redirect must be a hosted non-localhost HTTPS URL.",
      },
    };
  }

  const inviteResult = await ensureAuthUserForApproval(params.serviceClient, {
    email: request.email,
    fullName: request.full_name,
    organizationName: request.organization_name,
    inviteRedirectTo: inviteRedirect || null,
    sendInviteEmail,
  });

  const decisionMetadata = {
    ...(getObject(params.decisionMetadata)),
    invite_email_requested: sendInviteEmail,
    invite_email_sent: inviteResult.inviteEmailSent,
    invite_error: inviteResult.inviteError,
  };

  const reviewClient = params.reviewClient || params.serviceClient;
  const { data, error } = await reviewClient.rpc("tenant_signup_review_apply_v1", {
    p_request_id: request.id,
    p_decision: "approved",
    p_reviewer_user_id: params.reviewerUserId,
    p_decision_reason: asString(params.decisionReason) || null,
    p_invited_auth_user_id: inviteResult.authUserId,
    p_invite_email_sent: inviteResult.inviteEmailSent,
    p_invite_redirect_to: inviteRedirect || null,
    p_decision_metadata: decisionMetadata,
  });

  if (error) {
    try {
      await params.serviceClient.rpc("tenant_signup_request_record_error_v1", {
        p_request_id: request.id,
        p_error_code: "review_apply_failed",
        p_error_message: error.message || "review_apply_failed",
        p_error_context: {
          stage: "approve",
          invite_email_requested: sendInviteEmail,
          invite_email_sent: inviteResult.inviteEmailSent,
        },
      });
    } catch {
      // Diagnostic recording is best-effort; preserve the original review error.
    }

    return {
      ok: false,
      error: {
        code: "review_apply_failed",
        message: error.message || "review_apply_failed",
      },
    };
  }

  return getObject(data);
};

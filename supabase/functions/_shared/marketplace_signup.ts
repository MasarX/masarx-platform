import type { SupabaseClient } from "npm:@supabase/supabase-js@2.111.0";
import {
  asString,
  normalizeHostedRedirectUrl,
  normalizeOrigin,
  parseOriginAllowlist,
  policyBool,
  readClientIp,
  sha256Hex,
  type JsonRecord,
} from "./tenant_signup.ts";

export {
  asString,
  normalizeHostedRedirectUrl,
  normalizeOrigin,
  parseOriginAllowlist,
  policyBool,
  readClientIp,
  sha256Hex,
  type JsonRecord,
} from "./tenant_signup.ts";

export type MarketplaceParticipantRequestRow = {
  id: string;
  status: string;
  requested_participant_type_key: string;
  email: string;
  full_name: string;
  organization_name: string;
  organization_slug?: string | null;
  requested_organization_id?: string | null;
  requested_by_user_id?: string | null;
};

const getObject = (value: unknown): JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonRecord;
};

export const loadMarketplaceCompliancePolicy = async (
  serviceClient: SupabaseClient,
  participantTypeKey = "freelancer_driver",
  organizationId?: string | null,
): Promise<JsonRecord> => {
  const { data, error } = await serviceClient.rpc("marketplace_compliance_policy_v1", {
    p_context: {
      participant_type_key: participantTypeKey,
      organization_id: organizationId ?? null,
    },
  });
  if (error) {
    throw new Error(error.message || "marketplace_compliance_policy_load_failed");
  }
  return getObject(data);
};

export const getMarketplaceParticipantRequest = async (
  serviceClient: SupabaseClient,
  requestId: string,
): Promise<MarketplaceParticipantRequestRow | null> => {
  const { data, error } = await serviceClient.rpc("marketplace_participant_request_get_v1", {
    p_request_id: requestId,
  });

  if (error) {
    throw new Error(error.message || "marketplace_participant_request_lookup_failed");
  }

  const row = getObject(data);
  if (!Object.keys(row).length) return null;

  const id = asString(row.id);
  const status = asString(row.status);
  const requestedParticipantTypeKey = asString(row.requested_participant_type_key);
  const email = asString(row.email).toLowerCase();
  const fullName = asString(row.full_name);
  const organizationName = asString(row.organization_name);
  const organizationSlug = asString(row.organization_slug);
  const requestedOrganizationId = asString(row.requested_organization_id);
  const requestedByUserId = asString(row.requested_by_user_id);

  if (!id || !status || !requestedParticipantTypeKey || !email || !organizationName) {
    return null;
  }

  return {
    id,
    status,
    requested_participant_type_key: requestedParticipantTypeKey,
    email,
    full_name: fullName,
    organization_name: organizationName,
    organization_slug: organizationSlug || null,
    requested_organization_id: requestedOrganizationId || null,
    requested_by_user_id: requestedByUserId || null,
  };
};

const isUserAlreadyRegisteredError = (message: string): boolean => {
  const text = message.toLowerCase();
  return text.includes("already") && (text.includes("registered") || text.includes("exists"));
};

const findAuthUserIdByEmail = async (
  serviceClient: SupabaseClient,
  email: string,
): Promise<string> => {
  const target = email.trim().toLowerCase();
  if (!target) return "";

  const perPage = 200;
  for (let page = 1; ; page += 1) {
    const { data, error } = await serviceClient.auth.admin.listUsers({
      page,
      perPage,
    });

    if (error) {
      throw new Error(error.message || "marketplace_signup_auth_user_lookup_failed");
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
  serviceClient: SupabaseClient,
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
    signup_source: "marketplace_participant_review",
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
  serviceClient: SupabaseClient;
  requestId: string;
  reviewerUserId: string | null;
  decisionReason?: string | null;
  decisionMetadata?: JsonRecord;
  inviteRedirectOverride?: string | null;
};

export const approveMarketplaceParticipantRequest = async (
  params: ApprovalParams,
): Promise<JsonRecord> => {
  const request = await getMarketplaceParticipantRequest(params.serviceClient, params.requestId);
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

  const policy = await loadMarketplaceCompliancePolicy(
    params.serviceClient,
    request.requested_participant_type_key,
    request.requested_organization_id ?? null,
  );

  const requiresAuthProvision = request.requested_participant_type_key === "freelancer_driver";
  const inviteRedirect = normalizeHostedRedirectUrl(
    asString(params.inviteRedirectOverride) ||
      asString(
        getObject(policy.onboarding).invite_redirect_to,
      ),
  );

  let inviteResult:
    | { authUserId: string; inviteEmailSent: boolean; inviteError: string | null }
    | null = null;

  if (requiresAuthProvision) {
    if (!inviteRedirect) {
      return {
        ok: false,
        error: {
          code: "invite_redirect_required",
          message: "Invite redirect must be a hosted non-localhost HTTPS URL.",
        },
      };
    }

    inviteResult = await ensureAuthUserForApproval(params.serviceClient, {
      email: request.email,
      fullName: request.full_name || request.email,
      organizationName: request.organization_name,
      inviteRedirectTo: inviteRedirect || null,
      sendInviteEmail: true,
    });
  }

  const decisionMetadata = {
    ...getObject(params.decisionMetadata),
    reviewed_via: "marketplace-participant-review",
    invite_email_requested: requiresAuthProvision,
    invite_email_sent: inviteResult?.inviteEmailSent ?? false,
    invite_error: inviteResult?.inviteError ?? null,
  };

  const { data, error } = await params.serviceClient.rpc(
    "marketplace_participant_request_review_apply_v1",
    {
      p_request_id: request.id,
      p_decision: "approved",
      p_reviewer_user_id: params.reviewerUserId,
      p_invited_auth_user_id: inviteResult?.authUserId ?? null,
      p_invite_email_sent: inviteResult?.inviteEmailSent ?? false,
      p_invite_redirect_to: inviteRedirect || null,
      p_approved_organization_id: request.requested_organization_id ?? null,
      p_approved_user_id: request.requested_by_user_id ?? null,
      p_decision_metadata: decisionMetadata,
    },
  );

  if (error) {
    return {
      ok: false,
      error: {
        code: "approval_failed",
        message: error.message || "approval_failed",
      },
    };
  }

  return data && typeof data === "object" ? (data as JsonRecord) : { ok: true };
};

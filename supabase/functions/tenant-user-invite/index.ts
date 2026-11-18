import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@^2.45.4";
import { extractToken, parseRequestBody, readEnv } from "./_shared/mod.mjs";
import { normalizeHostedRedirectUrl } from "./_shared/tenant_signup.ts";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]);
const SUPABASE_ANON_KEY = readEnv("EDGE_SUPABASE_ANON_KEY", ["SUPABASE_ANON_KEY"]);
const SUPABASE_SERVICE_KEY = readEnv("EDGE_SUPABASE_SERVICE_ROLE_KEY", [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE_KEY",
]);
const EDGE_SUPABASE_SECRET_KEY = readEnv("EDGE_SUPABASE_SECRET_KEY", [
  "SUPABASE_SECRET_KEY",
]);

const corsHeaders = (req: Request): Record<string, string> => {
  const origin = req.headers.get("origin")?.trim() || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
    "access-control-max-age": "600",
    vary: "Origin",
  };
};

const json = (status: number, body: JsonRecord, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });

const asString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const isJwtLike = (value: string): boolean =>
  String(value || "").trim().split(".").length === 3;

const isUserAlreadyRegisteredError = (message: string): boolean => {
  const text = message.toLowerCase();
  return text.includes("already") && (text.includes("registered") || text.includes("exists"));
};

const findAuthUserIdByEmail = async (
  serviceClient: ReturnType<typeof createClient>,
  email: string,
): Promise<string> => {
  const target = email.trim().toLowerCase();
  if (!target) return "";
  const perPage = 200;
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await serviceClient.auth.admin.listUsers({ page, perPage });
    if (error) return "";
    const users = Array.isArray(data?.users) ? data.users : [];
    const matched = users.find((candidate) => asString(candidate?.email).toLowerCase() === target);
    if (matched?.id) return asString(matched.id);
    if (users.length < perPage) break;
  }
  return "";
};

const createUserClient = (token: string) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("missing_supabase_public_configuration");
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: "api" },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
        "x-client-info": "console-v2-tenant-user-invite",
      },
    },
    accessToken: async () => token,
  });
};

const createServiceClient = () => {
  const serviceKey = asString(SUPABASE_SERVICE_KEY) || asString(EDGE_SUPABASE_SECRET_KEY);
  if (!SUPABASE_URL || !serviceKey) {
    throw new Error("missing_supabase_service_configuration");
  }
  const apiKeyHeader = serviceKey;
  return createClient(SUPABASE_URL, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: "api" },
    global: {
      headers: {
        apikey: apiKeyHeader,
        ...(isJwtLike(serviceKey) ? { Authorization: `Bearer ${serviceKey}` } : {}),
        "x-client-info": "console-v2-tenant-user-invite",
      },
    },
  });
};

const ensureAuthUser = async (
  serviceClient: ReturnType<typeof createClient>,
  params: {
    email: string;
    fullName: string;
    organizationName: string;
    roleKey: string;
    inviteRedirectTo: string | null;
    sendInviteEmail: boolean;
  },
): Promise<{ authUserId: string; inviteEmailSent: boolean; inviteError: string | null }> => {
  const metadata = {
    full_name: params.fullName,
    organization_name: params.organizationName,
    role_key: params.roleKey,
    signup_source: "tenant_user_invite",
  };

  let inviteErrorMessage: string | null = null;
  if (params.sendInviteEmail) {
    const { data, error } = await serviceClient.auth.admin.inviteUserByEmail(
      params.email,
      {
        ...(params.inviteRedirectTo ? { redirectTo: params.inviteRedirectTo } : {}),
        data: metadata,
      },
    );
    if (!error && data?.user?.id) {
      return { authUserId: asString(data.user.id), inviteEmailSent: true, inviteError: null };
    }
    throw new Error(error?.message || "invite_user_failed");
  }

  const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
    email: params.email,
    email_confirm: !params.sendInviteEmail,
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

const resendHostedInviteEmail = async (
  serviceClient: ReturnType<typeof createClient>,
  params: {
    email: string;
    fullName: string;
    organizationName: string;
    roleKey: string;
    inviteRedirectTo: string | null;
    existingUserId: string;
  },
): Promise<{ authUserId: string; inviteEmailSent: boolean; inviteError: string | null }> => {
  const metadata = {
    full_name: params.fullName,
    organization_name: params.organizationName,
    role_key: params.roleKey,
    signup_source: "tenant_user_invite",
    invite_recovery: true,
  };

  const { data, error } = await serviceClient.auth.admin.inviteUserByEmail(
    params.email,
    {
      ...(params.inviteRedirectTo ? { redirectTo: params.inviteRedirectTo } : {}),
      data: metadata,
    },
  );
  if (error) {
    throw new Error(error.message || "invite_user_resend_failed");
  }

  return {
    authUserId: asString(data?.user?.id) || params.existingUserId,
    inviteEmailSent: true,
    inviteError: null,
  };
};

serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") {
    return json(405, { ok: false, error: { code: "method_not_allowed" } }, cors);
  }

  const token = extractToken(req, {
    prefer: "authorization",
    allowWebhookHeader: false,
    allowQueryParam: false,
  });
  if (!token) {
    return json(401, { ok: false, error: { code: "missing_authorization" } }, cors);
  }

  let payload: JsonRecord;
  try {
    payload = (await parseRequestBody(req)).json as JsonRecord;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_json";
    return json(400, { ok: false, error: { code: "invalid_json", message } }, cors);
  }

  const email = asString(payload.email).toLowerCase();
  const fullName = asString(payload.full_name);
  const roleKey = asString(payload.role_key).toLowerCase();
  const accessScopeType = asString(payload.access_scope_type).toLowerCase() || "tenant";
  const accessScopeId = asString(payload.access_scope_id) || null;
  const organizationId = asString(payload.organization_id) || null;
  const sendInviteEmail = payload.send_invite_email !== false;
  const resendExistingInvite = payload.resend_existing_invite === true;
  const inviteRedirectInput = asString(payload.invite_redirect_to);
  const inviteRedirectTo = inviteRedirectInput
    ? normalizeHostedRedirectUrl(inviteRedirectInput)
    : "";

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json(400, { ok: false, error: { code: "invalid_email" } }, cors);
  }
  if (!fullName) {
    return json(400, { ok: false, error: { code: "full_name_required" } }, cors);
  }
  if (!roleKey) {
    return json(400, { ok: false, error: { code: "role_key_required" } }, cors);
  }
  if (inviteRedirectInput && !inviteRedirectTo) {
    return json(400, {
      ok: false,
      error: {
        code: "invalid_invite_redirect_to",
        message: "invite_redirect_to must be a hosted non-localhost http/https URL.",
      },
    }, cors);
  }
  if (sendInviteEmail && !inviteRedirectTo) {
    return json(400, {
      ok: false,
      error: {
        code: "invite_redirect_required",
        message: "invite_redirect_to is required when send_invite_email is true.",
      },
    }, cors);
  }

  let userClient;
  let serviceClient;
  try {
    userClient = createUserClient(token);
    serviceClient = createServiceClient();
  } catch (error) {
    const message = error instanceof Error ? error.message : "missing_supabase_configuration";
    return json(500, { ok: false, error: { code: "server_misconfigured", message } }, cors);
  }

  const { data: guardData, error: guardError } = await userClient.rpc(
    "tenant_user_invite_assert_operator_v1",
    { p_organization_id: organizationId },
  );
  if (guardError) {
    return json(403, {
      ok: false,
      error: { code: "tenant_user_invite_forbidden", message: guardError.message },
    }, cors);
  }

  const guard = guardData && typeof guardData === "object" ? guardData as JsonRecord : {};
  const resolvedOrgId = asString(guard.organization_id);
  const organizationName = asString(guard.organization_name);
  const actorUserId = asString(guard.actor_user_id);
  if (!resolvedOrgId || !actorUserId) {
    return json(403, { ok: false, error: { code: "operator_context_required" } }, cors);
  }

  const inviteArgsBase: JsonRecord = {
    actor_user_id: actorUserId,
    organization_id: resolvedOrgId,
    email,
    full_name: fullName,
    role_key: roleKey,
    user_type: asString(payload.user_type) || undefined,
    access_scope_type: accessScopeType,
    access_scope_id: accessScopeId,
    send_invite_email_requested: sendInviteEmail,
    invite_redirect_to: inviteRedirectTo || null,
    metadata: payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
      ? payload.metadata
      : {},
  };

  const { data: preflightData, error: preflightError } = await serviceClient.rpc(
    "tenant_user_invite_apply_v1",
    { p_args: { ...inviteArgsBase, preflight_only: true } },
  );
  if (preflightError) {
    return json(400, {
      ok: false,
      error: { code: "tenant_user_invite_preflight_failed", message: preflightError.message },
    }, cors);
  }
  const preflight = preflightData && typeof preflightData === "object" ? preflightData as JsonRecord : {};
  const existingUserId = asString(preflight.existing_user_id);

  let authUser;
  if (existingUserId) {
    if (sendInviteEmail && resendExistingInvite) {
      const { error: resendAssertError } = await serviceClient.rpc(
        "tenant_user_invite_resend_assert_v1",
        {
          p_args: {
            actor_user_id: actorUserId,
            organization_id: resolvedOrgId,
            target_user_id: existingUserId,
            email,
            role_key: roleKey,
          },
        },
      );
      if (resendAssertError) {
        return json(400, {
          ok: false,
          error: { code: "tenant_user_invite_resend_denied", message: resendAssertError.message },
        }, cors);
      }
      try {
        authUser = await resendHostedInviteEmail(serviceClient, {
          email,
          fullName,
          organizationName,
          roleKey,
          inviteRedirectTo: inviteRedirectTo || null,
          existingUserId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "auth_user_invite_resend_failed";
        return json(400, { ok: false, error: { code: "auth_user_invite_resend_failed", message } }, cors);
      }
    } else {
      authUser = { authUserId: existingUserId, inviteEmailSent: false, inviteError: null };
    }
  } else {
    try {
      authUser = await ensureAuthUser(serviceClient, {
        email,
        fullName,
        organizationName,
        roleKey,
        inviteRedirectTo: inviteRedirectTo || null,
        sendInviteEmail,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "auth_user_invite_failed";
      return json(400, { ok: false, error: { code: "auth_user_invite_failed", message } }, cors);
    }
  }

  const { data: applyData, error: applyError } = await serviceClient.rpc(
    "tenant_user_invite_apply_v1",
    {
      p_args: {
        ...inviteArgsBase,
        auth_user_id: authUser.authUserId,
        invite_email_sent: authUser.inviteEmailSent,
        invite_error: authUser.inviteError,
      },
    },
  );

  if (applyError) {
    return json(400, {
      ok: false,
      error: { code: "tenant_user_invite_apply_failed", message: applyError.message },
    }, cors);
  }

  return json(200, {
    ok: true,
    invite_email_sent: authUser.inviteEmailSent,
    invite_error: authUser.inviteError,
    result: applyData && typeof applyData === "object" ? applyData as JsonRecord : {},
  }, cors);
});

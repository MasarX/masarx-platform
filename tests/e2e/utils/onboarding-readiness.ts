import { createAuthedSupabaseClient, rpcWithRetry, signOutSupabaseClient } from "./supabase";

type UiMe = {
  access_scope?: {
    scope_type?: string | null;
    scope_id?: string | null;
  } | null;
};

export type UiOnboardingReadinessFinding = {
  code?: string | null;
  component?: string | null;
  message?: string | null;
};

export type UiOnboardingReadinessPluginItem = {
  plugin_key?: string | null;
  plugin_name?: string | null;
  activation_mode?: string | null;
  status?: string | null;
  effective_version_status?: string | null;
  binding_count?: number | null;
  pending_task_exists?: boolean | null;
};

export type UiOnboardingReadinessSection = {
  status?: string | null;
  baseline_profile?: string | null;
  present_count?: number | null;
  required_count?: number | null;
  healthy_count?: number | null;
  pending_credentials_count?: number | null;
  items?: UiOnboardingReadinessPluginItem[] | null;
};

export type UiOnboardingReadiness = {
  scope_type?: string | null;
  scope_id?: string | null;
  generated_at?: string | null;
  overall_status?: string | null;
  healthy?: boolean | null;
  settings_defaults?: UiOnboardingReadinessSection | null;
  workflow_bindings?: UiOnboardingReadinessSection | null;
  integration_plugins?: UiOnboardingReadinessSection | null;
  blocking_findings?: UiOnboardingReadinessFinding[] | null;
};

export async function fetchOnboardingReadiness(params: {
  email: string;
  password: string;
  scopeType?: string | null;
  scopeId?: string | null;
}) {
  const { email, password, scopeType, scopeId } = params;
  const supabase = await createAuthedSupabaseClient({
    email,
    password,
    label: `onboarding-readiness:${email}`,
  });

  try {
    const { data: me, error: meError } = await rpcWithRetry<UiMe>(
      supabase,
      "ui_me_v1",
      null,
      { label: `ui_me_v1:onboarding-readiness:${email}` },
    );
    if (meError) {
      throw new Error(
        `Failed to read ui_me_v1 for ${email}: ${(meError as any)?.message || String(meError)}`,
      );
    }

    const resolvedScopeType = scopeType ?? me?.access_scope?.scope_type ?? null;
    const resolvedScopeId = scopeId ?? me?.access_scope?.scope_id ?? null;
    if (!resolvedScopeType) {
      throw new Error(`No onboarding readiness scope could be resolved for ${email}.`);
    }

    const { data: readiness, error: readinessError } = await rpcWithRetry<UiOnboardingReadiness>(
      supabase,
      "ui_get_onboarding_readiness_v1",
      {
        p_scope_type: resolvedScopeType,
        p_scope_id: resolvedScopeId ?? null,
      },
      { label: `ui_get_onboarding_readiness_v1:${resolvedScopeType}:${email}` },
    );

    if (readinessError || !readiness) {
      throw new Error(
        `Failed to read ui_get_onboarding_readiness_v1 for ${email}: ${
          (readinessError as any)?.message || "no data"
        }`,
      );
    }

    return {
      me: me ?? null,
      resolvedScopeType,
      resolvedScopeId,
      readiness,
    };
  } finally {
    await signOutSupabaseClient(supabase, { label: `onboarding-readiness:${email}` });
  }
}

export function formatReadinessLabel(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value.replace(/_/g, " ");
}

export function readinessCountLabel(current: number, total: number) {
  if (total <= 0) return "No required defaults";
  return `${current}/${total} ready`;
}

export function extractIsoTimestamp(value: string | null | undefined) {
  const match = String(value ?? "").match(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/,
  );
  return match?.[0] ?? null;
}

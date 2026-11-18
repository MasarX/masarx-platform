-- Migration: Mobile V2 active-role switching (auth_set_active_role_v1)
-- Date: 2026-05-10
-- Spec: FieldOps V2 production-readiness. AGENTS.md Mobile Field Ops Policy
--       Contract: "Multi-role per session: when auth.roles[] has >1 entry,
--       the drawer offers a role switcher. Switching invokes
--       auth_set_active_role_v1(role) which re-validates capabilities,
--       re-issues scoped session claims, and invalidates queries; full
--       re-authentication is not required. The switch is audit-logged via
--       decision_log."
--
-- Adds:
--   public.mobile_v2_active_role     -- per-user active-role storage
--   public.auth_set_active_role_v1   -- RPC that validates + persists +
--                                       audit-logs the switch
--   public.auth_get_active_role_v1   -- companion reader
--
-- Roles are NOT stored in users.roles[]; they're derived from
-- public.rbac_user_role_assignments. The active-role table records the UI
-- session preference (which assigned role is "current") so the drawer +
-- bottom tabs + capability overlay can resolve consistently after the
-- switch and across reloads.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605102000_auth_set_active_role_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Storage table: mobile_v2_active_role (per-user)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mobile_v2_active_role (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  role_key TEXT NOT NULL,
  switched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mobile_v2_active_role_org_idx
  ON public.mobile_v2_active_role (organization_id);

CREATE INDEX IF NOT EXISTS mobile_v2_active_role_role_idx
  ON public.mobile_v2_active_role (role_key);

ALTER TABLE public.mobile_v2_active_role ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.mobile_v2_active_role FROM PUBLIC;
REVOKE ALL ON TABLE public.mobile_v2_active_role FROM anon;
REVOKE ALL ON TABLE public.mobile_v2_active_role FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mobile_v2_active_role TO service_role;

DROP POLICY IF EXISTS mobile_v2_active_role_service_policy ON public.mobile_v2_active_role;
CREATE POLICY mobile_v2_active_role_service_policy
  ON public.mobile_v2_active_role
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS mobile_v2_active_role_self_select ON public.mobile_v2_active_role;
CREATE POLICY mobile_v2_active_role_self_select
  ON public.mobile_v2_active_role
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.mobile_v2_active_role IS
  'Per-user active-role selection for FieldOps V2 mobile shell. UI-session preference; the source-of-truth for role assignments remains rbac_user_role_assignments.';

-------------------------------------------------------------------------------
-- 2) auth_set_active_role_v1 RPC
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auth_set_active_role_v1(p_role_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_caller_org UUID;
  v_normalized_role TEXT;
  v_assignment_count INT;
  v_capability_keys TEXT[];
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_existing_role TEXT;
  v_outcome TEXT;
  v_switched_at TIMESTAMPTZ;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'auth_set_active_role_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_normalized_role := lower(btrim(COALESCE(p_role_key, '')));
  IF v_normalized_role = '' THEN
    RAISE EXCEPTION 'auth_set_active_role_v1: role_key required'
      USING ERRCODE = '22023';
  END IF;

  v_caller_org := public.current_user_org_id();
  IF v_caller_org IS NULL THEN
    RAISE EXCEPTION 'auth_set_active_role_v1: caller has no organization context'
      USING ERRCODE = '42501';
  END IF;

  -- Validate the requested role is currently assigned to the caller in
  -- rbac_user_role_assignments. Roles are revocable (revoked_at NOT NULL =
  -- inactive); we only count active assignments.
  SELECT COUNT(*)
    INTO v_assignment_count
    FROM public.rbac_user_role_assignments ura
    JOIN public.rbac_roles r ON r.id = ura.role_id
   WHERE ura.user_id = v_user_id
     AND ura.organization_id = v_caller_org
     AND ura.revoked_at IS NULL
     AND lower(r.key) = v_normalized_role;

  IF v_assignment_count = 0 THEN
    -- Audit the deny path before raising.
    PERFORM public.log_decision(
      p_organization_id := v_caller_org,
      p_decision_category := 'auth.set_active_role',
      p_resource_type := 'mobile_v2_active_role',
      p_resource_id := v_user_id,
      p_decision_point := 'auth_set_active_role_v1',
      p_decision_outcome := 'denied_role_not_assigned',
      p_performed_by_system := 'auth_set_active_role_v1',
      p_correlation_id := v_correlation_id,
      p_decision_inputs := jsonb_build_object(
        'requested_role', v_normalized_role,
        'caller_user_id', v_user_id
      ),
      p_decision_reason := 'requested role is not in caller active rbac assignments'
    );
    RAISE EXCEPTION 'auth_set_active_role_v1: role % not assigned to caller', v_normalized_role
      USING ERRCODE = '42501';
  END IF;

  -- Capture prior selection so we can mark idempotent vs role-changed.
  SELECT role_key INTO v_existing_role
    FROM public.mobile_v2_active_role
   WHERE user_id = v_user_id;

  -- Resolve the caller's full capability set for the requested role from the
  -- access_control_policy registry. Using a generic helper if available;
  -- otherwise aggregate from rbac_user_role_assignments + access_control_policy
  -- capability_keys. Keep this fail-soft: if no caps resolved, return empty
  -- array — frontend falls back to default-home only.
  BEGIN
    SELECT ARRAY_AGG(DISTINCT cap)
      INTO v_capability_keys
      FROM (
        SELECT jsonb_array_elements_text(
                 COALESCE(role_def->'capability_keys', '[]'::jsonb)
               ) AS cap
          FROM public.settings s
          JOIN public.settings_versions sv
            ON sv.id = s.settings_version_id,
               jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) AS role_def
         WHERE s.category = 'access_control_policy'
           AND s.scope_type IN ('global', 'tenant')
           AND (s.scope_id IS NULL OR s.scope_id = v_caller_org)
           AND lower(role_def->>'key') = v_normalized_role
      ) caps;
  EXCEPTION WHEN OTHERS THEN
    v_capability_keys := ARRAY[]::TEXT[];
  END;

  v_capability_keys := COALESCE(v_capability_keys, ARRAY[]::TEXT[]);

  -- Upsert active-role selection.
  INSERT INTO public.mobile_v2_active_role (
    user_id, organization_id, role_key, switched_at
  ) VALUES (
    v_user_id, v_caller_org, v_normalized_role, now()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      role_key = EXCLUDED.role_key,
      switched_at = CASE
        WHEN public.mobile_v2_active_role.role_key = EXCLUDED.role_key
          THEN public.mobile_v2_active_role.switched_at
        ELSE EXCLUDED.switched_at
      END
  RETURNING switched_at INTO v_switched_at;

  IF v_existing_role IS NULL THEN
    v_outcome := 'role_set';
  ELSIF v_existing_role = v_normalized_role THEN
    v_outcome := 'role_unchanged';
  ELSE
    v_outcome := 'role_switched';
  END IF;

  v_decision_log_id := public.log_decision(
    p_organization_id := v_caller_org,
    p_decision_category := 'auth.set_active_role',
    p_resource_type := 'mobile_v2_active_role',
    p_resource_id := v_user_id,
    p_decision_point := 'auth_set_active_role_v1',
    p_decision_outcome := v_outcome,
    p_performed_by_system := 'auth_set_active_role_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_build_object(
      'previous_role', v_existing_role,
      'requested_role', v_normalized_role,
      'capability_count', COALESCE(array_length(v_capability_keys, 1), 0)
    ),
    p_decision_reason := 'mobile-v2 drawer role switch'
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'active_role', v_normalized_role,
    'previous_role', v_existing_role,
    'organization_id', v_caller_org,
    'capability_keys', to_jsonb(v_capability_keys),
    'switched_at', v_switched_at,
    'correlation_id', v_correlation_id,
    'decision_log_id', v_decision_log_id,
    'outcome', v_outcome
  );
END;
$$;

REVOKE ALL ON FUNCTION public.auth_set_active_role_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_set_active_role_v1(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.auth_set_active_role_v1(TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.auth_set_active_role_v1(TEXT) IS
  'Mobile V2 drawer role switch. Validates the requested role is in the caller active rbac_user_role_assignments, persists the selection in mobile_v2_active_role, and audit-logs to decision_log. Idempotent on same-role calls (returns role_unchanged outcome).';

-------------------------------------------------------------------------------
-- 3) auth_get_active_role_v1 — companion reader
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auth_get_active_role_v1()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_active_role TEXT;
  v_organization_id UUID;
  v_switched_at TIMESTAMPTZ;
  v_assigned_roles TEXT[];
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'auth_get_active_role_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  SELECT role_key, organization_id, switched_at
    INTO v_active_role, v_organization_id, v_switched_at
    FROM public.mobile_v2_active_role
   WHERE user_id = v_user_id
   LIMIT 1;

  -- Always return the assigned-roles list so the drawer can render the
  -- switcher even when no active selection has been persisted yet.
  SELECT ARRAY_AGG(DISTINCT lower(r.key))
    INTO v_assigned_roles
    FROM public.rbac_user_role_assignments ura
    JOIN public.rbac_roles r ON r.id = ura.role_id
   WHERE ura.user_id = v_user_id
     AND ura.revoked_at IS NULL;

  RETURN jsonb_build_object(
    'active_role', v_active_role,
    'organization_id', v_organization_id,
    'switched_at', v_switched_at,
    'assigned_roles', to_jsonb(COALESCE(v_assigned_roles, ARRAY[]::TEXT[]))
  );
END;
$$;

REVOKE ALL ON FUNCTION public.auth_get_active_role_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_get_active_role_v1() FROM anon;
GRANT EXECUTE ON FUNCTION public.auth_get_active_role_v1() TO authenticated, service_role;

COMMENT ON FUNCTION public.auth_get_active_role_v1() IS
  'Returns the caller current mobile-v2 active role plus the full set of currently-assigned roles. Read-only companion to auth_set_active_role_v1.';

SELECT pg_advisory_unlock(hashtext('202605102000_auth_set_active_role_v1'));
COMMIT;

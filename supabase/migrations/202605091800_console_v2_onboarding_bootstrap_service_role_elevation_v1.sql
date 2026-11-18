-- Console V2 onboarding bootstrap: elevate JWT claims to service_role inside
-- the bootstrap call so downstream service-only helpers (create_task_system_v1
-- + provision_rbac_roles_from_templates_v1 + bootstrap_*_onboarding_v1) can
-- complete from an authenticated operator context.
--
-- Why this exists
-- ---------------
-- ui_execute_onboarding_bootstrap_v1 is SECURITY DEFINER and validates the
-- caller capability (settings.write OR system.write) at the canonical scope
-- before delegating to bootstrap_tenant/client/sender_onboarding_v1. The
-- inner chain calls create_task_system_v1 which gates on the JWT `role`
-- claim equal to 'service_role', not on session privileges. Because the
-- caller is an authenticated operator, the inner gate raises
--   create_task_system_v1 requires service_role context
-- which fails the bootstrap UX from the Console even when the operator
-- has explicit settings.write capability for the tenant scope.
--
-- The fix is: the SECURITY DEFINER wrapper temporarily overrides the JWT
-- claims to role=service_role for the duration of the bootstrap call,
-- restores the original claims afterwards (success or failure), and keeps
-- the capability check intact. This mirrors the standard Supabase pattern
-- of explicit role elevation inside SECURITY DEFINER wrappers.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605091800_console_v2_onboarding_bootstrap_service_role_elevation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_execute_onboarding_bootstrap_v1(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope RECORD;
  v_result JSONB := '{}'::jsonb;
  v_readiness JSONB := '{}'::jsonb;
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_elevated_claims JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_execute_onboarding_bootstrap_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_scope
    FROM public.resolve_settings_scope_context_v1(p_scope_type, p_scope_id)
   LIMIT 1;

  IF v_scope.scope_type NOT IN ('tenant', 'client', 'sender') THEN
    RAISE EXCEPTION 'ui_execute_onboarding_bootstrap_v1 only supports tenant, client, or sender scope'
      USING ERRCODE = '22023';
  END IF;

  IF v_scope.scope_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_onboarding_bootstrap_v1 requires scope_id'
      USING ERRCODE = '23502';
  END IF;

  IF NOT (
    public.user_has_capability_v1('settings.write', v_scope.scope_type, v_scope.scope_id)
    OR public.user_has_capability_v1('system.write', v_scope.scope_type, v_scope.scope_id)
  ) THEN
    RAISE EXCEPTION 'ui_execute_onboarding_bootstrap_v1 requires settings.write or system.write capability'
      USING ERRCODE = '42501';
  END IF;

  -- Capability gate has passed. Build elevated JWT claims for the duration of
  -- the bootstrap call so downstream service-only helpers
  -- (create_task_system_v1, provision_rbac_roles_from_templates_v1, etc.)
  -- can run without raising "requires service_role context". The original
  -- claims are restored on both success and failure paths.
  v_elevated_claims := jsonb_build_object(
    'role', 'service_role',
    'sub', auth.uid()::text,
    'origin', 'ui_execute_onboarding_bootstrap_v1',
    'origin_scope_type', v_scope.scope_type,
    'origin_scope_id', v_scope.scope_id::text
  );

  BEGIN
    PERFORM set_config('request.jwt.claims', v_elevated_claims::text, true);

    IF v_scope.scope_type = 'tenant' THEN
      v_result := public.bootstrap_tenant_onboarding_v1(v_scope.scope_id, 'console-v2:manual-readiness-repair');
    ELSIF v_scope.scope_type = 'client' THEN
      v_result := public.bootstrap_client_onboarding_v1(v_scope.scope_id, 'console-v2:manual-readiness-repair');
    ELSE
      v_result := public.bootstrap_sender_onboarding_v1(v_scope.scope_id, 'console-v2:manual-readiness-repair');
    END IF;

    PERFORM set_config('request.jwt.claims', v_prev_claims, true);
  EXCEPTION
    WHEN others THEN
      PERFORM set_config('request.jwt.claims', v_prev_claims, true);
      RAISE;
  END;

  v_readiness := COALESCE(
    v_result->'readiness',
    public.onboarding_readiness_snapshot_v1(v_scope.scope_type, v_scope.scope_id)
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'scope_type', v_scope.scope_type,
    'scope_id', v_scope.scope_id,
    'result', v_result,
    'readiness', v_readiness
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_onboarding_bootstrap_v1(TEXT, UUID) IS
  'Console V2 guarded onboarding readiness repair. Re-runs canonical bootstrap_tenant/client/sender_onboarding_v1 for the selected scope and returns the fresh readiness snapshot. Capability gate (settings.write|system.write) is enforced before elevating JWT claims to service_role for the bootstrap chain so downstream service-only helpers (create_task_system_v1, etc.) succeed from an authenticated operator context. Original JWT claims are restored on both success and failure.';

SELECT pg_advisory_unlock(hashtext('202605091800_console_v2_onboarding_bootstrap_service_role_elevation_v1'));
COMMIT;

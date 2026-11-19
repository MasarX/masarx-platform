-- Console V2 readiness repair: authenticated operators can re-run canonical
-- onboarding bootstrap for tenant/client/sender scopes from the readiness page.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605031830_onboarding_bootstrap_ui_execute_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

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

  IF v_scope.scope_type = 'tenant' THEN
    v_result := public.bootstrap_tenant_onboarding_v1(v_scope.scope_id, 'console-v2:manual-readiness-repair');
  ELSIF v_scope.scope_type = 'client' THEN
    v_result := public.bootstrap_client_onboarding_v1(v_scope.scope_id, 'console-v2:manual-readiness-repair');
  ELSE
    v_result := public.bootstrap_sender_onboarding_v1(v_scope.scope_id, 'console-v2:manual-readiness-repair');
  END IF;

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

CREATE OR REPLACE FUNCTION api.ui_execute_onboarding_bootstrap_v1(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_execute_onboarding_bootstrap_v1(p_scope_type, p_scope_id);
$function$;

REVOKE ALL ON FUNCTION public.ui_execute_onboarding_bootstrap_v1(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_onboarding_bootstrap_v1(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_onboarding_bootstrap_v1(TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION api.ui_execute_onboarding_bootstrap_v1(TEXT, UUID) FROM anon;

GRANT EXECUTE ON FUNCTION public.ui_execute_onboarding_bootstrap_v1(TEXT, UUID)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_execute_onboarding_bootstrap_v1(TEXT, UUID)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_execute_onboarding_bootstrap_v1(TEXT, UUID) IS
  'Console V2 guarded onboarding readiness repair. Re-runs canonical bootstrap_tenant/client/sender_onboarding_v1 for the selected scope and returns the fresh readiness snapshot.';
COMMENT ON FUNCTION api.ui_execute_onboarding_bootstrap_v1(TEXT, UUID) IS
  'Browser-safe api schema wrapper for public.ui_execute_onboarding_bootstrap_v1.';

SELECT pg_advisory_unlock(hashtext('202605031830_onboarding_bootstrap_ui_execute_v1'));
COMMIT;

-- Plan: Console V2 first-tenant onboarding closure
-- Step: allow platform operators to create fleet drivers in the active tenant.
--
-- Console V2 platform operators review and bootstrap tenant accounts from a
-- platform session while the shell's active tenant is the newly approved org.
-- Driver creation therefore needs an explicit target organization argument,
-- with tenant users still fail-closed to their own organization.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605071700_console_v2_driver_create_target_org_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  ld.id,
  'fleet.driver_created',
  'Fleet Driver Created',
  'Fleet driver profile creation decisions',
  610,
  FALSE,
  'active',
  jsonb_build_object('source', '202605071700_console_v2_driver_create_target_org_v1')
FROM public.lookup_definitions ld
WHERE ld.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

CREATE OR REPLACE FUNCTION public.create_driver_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_caller_org_id UUID := public.current_user_org_id();
  v_target_org_id UUID;

  v_user_id UUID;
  v_driver_code TEXT;
  v_status TEXT;
  v_hired_at TIMESTAMPTZ;
  v_metadata JSONB;

  v_user public.users%ROWTYPE;
  v_driver_profile_id UUID;
  v_created BOOLEAN := FALSE;
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'create_driver_v1: p_args must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR v_caller_org_id IS NULL THEN
    RAISE EXCEPTION 'create_driver_v1: authenticated tenant user required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  v_target_org_id := COALESCE(
    NULLIF(btrim(COALESCE(p_args->>'organization_id', p_args->>'tenant_organization_id', '')), '')::UUID,
    v_caller_org_id
  );

  IF v_target_org_id IS NULL THEN
    RAISE EXCEPTION 'create_driver_v1: organization_id could not be resolved' USING ERRCODE = '42501';
  END IF;
  IF v_target_org_id <> v_caller_org_id AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'create_driver_v1: organization % outside tenant scope', v_target_org_id USING ERRCODE = '42501';
  END IF;

  v_user_id := NULLIF(btrim(COALESCE(p_args->>'user_id', p_args->>'driver_user_id', '')), '')::UUID;
  v_driver_code := NULLIF(btrim(COALESCE(p_args->>'driver_code', '')), '');
  v_status := lower(NULLIF(btrim(COALESCE(p_args->>'status', '')), ''));
  v_hired_at := NULLIF(btrim(COALESCE(p_args->>'hired_at', '')), '')::TIMESTAMPTZ;
  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'create_driver_v1: user_id or driver_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_metadata) <> 'object' THEN
    RAISE EXCEPTION 'create_driver_v1: metadata must be a JSON object' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_user
    FROM public.users
   WHERE id = v_user_id;
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'create_driver_v1: user % not found', v_user_id USING ERRCODE = 'P0002';
  END IF;
  IF v_user.organization_id <> v_target_org_id THEN
    RAISE EXCEPTION 'create_driver_v1: user % belongs to another organization', v_user_id USING ERRCODE = '42501';
  END IF;

  IF v_status IS NULL THEN
    SELECT lv.value
      INTO v_status
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'driver_status'
       AND lv.is_default IS TRUE
     ORDER BY lv.sort_order, lv.value
     LIMIT 1;
  END IF;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'create_driver_v1: no default driver_status lookup row is configured' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'driver_status'
       AND lv.value = v_status
  ) THEN
    RAISE EXCEPTION 'create_driver_v1: status % not in lookup driver_status', v_status USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.driver_profiles (
    organization_id,
    user_id,
    driver_code,
    status,
    hired_at,
    metadata
  )
  VALUES (
    v_target_org_id,
    v_user_id,
    v_driver_code,
    v_status,
    v_hired_at,
    v_metadata || jsonb_build_object(
      'created_by', 'create_driver_v1',
      'created_correlation_id', v_correlation_id,
      'requested_organization_id', v_target_org_id
    )
  )
  ON CONFLICT (organization_id, user_id) DO NOTHING
  RETURNING id INTO v_driver_profile_id;

  IF v_driver_profile_id IS NOT NULL THEN
    v_created := TRUE;

    PERFORM public.enqueue_domain_event(
      v_target_org_id,
      'fleet.driver_created',
      'driver_profile',
      v_driver_profile_id,
      jsonb_build_object(
        'driver_user_id', v_user_id,
        'driver_code', v_driver_code,
        'status', v_status,
        'requested_by', auth.uid()
      ),
      v_correlation_id
    );

    PERFORM public.log_decision(
      v_target_org_id,
      'fleet.driver_created',
      'driver_profile',
      v_driver_profile_id,
      'rpc_dispatch',
      'created',
      'create_driver_v1',
      v_correlation_id,
      jsonb_build_object(
        'driver_user_id', v_user_id,
        'driver_code', v_driver_code,
        'status', v_status,
        'driver_status_source', 'lookup_values.driver_status'
      ),
      NULL
    );
  ELSE
    SELECT dp.id, dp.status
      INTO v_driver_profile_id, v_status
      FROM public.driver_profiles dp
     WHERE dp.organization_id = v_target_org_id
       AND dp.user_id = v_user_id
     LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'created', v_created,
    'driver_profile_id', v_driver_profile_id,
    'driver_user_id', v_user_id,
    'organization_id', v_target_org_id,
    'status', v_status,
    'correlation_id', v_correlation_id,
    'resolved_from', 'driver_status/lookup'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION api.create_driver_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.create_driver_v1(COALESCE($1, '{}'::jsonb));
$function$;

REVOKE ALL ON FUNCTION public.create_driver_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_driver_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_driver_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.create_driver_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.create_driver_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.create_driver_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.create_driver_v1(JSONB)
  IS 'Canonical fleet RPC: create a driver_profiles row for an existing tenant user. Platform users may target the active tenant with organization_id; tenant users are scoped to their own organization. Capability: fleet.write.';
COMMENT ON FUNCTION api.create_driver_v1(JSONB)
  IS 'Console V2 api-schema wrapper delegating to canonical public.create_driver_v1(jsonb).';

SELECT pg_advisory_unlock(hashtext('202605071700_console_v2_driver_create_target_org_v1'));

COMMIT;

-- Plan: PLAN-202602-integration-plugin-studio-v1 / Step: S08
-- Migration: Resolve integration-plugin egress policy for outbound jobs
-- Purpose:
--   - Detect integration-plugin-managed outbound jobs at dispatch time.
--   - Resolve tenant/global integration_plugin_egress_policy row for api-caller enforcement.
--   - Keep policy resolution row-driven and org-scoped.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602220070_integration_plugin_egress_policy_resolver_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.resolve_integration_plugin_egress_policy_for_job_v1(
  p_job_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_job public.outbound_calls%ROWTYPE;
  v_operation_id UUID := NULL;
  v_operation public.operation_templates%ROWTYPE;
  v_provider public.providers%ROWTYPE;
  v_org_id UUID := NULL;
  v_managed_by TEXT := 'platform';
  v_policy JSONB := '{}'::jsonb;
BEGIN
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'resolve_integration_plugin_egress_policy_for_job_v1 requires job_id';
  END IF;

  SELECT *
    INTO v_job
    FROM public.outbound_calls oc
   WHERE oc.id = p_job_id
   LIMIT 1;

  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'resolve_integration_plugin_egress_policy_for_job_v1 job % not found', p_job_id;
  END IF;

  BEGIN
    v_operation_id := NULLIF(COALESCE(v_job.context->>'operation_template_id', ''), '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_operation_id := NULL;
  END;

  IF v_operation_id IS NOT NULL THEN
    SELECT *
      INTO v_operation
      FROM public.operation_templates ot
     WHERE ot.id = v_operation_id
     LIMIT 1;

    IF v_operation.id IS NOT NULL THEN
      SELECT *
        INTO v_provider
        FROM public.providers p
       WHERE p.id = v_operation.provider_id
       LIMIT 1;
    END IF;
  END IF;

  IF v_provider.id IS NULL
     AND lower(COALESCE(v_job.target_type, '')) = 'provider'
     AND v_job.target_id IS NOT NULL
  THEN
    SELECT *
      INTO v_provider
      FROM public.providers p
     WHERE p.id = v_job.target_id
     LIMIT 1;
  END IF;

  v_org_id := v_provider.organization_id;
  IF v_org_id IS NULL THEN
    BEGIN
      v_org_id := public.resolve_organization_id_strict('outbound_call', p_job_id);
    EXCEPTION
      WHEN others THEN
        v_org_id := NULL;
    END;
  END IF;

  v_managed_by := lower(COALESCE(
    NULLIF(COALESCE(v_operation.metadata->>'managed_by', ''), ''),
    NULLIF(COALESCE(v_provider.metadata->>'managed_by', ''), ''),
    'platform'
  ));

  IF v_managed_by <> 'integration_plugin' THEN
    RETURN jsonb_build_object(
      'enforce', FALSE,
      'managed_by', v_managed_by,
      'organization_id', v_org_id,
      'policy', '{}'::jsonb
    );
  END IF;

  IF v_org_id IS NOT NULL THEN
    v_policy := public.resolve_settings('integration_plugin_egress_policy', 'tenant', v_org_id);
  END IF;

  IF v_policy IS NULL THEN
    v_policy := public.resolve_settings('integration_plugin_egress_policy', 'global', NULL);
  END IF;

  RETURN jsonb_build_object(
    'enforce', TRUE,
    'managed_by', 'integration_plugin',
    'organization_id', v_org_id,
    'policy', COALESCE(v_policy, '{}'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_integration_plugin_egress_policy_for_job_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_integration_plugin_egress_policy_for_job_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_integration_plugin_egress_policy_for_job_v1(UUID) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_caller_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.resolve_integration_plugin_egress_policy_for_job_v1(UUID) TO edge_api_caller_role';
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION api.resolve_integration_plugin_egress_policy_for_job_v1(
  p_job_id UUID
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.resolve_integration_plugin_egress_policy_for_job_v1(p_job_id);
$function$;

REVOKE ALL ON FUNCTION api.resolve_integration_plugin_egress_policy_for_job_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_integration_plugin_egress_policy_for_job_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION api.resolve_integration_plugin_egress_policy_for_job_v1(UUID) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_caller_role') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA api TO edge_api_caller_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION api.resolve_integration_plugin_egress_policy_for_job_v1(UUID) TO edge_api_caller_role';
  END IF;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202602220070_integration_plugin_egress_policy_resolver_v1'));
COMMIT;

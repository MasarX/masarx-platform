-- Migration: Console V2 geocode address projection
-- Purpose:
--   Keep the operator-facing address projection aligned with canonical geocode
--   truth. When workflow geocoding writes a primary geocode, the linked address
--   must expose coordinates and a validation state so Console V2 drawers do not
--   show stale "pending" state after a successful backend workflow.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605090245_console_v2_geocode_address_projection_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.project_address_from_primary_geocode_v1(
  p_address_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_address RECORD;
  v_geocode RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_min_confidence NUMERIC := NULL;
  v_validation_status TEXT := 'requires_review';
BEGIN
  SELECT *
    INTO v_address
    FROM public.addresses
   WHERE id = p_address_id
   ORDER BY created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'projected', FALSE,
      'reason', 'address_missing',
      'address_id', p_address_id
    );
  END IF;

  SELECT
      g.id,
      g.coordinates,
      g.confidence_score,
      g.provider_name,
      g.geocoded_at
    INTO v_geocode
    FROM public.geocodes g
   WHERE g.address_id = v_address.id
     AND g.client_id = v_address.client_id
     AND g.is_primary IS TRUE
     AND (g.expires_at IS NULL OR g.expires_at > now())
   ORDER BY g.geocoded_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'projected', FALSE,
      'reason', 'primary_geocode_missing',
      'address_id', v_address.id
    );
  END IF;

  v_policy := COALESCE(
    public.resolve_settings('geocoding_policy', 'client', v_address.client_id),
    public.resolve_settings('geocoding_policy', 'tenant', v_address.organization_id),
    public.resolve_settings('geocoding_policy', 'global', NULL),
    '{}'::jsonb
  );

  v_min_confidence := COALESCE(
    NULLIF(v_policy #>> '{local_lookup,min_confidence}', '')::NUMERIC,
    NULLIF(v_policy #>> '{provider_agreement_rules,primary_threshold}', '')::NUMERIC,
    NULLIF(v_policy ->> 'primary_threshold', '')::NUMERIC
  );

  IF v_min_confidence IS NOT NULL
     AND COALESCE(v_geocode.confidence_score, 0) >= v_min_confidence THEN
    v_validation_status := 'valid';
  END IF;

  PERFORM set_config('app.address_versioning_skip', '1', true);
  BEGIN
    UPDATE public.addresses
       SET coordinates = v_geocode.coordinates,
           validation_status = v_validation_status
     WHERE id = v_address.id
       AND client_id = v_address.client_id;
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config('app.address_versioning_skip', '0', true);
      RAISE;
  END;
  PERFORM set_config('app.address_versioning_skip', '0', true);

  RETURN jsonb_build_object(
    'projected', TRUE,
    'address_id', v_address.id,
    'geocode_id', v_geocode.id,
    'provider_name', v_geocode.provider_name,
    'confidence_score', v_geocode.confidence_score,
    'min_confidence', v_min_confidence,
    'validation_status', v_validation_status,
    'geocoded_at', v_geocode.geocoded_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.project_address_from_primary_geocode_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.project_address_from_primary_geocode_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.project_address_from_primary_geocode_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.project_address_from_primary_geocode_v1(UUID) TO service_role;

COMMENT ON FUNCTION public.project_address_from_primary_geocode_v1(UUID) IS
  'Projects canonical primary geocode coordinates/confidence onto the linked address validation projection using row-driven geocoding_policy thresholds.';

DO $$
BEGIN
  IF to_regprocedure('workflow_handlers.execute_geocode_cache_v1_console_v2_projection_base(public.workflow_run_steps, public.workflow_runs, jsonb)') IS NULL THEN
    EXECUTE 'ALTER FUNCTION workflow_handlers.execute_geocode_cache_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
             RENAME TO execute_geocode_cache_v1_console_v2_projection_base';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_geocode_cache_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO workflow_handlers, public, extensions, pg_temp
AS $function$
DECLARE
  v_response public.workflow_handler_response;
  v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_action TEXT := lower(COALESCE(NULLIF(v_metadata->>'action', ''), 'read'));
  v_ctx RECORD;
  v_projection JSONB := NULL;
BEGIN
  v_response := workflow_handlers.execute_geocode_cache_v1_console_v2_projection_base(
    p_step,
    p_run,
    p_operation_result
  );

  IF v_action = 'write'
     AND COALESCE((v_response.operation_result->>'written')::BOOLEAN, FALSE) THEN
    SELECT *
      INTO v_ctx
      FROM public.geocoding_extract_context(p_run);

    IF v_ctx.address_id IS NOT NULL THEN
      v_projection := public.project_address_from_primary_geocode_v1(v_ctx.address_id);
      v_response.operation_result := COALESCE(v_response.operation_result, '{}'::jsonb)
        || jsonb_build_object('address_projection', v_projection);
    END IF;
  END IF;

  RETURN v_response;
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_geocode_cache_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  SET search_path TO workflow_handlers, public, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_geocode_cache_v1(public.workflow_run_steps, public.workflow_runs, JSONB) IS
  'Console V2 projection wrapper: delegates canonical geocode cache writes, then projects primary geocode coordinates/status onto addresses for operator-facing read models.';

SELECT public.project_address_from_primary_geocode_v1(a.id)
  FROM public.addresses a
 WHERE a.validation_status = 'pending'
   AND EXISTS (
     SELECT 1
       FROM public.geocodes g
      WHERE g.address_id = a.id
        AND g.client_id = a.client_id
        AND g.is_primary IS TRUE
        AND (g.expires_at IS NULL OR g.expires_at > now())
   );

SELECT pg_advisory_unlock(hashtext('202605090245_console_v2_geocode_address_projection_v1'));
COMMIT;

-- Migration: Console V2 route-plan candidate read API v1
-- Purpose:
--   Expose the canonical delivery-wave candidate resolver through a browser-safe
--   api RPC so Console V2 can source the New route plan picker from eligible
--   route-plan candidates instead of the broad shipments list.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605070930_console_v2_route_plan_candidate_read_api_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_route_plan_delivery_wave_candidates_v1(
  p_input JSONB
)
RETURNS TABLE (
  sequence_order INT,
  shipment_id UUID,
  client_id UUID,
  zone_id UUID,
  branch_id UUID,
  service_level TEXT,
  promised_delivery_date DATE,
  promised_window_start_at TIMESTAMPTZ,
  promised_window_end_at TIMESTAMPTZ,
  priority_score NUMERIC,
  tracking_number TEXT,
  stop_payload JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_ctx RECORD;
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_payload JSONB := '{}'::jsonb;
  v_platform_org_id UUID := NULL;
BEGIN
  SELECT *
    INTO v_ctx
    FROM public.ui_route_plan_actor_context_v1('read')
   LIMIT 1;

  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'ui_route_plan_delivery_wave_candidates_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  v_payload := v_input - 'organization_id' - 'requested_by_user_id' - 'actor_user_id' - 'actor_system';

  IF v_ctx.is_platform IS TRUE THEN
    BEGIN
      v_platform_org_id := NULLIF(v_input->>'organization_id', '')::uuid;
    EXCEPTION WHEN others THEN
      v_platform_org_id := NULL;
    END;

    IF v_platform_org_id IS NULL THEN
      RAISE EXCEPTION 'ui_route_plan_delivery_wave_candidates_v1 platform read requires organization_id'
        USING ERRCODE = '23514';
    END IF;

    v_payload := jsonb_strip_nulls(v_payload || jsonb_build_object('organization_id', v_platform_org_id));
  ELSE
    v_payload := jsonb_strip_nulls(v_payload || jsonb_build_object('organization_id', v_ctx.organization_id));
  END IF;

  RETURN QUERY
  SELECT *
  FROM public.route_plan_delivery_wave_candidates_v1(v_payload);
END;
$function$;

COMMENT ON FUNCTION public.ui_route_plan_delivery_wave_candidates_v1(JSONB) IS
  'Authenticated UI read path for canonical route-plan delivery-wave candidates. Tenant context is derived server-side before calling route_plan_delivery_wave_candidates_v1.';

REVOKE ALL ON FUNCTION public.ui_route_plan_delivery_wave_candidates_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_route_plan_delivery_wave_candidates_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_route_plan_delivery_wave_candidates_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_route_plan_delivery_wave_candidates_v1(
  p_input JSONB
)
RETURNS TABLE (
  sequence_order INT,
  shipment_id UUID,
  client_id UUID,
  zone_id UUID,
  branch_id UUID,
  service_level TEXT,
  promised_delivery_date DATE,
  promised_window_start_at TIMESTAMPTZ,
  promised_window_end_at TIMESTAMPTZ,
  priority_score NUMERIC,
  tracking_number TEXT,
  stop_payload JSONB
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT * FROM public.ui_route_plan_delivery_wave_candidates_v1($1);
$function$;

COMMENT ON FUNCTION api.ui_route_plan_delivery_wave_candidates_v1(JSONB) IS
  'Browser-safe api wrapper for Console V2 route-plan candidate reads.';

REVOKE ALL ON FUNCTION api.ui_route_plan_delivery_wave_candidates_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_route_plan_delivery_wave_candidates_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_route_plan_delivery_wave_candidates_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605070930_console_v2_route_plan_candidate_read_api_v1'));

COMMIT;

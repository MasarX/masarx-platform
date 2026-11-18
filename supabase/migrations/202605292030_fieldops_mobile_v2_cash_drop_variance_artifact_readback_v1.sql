-- Migration: FieldOps Mobile V2 cash-drop variance artifact readback
-- Purpose:
--   Require non-zero cash-drop variance to reference a current-tenant
--   registered envelope artifact and expose that artifact in resolver readback.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605292030_fieldops_mobile_v2_cash_drop_variance_artifact_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.sign_fieldops_cash_drop_v1(
  p_expected_sar INT,
  p_actual_sar INT,
  p_supervisor_name TEXT,
  p_photo_id UUID,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_org      UUID;
  v_existing UUID;
  v_decision_id UUID;
  v_variance INT;
  v_supervisor TEXT := NULLIF(btrim(COALESCE(p_supervisor_name, '')), '');
  v_photo_storage_key TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'sign_fieldops_cash_drop_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'sign_fieldops_cash_drop_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'sign_fieldops_cash_drop_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_expected_sar IS NULL OR p_expected_sar < 0 THEN
    RAISE EXCEPTION 'sign_fieldops_cash_drop_v1: expected_sar must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF p_actual_sar IS NULL OR p_actual_sar < 0 THEN
    RAISE EXCEPTION 'sign_fieldops_cash_drop_v1: actual_sar must be >= 0' USING ERRCODE = '22023';
  END IF;

  v_variance := p_actual_sar - p_expected_sar;
  IF v_variance <> 0 THEN
    IF v_supervisor IS NULL OR p_photo_id IS NULL THEN
      RAISE EXCEPTION 'sign_fieldops_cash_drop_v1: variance % requires supervisor_name + photo_id', v_variance USING ERRCODE = '22023';
    END IF;

    SELECT a.storage_key
      INTO v_photo_storage_key
      FROM public.artifacts a
     WHERE a.id = p_photo_id
       AND a.organization_id = v_org
       AND a.storage_bucket = 'fieldops-evidence'
       AND a.storage_key LIKE (v_org::text || '/cash-drop/%')
       AND COALESCE(a.source_system, '') = 'fieldops_mobile_v2'
       AND COALESCE(a.metadata->>'artifact_kind', '') = 'cash_drop_envelope'
     LIMIT 1;

    IF v_photo_storage_key IS NULL THEN
      RAISE EXCEPTION 'sign_fieldops_cash_drop_v1: variance % requires current-tenant registered cash-drop photo artifact', v_variance USING ERRCODE = '22023';
    END IF;
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_cash_drop', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'variance_sar', v_variance
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_cash_drop',
    p_resource_type       := 'cash_drop',
    p_resource_id         := p_idempotency_key,
    p_decision_point      := 'sign_cash_drop',
    p_decision_outcome    := CASE WHEN v_variance = 0 THEN 'balanced' ELSE 'variance' END,
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'expected_sar',     p_expected_sar,
                               'actual_sar',       p_actual_sar,
                               'variance_sar',     v_variance,
                               'supervisor_name',  v_supervisor,
                               'photo_id',         p_photo_id,
                               'photo_storage_key', v_photo_storage_key,
                               'actor_user_id',    v_user_id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', CASE WHEN v_variance = 0 THEN 'balanced' ELSE 'variance' END,
    'variance_sar', v_variance
  );
END;
$$;

COMMENT ON FUNCTION public.sign_fieldops_cash_drop_v1(INT, INT, TEXT, UUID, UUID) IS
  'Mobile V2 COD cash-drop sign write. Validates non-negative amounts and requires current-tenant registered envelope artifact when variance != 0. Idempotent on p_idempotency_key.';

REVOKE ALL ON FUNCTION public.sign_fieldops_cash_drop_v1(INT, INT, TEXT, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sign_fieldops_cash_drop_v1(INT, INT, TEXT, UUID, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.sign_fieldops_cash_drop_v1(
  p_expected_sar INT,
  p_actual_sar INT,
  p_supervisor_name TEXT,
  p_photo_id UUID,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.sign_fieldops_cash_drop_v1(p_expected_sar, p_actual_sar, p_supervisor_name, p_photo_id, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.sign_fieldops_cash_drop_v1(INT, INT, TEXT, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.sign_fieldops_cash_drop_v1(INT, INT, TEXT, UUID, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_fieldops_cash_drop_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_policy JSONB;
  v_safe TEXT;
  v_latest_drop JSONB := NULL;
  v_expected_sar INT := 0;
  v_requested_route_run_id UUID;
  v_route_run_id UUID;
  v_route_expected NUMERIC := 0;
  v_tz TEXT := 'Asia/Riyadh';
  v_loc JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_cash_drop_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RETURN jsonb_build_object(
      'expected_sar', 0,
      'safe_location', '-',
      'latest_drop', NULL
    );
  END IF;

  BEGIN
    SELECT policy.value INTO v_policy
    FROM public.resolve_settings_row_from_policy_context_v1(
      'mobile_cash_policy',
      jsonb_build_object('organization_id', v_org)
    ) AS policy;
  EXCEPTION WHEN OTHERS THEN
    v_policy := '{}'::jsonb;
  END;

  v_safe := COALESCE(v_policy->>'safe_location', 'Hub safe');

  IF COALESCE(v_policy->>'default_expected_sar', '') ~ '^[0-9]+$' THEN
    v_expected_sar := (v_policy->>'default_expected_sar')::int;
  END IF;

  BEGIN
    SELECT public.resolve_settings('localization_policy', 'tenant', v_org)
      INTO v_loc;
    IF v_loc IS NULL THEN
      SELECT public.resolve_settings('localization_policy', 'global', NULL)
        INTO v_loc;
    END IF;
    IF v_loc IS NOT NULL AND v_loc ? 'timezone' THEN
      v_tz := COALESCE(NULLIF(v_loc->>'timezone', ''), v_tz);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  BEGIN
    v_requested_route_run_id := NULLIF(p_context->>'route_run_id', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_requested_route_run_id := NULL;
  END;

  IF v_requested_route_run_id IS NOT NULL THEN
    SELECT rr.id
      INTO v_route_run_id
      FROM public.route_runs rr
     WHERE rr.id = v_requested_route_run_id
       AND rr.organization_id = v_org
       AND rr.driver_user_id = v_user_id
     LIMIT 1;
  END IF;

  IF v_route_run_id IS NULL THEN
    SELECT rr.id
      INTO v_route_run_id
      FROM public.route_runs rr
     WHERE rr.organization_id = v_org
       AND rr.driver_user_id = v_user_id
       AND (
         rr.status IN ('in_progress', 'completed', 'planned', 'active')
         OR rr.planned_date = (now() AT TIME ZONE v_tz)::date
         OR rr.created_at::date = (now() AT TIME ZONE v_tz)::date
       )
     ORDER BY
       CASE rr.status
         WHEN 'in_progress' THEN 0
         WHEN 'active' THEN 1
         WHEN 'planned' THEN 2
         WHEN 'completed' THEN 3
         ELSE 4
       END,
       rr.updated_at DESC,
       rr.created_at DESC
     LIMIT 1;
  END IF;

  IF v_route_run_id IS NOT NULL THEN
    WITH stop_base AS (
      SELECT
        CASE
          WHEN latest_action.payment_collected_amount IS NOT NULL THEN latest_action.payment_collected_amount
          WHEN COALESCE(latest_action.action_data #>> '{delivery_completion,payment_collection,collected_amount}', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
            THEN (latest_action.action_data #>> '{delivery_completion,payment_collection,collected_amount}')::numeric
          WHEN COALESCE(latest_action.action_data #>> '{task_event_payload,delivery_completion,payment_collection,collected_amount}', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
            THEN (latest_action.action_data #>> '{task_event_payload,delivery_completion,payment_collection,collected_amount}')::numeric
          ELSE 0
        END AS collected_amount
      FROM public.route_stops rs
      JOIN public.shipments s
        ON s.id = rs.shipment_id
       AND s.organization_id = rs.organization_id
       AND s.client_id = rs.client_id
      LEFT JOIN LATERAL (
        SELECT
          sa.payment_collected_amount,
          sa.action_data
        FROM public.shipment_actions sa
        WHERE sa.organization_id = rs.organization_id
          AND sa.client_id = rs.client_id
          AND sa.shipment_id = rs.shipment_id
          AND sa.action_data->>'route_stop_id' = rs.id::text
        ORDER BY sa.timestamp DESC, sa.created_at DESC, sa.id DESC
        LIMIT 1
      ) latest_action ON TRUE
      WHERE rs.organization_id = v_org
        AND rs.route_run_id = v_route_run_id
    )
    SELECT COALESCE(SUM(collected_amount), 0)
      INTO v_route_expected
      FROM stop_base;

    IF v_route_expected > 0 THEN
      v_expected_sar := round(v_route_expected)::int;
    END IF;
  END IF;

  SELECT jsonb_build_object(
           'decision_log_id', dl.id,
           'state', dl.decision_outcome,
           'expected_sar', CASE
             WHEN COALESCE(dl.decision_inputs->>'expected_sar', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
               THEN round((dl.decision_inputs->>'expected_sar')::numeric)::int
             ELSE 0
           END,
           'actual_sar', CASE
             WHEN COALESCE(dl.decision_inputs->>'actual_sar', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
               THEN round((dl.decision_inputs->>'actual_sar')::numeric)::int
             ELSE 0
           END,
           'variance_sar', CASE
             WHEN COALESCE(dl.decision_inputs->>'variance_sar', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
               THEN round((dl.decision_inputs->>'variance_sar')::numeric)::int
             ELSE 0
           END,
           'supervisor_name', NULLIF(dl.decision_inputs->>'supervisor_name', ''),
           'photo_id', NULLIF(dl.decision_inputs->>'photo_id', ''),
           'photo_artifact_registered', photo.id IS NOT NULL,
           'photo_storage_key', photo.storage_key,
           'submitted_at', dl.timestamp
         )
    INTO v_latest_drop
    FROM public.decision_log dl
    LEFT JOIN LATERAL (
      SELECT a.id, a.storage_key
        FROM public.artifacts a
       WHERE a.organization_id = dl.organization_id
         AND a.storage_bucket = 'fieldops-evidence'
         AND a.id = CASE
           WHEN COALESCE(dl.decision_inputs->>'photo_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             THEN (dl.decision_inputs->>'photo_id')::uuid
           ELSE NULL
         END
       LIMIT 1
    ) photo ON TRUE
   WHERE dl.organization_id = v_org
     AND dl.decision_category = 'fieldops_cash_drop'
     AND dl.performed_by_system = 'fieldops_mobile_v2'
     AND dl.decision_inputs->>'actor_user_id' = v_user_id::text
   ORDER BY dl.timestamp DESC, dl.id DESC
   LIMIT 1;

  RETURN jsonb_build_object(
    'expected_sar', v_expected_sar,
    'safe_location', v_safe,
    'latest_drop', v_latest_drop
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_cash_drop_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_cash_drop_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_cash_drop_v1(TEXT, JSONB) IS
  'Mobile V2 cash drop expected/readback envelope. Resolves expected SAR from canonical route-stop payment collection truth, falls back to mobile_cash_policy default_expected_sar, and returns latest same-driver drop with registered envelope artifact readback.';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_cash_drop_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT public.resolve_fieldops_cash_drop_v1(p_active_role, p_context); $$;
REVOKE ALL ON FUNCTION api.resolve_fieldops_cash_drop_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_cash_drop_v1(TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605292030_fieldops_mobile_v2_cash_drop_variance_artifact_readback_v1'));
COMMIT;

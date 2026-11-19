-- Migration: FieldOps Mobile V2 EOR reconciliation readback
-- Date: 2026-05-27
--
-- Purpose:
--   Mobile V2 End-of-Route already renders a backend-backed summary, but the
--   live resolver did not return a reconciliation payload. The UI therefore
--   could only complete the hand-back checklist with an informational message
--   instead of submitting the existing submit_fieldops_eod_recon_v1 write.
--
--   This migration keeps the existing RPC contract and adds real, route-scoped
--   reconciliation inputs/readback to resolve_fieldops_eor_v1:
--     - route_label
--     - recon
--     - last_recon
--
--   Values are derived from canonical route_stops + payment_collection truth
--   and decision_log rows. Fixture/demo values remain outside live proof paths.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605270900_fieldops_mobile_v2_eor_recon_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable
)
VALUES (
  'decision_category',
  'Business decision categories for decision_log',
  'engineering',
  'tier_1',
  FALSE
)
ON CONFLICT (category) DO NOTHING;

WITH fieldops_mobile_v2_categories(value, label, description, sort_order) AS (
  VALUES
    ('fieldops_auth_otp', 'FieldOps OTP authentication', 'Mobile V2 OTP verification decisions.', 9400),
    ('fieldops_role_set', 'FieldOps role selection', 'Mobile V2 active role selection decisions.', 9401),
    ('fieldops_kyc_doc', 'FieldOps KYC document', 'Mobile V2 KYC document upload decisions.', 9402),
    ('fieldops_kyc_vehicle', 'FieldOps KYC vehicle', 'Mobile V2 vehicle registration decisions.', 9403),
    ('fieldops_cleaning_check', 'FieldOps cleaning check', 'Mobile V2 cleaning attestation decisions.', 9404),
    ('fieldops_pre_shift_gate', 'FieldOps pre-shift gate', 'Mobile V2 pre-shift gate decisions.', 9405),
    ('fieldops_incident', 'FieldOps incident', 'Mobile V2 incident report decisions.', 9406),
    ('fieldops_reassign', 'FieldOps reassignment', 'Mobile V2 stop reassignment request decisions.', 9407),
    ('fieldops_reschedule', 'FieldOps reschedule', 'Mobile V2 stop reschedule request decisions.', 9408),
    ('fieldops_damage_hold', 'FieldOps damage hold', 'Mobile V2 damaged parcel hold decisions.', 9409),
    ('fieldops_eod_recon', 'FieldOps EOD reconciliation', 'Mobile V2 end-of-day route reconciliation decisions.', 9410)
)
INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, status, metadata)
SELECT
  ld.id,
  c.value,
  c.label,
  c.description,
  c.sort_order,
  false,
  'active',
  jsonb_build_object('source', 'fieldops_mobile_v2_eor_recon_readback_v1')
FROM public.lookup_definitions ld
JOIN fieldops_mobile_v2_categories c ON TRUE
WHERE ld.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    retired_at = NULL,
    effective_until = NULL,
    updated_at = now(),
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata;

DROP FUNCTION IF EXISTS api.submit_fieldops_eod_recon_v1(INT, INT, NUMERIC, NUMERIC, TEXT, UUID);
DROP FUNCTION IF EXISTS public.submit_fieldops_eod_recon_v1(INT, INT, NUMERIC, NUMERIC, TEXT, UUID);

CREATE OR REPLACE FUNCTION public.resolve_fieldops_eor_v1(
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
  v_requested_route_run_id UUID;
  v_route_run_id UUID;
  v_route_started_at TIMESTAMPTZ;
  v_route_label TEXT := '';
  v_delivered INT := 0;
  v_failed INT := 0;
  v_total INT := 0;
  v_open INT := 0;
  v_parcels_count INT := 0;
  v_cash_declared NUMERIC := 0;
  v_cash_counted NUMERIC := 0;
  v_wallet_status TEXT := 'synced';
  v_tz TEXT := 'Asia/Riyadh';
  v_loc JSONB;
  v_cash_drop JSONB;
  v_last_recon JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_eor_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RETURN jsonb_build_object(
      'summary', jsonb_build_object('delivered', 0, 'failed', 0, 'total', 0),
      'checklist', '[]'::jsonb,
      'performance_note', NULL,
      'route_label', '',
      'recon', NULL,
      'last_recon', NULL
    );
  END IF;

  BEGIN
    SELECT public.resolve_settings('localization_policy', 'tenant', v_org)
    INTO v_loc;

    IF v_loc IS NULL THEN
      SELECT public.resolve_settings('localization_policy', 'global', NULL)
      INTO v_loc;
    END IF;

    IF v_loc IS NOT NULL AND (v_loc ? 'timezone') THEN
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
    SELECT rr.id,
           COALESCE(rr.started_at, rr.created_at),
           'RT-' || left(rr.id::text, 8)
      INTO v_route_run_id, v_route_started_at, v_route_label
      FROM public.route_runs rr
     WHERE rr.id = v_requested_route_run_id
       AND rr.organization_id = v_org
       AND rr.driver_user_id = v_user_id
     LIMIT 1;
  END IF;

  IF v_route_run_id IS NULL THEN
    SELECT rr.id,
           COALESCE(rr.started_at, rr.created_at),
           'RT-' || left(rr.id::text, 8)
      INTO v_route_run_id, v_route_started_at, v_route_label
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
        rs.id,
        rs.shipment_id,
        COALESCE(
          NULLIF(rs.metadata #>> '{execution,outcome}', ''),
          latest_action.route_stop_outcome,
          CASE
            WHEN latest_action.delivery_attempt_outcome = 'delivered' THEN 'done'
            WHEN latest_action.delivery_attempt_outcome IS NOT NULL THEN 'failed'
            ELSE NULL
          END,
          NULLIF(rs.metadata->>'status', ''),
          ''
        ) AS stop_status,
        CASE
          WHEN latest_action.payment_collected_amount IS NOT NULL THEN latest_action.payment_collected_amount
          WHEN COALESCE(latest_action.action_data #>> '{delivery_completion,payment_collection,collected_amount}', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
            THEN (latest_action.action_data #>> '{delivery_completion,payment_collection,collected_amount}')::numeric
          WHEN COALESCE(latest_action.action_data #>> '{task_event_payload,delivery_completion,payment_collection,collected_amount}', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
            THEN (latest_action.action_data #>> '{task_event_payload,delivery_completion,payment_collection,collected_amount}')::numeric
          ELSE 0
        END AS collected_amount,
        GREATEST(
          COALESCE(NULLIF(s.box_count, 0), 0),
          (
            SELECT count(*)::int
              FROM public.shipment_boxes sb
             WHERE sb.shipment_id = rs.shipment_id
          ),
          1
        ) AS parcel_count
      FROM public.route_stops rs
      JOIN public.shipments s
        ON s.id = rs.shipment_id
       AND s.organization_id = rs.organization_id
       AND s.client_id = rs.client_id
      LEFT JOIN LATERAL (
        SELECT
          sa.route_stop_outcome,
          sa.delivery_attempt_outcome,
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
    SELECT
      COALESCE(SUM(CASE WHEN lower(stop_status) IN ('done', 'delivered', 'completed') THEN 1 ELSE 0 END), 0)::int,
      COALESCE(SUM(CASE WHEN lower(stop_status) IN ('failed', 'partial', 'attempted', 'skipped') THEN 1 ELSE 0 END), 0)::int,
      count(*)::int,
      COALESCE(SUM(CASE WHEN lower(stop_status) NOT IN ('done', 'delivered', 'completed', 'failed', 'partial', 'attempted', 'skipped') THEN 1 ELSE 0 END), 0)::int,
      COALESCE(SUM(parcel_count), 0)::int,
      COALESCE(SUM(collected_amount), 0)
    INTO v_delivered, v_failed, v_total, v_open, v_parcels_count, v_cash_declared
    FROM stop_base;

    SELECT dl.decision_inputs
      INTO v_cash_drop
      FROM public.decision_log dl
     WHERE dl.organization_id = v_org
       AND dl.decision_category = 'fieldops_cash_drop'
       AND dl.performed_by_system = 'fieldops_mobile_v2'
       AND dl.decision_inputs->>'actor_user_id' = v_user_id::text
       AND dl.timestamp >= COALESCE(v_route_started_at, now() - interval '1 day')
     ORDER BY dl.timestamp DESC
     LIMIT 1;

    IF v_cash_drop IS NOT NULL THEN
      IF COALESCE(v_cash_drop->>'actual_sar', '') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN
        v_cash_counted := (v_cash_drop->>'actual_sar')::numeric;
      ELSE
        v_cash_counted := v_cash_declared;
      END IF;
      IF COALESCE(v_cash_drop->>'variance_sar', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
         AND (v_cash_drop->>'variance_sar')::numeric <> 0 THEN
        v_wallet_status := 'stale';
      END IF;
    ELSE
      v_cash_counted := v_cash_declared;
    END IF;

    SELECT jsonb_build_object(
             'decision_log_id', dl.id,
             'state', dl.decision_outcome,
             'route_run_id', dl.decision_inputs->>'route_run_id',
             'parcels_count', CASE WHEN COALESCE(dl.decision_inputs->>'parcels_count', '') ~ '^-?[0-9]+$' THEN (dl.decision_inputs->>'parcels_count')::int ELSE 0 END,
             'mismatch_count', CASE WHEN COALESCE(dl.decision_inputs->>'mismatch_count', '') ~ '^-?[0-9]+$' THEN (dl.decision_inputs->>'mismatch_count')::int ELSE 0 END,
             'cash_declared', CASE WHEN COALESCE(dl.decision_inputs->>'cash_declared', '') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (dl.decision_inputs->>'cash_declared')::numeric ELSE 0 END,
             'cash_counted', CASE WHEN COALESCE(dl.decision_inputs->>'cash_counted', '') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (dl.decision_inputs->>'cash_counted')::numeric ELSE 0 END,
             'cash_variance', CASE WHEN COALESCE(dl.decision_inputs->>'cash_variance', '') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (dl.decision_inputs->>'cash_variance')::numeric ELSE 0 END,
             'wallet_status', COALESCE(dl.decision_inputs->>'wallet_status', 'synced'),
             'submitted_at', dl.timestamp
           )
      INTO v_last_recon
      FROM public.decision_log dl
     WHERE dl.organization_id = v_org
       AND dl.decision_category = 'fieldops_eod_recon'
       AND dl.performed_by_system = 'fieldops_mobile_v2'
       AND dl.decision_inputs->>'actor_user_id' = v_user_id::text
       AND dl.decision_inputs->>'route_run_id' = v_route_run_id::text
       AND dl.timestamp >= COALESCE(v_route_started_at, now() - interval '1 day')
     ORDER BY dl.timestamp DESC
     LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'summary', jsonb_build_object(
      'delivered', v_delivered,
      'failed', v_failed,
      'total', v_total
    ),
    'checklist', jsonb_build_array(
      jsonb_build_object(
        'id','parcels',
        'icon','package',
        'label','Returned undelivered parcels',
        'sub', (v_failed + v_open)::text || ' parcels in vehicle'
      ),
      jsonb_build_object(
        'id','cash',
        'icon','cash',
        'label','Hand over COD cash',
        'sub', CASE
                 WHEN v_cash_declared > 0 THEN trim(to_char(v_cash_declared, 'FM999999990.00')) || ' SAR collected'
                 ELSE 'No COD collected'
               END
      ),
      jsonb_build_object('id','devices','icon','shield','label','Plug in handheld + scanner','sub','Battery report uploaded'),
      jsonb_build_object('id','sync','icon','cloud-up','label','Final sync','sub','Outbox check')
    ),
    'performance_note', NULL,
    'route_label', COALESCE(v_route_label, ''),
    'recon', CASE
      WHEN v_route_run_id IS NULL THEN NULL
      ELSE jsonb_build_object(
        'parcels_count', v_parcels_count,
        'mismatch_count', v_open,
        'cash_declared', v_cash_declared,
        'cash_counted', v_cash_counted,
        'wallet_status', v_wallet_status,
        'route_run_id', v_route_run_id
      )
    END,
    'last_recon', v_last_recon
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_eor_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_eor_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_eor_v1(TEXT, JSONB) IS
  'Mobile V2 end-of-route hand-back envelope. Resolves tenant timezone, route-scoped summary, COD/EOD reconciliation inputs, and latest EOD decision-log readback without fixture fallback.';

CREATE OR REPLACE FUNCTION public.submit_fieldops_eod_recon_v1(
  p_parcels_count INT,
  p_mismatch_count INT,
  p_cash_declared NUMERIC,
  p_cash_counted NUMERIC,
  p_wallet_status TEXT,
  p_idempotency_key UUID,
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id     UUID := auth.uid();
  v_org         UUID;
  v_wallet      TEXT := lower(btrim(COALESCE(p_wallet_status, '')));
  v_existing    UUID;
  v_decision_id UUID;
  v_variance    NUMERIC;
  v_outcome     TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_eod_recon_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_eod_recon_v1 requires organization context' USING ERRCODE = '42501';
  END IF;

  IF p_route_run_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_eod_recon_v1 requires route_run_id' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.route_runs rr
     WHERE rr.id = p_route_run_id
       AND rr.organization_id = v_org
       AND rr.driver_user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'submit_fieldops_eod_recon_v1 route_run_id is not visible to caller' USING ERRCODE = '42501';
  END IF;

  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_eod_recon_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_parcels_count IS NULL OR p_parcels_count < 0 THEN
    RAISE EXCEPTION 'submit_fieldops_eod_recon_v1: parcels_count must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF p_mismatch_count IS NULL OR p_mismatch_count < 0 THEN
    RAISE EXCEPTION 'submit_fieldops_eod_recon_v1: mismatch_count must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF p_cash_declared IS NULL OR p_cash_declared < 0 THEN
    RAISE EXCEPTION 'submit_fieldops_eod_recon_v1: cash_declared must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF p_cash_counted IS NULL OR p_cash_counted < 0 THEN
    RAISE EXCEPTION 'submit_fieldops_eod_recon_v1: cash_counted must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF v_wallet NOT IN ('synced', 'stale', 'offline') THEN
    RAISE EXCEPTION 'submit_fieldops_eod_recon_v1: invalid wallet_status %', p_wallet_status USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_eod_recon', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'route_run_id', p_route_run_id
    );
  END IF;

  v_variance := p_cash_counted - p_cash_declared;
  v_outcome  := CASE
                  WHEN p_mismatch_count = 0 AND v_variance = 0 AND v_wallet = 'synced' THEN 'clean'
                  ELSE 'with_variances'
                END;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_eod_recon',
    p_resource_type       := 'route_run',
    p_resource_id         := p_route_run_id,
    p_decision_point      := 'submit_eod_recon',
    p_decision_outcome    := v_outcome,
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'route_run_id',   p_route_run_id,
                               'parcels_count',  p_parcels_count,
                               'mismatch_count', p_mismatch_count,
                               'cash_declared',  p_cash_declared,
                               'cash_counted',   p_cash_counted,
                               'cash_variance',  v_variance,
                               'wallet_status',  v_wallet,
                               'actor_user_id',  v_user_id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', v_outcome,
    'route_run_id', p_route_run_id,
    'cash_variance', v_variance
  );
END;
$$;

COMMENT ON FUNCTION public.submit_fieldops_eod_recon_v1(INT, INT, NUMERIC, NUMERIC, TEXT, UUID, UUID) IS
  'Mobile V2 route-scoped EOD reconciliation write. Validates caller-owned route_run_id and stores route lineage for same-screen readback.';

REVOKE ALL ON FUNCTION public.submit_fieldops_eod_recon_v1(INT, INT, NUMERIC, NUMERIC, TEXT, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_eod_recon_v1(INT, INT, NUMERIC, NUMERIC, TEXT, UUID, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_fieldops_eor_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT public.resolve_fieldops_eor_v1(p_active_role, p_context); $$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_eor_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_eor_v1(TEXT, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_eod_recon_v1(
  p_parcels_count INT,
  p_mismatch_count INT,
  p_cash_declared NUMERIC,
  p_cash_counted NUMERIC,
  p_wallet_status TEXT,
  p_idempotency_key UUID,
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_eod_recon_v1(
    p_parcels_count,
    p_mismatch_count,
    p_cash_declared,
    p_cash_counted,
    p_wallet_status,
    p_idempotency_key,
    p_route_run_id
  );
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_eod_recon_v1(INT, INT, NUMERIC, NUMERIC, TEXT, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_eod_recon_v1(INT, INT, NUMERIC, NUMERIC, TEXT, UUID, UUID) TO authenticated, service_role;

DO $$
DECLARE
  v_canonical_sections JSONB;
  v_setting RECORD;
  v_current JSONB;
  v_apps JSONB;
  v_mobile JSONB;
  v_sections JSONB;
  v_new_sections JSONB;
  v_section JSONB;
  v_canonical_section JSONB;
  v_new_items JSONB;
  v_item JSONB;
  v_seen_section_ids TEXT[];
  v_existing_item_ids TEXT[];
BEGIN
  SELECT sv.value #> '{apps,mobile,sections}'
    INTO v_canonical_sections
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF jsonb_typeof(COALESCE(v_canonical_sections, 'null'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Mobile V2 EOR readiness requires global ui_navigation.apps.mobile.sections';
  END IF;

  FOR v_setting IN
    SELECT s.id AS setting_id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
       AND NOT (s.scope_type = 'global' AND s.scope_id IS NULL)
  LOOP
    v_current := v_setting.value;
    v_apps := COALESCE(v_current->'apps', '{}'::jsonb);
    v_mobile := COALESCE(v_apps->'mobile', jsonb_build_object('sections', '[]'::jsonb));
    v_sections := COALESCE(v_mobile->'sections', '[]'::jsonb);
    v_new_sections := '[]'::jsonb;
    v_seen_section_ids := ARRAY[]::TEXT[];

    FOR v_section IN SELECT value FROM jsonb_array_elements(v_sections) AS value LOOP
      v_seen_section_ids := array_append(v_seen_section_ids, v_section->>'id');
      v_canonical_section := NULL;

      SELECT value
        INTO v_canonical_section
        FROM jsonb_array_elements(v_canonical_sections) AS value
       WHERE value->>'id' = v_section->>'id'
       LIMIT 1;

      IF v_canonical_section IS NOT NULL AND (v_section->>'id') LIKE 'v2-%' THEN
        v_new_items := COALESCE(v_section->'items', '[]'::jsonb);

        SELECT COALESCE(array_agg(item->>'id'), ARRAY[]::TEXT[])
          INTO v_existing_item_ids
          FROM jsonb_array_elements(v_new_items) AS item;

        FOR v_item IN
          SELECT value
            FROM jsonb_array_elements(COALESCE(v_canonical_section->'items', '[]'::jsonb)) AS value
        LOOP
          IF NOT (COALESCE(v_item->>'id', '') = ANY(v_existing_item_ids)) THEN
            v_new_items := v_new_items || jsonb_build_array(v_item);
            v_existing_item_ids := array_append(v_existing_item_ids, v_item->>'id');
          END IF;
        END LOOP;

        v_section := jsonb_set(v_section, '{items}', v_new_items, true);
      END IF;

      v_new_sections := v_new_sections || jsonb_build_array(v_section);
    END LOOP;

    FOR v_canonical_section IN
      SELECT value
        FROM jsonb_array_elements(v_canonical_sections) AS value
       WHERE value->>'id' LIKE 'v2-%'
    LOOP
      IF NOT (COALESCE(v_canonical_section->>'id', '') = ANY(v_seen_section_ids)) THEN
        v_new_sections := v_new_sections || jsonb_build_array(v_canonical_section);
      END IF;
    END LOOP;

    v_mobile := jsonb_set(v_mobile, '{sections}', v_new_sections, true);
    v_apps := jsonb_set(v_apps, '{mobile}', v_mobile, true);
    v_current := jsonb_set(v_current, '{apps}', v_apps, true);

    IF v_current IS DISTINCT FROM v_setting.value THEN
      UPDATE public.settings_versions
         SET value = v_current,
             version = v_setting.version + 1,
             change_reason = 'Mobile V2 EOR readiness: sync scoped ui_navigation with canonical Mobile V2 sections.',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_setting.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_current,
             last_updated = now()
       WHERE id = v_setting.setting_id;
    END IF;
  END LOOP;
END $$;

SELECT pg_advisory_unlock(hashtext('202605270900_fieldops_mobile_v2_eor_recon_readback_v1'));
COMMIT;

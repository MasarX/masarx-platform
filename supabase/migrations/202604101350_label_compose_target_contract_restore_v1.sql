-- Migration: restore label compose settings contract + generic target aliases
-- Purpose:
--   - Restore label_render_policy / label_print_profile enrichment and
--     settings-resolution provenance in compose_label_payload after the
--     platform-role compatibility rewrite regressed those fields.
--   - Keep batch + compact compose flows aligned by routing them through the
--     canonical single-job compose contract.
--   - Publish generic target aliases (target.type/id/box_id/code/label) that
--     the label renderer already reads for target-neutral labels.

BEGIN;

SET search_path TO public, pg_temp;

CREATE OR REPLACE FUNCTION public.resolve_label_target_payload(
  p_target_type TEXT,
  p_target_id UUID,
  p_target_box_id UUID DEFAULT NULL
)
RETURNS TABLE (
  organization_id UUID,
  client_id UUID,
  target_type TEXT,
  target_id UUID,
  target_box_id UUID,
  barcode TEXT,
  barcode_format TEXT,
  payload JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_target_type TEXT := public.normalize_label_target_type(p_target_type);
BEGIN
  IF v_target_type IS NULL THEN
    RAISE EXCEPTION 'Unsupported label target type %', p_target_type
      USING ERRCODE = '22023';
  END IF;

  IF p_target_id IS NULL THEN
    RAISE EXCEPTION 'Label target id is required'
      USING ERRCODE = '23502';
  END IF;

  IF v_target_type = 'route_run' THEN
    RETURN QUERY
    WITH route_data AS (
      SELECT
        rr.*,
        COALESCE(rr.metadata ->> 'barcode', rr.metadata ->> 'route_code', rr.id::text) AS target_code
      FROM public.route_runs rr
      WHERE rr.id = p_target_id
    )
    SELECT
      rr.organization_id,
      NULL::uuid AS client_id,
      'route_run'::text AS target_type,
      rr.id AS target_id,
      p_target_box_id AS target_box_id,
      rr.target_code AS barcode,
      'CODE128'::text AS barcode_format,
      jsonb_strip_nulls(
        jsonb_build_object(
          'target',
          jsonb_build_object(
            'type', 'route_run',
            'id', rr.id,
            'box_id', p_target_box_id,
            'label', rr.target_code,
            'code', rr.target_code,
            'target_type', 'route_run',
            'target_id', rr.id,
            'target_box_id', p_target_box_id,
            'barcode', rr.target_code,
            'barcode_format', 'CODE128'
          ),
          'route_run',
          jsonb_build_object(
            'id', rr.id,
            'organization_id', rr.organization_id,
            'branch_id', rr.branch_id,
            'driver_user_id', rr.driver_user_id,
            'vehicle_id', rr.vehicle_id,
            'status', rr.status,
            'planned_date', rr.planned_date,
            'planned_start_at', rr.planned_start_at,
            'planned_end_at', rr.planned_end_at,
            'started_at', rr.started_at,
            'ended_at', rr.ended_at,
            'metadata', rr.metadata,
            'created_at', rr.created_at,
            'code', rr.target_code
          ),
          'barcode', rr.target_code,
          'barcode_format', 'CODE128'
        )
      ) AS payload
    FROM route_data rr;
    RETURN;
  ELSIF v_target_type = 'handling_unit' THEN
    RETURN QUERY
    SELECT
      hu.organization_id,
      NULL::uuid AS client_id,
      'handling_unit'::text AS target_type,
      hu.id AS target_id,
      p_target_box_id AS target_box_id,
      hu.code AS barcode,
      'CODE128'::text AS barcode_format,
      jsonb_strip_nulls(
        jsonb_build_object(
          'target',
          jsonb_build_object(
            'type', 'handling_unit',
            'id', hu.id,
            'box_id', p_target_box_id,
            'label', hu.code,
            'code', hu.code,
            'target_type', 'handling_unit',
            'target_id', hu.id,
            'target_box_id', p_target_box_id,
            'barcode', hu.code,
            'barcode_format', 'CODE128'
          ),
          'handling_unit',
          jsonb_build_object(
            'id', hu.id,
            'organization_id', hu.organization_id,
            'branch_id', hu.branch_id,
            'unit_type', hu.unit_type,
            'status', hu.status,
            'code', hu.code,
            'metadata', hu.metadata,
            'created_at', hu.created_at
          ),
          'barcode', hu.code,
          'barcode_format', 'CODE128'
        )
      ) AS payload
    FROM public.handling_units hu
    WHERE hu.id = p_target_id;
    RETURN;
  ELSIF v_target_type = 'warehouse_transfer' THEN
    RETURN QUERY
    WITH transfer_data AS (
      SELECT
        wt.*,
        COALESCE(NULLIF(wt.transfer_code, ''), wt.id::text) AS target_code
      FROM public.warehouse_transfers wt
      WHERE wt.id = p_target_id
    )
    SELECT
      wt.organization_id,
      NULL::uuid AS client_id,
      'warehouse_transfer'::text AS target_type,
      wt.id AS target_id,
      p_target_box_id AS target_box_id,
      wt.target_code AS barcode,
      'CODE128'::text AS barcode_format,
      jsonb_strip_nulls(
        jsonb_build_object(
          'target',
          jsonb_build_object(
            'type', 'warehouse_transfer',
            'id', wt.id,
            'box_id', p_target_box_id,
            'label', wt.target_code,
            'code', wt.target_code,
            'target_type', 'warehouse_transfer',
            'target_id', wt.id,
            'target_box_id', p_target_box_id,
            'barcode', wt.target_code,
            'barcode_format', 'CODE128'
          ),
          'warehouse_transfer',
          jsonb_build_object(
            'id', wt.id,
            'organization_id', wt.organization_id,
            'from_branch_id', wt.from_branch_id,
            'to_branch_id', wt.to_branch_id,
            'status', wt.status,
            'transfer_code', wt.transfer_code,
            'vehicle_id', wt.vehicle_id,
            'driver_user_id', wt.driver_user_id,
            'created_by_user_id', wt.created_by_user_id,
            'planned_dispatch_at', wt.planned_dispatch_at,
            'planned_receive_at', wt.planned_receive_at,
            'dispatched_at', wt.dispatched_at,
            'received_at', wt.received_at,
            'metadata', wt.metadata,
            'created_at', wt.created_at,
            'code', wt.target_code
          ),
          'barcode', wt.target_code,
          'barcode_format', 'CODE128'
        )
      ) AS payload
    FROM transfer_data wt;
    RETURN;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.compose_label_payload(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_job public.label_jobs%ROWTYPE;
  v_sender_id UUID;
  v_scope_type TEXT;
  v_scope_id UUID;

  v_policy_row RECORD;
  v_policy JSONB;
  v_policy_resolution_id UUID := NULL;

  v_print_row RECORD;
  v_print_profile JSONB;
  v_print_resolution_id UUID := NULL;

  v_payload JSONB;
  v_shipment_metadata JSONB;
  v_explicit_header_mode TEXT;
  v_effective_header_mode TEXT;
  v_target RECORD;
  v_claim_role TEXT := lower(NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')), ''));
BEGIN
  SELECT *
    INTO v_job
    FROM public.label_jobs
   WHERE id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Label job % not found', p_job_id;
  END IF;

  IF COALESCE(v_claim_role, lower(current_user)) NOT IN (
    'service_role',
    'edge_label_renderer_role',
    'postgres',
    'supabase_admin'
  ) THEN
    IF public.current_user_org_id() IS NULL OR public.current_user_org_id() <> v_job.organization_id THEN
      RAISE EXCEPTION 'Access denied for label job %', p_job_id;
    END IF;
  END IF;

  IF v_job.shipment_id IS NOT NULL THEN
    SELECT s.sender_id
      INTO v_sender_id
      FROM public.shipments s
     WHERE s.id = v_job.shipment_id;
  END IF;

  IF v_sender_id IS NOT NULL THEN
    v_scope_type := 'sender';
    v_scope_id := v_sender_id;
  ELSIF v_job.client_id IS NOT NULL THEN
    v_scope_type := 'client';
    v_scope_id := v_job.client_id;
  ELSIF v_job.organization_id IS NOT NULL THEN
    v_scope_type := 'tenant';
    v_scope_id := v_job.organization_id;
  ELSE
    v_scope_type := 'global';
    v_scope_id := NULL;
  END IF;

  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row('label_render_policy', v_scope_type, v_scope_id)
   LIMIT 1;

  IF NOT FOUND OR v_policy_row.value IS NULL THEN
    SELECT *
      INTO v_policy_row
      FROM public.resolve_settings_row('label_render_policy', 'global', NULL)
     LIMIT 1;
  END IF;

  IF NOT FOUND OR v_policy_row.value IS NULL THEN
    RAISE EXCEPTION 'label_render_policy missing (global) - seed defaults before rendering';
  END IF;

  v_policy := v_policy_row.value;

  v_policy_resolution_id := public.log_settings_resolution(
    p_organization_id := v_job.organization_id,
    p_category := 'label_render_policy',
    p_winning_scope_type := v_policy_row.scope_type,
    p_winning_scope_id := v_policy_row.scope_id,
    p_winning_settings_id := v_policy_row.settings_id,
    p_winning_settings_version_id := v_policy_row.settings_version_id,
    p_winning_version := v_policy_row.version,
    p_scope_path := COALESCE(v_policy_row.scope_path, '[]'::jsonb),
    p_inputs := jsonb_strip_nulls(
      jsonb_build_object(
        'label_job_id', v_job.id,
        'shipment_id', v_job.shipment_id,
        'shipment_box_id', v_job.shipment_box_id,
        'target_type', v_job.target_type,
        'target_id', v_job.target_id,
        'target_box_id', v_job.target_box_id,
        'client_id', v_job.client_id,
        'sender_id', v_sender_id,
        'label_type', v_job.label_type
      )
    ),
    p_merge_notes := NULL
  );

  SELECT *
    INTO v_print_row
    FROM public.resolve_settings_row('label_print_profile', v_scope_type, v_scope_id)
   LIMIT 1;

  IF NOT FOUND OR v_print_row.value IS NULL THEN
    SELECT *
      INTO v_print_row
      FROM public.resolve_settings_row('label_print_profile', 'global', NULL)
     LIMIT 1;
  END IF;

  IF NOT FOUND OR v_print_row.value IS NULL THEN
    RAISE EXCEPTION 'label_print_profile missing (global) - seed defaults before rendering';
  END IF;

  v_print_profile := v_print_row.value;

  v_print_resolution_id := public.log_settings_resolution(
    p_organization_id := v_job.organization_id,
    p_category := 'label_print_profile',
    p_winning_scope_type := v_print_row.scope_type,
    p_winning_scope_id := v_print_row.scope_id,
    p_winning_settings_id := v_print_row.settings_id,
    p_winning_settings_version_id := v_print_row.settings_version_id,
    p_winning_version := v_print_row.version,
    p_scope_path := COALESCE(v_print_row.scope_path, '[]'::jsonb),
    p_inputs := jsonb_strip_nulls(
      jsonb_build_object(
        'label_job_id', v_job.id,
        'shipment_id', v_job.shipment_id,
        'shipment_box_id', v_job.shipment_box_id,
        'target_type', v_job.target_type,
        'target_id', v_job.target_id,
        'target_box_id', v_job.target_box_id,
        'client_id', v_job.client_id,
        'sender_id', v_sender_id,
        'label_type', v_job.label_type
      )
    ),
    p_merge_notes := NULL
  );

  IF v_job.shipment_id IS NOT NULL THEN
    SELECT to_jsonb(payload)
      INTO v_payload
      FROM public.shipment_label_payload_v payload
     WHERE payload.shipment_id = v_job.shipment_id
       AND (
         v_job.shipment_box_id IS NULL
         OR payload.shipment_box_id = v_job.shipment_box_id
       )
     ORDER BY payload.box_number NULLS FIRST
     LIMIT 1;
  ELSE
    SELECT *
      INTO v_target
      FROM public.resolve_label_target_payload(
        v_job.target_type,
        v_job.target_id,
        v_job.target_box_id
      )
     LIMIT 1;
    v_payload := COALESCE(v_target.payload, '{}'::jsonb);
  END IF;

  v_payload := COALESCE(v_payload, '{}'::jsonb);
  v_payload := jsonb_set(v_payload, '{label_render_policy}', v_policy, TRUE);
  v_payload := jsonb_set(v_payload, '{label_print_profile}', v_print_profile, TRUE);

  v_payload := jsonb_set(
    v_payload,
    '{label_render_policy_resolution}',
    jsonb_strip_nulls(
      jsonb_build_object(
        'settings_resolution_id', v_policy_resolution_id,
        'winning_scope_type', v_policy_row.scope_type,
        'winning_scope_id', v_policy_row.scope_id,
        'version', v_policy_row.version
      )
    ),
    TRUE
  );

  v_payload := jsonb_set(
    v_payload,
    '{label_print_profile_resolution}',
    jsonb_strip_nulls(
      jsonb_build_object(
        'settings_resolution_id', v_print_resolution_id,
        'winning_scope_type', v_print_row.scope_type,
        'winning_scope_id', v_print_row.scope_id,
        'version', v_print_row.version
      )
    ),
    TRUE
  );

  v_shipment_metadata := v_payload -> 'shipment_metadata';
  IF v_shipment_metadata IS NULL OR jsonb_typeof(v_shipment_metadata) <> 'object' THEN
    v_shipment_metadata := '{}'::jsonb;
  END IF;

  v_explicit_header_mode := NULLIF(
    btrim(
      COALESCE(
        v_shipment_metadata ->> 'header_brand_mode',
        v_shipment_metadata ->> 'headerBrandMode'
      )
    ),
    ''
  );

  v_effective_header_mode := COALESCE(
    v_explicit_header_mode,
    NULLIF(btrim(v_policy ->> 'header_brand_mode'), '')
  );

  IF v_effective_header_mode IS NULL THEN
    RAISE EXCEPTION 'label_render_policy.header_brand_mode missing (global) - seed defaults before rendering';
  END IF;

  v_shipment_metadata := jsonb_set(
    v_shipment_metadata,
    '{header_brand_mode}',
    to_jsonb(v_effective_header_mode),
    TRUE
  );
  v_payload := jsonb_set(v_payload, '{shipment_metadata}', v_shipment_metadata, TRUE);

  RETURN jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id,
      'organization_id', v_job.organization_id,
      'client_id', v_job.client_id,
      'shipment_id', v_job.shipment_id,
      'shipment_box_id', v_job.shipment_box_id,
      'target_type', v_job.target_type,
      'target_id', v_job.target_id,
      'target_box_id', v_job.target_box_id,
      'target_metadata', COALESCE(v_job.target_metadata, '{}'::jsonb),
      'label_type', v_job.label_type,
      'attempts', v_job.attempts,
      'max_attempts', v_job.max_attempts,
      'template', v_job.template_snapshot,
      'renderer_hint', v_job.renderer_hint,
      'retry_state', v_job.retry_state,
      'workflow_run_step_id', NULL
    ),
    'payload', v_payload
  );
END;
$function$;

COMMENT ON FUNCTION public.compose_label_payload(UUID)
  IS 'Return canonical payload + template snapshot for a label job, including resolved settings and target-neutral jobs.';

CREATE OR REPLACE FUNCTION public.compose_label_payloads(p_job_ids UUID[])
RETURNS TABLE (
  job_id UUID,
  composed JSONB,
  compose_ms NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
  SELECT
    j.id AS job_id,
    public.compose_label_payload(j.id) AS composed,
    0::numeric AS compose_ms
  FROM public.label_jobs j
  WHERE j.id = ANY (p_job_ids)
  ORDER BY array_position(p_job_ids, j.id);
$function$;

CREATE OR REPLACE FUNCTION public.lease_and_compose_label_payloads_compact(
  p_job_ids UUID[],
  p_lease_seconds INTEGER DEFAULT 300,
  p_max_jobs INTEGER DEFAULT 10
)
RETURNS TABLE (
  job_id UUID,
  composed JSONB,
  compose_ms NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_lease_interval INTERVAL := make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 300), 60));
  v_max_jobs INTEGER := LEAST(GREATEST(COALESCE(p_max_jobs, 10), 1), 100);
  v_expected_count INTEGER := 0;
BEGIN
  IF p_job_ids IS NULL OR array_length(p_job_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  v_expected_count := LEAST(v_max_jobs, array_length(p_job_ids, 1));
  IF v_expected_count <= 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT lj.id
    FROM public.label_jobs lj
    WHERE lj.id = ANY (p_job_ids)
      AND lj.status = 'pending'
      AND lj.scheduled_at <= now()
      AND lj.attempts < lj.max_attempts
    ORDER BY lj.scheduled_at, lj.created_at
    LIMIT v_expected_count
    FOR UPDATE SKIP LOCKED
  ),
  candidate_count AS (
    SELECT COUNT(*)::int AS cnt
    FROM candidate
  ),
  guarded_candidate AS (
    SELECT c.id
    FROM candidate c
    CROSS JOIN candidate_count cc
    WHERE cc.cnt = v_expected_count
  ),
  leased AS (
    UPDATE public.label_jobs lj
    SET status = 'in_progress',
        attempts = lj.attempts + 1,
        last_attempt_at = now(),
        lease_expires_at = now() + v_lease_interval
    FROM guarded_candidate gc
    WHERE lj.id = gc.id
    RETURNING lj.id
  )
  SELECT
    l.id AS job_id,
    public.compose_label_payload(l.id) AS composed,
    0::numeric AS compose_ms
  FROM leased l
  ORDER BY array_position(p_job_ids, l.id);
END;
$function$;

COMMIT;

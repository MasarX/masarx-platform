-- Migration: label_generation_target_neutral_v1
-- Purpose: Generalize label generation to target-neutral jobs while preserving shipment label behavior.

BEGIN;

SET search_path TO public, pg_temp;

CREATE OR REPLACE FUNCTION public.normalize_label_target_type(p_target_type TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE lower(btrim(COALESCE(p_target_type, '')))
    WHEN 'route' THEN 'route_run'
    WHEN 'route_run' THEN 'route_run'
    WHEN 'route_runs' THEN 'route_run'
    WHEN 'route-run' THEN 'route_run'
    WHEN 'container' THEN 'handling_unit'
    WHEN 'handling_unit' THEN 'handling_unit'
    WHEN 'handling_units' THEN 'handling_unit'
    WHEN 'handling-unit' THEN 'handling_unit'
    WHEN 'transfer' THEN 'warehouse_transfer'
    WHEN 'branch_transfer' THEN 'warehouse_transfer'
    WHEN 'branch_transfers' THEN 'warehouse_transfer'
    WHEN 'warehouse_transfer' THEN 'warehouse_transfer'
    WHEN 'warehouse_transfers' THEN 'warehouse_transfer'
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION public.default_label_type_for_target_type(p_target_type TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE public.normalize_label_target_type(p_target_type)
    WHEN 'route_run' THEN 'route'
    WHEN 'handling_unit' THEN 'container'
    WHEN 'warehouse_transfer' THEN 'transfer'
    ELSE NULL
  END;
$function$;

DROP FUNCTION IF EXISTS public.resolve_label_target_payload(TEXT, UUID, UUID);

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
    SELECT
      rr.organization_id,
      NULL::uuid AS client_id,
      'route_run'::text AS target_type,
      rr.id AS target_id,
      p_target_box_id AS target_box_id,
      COALESCE(rr.metadata ->> 'barcode', rr.metadata ->> 'route_code', rr.id::text) AS barcode,
      'CODE128'::text AS barcode_format,
      jsonb_strip_nulls(
        jsonb_build_object(
          'target',
          jsonb_build_object(
            'target_type', 'route_run',
            'target_id', rr.id,
            'target_box_id', p_target_box_id,
            'barcode', COALESCE(rr.metadata ->> 'barcode', rr.metadata ->> 'route_code', rr.id::text),
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
            'created_at', rr.created_at
          ),
          'barcode', COALESCE(rr.metadata ->> 'barcode', rr.metadata ->> 'route_code', rr.id::text),
          'barcode_format', 'CODE128'
        )
      ) AS payload
    FROM route_runs rr
    WHERE rr.id = p_target_id;
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
    FROM handling_units hu
    WHERE hu.id = p_target_id;
    RETURN;
  ELSIF v_target_type = 'warehouse_transfer' THEN
    RETURN QUERY
    SELECT
      wt.organization_id,
      NULL::uuid AS client_id,
      'warehouse_transfer'::text AS target_type,
      wt.id AS target_id,
      p_target_box_id AS target_box_id,
      COALESCE(NULLIF(wt.transfer_code, ''), wt.id::text) AS barcode,
      'CODE128'::text AS barcode_format,
      jsonb_strip_nulls(
        jsonb_build_object(
          'target',
          jsonb_build_object(
            'target_type', 'warehouse_transfer',
            'target_id', wt.id,
            'target_box_id', p_target_box_id,
            'barcode', COALESCE(NULLIF(wt.transfer_code, ''), wt.id::text),
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
            'created_at', wt.created_at
          ),
          'barcode', COALESCE(NULLIF(wt.transfer_code, ''), wt.id::text),
          'barcode_format', 'CODE128'
        )
      ) AS payload
    FROM warehouse_transfers wt
    WHERE wt.id = p_target_id;
    RETURN;
  END IF;
END;
$function$;

ALTER TABLE public.label_jobs
  ADD COLUMN IF NOT EXISTS target_type TEXT,
  ADD COLUMN IF NOT EXISTS target_id UUID,
  ADD COLUMN IF NOT EXISTS target_box_id UUID,
  ADD COLUMN IF NOT EXISTS target_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ALTER COLUMN client_id DROP NOT NULL,
  ALTER COLUMN shipment_id DROP NOT NULL;

COMMENT ON COLUMN public.label_jobs.target_type IS 'Target-neutral label generation type, normalized to route_run, handling_unit, or warehouse_transfer.';
COMMENT ON COLUMN public.label_jobs.target_id IS 'Target entity id for target-neutral label generation.';
COMMENT ON COLUMN public.label_jobs.target_box_id IS 'Optional target-scoped box/container id for target-neutral label generation.';
COMMENT ON COLUMN public.label_jobs.target_metadata IS 'Target-neutral lineage metadata captured at request time.';

DROP TABLE IF EXISTS public.label_artifacts CASCADE;

CREATE TABLE public.label_artifacts (
  id UUID DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id UUID,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  target_box_id UUID,
  label_type TEXT NOT NULL,
  barcode TEXT NOT NULL,
  barcode_format TEXT NOT NULL,
  layout_template_id UUID NOT NULL,
  file_url TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  generated_by UUID,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  print_count INTEGER NOT NULL DEFAULT 0,
  last_printed_at TIMESTAMPTZ,
  source_label_job_id UUID NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  renderer_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, organization_id),
  UNIQUE (source_label_job_id)
);

CREATE INDEX IF NOT EXISTS idx_label_artifacts_org_target
  ON public.label_artifacts (organization_id, target_type, target_id, target_box_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_label_artifacts_file_url
  ON public.label_artifacts (file_url);

CREATE OR REPLACE FUNCTION public.label_artifacts_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_label_artifacts_set_updated_at ON public.label_artifacts;

CREATE TRIGGER trg_label_artifacts_set_updated_at
  BEFORE UPDATE ON public.label_artifacts
  FOR EACH ROW
  EXECUTE FUNCTION public.label_artifacts_set_updated_at();

ALTER TABLE public.label_artifacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.label_artifacts FROM PUBLIC;
REVOKE ALL ON TABLE public.label_artifacts FROM anon;
REVOKE ALL ON TABLE public.label_artifacts FROM authenticated;

DROP POLICY IF EXISTS label_artifacts_select_authenticated ON public.label_artifacts;
CREATE POLICY label_artifacts_select_authenticated
  ON public.label_artifacts
  FOR SELECT
  TO authenticated
  USING (organization_id = current_user_org_id());

DROP POLICY IF EXISTS label_artifacts_service_all ON public.label_artifacts;
CREATE POLICY label_artifacts_service_all
  ON public.label_artifacts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.request_label_generation_target_v1(
  p_target_type TEXT,
  p_target_id UUID,
  p_label_type TEXT,
  p_requested_by UUID DEFAULT NULL,
  p_requested_source TEXT DEFAULT NULL,
  p_target_box_id UUID DEFAULT NULL,
  p_job_purpose TEXT DEFAULT 'primary'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_target_type TEXT := public.normalize_label_target_type(p_target_type);
  v_target RECORD;
  v_template RECORD;
  v_job_id UUID;
  v_idempotency_key TEXT;
  v_retry_backoff JSONB;
  v_job_purpose TEXT := COALESCE(NULLIF(p_job_purpose, ''), 'primary');
  v_inserted BOOLEAN := FALSE;
  v_label_type TEXT := COALESCE(NULLIF(lower(btrim(p_label_type)), ''), public.default_label_type_for_target_type(p_target_type));
  v_claim_role TEXT := lower(NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')), ''));
BEGIN
  IF v_target_type IS NULL THEN
    RAISE EXCEPTION 'Unsupported label target type %', p_target_type
      USING ERRCODE = '22023';
  END IF;

  IF p_target_id IS NULL THEN
    RAISE EXCEPTION 'Label target id is required'
      USING ERRCODE = '23502';
  END IF;

  IF v_label_type IS NULL THEN
    RAISE EXCEPTION 'Label type is required for target %', p_target_type
      USING ERRCODE = '23502';
  END IF;

  SELECT *
    INTO v_target
    FROM public.resolve_label_target_payload(v_target_type, p_target_id, p_target_box_id)
   LIMIT 1;

  IF v_target.organization_id IS NULL THEN
    RAISE EXCEPTION 'Target % not found for organization lookup', p_target_id
      USING ERRCODE = '23503';
  END IF;

  IF COALESCE(v_claim_role, lower(current_user)) NOT IN ('service_role', 'edge_label_renderer_role') THEN
    IF current_user_org_id() IS NULL OR current_user_org_id() <> v_target.organization_id THEN
      RAISE EXCEPTION 'Access denied for label target %', p_target_id;
    END IF;
  END IF;

  SELECT *
    INTO v_template
    FROM public.resolve_label_template(
      v_target.organization_id,
      v_target.client_id,
      NULL,
      v_label_type
    )
   LIMIT 1;

  IF v_template.template_id IS NULL THEN
    RAISE EXCEPTION 'Unable to resolve label template for target % label_type %', p_target_id, v_label_type;
  END IF;

  v_retry_backoff := COALESCE(v_template.retry_backoff, '[]'::jsonb);
  v_idempotency_key := format(
    '%s:%s:%s:%s:%s:%s:%s',
    v_target.organization_id,
    v_target_type,
    p_target_id,
    COALESCE(p_target_box_id::text, '00000000-0000-0000-0000-000000000000'),
    v_label_type,
    v_template.template_id,
    v_job_purpose
  );

  INSERT INTO public.label_jobs (
    organization_id,
    client_id,
    shipment_id,
    shipment_box_id,
    target_type,
    target_id,
    target_box_id,
    target_metadata,
    label_type,
    template_id,
    template_version,
    template_snapshot,
    status,
    attempts,
    max_attempts,
    scheduled_at,
    job_purpose,
    idempotency_key,
    requested_by,
    requested_source,
    renderer_hint,
    retry_state
  )
  VALUES (
    v_target.organization_id,
    v_target.client_id,
    NULL,
    NULL,
    v_target_type,
    p_target_id,
    p_target_box_id,
    COALESCE(v_target.payload, '{}'::jsonb),
    v_label_type,
    v_template.template_id,
    v_template.template_version,
    v_template.template_snapshot,
    'pending',
    0,
    COALESCE(v_template.max_attempts, 5),
    now(),
    v_job_purpose,
    v_idempotency_key,
    p_requested_by,
    p_requested_source,
    v_template.template_snapshot -> 'label_config' ->> 'provider_hint',
    v_retry_backoff
  )
  ON CONFLICT ON CONSTRAINT label_jobs_unique_request DO NOTHING
  RETURNING id INTO v_job_id;

  IF v_job_id IS NOT NULL THEN
    v_inserted := TRUE;
  END IF;

  IF v_job_id IS NULL THEN
    SELECT id
      INTO v_job_id
      FROM public.label_jobs
     WHERE organization_id = v_target.organization_id
       AND target_type = v_target_type
       AND target_id = p_target_id
       AND target_box_id IS NOT DISTINCT FROM p_target_box_id
       AND label_type = v_label_type
       AND template_id = v_template.template_id
       AND job_purpose = v_job_purpose
     ORDER BY created_at DESC
     LIMIT 1;
  END IF;

  PERFORM public.log_decision(
    p_organization_id := v_target.organization_id,
    p_decision_category := 'label_job',
    p_resource_type := 'label_job',
    p_resource_id := v_job_id,
    p_decision_point := 'request_label_generation_target',
    p_decision_outcome := CASE WHEN v_inserted THEN 'enqueued' ELSE 'reused' END,
    p_performed_by_system := 'workflow_engine',
    p_correlation_id := NULL,
    p_decision_inputs := jsonb_build_object(
      'target_type', v_target_type,
      'target_id', p_target_id,
      'target_box_id', p_target_box_id,
      'label_type', v_label_type,
      'template_id', v_template.template_id,
      'template_version', v_template.template_version,
      'job_purpose', v_job_purpose
    ),
    p_decision_reason := CASE WHEN v_inserted THEN NULL ELSE 'idempotent_reuse' END
  );

  RETURN v_job_id;
END;
$function$;

COMMENT ON FUNCTION public.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT)
  IS 'Create or return an idempotent label job for a non-shipment target and label type.';

REVOKE ALL ON FUNCTION public.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) TO edge_label_renderer_role;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.request_label_generation_target_for_step_v1(
  p_workflow_run_step_id UUID,
  p_target_type TEXT,
  p_target_id UUID,
  p_label_type TEXT,
  p_requested_by UUID DEFAULT NULL,
  p_requested_source TEXT DEFAULT NULL,
  p_target_box_id UUID DEFAULT NULL,
  p_job_purpose TEXT DEFAULT 'primary'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
BEGIN
  PERFORM set_config('app.workflow_run_step_id', COALESCE(p_workflow_run_step_id::text, ''), true);
  PERFORM set_config('platform.workflow_run_step_id', COALESCE(p_workflow_run_step_id::text, ''), true);
  RETURN public.request_label_generation_target_v1(
    p_target_type := p_target_type,
    p_target_id := p_target_id,
    p_label_type := p_label_type,
    p_requested_by := p_requested_by,
    p_requested_source := p_requested_source,
    p_target_box_id := p_target_box_id,
    p_job_purpose := p_job_purpose
  );
END;
$function$;

COMMENT ON FUNCTION public.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT)
  IS 'Create or return an idempotent non-shipment label job while preserving workflow step context.';

REVOKE ALL ON FUNCTION public.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) TO edge_label_renderer_role;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.compose_label_payload(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_job label_jobs%ROWTYPE;
  v_payload JSONB;
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

  IF COALESCE(v_claim_role, lower(current_user)) NOT IN ('service_role', 'edge_label_renderer_role') THEN
    IF current_user_org_id() IS NULL OR current_user_org_id() <> v_job.organization_id THEN
      RAISE EXCEPTION 'Access denied for label job %', p_job_id;
    END IF;
  END IF;

  IF v_job.shipment_id IS NOT NULL THEN
    SELECT to_jsonb(payload)
      INTO v_payload
      FROM shipment_label_payload_v payload
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
    'payload', COALESCE(v_payload, '{}'::jsonb)
  );
END;
$function$;

COMMENT ON FUNCTION public.compose_label_payload(UUID)
  IS 'Return canonical payload + template snapshot for a label job, including target-neutral jobs.';

CREATE OR REPLACE FUNCTION public.compose_label_payloads(p_job_ids UUID[])
RETURNS TABLE (job_id UUID, composed JSONB, compose_ms NUMERIC)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH jobs AS (
    SELECT lj.*
    FROM public.label_jobs lj
    WHERE lj.id = ANY (p_job_ids)
  ),
  payload_by_job AS (
    SELECT
      j.id AS job_id,
      CASE
        WHEN j.shipment_id IS NOT NULL THEN COALESCE(to_jsonb(p), '{}'::jsonb)
        ELSE COALESCE(t.payload, '{}'::jsonb)
      END AS payload
    FROM jobs j
    LEFT JOIN LATERAL (
      SELECT p.*
      FROM public.shipment_label_payload_v p
      WHERE p.shipment_id = j.shipment_id
        AND (
          j.shipment_box_id IS NULL
          OR p.shipment_box_id = j.shipment_box_id
        )
      ORDER BY p.box_number NULLS FIRST
      LIMIT 1
    ) p ON j.shipment_id IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT tp.payload
      FROM public.resolve_label_target_payload(j.target_type, j.target_id, j.target_box_id) tp
      LIMIT 1
    ) t ON j.shipment_id IS NULL
  )
  SELECT
    j.id AS job_id,
    jsonb_build_object(
      'job',
      jsonb_build_object(
        'id', j.id,
        'organization_id', j.organization_id,
        'client_id', j.client_id,
        'shipment_id', j.shipment_id,
        'shipment_box_id', j.shipment_box_id,
        'target_type', j.target_type,
        'target_id', j.target_id,
        'target_box_id', j.target_box_id,
        'target_metadata', COALESCE(j.target_metadata, '{}'::jsonb),
        'label_type', j.label_type,
        'attempts', j.attempts,
        'max_attempts', j.max_attempts,
        'template', j.template_snapshot,
        'renderer_hint', j.renderer_hint,
        'retry_state', j.retry_state
      ),
      'payload',
      payload_by_job.payload
    ) AS composed,
    0::numeric AS compose_ms
  FROM jobs j
  JOIN payload_by_job ON payload_by_job.job_id = j.id;
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
    RETURNING lj.*
  ),
  payload_by_job AS (
    SELECT
      l.id AS job_id,
      CASE
        WHEN l.shipment_id IS NOT NULL THEN COALESCE(to_jsonb(p), '{}'::jsonb)
        ELSE COALESCE(t.payload, '{}'::jsonb)
      END AS payload
    FROM leased l
    LEFT JOIN LATERAL (
      SELECT p.*
      FROM public.shipment_label_payload_v p
      WHERE p.shipment_id = l.shipment_id
        AND (
          l.shipment_box_id IS NULL
          OR p.shipment_box_id = l.shipment_box_id
        )
      ORDER BY p.box_number NULLS FIRST
      LIMIT 1
    ) p ON l.shipment_id IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT tp.payload
      FROM public.resolve_label_target_payload(l.target_type, l.target_id, l.target_box_id) tp
      LIMIT 1
    ) t ON l.shipment_id IS NULL
  )
  SELECT
    l.id AS job_id,
    jsonb_build_object(
      'job',
      jsonb_build_object(
        'id', l.id,
        'organization_id', l.organization_id,
        'client_id', l.client_id,
        'shipment_id', l.shipment_id,
        'shipment_box_id', l.shipment_box_id,
        'target_type', l.target_type,
        'target_id', l.target_id,
        'target_box_id', l.target_box_id,
        'target_metadata', COALESCE(l.target_metadata, '{}'::jsonb),
        'label_type', l.label_type,
        'attempts', l.attempts,
        'max_attempts', l.max_attempts,
        'template', l.template_snapshot,
        'renderer_hint', l.renderer_hint,
        'retry_state', l.retry_state
      ),
      'payload',
      payload_by_job.payload
    ) AS composed,
    0::numeric AS compose_ms
  FROM leased l
  JOIN payload_by_job ON payload_by_job.job_id = l.id;
END;
$function$;

COMMENT ON FUNCTION public.lease_and_compose_label_payloads_compact(UUID[], INTEGER, INTEGER)
  IS 'All-or-none compact helper: lease explicit pending label jobs and compose payloads in one call; returns zero rows when full lease cannot be satisfied.';

CREATE OR REPLACE FUNCTION public.complete_label_job(
  p_job_id UUID,
  p_status TEXT,
  p_file_url TEXT,
  p_file_size_bytes INTEGER,
  p_renderer_metadata JSONB DEFAULT NULL,
  p_error_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_job label_jobs%ROWTYPE;
  v_now TIMESTAMPTZ := now();
  v_barcode TEXT;
  v_barcode_format TEXT;
  v_label_id UUID;
  v_label_metadata JSONB;
  v_retry_seconds INTEGER;
  v_retry_length INTEGER;
  v_index INTEGER;
  v_max_delay INTEGER := 3600;
  v_target RECORD;
  v_claim_role TEXT := lower(NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')), ''));
BEGIN
  SELECT *
    INTO v_job
    FROM public.label_jobs
   WHERE id = p_job_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Label job % not found', p_job_id;
  END IF;

  IF COALESCE(v_claim_role, lower(current_user)) NOT IN ('service_role', 'edge_label_renderer_role') THEN
    IF current_user_org_id() IS NULL OR current_user_org_id() <> v_job.organization_id THEN
      RAISE EXCEPTION 'Access denied for label job %', p_job_id;
    END IF;
  END IF;

  IF lower(p_status) = 'succeeded' THEN
    IF v_job.shipment_id IS NOT NULL THEN
      IF v_job.shipment_box_id IS NOT NULL THEN
        SELECT barcode
          INTO v_barcode
          FROM shipment_boxes
         WHERE id = v_job.shipment_box_id;
      END IF;

      IF v_barcode IS NULL THEN
        SELECT sb.barcode
          INTO v_barcode
          FROM shipment_boxes sb
         WHERE sb.shipment_id = v_job.shipment_id
         ORDER BY sb.box_number
         LIMIT 1;
      END IF;
    ELSE
      SELECT *
        INTO v_target
        FROM public.resolve_label_target_payload(
          v_job.target_type,
          v_job.target_id,
          v_job.target_box_id
        )
       LIMIT 1;
      v_barcode := v_target.barcode;
      v_barcode_format := COALESCE(v_target.barcode_format, 'CODE128');
    END IF;

    v_barcode := COALESCE(
      v_barcode,
      v_job.template_snapshot -> 'label_config' ->> 'fallback_barcode'
    );

    IF v_barcode IS NULL THEN
      RAISE EXCEPTION 'Unable to resolve barcode for label job %', p_job_id;
    END IF;

    v_barcode_format := COALESCE(
      v_barcode_format,
      v_job.template_snapshot -> 'label_config' ->> 'barcode_format',
      v_job.template_snapshot -> 'renderer_config' -> 'barcode' ->> 'type',
      'CODE128'
    );

    v_label_id := COALESCE(v_job.label_id, gen_random_uuid());

    v_label_metadata := jsonb_strip_nulls(
      jsonb_build_object(
        'label_job_id', v_job.id,
        'template', v_job.template_snapshot,
        'target', CASE
          WHEN v_job.target_type IS NULL THEN NULL
          ELSE jsonb_build_object(
            'target_type', v_job.target_type,
            'target_id', v_job.target_id,
            'target_box_id', v_job.target_box_id
          )
        END,
        'target_metadata', CASE
          WHEN v_job.target_type IS NULL THEN NULL
          ELSE COALESCE(v_job.target_metadata, '{}'::jsonb)
        END
      )
    );

    IF v_job.shipment_id IS NOT NULL THEN
      INSERT INTO public.labels (
        id,
        shipment_id,
        label_type,
        barcode,
        barcode_format,
        layout_template_id,
        file_url,
        file_size_bytes,
        generated_by,
        generated_at,
        print_count,
        last_printed_at,
        metadata,
        renderer_metadata
      )
      VALUES (
        v_label_id,
        v_job.shipment_id,
        v_job.label_type,
        v_barcode,
        v_barcode_format,
        v_job.template_id,
        p_file_url,
        COALESCE(p_file_size_bytes, 0),
        v_job.requested_by,
        v_now,
        1,
        v_now,
        v_label_metadata,
        COALESCE(p_renderer_metadata, '{}'::jsonb)
      )
      ON CONFLICT (id, shipment_id) DO UPDATE
      SET file_url = EXCLUDED.file_url,
          file_size_bytes = EXCLUDED.file_size_bytes,
          generated_by = EXCLUDED.generated_by,
          generated_at = EXCLUDED.generated_at,
          last_printed_at = EXCLUDED.last_printed_at,
          print_count = labels.print_count + 1,
          metadata = EXCLUDED.metadata,
          renderer_metadata = EXCLUDED.renderer_metadata;
    ELSE
      INSERT INTO public.label_artifacts (
        id,
        organization_id,
        client_id,
        target_type,
        target_id,
        target_box_id,
        label_type,
        barcode,
        barcode_format,
        layout_template_id,
        file_url,
        file_size_bytes,
        generated_by,
        generated_at,
        print_count,
        last_printed_at,
        source_label_job_id,
        metadata,
        renderer_metadata
      )
      VALUES (
        v_label_id,
        v_job.organization_id,
        v_job.client_id,
        v_job.target_type,
        v_job.target_id,
        v_job.target_box_id,
        v_job.label_type,
        v_barcode,
        v_barcode_format,
        v_job.template_id,
        p_file_url,
        COALESCE(p_file_size_bytes, 0),
        v_job.requested_by,
        v_now,
        1,
        v_now,
        v_job.id,
        v_label_metadata,
        COALESCE(p_renderer_metadata, '{}'::jsonb)
      )
      ON CONFLICT (source_label_job_id) DO UPDATE
      SET file_url = EXCLUDED.file_url,
          file_size_bytes = EXCLUDED.file_size_bytes,
          generated_by = EXCLUDED.generated_by,
          generated_at = EXCLUDED.generated_at,
          last_printed_at = EXCLUDED.last_printed_at,
          print_count = public.label_artifacts.print_count + 1,
          metadata = EXCLUDED.metadata,
          renderer_metadata = EXCLUDED.renderer_metadata;
    END IF;

    UPDATE public.label_jobs
    SET status = 'succeeded',
        completed_at = v_now,
        lease_expires_at = NULL,
        output_file_url = p_file_url,
        output_file_size_bytes = COALESCE(p_file_size_bytes, 0),
        renderer_metadata = COALESCE(p_renderer_metadata, '{}'::jsonb),
        error_reason = NULL,
        label_id = v_label_id
    WHERE id = v_job.id;

    IF v_job.shipment_id IS NOT NULL THEN
      INSERT INTO shipment_actions (
        id,
        shipment_id,
        action_type,
        action_category,
        action_data,
        timestamp,
        created_at,
        performed_by_system
      )
      VALUES (
        gen_random_uuid(),
        v_job.shipment_id,
        'label_generated',
        'operational',
        jsonb_build_object(
          'label_job_id', v_job.id,
          'label_id', v_label_id,
          'attempts', v_job.attempts,
          'template_version', v_job.template_version
        ),
        v_now,
        v_now,
        'label_renderer'
      );
    END IF;

    PERFORM public.log_decision(
      p_organization_id := v_job.organization_id,
      p_decision_category := 'label_job',
      p_resource_type := 'label_job',
      p_resource_id := v_job.id,
      p_decision_point := 'complete_label_job',
      p_decision_outcome := 'render_succeeded',
      p_performed_by_system := 'label_renderer',
      p_correlation_id := NULL,
      p_decision_inputs := jsonb_build_object(
        'label_id', v_label_id,
        'file_url', p_file_url,
        'file_size_bytes', COALESCE(p_file_size_bytes, 0),
        'attempts', v_job.attempts + 1,
        'template_id', v_job.template_id,
        'template_version', v_job.template_version,
        'target_type', v_job.target_type,
        'target_id', v_job.target_id,
        'target_box_id', v_job.target_box_id
      )
    );
  ELSE
    v_retry_length := COALESCE(jsonb_array_length(v_job.retry_state), 0);
    IF v_retry_length >= v_job.attempts AND v_job.attempts > 0 THEN
      v_index := v_job.attempts;
      v_retry_seconds := COALESCE((v_job.retry_state ->> (v_index - 1))::INTEGER, 0);
    ELSE
      v_retry_seconds := 0;
    END IF;
    IF v_retry_seconds <= 0 THEN
      v_retry_seconds := LEAST(v_max_delay, 60 * (2 ^ GREATEST(v_job.attempts - 1, 0)));
    END IF;
    v_retry_seconds := LEAST(v_max_delay, GREATEST(v_retry_seconds, 30));

    IF v_job.attempts >= v_job.max_attempts THEN
      UPDATE public.label_jobs
      SET status = 'failed',
          completed_at = v_now,
          lease_expires_at = NULL,
          renderer_metadata = COALESCE(p_renderer_metadata, '{}'::jsonb),
          error_reason = COALESCE(p_error_reason, 'max_attempts_exceeded')
      WHERE id = v_job.id;

      PERFORM public.log_decision(
        p_organization_id := v_job.organization_id,
        p_decision_category := 'label_job',
        p_resource_type := 'label_job',
        p_resource_id := v_job.id,
        p_decision_point := 'complete_label_job',
        p_decision_outcome := 'render_failed',
        p_performed_by_system := 'label_renderer',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_build_object(
          'attempts', v_job.attempts,
          'max_attempts', v_job.max_attempts,
          'template_id', v_job.template_id,
          'template_version', v_job.template_version,
          'target_type', v_job.target_type,
          'target_id', v_job.target_id,
          'target_box_id', v_job.target_box_id
        ),
        p_decision_reason := COALESCE(p_error_reason, 'max_attempts_exceeded')
      );
    ELSE
      UPDATE public.label_jobs
      SET status = 'pending',
          lease_expires_at = NULL,
          scheduled_at = v_now + make_interval(secs => v_retry_seconds),
          renderer_metadata = COALESCE(p_renderer_metadata, '{}'::jsonb),
          error_reason = p_error_reason
      WHERE id = v_job.id;

      PERFORM public.log_decision(
        p_organization_id := v_job.organization_id,
        p_decision_category := 'label_job',
        p_resource_type := 'label_job',
        p_resource_id := v_job.id,
        p_decision_point := 'complete_label_job',
        p_decision_outcome := 'render_retry_scheduled',
        p_performed_by_system := 'label_renderer',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_build_object(
          'next_attempt_in_seconds', v_retry_seconds,
          'attempts', v_job.attempts,
          'max_attempts', v_job.max_attempts,
          'template_id', v_job.template_id,
          'template_version', v_job.template_version,
          'target_type', v_job.target_type,
          'target_id', v_job.target_id,
          'target_box_id', v_job.target_box_id
        ),
        p_decision_reason := p_error_reason
      );
    END IF;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.complete_label_job(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT)
  IS 'Mark a label job as succeeded or failed, updating labels or label_artifacts and scheduling retries.';

CREATE OR REPLACE FUNCTION public.request_label_reprint(
  p_label_id UUID,
  p_actor_id UUID DEFAULT NULL,
  p_requested_source TEXT DEFAULT 'reprint'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_label RECORD;
  v_template_snapshot JSONB;
  v_template_version INTEGER;
  v_template_id UUID;
  v_retry JSONB;
  v_max_attempts INTEGER;
  v_job_id UUID;
  v_source_job label_jobs%ROWTYPE;
  v_claim_role TEXT := lower(NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')), ''));
BEGIN
  SELECT
    l.*,
    s.organization_id,
    s.client_id,
    s.sender_id,
    sb.id AS matched_box_id,
    NULL::text AS target_type,
    NULL::uuid AS target_id,
    NULL::uuid AS target_box_id,
    NULL::uuid AS source_label_job_id
  INTO v_label
  FROM labels l
  JOIN shipments s ON s.id = l.shipment_id
  LEFT JOIN shipment_boxes sb ON sb.barcode = l.barcode
  WHERE l.id = p_label_id;

  IF NOT FOUND THEN
    SELECT
      la.id,
      la.organization_id,
      la.client_id,
      NULL::uuid AS shipment_id,
      NULL::uuid AS matched_box_id,
      la.target_type,
      la.target_id,
      la.target_box_id,
      la.label_type,
      la.layout_template_id,
      la.metadata,
      la.source_label_job_id
    INTO v_label
    FROM label_artifacts la
    WHERE la.id = p_label_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Label % not found', p_label_id;
  END IF;

  IF COALESCE(v_claim_role, lower(current_user)) NOT IN ('service_role', 'edge_label_renderer_role') THEN
    IF current_user_org_id() IS NULL OR current_user_org_id() <> v_label.organization_id THEN
      RAISE EXCEPTION 'Access denied for label %', p_label_id;
    END IF;
  END IF;

  IF v_label.source_label_job_id IS NOT NULL THEN
    SELECT *
      INTO v_source_job
      FROM public.label_jobs
     WHERE id = v_label.source_label_job_id
     LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Source label job % not found for label %', v_label.source_label_job_id, p_label_id;
    END IF;

    v_template_snapshot := COALESCE(v_source_job.template_snapshot, '{}'::jsonb);
    v_template_version := v_source_job.template_version;
    v_template_id := v_source_job.template_id;
    v_retry := COALESCE(v_source_job.retry_state, '[]'::jsonb);
    v_max_attempts := v_source_job.max_attempts;
  ELSE
    v_template_snapshot := COALESCE(v_label.metadata -> 'template', '{}'::jsonb);

    IF jsonb_typeof(v_template_snapshot) IS DISTINCT FROM 'object'
        OR v_template_snapshot = '{}'::jsonb THEN
      SELECT
        rt.template_snapshot,
        rt.template_version,
        rt.template_id,
        rt.max_attempts,
        rt.retry_backoff
      INTO v_template_snapshot,
           v_template_version,
           v_template_id,
           v_max_attempts,
           v_retry
      FROM resolve_label_template(
        v_label.organization_id,
        v_label.client_id,
        v_label.sender_id,
        v_label.label_type
      ) AS rt
      LIMIT 1;
    ELSE
      v_template_version := COALESCE((v_template_snapshot ->> 'template_version')::INTEGER, 1);
      v_template_id := COALESCE(v_label.layout_template_id, (v_template_snapshot ->> 'template_id')::UUID);
      v_retry := COALESCE(v_template_snapshot -> 'label_config' -> 'retry_backoff_seconds', '[]'::jsonb);
      v_max_attempts := COALESCE((v_template_snapshot -> 'label_config' ->> 'max_attempts')::INTEGER, 5);
    END IF;
  END IF;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'Template reference missing for label %', p_label_id;
  END IF;

  INSERT INTO public.label_jobs (
    organization_id,
    client_id,
    shipment_id,
    shipment_box_id,
    target_type,
    target_id,
    target_box_id,
    target_metadata,
    label_id,
    label_type,
    template_id,
    template_version,
    template_snapshot,
    status,
    attempts,
    max_attempts,
    scheduled_at,
    job_purpose,
    idempotency_key,
    requested_by,
    requested_source,
    renderer_hint,
    retry_state
  )
  VALUES (
    v_label.organization_id,
    COALESCE(v_label.client_id, v_source_job.client_id),
    CASE WHEN v_label.shipment_id IS NOT NULL THEN v_label.shipment_id ELSE NULL END,
    CASE WHEN v_label.shipment_id IS NOT NULL THEN v_label.matched_box_id ELSE NULL END,
    v_label.target_type,
    v_label.target_id,
    v_label.target_box_id,
    COALESCE(v_label.metadata, '{}'::jsonb),
    p_label_id,
    v_label.label_type,
    v_template_id,
    v_template_version,
    v_template_snapshot,
    'pending',
    0,
    COALESCE(v_max_attempts, 5),
    now(),
    'reprint',
    gen_random_uuid()::text,
    p_actor_id,
    p_requested_source,
    v_template_snapshot -> 'label_config' ->> 'provider_hint',
    COALESCE(v_retry, '[]'::jsonb)
  )
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$function$;

COMMENT ON FUNCTION public.request_label_reprint(UUID, UUID, TEXT)
  IS 'Queue a reprint job using the original template snapshot stored on the label or label_artifact.';

DROP FUNCTION IF EXISTS public.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID);

CREATE OR REPLACE FUNCTION public.resolve_label_files_for_bundle(
  p_org_id UUID,
  p_shipment_ids UUID[] DEFAULT NULL,
  p_label_ids UUID[] DEFAULT NULL,
  p_client_id UUID DEFAULT NULL,
  p_sender_id UUID DEFAULT NULL
)
RETURNS TABLE (
  label_id UUID,
  shipment_id UUID,
  shipment_box_id UUID,
  target_type TEXT,
  target_id UUID,
  target_box_id UUID,
  file_url TEXT,
  box_number INT,
  label_type TEXT,
  generated_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
  WITH shipments_scope AS (
    SELECT s.id AS shipment_id
    FROM shipments s
    WHERE s.organization_id = p_org_id
      AND (p_client_id IS NULL OR s.client_id = p_client_id)
      AND (p_sender_id IS NULL OR s.sender_id = p_sender_id)
      AND (p_shipment_ids IS NULL OR s.id = ANY(p_shipment_ids))
  ),
  latest_labels AS (
    SELECT DISTINCT ON (l.shipment_id, l.barcode)
      l.id,
      l.shipment_id,
      l.barcode,
      l.file_url,
      l.label_type,
      l.generated_at
    FROM labels l
    JOIN shipments_scope ss ON ss.shipment_id = l.shipment_id
    WHERE p_label_ids IS NULL OR l.id = ANY(p_label_ids)
    ORDER BY l.shipment_id, l.barcode, l.generated_at DESC
  ),
  latest_target_artifacts AS (
    SELECT DISTINCT ON (la.organization_id, la.target_type, la.target_id, la.target_box_id, la.label_type)
      la.id,
      la.organization_id,
      la.target_type,
      la.target_id,
      la.target_box_id,
      la.file_url,
      la.label_type,
      la.generated_at
    FROM label_artifacts la
    WHERE la.organization_id = p_org_id
      AND (p_client_id IS NULL OR la.client_id = p_client_id)
      AND (p_label_ids IS NULL OR la.id = ANY(p_label_ids))
    ORDER BY la.organization_id, la.target_type, la.target_id, la.target_box_id, la.label_type, la.generated_at DESC
  )
  SELECT
    ll.id AS label_id,
    ll.shipment_id,
    sb.id AS shipment_box_id,
    NULL::text AS target_type,
    NULL::uuid AS target_id,
    NULL::uuid AS target_box_id,
    ll.file_url,
    sb.box_number,
    ll.label_type,
    ll.generated_at
  FROM latest_labels ll
  LEFT JOIN shipment_boxes sb
         ON sb.shipment_id = ll.shipment_id
        AND sb.barcode = ll.barcode

  UNION ALL

  SELECT
    la.id AS label_id,
    NULL::uuid AS shipment_id,
    NULL::uuid AS shipment_box_id,
    la.target_type,
    la.target_id,
    la.target_box_id,
    la.file_url,
    NULL::int AS box_number,
    la.label_type,
    la.generated_at
  FROM latest_target_artifacts la
  ORDER BY shipment_id NULLS LAST, generated_at DESC;
$function$;

COMMENT ON FUNCTION public.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID)
  IS 'Return latest label file references for an organization, including target-neutral artifacts.';

REVOKE ALL ON FUNCTION public.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) TO edge_label_renderer_role;
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID);

CREATE OR REPLACE FUNCTION public.resolve_label_bundle_targets_for_file_urls(
  p_org_id UUID,
  p_file_urls TEXT[],
  p_client_id UUID DEFAULT NULL,
  p_sender_id UUID DEFAULT NULL
)
RETURNS TABLE (
  input_index INT,
  input_file_url TEXT,
  file_url TEXT,
  label_id UUID,
  shipment_id UUID,
  shipment_box_id UUID,
  target_type TEXT,
  target_id UUID,
  target_box_id UUID
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
  WITH input AS (
    SELECT
      u.file_url,
      u.ordinality::int AS input_index
    FROM unnest(p_file_urls) WITH ORDINALITY AS u(file_url, ordinality)
  ),
  shipments_scope AS (
    SELECT s.id AS shipment_id
    FROM shipments s
    WHERE s.organization_id = p_org_id
      AND (p_client_id IS NULL OR s.client_id = p_client_id)
      AND (p_sender_id IS NULL OR s.sender_id = p_sender_id)
  ),
  label_matches AS (
    SELECT
      i.input_index,
      i.file_url AS input_file_url,
      l.file_url,
      l.id AS label_id,
      l.shipment_id,
      sb.id AS shipment_box_id,
      NULL::text AS target_type,
      NULL::uuid AS target_id,
      NULL::uuid AS target_box_id
    FROM input i
    JOIN labels l
      ON l.file_url = i.file_url
    JOIN shipments_scope ss
      ON ss.shipment_id = l.shipment_id
    LEFT JOIN shipment_boxes sb
      ON sb.shipment_id = l.shipment_id
     AND sb.barcode = l.barcode
  ),
  artifact_matches AS (
    SELECT
      i.input_index,
      i.file_url AS input_file_url,
      la.file_url,
      la.id AS label_id,
      NULL::uuid AS shipment_id,
      NULL::uuid AS shipment_box_id,
      la.target_type,
      la.target_id,
      la.target_box_id
    FROM input i
    JOIN label_artifacts la
      ON la.file_url = i.file_url
    WHERE la.organization_id = p_org_id
      AND (p_client_id IS NULL OR la.client_id = p_client_id)
  ),
  combined AS (
    SELECT DISTINCT ON (input_index)
      input_index,
      input_file_url,
      file_url,
      label_id,
      shipment_id,
      shipment_box_id,
      target_type,
      target_id,
      target_box_id
    FROM (
      SELECT
        input_index,
        input_file_url,
        file_url,
        label_id,
        shipment_id,
        shipment_box_id,
        target_type,
        target_id,
        target_box_id,
        1 AS precedence
      FROM label_matches
      UNION ALL
      SELECT
        input_index,
        input_file_url,
        file_url,
        label_id,
        shipment_id,
        shipment_box_id,
        target_type,
        target_id,
        target_box_id,
        2 AS precedence
      FROM artifact_matches
    ) t
    ORDER BY input_index, precedence
  )
  SELECT
    i.input_index,
    i.file_url AS input_file_url,
    c.file_url,
    c.label_id,
    c.shipment_id,
    c.shipment_box_id,
    c.target_type,
    c.target_id,
    c.target_box_id
  FROM input i
  LEFT JOIN combined c
    ON c.input_index = i.input_index
  ORDER BY i.input_index;
$function$;

COMMENT ON FUNCTION public.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID)
  IS 'Resolve bundle targets from file_urls while enforcing org/client/sender scope; returns shipment or target-neutral rows.';

REVOKE ALL ON FUNCTION public.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) TO edge_label_renderer_role;
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

DROP FUNCTION IF EXISTS api.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT);
CREATE OR REPLACE FUNCTION api.request_label_generation_target_v1(
  p_target_type TEXT,
  p_target_id UUID,
  p_label_type TEXT,
  p_requested_by UUID DEFAULT NULL,
  p_requested_source TEXT DEFAULT NULL,
  p_target_box_id UUID DEFAULT NULL,
  p_job_purpose TEXT DEFAULT 'primary'
)
RETURNS UUID
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.request_label_generation_target_v1(
    p_target_type,
    p_target_id,
    p_label_type,
    p_requested_by,
    p_requested_source,
    p_target_box_id,
    p_job_purpose
  );
$function$;

DROP FUNCTION IF EXISTS api.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT);
CREATE OR REPLACE FUNCTION api.request_label_generation_target_for_step_v1(
  p_workflow_run_step_id UUID,
  p_target_type TEXT,
  p_target_id UUID,
  p_label_type TEXT,
  p_requested_by UUID DEFAULT NULL,
  p_requested_source TEXT DEFAULT NULL,
  p_target_box_id UUID DEFAULT NULL,
  p_job_purpose TEXT DEFAULT 'primary'
)
RETURNS UUID
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.request_label_generation_target_for_step_v1(
    p_workflow_run_step_id,
    p_target_type,
    p_target_id,
    p_label_type,
    p_requested_by,
    p_requested_source,
    p_target_box_id,
    p_job_purpose
  );
$function$;

DROP FUNCTION IF EXISTS api.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID);
CREATE OR REPLACE FUNCTION api.resolve_label_files_for_bundle(
  p_org_id UUID,
  p_shipment_ids UUID[] DEFAULT NULL,
  p_label_ids UUID[] DEFAULT NULL,
  p_client_id UUID DEFAULT NULL,
  p_sender_id UUID DEFAULT NULL
)
RETURNS TABLE (
  label_id UUID,
  shipment_id UUID,
  shipment_box_id UUID,
  target_type TEXT,
  target_id UUID,
  target_box_id UUID,
  file_url TEXT,
  box_number INT,
  label_type TEXT,
  generated_at TIMESTAMPTZ
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT * FROM public.resolve_label_files_for_bundle(
    p_org_id,
    p_shipment_ids,
    p_label_ids,
    p_client_id,
    p_sender_id
  );
$function$;

DROP FUNCTION IF EXISTS api.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID);
CREATE OR REPLACE FUNCTION api.resolve_label_bundle_targets_for_file_urls(
  p_org_id UUID,
  p_file_urls TEXT[],
  p_client_id UUID DEFAULT NULL,
  p_sender_id UUID DEFAULT NULL
)
RETURNS TABLE (
  input_index INT,
  input_file_url TEXT,
  file_url TEXT,
  label_id UUID,
  shipment_id UUID,
  shipment_box_id UUID,
  target_type TEXT,
  target_id UUID,
  target_box_id UUID
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT * FROM public.resolve_label_bundle_targets_for_file_urls(
    p_org_id,
    p_file_urls,
    p_client_id,
    p_sender_id
  );
$function$;

COMMIT;

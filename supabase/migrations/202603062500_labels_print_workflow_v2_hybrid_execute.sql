-- Migration: labels print workflow v2 hybrid execute path
-- Purpose:
--  - Collapse the active shipments print path to a thin workflow envelope around the existing print_sync renderer path.
--  - Keep workflow/audit SSOT while removing the prepare->bundle orchestration chain from the active command route.
--  - Reuse one bulk enqueue helper and one async invoke wrapper for fresh-only print execution.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603062500_labels_print_workflow_v2_hybrid_execute'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

UPDATE public.schema_registry
SET schema = jsonb_set(
      COALESCE(schema, '{}'::jsonb),
      '{properties,workflow_mode}',
      jsonb_build_object('type', 'string', 'enum', jsonb_build_array('multi_step', 'print_sync_execute')),
      true
    ),
    updated_at = now()
WHERE category = 'label_print_policy';

WITH current_global AS (
  SELECT settings_version_id
  FROM public.settings
  WHERE category = 'label_print_policy'
    AND scope_type = 'global'
    AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  ORDER BY last_updated DESC
  LIMIT 1
),
updated_version AS (
  UPDATE public.settings_versions sv
  SET value = jsonb_set(
        COALESCE(sv.value, '{}'::jsonb),
        '{workflow_mode}',
        COALESCE(sv.value->'workflow_mode', to_jsonb('print_sync_execute'::text)),
        true
      ),
      change_reason = 'Add label_print_policy workflow_mode default for hybrid workflow execution',
      approved_at = workflow_now(),
      effective_from = workflow_now()
  FROM current_global cg
  WHERE sv.id = cg.settings_version_id
  RETURNING sv.id, sv.value
)
UPDATE public.settings s
SET cached_value = uv.value,
    last_updated = workflow_now()
FROM updated_version uv
WHERE s.category = 'label_print_policy'
  AND s.scope_type = 'global'
  AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND s.settings_version_id = uv.id;

CREATE OR REPLACE FUNCTION public.resolve_label_print_targets_v1(
  p_organization_id uuid,
  p_shipments jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
WITH shipments_raw AS (
  SELECT
    ordinality::int AS shipment_index,
    NULLIF(item->>'shipment_id', '')::uuid AS shipment_id,
    CASE
      WHEN jsonb_typeof(COALESCE(item->'box_ids', '[]'::jsonb)) = 'array' THEN COALESCE(item->'box_ids', '[]'::jsonb)
      ELSE '[]'::jsonb
    END AS box_ids
  FROM jsonb_array_elements(
         CASE
           WHEN jsonb_typeof(COALESCE(p_shipments, '[]'::jsonb)) = 'array' THEN COALESCE(p_shipments, '[]'::jsonb)
           ELSE '[]'::jsonb
         END
       ) WITH ORDINALITY AS t(item, ordinality)
  WHERE item ? 'shipment_id'
),
explicit_boxes AS (
  SELECT
    sr.shipment_index,
    sr.shipment_id,
    box_ordinality::int AS box_index,
    box_text::uuid AS shipment_box_id
  FROM shipments_raw sr
  CROSS JOIN LATERAL jsonb_array_elements_text(sr.box_ids) WITH ORDINALITY AS box(box_text, box_ordinality)
  WHERE box_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
),
in_scope_shipments AS (
  SELECT DISTINCT
    sr.shipment_index,
    sr.shipment_id
  FROM shipments_raw sr
  JOIN public.shipments s
    ON s.id = sr.shipment_id
   AND s.organization_id = p_organization_id
),
out_of_scope AS (
  SELECT DISTINCT
    sr.shipment_index,
    sr.shipment_id
  FROM shipments_raw sr
  LEFT JOIN in_scope_shipments iss
    ON iss.shipment_id = sr.shipment_id
  WHERE iss.shipment_id IS NULL
),
invalid_boxes AS (
  SELECT DISTINCT
    eb.shipment_index,
    eb.shipment_id,
    eb.shipment_box_id
  FROM explicit_boxes eb
  LEFT JOIN public.shipment_boxes sb
    ON sb.id = eb.shipment_box_id
   AND sb.shipment_id = eb.shipment_id
  WHERE sb.id IS NULL
),
target_boxes AS (
  SELECT
    iss.shipment_index,
    iss.shipment_id,
    sb.id AS shipment_box_id,
    sb.box_number,
    COALESCE(eb.box_index, row_number() OVER (
      PARTITION BY iss.shipment_id
      ORDER BY sb.box_number, sb.id
    ))::int AS box_sort_index
  FROM in_scope_shipments iss
  JOIN public.shipment_boxes sb
    ON sb.shipment_id = iss.shipment_id
  LEFT JOIN explicit_boxes eb
    ON eb.shipment_id = iss.shipment_id
   AND eb.shipment_box_id = sb.id
  WHERE NOT EXISTS (
          SELECT 1
          FROM explicit_boxes eb_any
          WHERE eb_any.shipment_id = iss.shipment_id
        )
     OR eb.shipment_box_id IS NOT NULL
),
deduped_targets AS (
  SELECT DISTINCT ON (tb.shipment_id, tb.shipment_box_id)
    tb.shipment_index,
    tb.shipment_id,
    tb.shipment_box_id,
    tb.box_number,
    ((tb.shipment_index * 1000) + tb.box_sort_index)::int AS sort_index
  FROM target_boxes tb
  ORDER BY tb.shipment_id, tb.shipment_box_id, tb.shipment_index, tb.box_sort_index
),
grouped_shipments AS (
  SELECT
    dt.shipment_id,
    MIN(dt.sort_index) AS shipment_order,
    array_agg(dt.shipment_box_id ORDER BY dt.sort_index) FILTER (WHERE dt.shipment_box_id IS NOT NULL) AS shipment_box_ids
  FROM deduped_targets dt
  GROUP BY dt.shipment_id
),
counts AS (
  SELECT
    COUNT(DISTINCT sr.shipment_id)::int AS requested,
    COUNT(DISTINCT iss.shipment_id)::int AS in_scope,
    COUNT(*) FILTER (WHERE dt.shipment_box_id IS NOT NULL)::int AS expected,
    COUNT(DISTINCT o.shipment_id)::int AS out_of_scope,
    COUNT(DISTINCT ib.shipment_box_id)::int AS invalid_box_requests
  FROM shipments_raw sr
  LEFT JOIN in_scope_shipments iss ON iss.shipment_id = sr.shipment_id
  LEFT JOIN out_of_scope o ON o.shipment_id = sr.shipment_id
  LEFT JOIN invalid_boxes ib ON ib.shipment_id = sr.shipment_id
  LEFT JOIN deduped_targets dt ON dt.shipment_id = sr.shipment_id
)
SELECT jsonb_strip_nulls(
  jsonb_build_object(
    'targets', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_strip_nulls(
            jsonb_build_object(
              'shipment_id', dt.shipment_id,
              'shipment_box_id', dt.shipment_box_id,
              'box_number', dt.box_number,
              'status', 'pending'
            )
          )
          ORDER BY dt.sort_index
        )
        FROM deduped_targets dt
      ),
      '[]'::jsonb
    ),
    'grouped_shipments', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_strip_nulls(
            jsonb_build_object(
              'shipment_id', gs.shipment_id,
              'box_ids', CASE
                WHEN array_length(gs.shipment_box_ids, 1) IS NULL THEN NULL
                ELSE to_jsonb(gs.shipment_box_ids)
              END
            )
          )
          ORDER BY gs.shipment_order
        )
        FROM grouped_shipments gs
      ),
      '[]'::jsonb
    ),
    'out_of_scope', COALESCE(
      (
        SELECT jsonb_agg(jsonb_build_object('shipment_id', o.shipment_id) ORDER BY o.shipment_index)
        FROM out_of_scope o
      ),
      '[]'::jsonb
    ),
    'invalid_boxes', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'shipment_id', ib.shipment_id,
            'shipment_box_id', ib.shipment_box_id
          )
          ORDER BY ib.shipment_index
        )
        FROM invalid_boxes ib
      ),
      '[]'::jsonb
    ),
    'counts', (
      SELECT jsonb_strip_nulls(
        jsonb_build_object(
          'requested', c.requested,
          'in_scope', c.in_scope,
          'expected', c.expected,
          'out_of_scope', c.out_of_scope,
          'invalid_box_requests', c.invalid_box_requests
        )
      )
      FROM counts c
    )
  )
);
$$;

COMMENT ON FUNCTION public.resolve_label_print_targets_v1(uuid, jsonb)
  IS 'Resolve in-scope shipment box targets for fresh label printing without consulting stale label artifacts.';

REVOKE ALL ON FUNCTION public.resolve_label_print_targets_v1(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_label_print_targets_v1(uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_label_renderer_invoke_config_v1(
  p_organization_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_settings jsonb;
  v_provider jsonb;
  v_url text;
  v_secret text;
  v_timeout_ms int;
BEGIN
  v_settings := COALESCE(
    CASE
      WHEN p_organization_id IS NOT NULL THEN public.resolve_settings('label_provider', 'tenant', p_organization_id)
      ELSE NULL
    END,
    public.resolve_settings('label_provider', 'global', NULL)
  );

  IF v_settings IS NULL THEN
    RAISE EXCEPTION 'resolve_label_renderer_invoke_config_v1: label_provider settings not found';
  END IF;

  v_provider := COALESCE((v_settings->'providers')->0, '{}'::jsonb);
  v_url := NULLIF(v_provider->>'invoke_url', '');
  v_secret := NULLIF(v_provider->>'invoke_secret', '');
  v_timeout_ms := COALESCE(NULLIF(v_provider->>'timeout_ms', '')::int, 15000);

  IF v_url IS NULL THEN
    RAISE EXCEPTION 'resolve_label_renderer_invoke_config_v1: invoke_url missing in label_provider configuration';
  END IF;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'resolve_label_renderer_invoke_config_v1: invoke_secret missing in label_provider configuration';
  END IF;
  IF v_url LIKE 'https://example.%' OR v_secret = 'EXAMPLE_PASSWORD' THEN
    RAISE EXCEPTION 'resolve_label_renderer_invoke_config_v1: provider invoke configuration not activated (update settings)';
  END IF;

  RETURN jsonb_build_object(
    'invoke_url', v_url,
    'invoke_secret', v_secret,
    'provider_name', NULLIF(v_provider->>'name', ''),
    'timeout_ms', v_timeout_ms,
    'timeout_seconds', GREATEST((v_timeout_ms + 999) / 1000, 1)
  );
END;
$$;

COMMENT ON FUNCTION public.resolve_label_renderer_invoke_config_v1(uuid)
  IS 'Resolve active label renderer invoke configuration for async/sync DB wrappers without duplicating settings logic.';

REVOKE ALL ON FUNCTION public.resolve_label_renderer_invoke_config_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_label_renderer_invoke_config_v1(uuid) TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.resolve_label_renderer_invoke_config_v1(uuid) TO edge_label_renderer_role;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_label_renderer(
    p_max_jobs INT DEFAULT 5,
    p_payload JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_body JSONB;
    v_org_id UUID;
    v_provider JSONB;
    v_headers JSONB;
    v_response JSONB;
    v_timeout_seconds INT;
    v_existing_timeout_text TEXT;
    v_existing_timeout_ms INT;
    v_desired_timeout_ms INT;
BEGIN
    v_body := CASE
        WHEN p_payload IS NOT NULL AND jsonb_typeof(p_payload) = 'object'
            THEN jsonb_strip_nulls(p_payload)
        ELSE jsonb_build_object('max_jobs', GREATEST(COALESCE(p_max_jobs, 5), 1))
    END;

    v_org_id := NULLIF(v_body->>'organization_id', '')::UUID;
    v_provider := public.resolve_label_renderer_invoke_config_v1(v_org_id);

    v_headers := jsonb_build_object(
        'content-type', 'application/json',
        'authorization', concat('Bearer ', v_provider->>'invoke_secret')
    );

    v_timeout_seconds := COALESCE(NULLIF(v_provider->>'timeout_seconds', '')::INT, 15);

    v_existing_timeout_text := current_setting('statement_timeout', true);
    v_desired_timeout_ms := (v_timeout_seconds + 5) * 1000;
    IF v_existing_timeout_text IS NOT NULL THEN
        BEGIN
            v_existing_timeout_ms :=
                ROUND(EXTRACT(EPOCH FROM v_existing_timeout_text::interval) * 1000)::INT;
        EXCEPTION WHEN OTHERS THEN
            v_existing_timeout_ms := NULL;
        END;
    END IF;

    IF v_existing_timeout_ms IS NOT NULL AND v_existing_timeout_ms > 0 THEN
        v_desired_timeout_ms := GREATEST(v_existing_timeout_ms, v_desired_timeout_ms);
        PERFORM set_config('statement_timeout', v_desired_timeout_ms::TEXT, true);
    END IF;

    v_response := public.call_api_wait(
        v_provider->>'invoke_url',
        'POST',
        v_headers,
        v_body,
        v_timeout_seconds,
        v_timeout_seconds
    );

    RETURN v_response || jsonb_build_object(
        'request_payload', v_body,
        'provider_name', v_provider->>'provider_name'
    );
END;
$$;

COMMENT ON FUNCTION public.invoke_label_renderer(INT, JSONB)
    IS 'Trigger label renderer edge worker using resolved provider settings (sync via call_api_wait; statement_timeout guard).';

GRANT EXECUTE ON FUNCTION public.invoke_label_renderer(INT, JSONB) TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.invoke_label_renderer(INT, JSONB) TO edge_label_renderer_role;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.request_label_generation_bulk_for_step_v1(
  p_workflow_run_step_id uuid,
  p_shipments jsonb,
  p_label_type text,
  p_requested_by uuid DEFAULT NULL,
  p_requested_source text DEFAULT NULL,
  p_job_purpose text DEFAULT 'primary'
)
RETURNS TABLE (
  job_id uuid,
  shipment_id uuid,
  shipment_box_id uuid,
  inserted boolean,
  shipment_index int,
  box_index int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_conflict_count int := 0;
BEGIN
  IF p_workflow_run_step_id IS NULL THEN
    RAISE EXCEPTION 'request_label_generation_bulk_for_step_v1 requires workflow_run_step_id';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _label_generation_bulk_for_step_result (
    job_id uuid,
    shipment_id uuid,
    shipment_box_id uuid,
    inserted boolean,
    shipment_index int,
    box_index int
  ) ON COMMIT DROP;
  TRUNCATE TABLE _label_generation_bulk_for_step_result;

  INSERT INTO _label_generation_bulk_for_step_result (job_id, shipment_id, shipment_box_id, inserted, shipment_index, box_index)
  SELECT job_id, shipment_id, shipment_box_id, inserted, shipment_index, box_index
  FROM public.request_label_generation_bulk_v1(
    p_shipments,
    p_label_type,
    p_requested_by,
    p_requested_source,
    p_job_purpose
  );

  SELECT COUNT(*)
  INTO v_conflict_count
  FROM public.label_jobs lj
  WHERE lj.id IN (SELECT job_id FROM _label_generation_bulk_for_step_result)
    AND lj.workflow_run_step_id IS NOT NULL
    AND lj.workflow_run_step_id IS DISTINCT FROM p_workflow_run_step_id;

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'request_label_generation_bulk_for_step_v1 step linkage conflict for % job(s)', v_conflict_count;
  END IF;

  UPDATE public.label_jobs lj
  SET workflow_run_step_id = p_workflow_run_step_id
  WHERE lj.id IN (SELECT job_id FROM _label_generation_bulk_for_step_result)
    AND lj.workflow_run_step_id IS NULL;

  RETURN QUERY
  SELECT r.job_id, r.shipment_id, r.shipment_box_id, r.inserted, r.shipment_index, r.box_index
  FROM _label_generation_bulk_for_step_result r
  ORDER BY r.shipment_index, r.box_index;
END;
$$;

COMMENT ON FUNCTION public.request_label_generation_bulk_for_step_v1(uuid, jsonb, text, uuid, text, text)
  IS 'Workflow-step-aware bulk label-job enqueue helper that reuses request_label_generation_bulk_v1 and links new jobs to the current workflow step.';

REVOKE ALL ON FUNCTION public.request_label_generation_bulk_for_step_v1(uuid, jsonb, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_label_generation_bulk_for_step_v1(uuid, jsonb, text, uuid, text, text) TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.request_label_generation_bulk_for_step_v1(uuid, jsonb, text, uuid, text, text) TO edge_label_renderer_role;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_label_renderer_print_sync_v1(
  p_workflow_run_id uuid,
  p_workflow_run_step_id uuid,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_print_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_org_id uuid := NULL;
  v_workflow_progress_enabled boolean := true;
  v_workflow_progress_budget_ms int := 1200;
  v_workflow_progress_max_steps int := 10;
  v_provider jsonb;
  v_headers jsonb;
  v_request_body jsonb;
  v_request_id bigint;
  v_enabled_text text := '';
BEGIN
  IF p_workflow_run_id IS NULL THEN
    RAISE EXCEPTION 'invoke_label_renderer_print_sync_v1 requires workflow_run_id';
  END IF;
  IF p_workflow_run_step_id IS NULL THEN
    RAISE EXCEPTION 'invoke_label_renderer_print_sync_v1 requires workflow_run_step_id';
  END IF;
  IF jsonb_typeof(v_print_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invoke_label_renderer_print_sync_v1 requires object payload';
  END IF;

  IF jsonb_typeof(v_print_payload->'print') = 'object' THEN
    v_print_payload := v_print_payload->'print';
  END IF;

  v_org_id := COALESCE(
    NULLIF(v_print_payload->>'organization_id', '')::uuid,
    NULLIF(p_payload->>'organization_id', '')::uuid
  );
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'invoke_label_renderer_print_sync_v1 requires organization_id in payload';
  END IF;

  v_enabled_text := lower(COALESCE(NULLIF(v_print_payload->>'workflow_progress_enabled', ''), 'true'));
  v_workflow_progress_enabled := v_enabled_text IN ('1', 't', 'true', 'y', 'yes', 'on');

  IF COALESCE(v_print_payload->>'workflow_progress_budget_ms', '') ~ '^\d+$' THEN
    v_workflow_progress_budget_ms := LEAST(GREATEST((v_print_payload->>'workflow_progress_budget_ms')::int, 25), 5000);
  END IF;
  IF COALESCE(v_print_payload->>'workflow_progress_max_steps', '') ~ '^\d+$' THEN
    v_workflow_progress_max_steps := LEAST(GREATEST((v_print_payload->>'workflow_progress_max_steps')::int, 1), 50);
  END IF;

  v_print_payload := jsonb_strip_nulls(
    v_print_payload || jsonb_build_object(
      'organization_id', v_org_id,
      'workflow_run_id', p_workflow_run_id,
      'workflow_run_step_id', p_workflow_run_step_id,
      'workflow_progress_enabled', v_workflow_progress_enabled,
      'workflow_progress_budget_ms', v_workflow_progress_budget_ms,
      'workflow_progress_max_steps', v_workflow_progress_max_steps
    )
  );

  v_provider := public.resolve_label_renderer_invoke_config_v1(v_org_id);
  v_headers := jsonb_build_object(
    'content-type', 'application/json',
    'authorization', concat('Bearer ', v_provider->>'invoke_secret')
  );
  v_request_body := jsonb_build_object(
    'organization_id', v_org_id,
    'print', v_print_payload
  );

  v_request_id := public.dispatch_api_request_v1(
    v_provider->>'invoke_url',
    'POST',
    v_headers,
    v_request_body,
    COALESCE(NULLIF(v_provider->>'timeout_seconds', '')::int, 15)
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'status', 202,
    'completed', false,
    'request_id', v_request_id,
    'provider_name', v_provider->>'provider_name',
    'request_payload', v_request_body
  ));
END;
$$;

COMMENT ON FUNCTION public.invoke_label_renderer_print_sync_v1(uuid, uuid, jsonb)
  IS 'Dispatch label-renderer print_sync asynchronously with canonical workflow callback fields and return the async request id.';

REVOKE ALL ON FUNCTION public.invoke_label_renderer_print_sync_v1(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invoke_label_renderer_print_sync_v1(uuid, uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_print_execute_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result jsonb DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_response public.workflow_handler_response;
  v_context jsonb := COALESCE(p_run.context, '{}'::jsonb);
  v_payload jsonb := COALESCE(v_context->'payload', '{}'::jsonb);
  v_label_state jsonb := COALESCE(v_context->'label_print', '{}'::jsonb);
  v_policy jsonb := '{}'::jsonb;
  v_org_id uuid := NULL;
  v_requested_by uuid := NULL;
  v_shipments jsonb := '[]'::jsonb;
  v_options jsonb := '{}'::jsonb;
  v_target_state jsonb := '{}'::jsonb;
  v_targets jsonb := '[]'::jsonb;
  v_grouped_shipments jsonb := '[]'::jsonb;
  v_out_of_scope jsonb := '[]'::jsonb;
  v_invalid_boxes jsonb := '[]'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_counts_patch jsonb := '{}'::jsonb;
  v_fresh_state jsonb := '{}'::jsonb;
  v_ready jsonb := '[]'::jsonb;
  v_pending jsonb := '[]'::jsonb;
  v_failed jsonb := '[]'::jsonb;
  v_label_job_ids jsonb := '[]'::jsonb;
  v_execute_async jsonb := COALESCE(v_label_state->'execute_async', '{}'::jsonb);
  v_execute_request_id bigint := NULL;
  v_execute_request_id_text text := '';
  v_execute_response jsonb := COALESCE(v_label_state->'execute_response', '{}'::jsonb);
  v_result jsonb := '{}'::jsonb;
  v_result_status text := '';
  v_bundle_response jsonb := '{}'::jsonb;
  v_bundle_status text := '';
  v_last_error text := NULL;
  v_expected_count int := 0;
  v_ready_count int := 0;
  v_pending_count int := 0;
  v_failed_count int := 0;
  v_poll_seconds int := 1;
  v_workflow_progress_budget_ms int := 1200;
  v_workflow_progress_max_steps int := 10;
  v_requested_source text := format('workflow.labels_print_execute:%s', p_step.id);
  v_print_payload jsonb := '{}'::jsonb;
  v_http_response jsonb := '{}'::jsonb;
  v_http_body jsonb := '{}'::jsonb;
  v_http_completed boolean := false;
  v_client_id text := NULL;
  v_sender_id text := NULL;
  v_label_type text := 'shipping';
  v_output_name text := NULL;
  v_expires_seconds int := NULL;
  v_print_mode text := 'print_sync';
  v_artifact_kind text := NULL;
BEGIN
  v_org_id := COALESCE(
    NULLIF(v_label_state->>'organization_id', '')::uuid,
    NULLIF(v_context->>'organization_id', '')::uuid,
    NULLIF(v_payload->>'organization_id', '')::uuid
  );
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'execute_label_print_execute_v1: organization_id missing from workflow context';
  END IF;

  v_policy := COALESCE(
    v_label_state->'policy',
    public.resolve_settings('label_print_policy', 'tenant', v_org_id),
    public.resolve_settings('label_print_policy', 'global', NULL),
    '{}'::jsonb
  );

  v_requested_by := COALESCE(
    NULLIF(v_context->>'requested_by', '')::uuid,
    NULLIF(v_payload->>'requested_by', '')::uuid,
    p_run.requested_by
  );
  v_shipments := COALESCE(v_label_state->'shipments', v_payload->'shipments', '[]'::jsonb);
  v_options := COALESCE(v_label_state->'options', v_payload->'options', '{}'::jsonb);
  v_client_id := NULLIF(COALESCE(v_label_state->>'client_id', v_payload->>'client_id'), '');
  v_sender_id := NULLIF(COALESCE(v_label_state->>'sender_id', v_payload->>'sender_id'), '');
  v_label_type := lower(COALESCE(NULLIF(v_options->>'label_type', ''), NULLIF(v_payload->>'label_type', ''), 'shipping'));
  v_output_name := NULLIF(COALESCE(v_options->>'output_name', v_payload->>'output_name'), '');
  IF COALESCE(v_options->>'expires_seconds', '') ~ '^\d+$' THEN
    v_expires_seconds := GREATEST((v_options->>'expires_seconds')::int, 60);
  ELSIF COALESCE(v_payload->>'expires_seconds', '') ~ '^\d+$' THEN
    v_expires_seconds := GREATEST((v_payload->>'expires_seconds')::int, 60);
  END IF;

  v_targets := COALESCE(v_label_state->'targets', '[]'::jsonb);
  v_grouped_shipments := COALESCE(v_label_state->'grouped_shipments', '[]'::jsonb);
  v_out_of_scope := COALESCE(v_label_state->'out_of_scope', '[]'::jsonb);
  v_invalid_boxes := COALESCE(v_label_state->'invalid_boxes', '[]'::jsonb);
  v_counts := COALESCE(v_label_state->'counts', '{}'::jsonb);

  IF jsonb_typeof(v_targets) IS DISTINCT FROM 'array' OR jsonb_array_length(v_targets) = 0 THEN
    v_target_state := public.resolve_label_print_targets_v1(v_org_id, v_shipments);
    v_targets := COALESCE(v_target_state->'targets', '[]'::jsonb);
    v_grouped_shipments := COALESCE(v_target_state->'grouped_shipments', '[]'::jsonb);
    v_out_of_scope := COALESCE(v_target_state->'out_of_scope', '[]'::jsonb);
    v_invalid_boxes := COALESCE(v_target_state->'invalid_boxes', '[]'::jsonb);
    v_counts := COALESCE(v_target_state->'counts', '{}'::jsonb);
  END IF;

  v_expected_count := COALESCE(jsonb_array_length(v_targets), 0);
  v_counts_patch := jsonb_strip_nulls(jsonb_build_object(
    'requested', COALESCE(NULLIF(v_counts->>'requested', '')::int, 0),
    'in_scope', COALESCE(NULLIF(v_counts->>'in_scope', '')::int, 0),
    'expected', v_expected_count,
    'out_of_scope', COALESCE(jsonb_array_length(v_out_of_scope), 0),
    'invalid_box_requests', COALESCE(jsonb_array_length(v_invalid_boxes), 0)
  ));
  v_counts := COALESCE(v_counts, '{}'::jsonb) || v_counts_patch;

  IF COALESCE(v_policy->>'poll_interval_seconds', '') ~ '^\d+$' THEN
    v_poll_seconds := LEAST(GREATEST((v_policy->>'poll_interval_seconds')::int, 1), 300);
  END IF;
  IF COALESCE(v_policy->>'bundle_inline_progress_budget_ms', '') ~ '^\d+$' THEN
    v_workflow_progress_budget_ms := LEAST(GREATEST((v_policy->>'bundle_inline_progress_budget_ms')::int, 25), 5000);
  END IF;
  IF COALESCE(v_policy->>'bundle_inline_progress_max_steps', '') ~ '^\d+$' THEN
    v_workflow_progress_max_steps := LEAST(GREATEST((v_policy->>'bundle_inline_progress_max_steps')::int, 1), 50);
  END IF;

  IF v_expected_count = 0 THEN
    v_response.status := 'failed';
    v_response.workflow_status := 'failed';
    v_response.last_error := 'no_printable_label_targets';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'status', 'failed',
      'error', 'no_printable_label_targets',
      'counts', v_counts,
      'out_of_scope', v_out_of_scope,
      'invalid_boxes', v_invalid_boxes
    ));
    v_response.context_patch := jsonb_build_object(
      'label_print', jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'requested_by', v_requested_by,
        'shipments', v_grouped_shipments,
        'targets', v_targets,
        'grouped_shipments', v_grouped_shipments,
        'out_of_scope', v_out_of_scope,
        'invalid_boxes', v_invalid_boxes,
        'counts', v_counts,
        'options', v_options,
        'policy', v_policy,
        'fresh_generation_required', true,
        'fresh_resolve_mode', 'workflow_scope_only',
        'fresh_request_scope_key', p_step.id::text,
        'requested_source', v_requested_source
      ))
    );
    RETURN v_response;
  END IF;

  IF lower(COALESCE(NULLIF(p_operation_result->>'external_step_result', ''), 'false')) IN ('1', 't', 'true', 'y', 'yes', 'on') THEN
    v_result := COALESCE(p_operation_result->'execute', p_operation_result->'body', p_operation_result);
  ELSE
    v_execute_request_id_text := COALESCE(
      NULLIF(v_execute_async->>'request_id', ''),
      NULLIF(v_execute_response->>'request_id', '')
    );
    IF v_execute_request_id_text ~ '^[0-9]+$' THEN
      v_execute_request_id := v_execute_request_id_text::bigint;
    END IF;

    IF v_execute_request_id IS NULL THEN
      v_print_payload := jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'client_id', v_client_id,
        'sender_id', v_sender_id,
        'label_type', v_label_type,
        'shipments', v_grouped_shipments,
        'output_name', v_output_name,
        'expires_seconds', v_expires_seconds,
        'workflow_progress_enabled', true,
        'workflow_progress_budget_ms', v_workflow_progress_budget_ms,
        'workflow_progress_max_steps', v_workflow_progress_max_steps,
        'metadata', jsonb_strip_nulls(
          public.jsonb_deep_merge(
            COALESCE(v_options->'metadata', '{}'::jsonb),
            jsonb_build_object(
              'correlation_id', NULLIF(v_context->>'correlation_id', ''),
              'fresh_generation_required', true,
              'fresh_request_scope_key', p_step.id::text,
              'requested_source', v_requested_source
            )
          )
        )
      ));

      v_execute_response := public.invoke_label_renderer_print_sync_v1(
        p_run.id,
        p_step.id,
        v_print_payload
      );
      v_execute_request_id_text := NULLIF(v_execute_response->>'request_id', '');
      IF v_execute_request_id_text ~ '^[0-9]+$' THEN
        v_execute_request_id := v_execute_request_id_text::bigint;
      END IF;

      v_response.status := 'pending';
      v_response.next_run_at := now() + make_interval(secs => v_poll_seconds);
      v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
      v_response.max_retries := p_step.max_retries;
      v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'status', 'pending',
        'request_id', v_execute_request_id,
        'counts', v_counts,
        'ready', '[]'::jsonb,
        'pending', v_targets,
        'failed', '[]'::jsonb
      ));
      v_response.context_patch := jsonb_build_object(
        'label_print', jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_org_id,
          'requested_by', v_requested_by,
          'shipments', v_grouped_shipments,
          'targets', v_targets,
          'grouped_shipments', v_grouped_shipments,
          'out_of_scope', v_out_of_scope,
          'invalid_boxes', v_invalid_boxes,
          'counts', v_counts,
          'options', v_options,
          'policy', v_policy,
          'ready', '[]'::jsonb,
          'pending', v_targets,
          'failed', '[]'::jsonb,
          'fresh_generation_required', true,
          'fresh_resolve_mode', 'workflow_scope_only',
          'fresh_request_scope_key', p_step.id::text,
          'requested_source', v_requested_source,
          'execute_async', jsonb_strip_nulls(jsonb_build_object(
            'request_id', v_execute_request_id,
            'requested_at', now(),
            'request_payload', v_execute_response->'request_payload',
            'provider_name', v_execute_response->>'provider_name',
            'completed', false
          ))
        ))
      );
      RETURN v_response;
    END IF;

    BEGIN
      v_http_response := COALESCE(public.check_async_response(v_execute_request_id), '{}'::jsonb);
      v_http_completed := COALESCE((v_http_response->>'completed')::boolean, false);
      IF jsonb_typeof(v_http_response->'body') = 'object' THEN
        v_http_body := v_http_response->'body';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_http_response := '{}'::jsonb;
      v_http_body := '{}'::jsonb;
      v_http_completed := false;
    END;

    IF NOT v_http_completed THEN
      v_response.status := 'pending';
      v_response.next_run_at := now() + make_interval(secs => v_poll_seconds);
      v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
      v_response.max_retries := p_step.max_retries;
      v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'status', 'pending',
        'request_id', v_execute_request_id,
        'counts', v_counts,
        'ready', COALESCE(v_label_state->'ready', '[]'::jsonb),
        'pending', COALESCE(v_label_state->'pending', v_targets),
        'failed', COALESCE(v_label_state->'failed', '[]'::jsonb)
      ));
      v_response.context_patch := jsonb_build_object(
        'label_print', jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_org_id,
          'requested_by', v_requested_by,
          'shipments', v_grouped_shipments,
          'targets', v_targets,
          'grouped_shipments', v_grouped_shipments,
          'out_of_scope', v_out_of_scope,
          'invalid_boxes', v_invalid_boxes,
          'counts', v_counts,
          'options', v_options,
          'policy', v_policy,
          'ready', COALESCE(v_label_state->'ready', '[]'::jsonb),
          'pending', COALESCE(v_label_state->'pending', v_targets),
          'failed', COALESCE(v_label_state->'failed', '[]'::jsonb),
          'fresh_generation_required', true,
          'fresh_resolve_mode', 'workflow_scope_only',
          'fresh_request_scope_key', p_step.id::text,
          'requested_source', v_requested_source,
          'execute_async', jsonb_strip_nulls(jsonb_build_object(
            'request_id', v_execute_request_id,
            'requested_at', COALESCE(v_execute_async->>'requested_at', now()::text),
            'request_payload', COALESCE(v_execute_async->'request_payload', v_execute_response->'request_payload'),
            'provider_name', COALESCE(v_execute_async->>'provider_name', v_execute_response->>'provider_name'),
            'completed', false
          ))
        ))
      );
      RETURN v_response;
    END IF;

    v_result := COALESCE(v_http_body, '{}'::jsonb);
  END IF;

  v_result_status := lower(COALESCE(NULLIF(v_result->>'status', ''), 'ok'));
  v_bundle_response := COALESCE(v_result->'bundle', '{}'::jsonb);
  v_bundle_status := lower(COALESCE(NULLIF(v_bundle_response->>'status', ''), v_result_status, 'ok'));
  v_print_mode := COALESCE(NULLIF(v_result->>'mode', ''), 'print_sync');
  v_artifact_kind := COALESCE(NULLIF(v_result->>'artifact_kind', ''), NULLIF(v_bundle_response->>'artifact_kind', ''));

  v_fresh_state := public.resolve_label_print_fresh_scope_v1(p_step.id, v_targets);
  v_ready := COALESCE(v_fresh_state->'ready', '[]'::jsonb);
  v_pending := COALESCE(v_fresh_state->'pending', '[]'::jsonb);
  v_failed := COALESCE(v_fresh_state->'failed', '[]'::jsonb);
  v_label_job_ids := COALESCE(v_fresh_state->'label_job_ids', '[]'::jsonb);
  v_ready_count := COALESCE(NULLIF(v_fresh_state->>'ready_count', '')::int, 0);
  v_pending_count := COALESCE(NULLIF(v_fresh_state->>'pending_count', '')::int, 0);
  v_failed_count := COALESCE(NULLIF(v_fresh_state->>'failed_count', '')::int, 0);

  v_counts := COALESCE(v_counts, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
    'ready', v_ready_count,
    'pending', v_pending_count,
    'failed', v_failed_count,
    'expected', v_expected_count,
    'bundled', CASE
      WHEN COALESCE(v_bundle_response #>> '{counts,bundled}', '') ~ '^\d+$' THEN (v_bundle_response #>> '{counts,bundled}')::int
      ELSE NULL
    END
  ));

  IF v_result_status IN ('failed', 'error') OR v_bundle_status IN ('failed', 'error') OR NULLIF(v_result->>'error', '') IS NOT NULL THEN
    v_response.status := 'failed';
    v_response.workflow_status := 'failed';
    v_last_error := COALESCE(NULLIF(v_result->>'error', ''), NULLIF(v_bundle_response->>'error', ''), 'label_print_execute_failed');
    v_response.last_error := v_last_error;
  ELSIF v_pending_count > 0 THEN
    v_response.status := 'pending';
    v_response.next_run_at := now() + make_interval(secs => v_poll_seconds);
    v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
    v_response.max_retries := p_step.max_retries;
  ELSIF COALESCE(NULLIF(v_bundle_response->>'file_path', ''), NULLIF(v_bundle_response->>'file_url', ''), NULLIF(v_bundle_response->>'signed_url', '')) IS NULL THEN
    v_response.status := 'pending';
    v_response.next_run_at := now() + make_interval(secs => v_poll_seconds);
    v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries);
    v_response.max_retries := p_step.max_retries;
  ELSE
    v_response.status := 'completed';
  END IF;

  v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'status', CASE
      WHEN v_response.status = 'completed' THEN 'ok'
      ELSE v_response.status
    END,
    'execute', v_result,
    'bundle', CASE WHEN jsonb_typeof(v_bundle_response) = 'object' THEN v_bundle_response ELSE NULL END,
    'counts', v_counts,
    'ready', v_ready,
    'pending', v_pending,
    'failed', v_failed,
    'artifact_kind', v_artifact_kind,
    'print_mode', v_print_mode,
    'request_id', v_execute_request_id,
    'error', CASE WHEN v_response.status = 'failed' THEN v_last_error ELSE NULL END
  ));

  v_response.context_patch := jsonb_build_object(
    'label_print', jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org_id,
      'requested_by', v_requested_by,
      'shipments', v_grouped_shipments,
      'targets', v_targets,
      'grouped_shipments', v_grouped_shipments,
      'out_of_scope', v_out_of_scope,
      'invalid_boxes', v_invalid_boxes,
      'counts', v_counts,
      'options', v_options,
      'policy', v_policy,
      'ready', v_ready,
      'pending', v_pending,
      'failed', v_failed,
      'label_job_ids', v_label_job_ids,
      'fresh_generation_required', true,
      'fresh_resolve_mode', 'workflow_scope_only',
      'fresh_request_scope_key', p_step.id::text,
      'requested_source', v_requested_source,
      'execute_async', jsonb_strip_nulls(jsonb_build_object(
        'request_id', v_execute_request_id,
        'requested_at', COALESCE(v_execute_async->>'requested_at', now()::text),
        'request_payload', COALESCE(v_execute_async->'request_payload', v_execute_response->'request_payload'),
        'provider_name', COALESCE(v_execute_async->>'provider_name', v_execute_response->>'provider_name'),
        'completed', CASE WHEN v_response.status = 'completed' THEN true ELSE NULL END
      )),
      'execute_response', v_result,
      'bundle_response', CASE WHEN jsonb_typeof(v_bundle_response) = 'object' THEN v_bundle_response ELSE NULL END,
      'artifact_kind', v_artifact_kind,
      'print_mode', v_print_mode
    ))
  );

  RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_execute_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  IS 'Hybrid print workflow execute step that asynchronously dispatches print_sync, reconciles completion, and patches canonical bundle/audit context.';

INSERT INTO public.operation_handlers (handler_key, handler_schema, handler_name, handler_signature, handler_version, is_active, notes, doc_url)
VALUES (
  'label_print_execute',
  'workflow_handlers',
  'execute_label_print_execute_v1',
  '(public.workflow_run_steps,public.workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Hybrid shipments label print execute step using async print_sync dispatch + canonical finalize.',
  'docs/ops/runbooks/label_renderer_runbook.md#print-sync'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = TRUE,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

WITH upsert_template AS (
  INSERT INTO public.workflow_templates (
    id,
    name,
    description,
    version,
    status,
    scope_type,
    scope_id,
    notes,
    created_at,
    updated_at
  ) VALUES (
    gen_random_uuid(),
    'labels_print_workflow_v2',
    'Hybrid workflow envelope for fresh shipments label printing using async print_sync execution + canonical finalize.',
    1,
    'active',
    'global',
    NULL,
    'Active shipments label print workflow: execute -> finalize -> complete.',
    now(),
    now()
  )
  ON CONFLICT (name) DO UPDATE
  SET description = EXCLUDED.description,
      status = 'active',
      notes = EXCLUDED.notes,
      updated_at = now()
  RETURNING id
),
template AS (
  SELECT id FROM upsert_template
)
DELETE FROM public.workflow_template_steps
WHERE workflow_template_id = (SELECT id FROM template);

WITH template AS (
  SELECT id FROM public.workflow_templates WHERE name = 'labels_print_workflow_v2' LIMIT 1
)
INSERT INTO public.workflow_template_steps (
  id,
  workflow_template_id,
  sequence_order,
  operation_name,
  operation_settings_category,
  transition_condition,
  metadata,
  handler_key,
  handler_version,
  enabled,
  created_at,
  updated_at
)
VALUES
  (
    gen_random_uuid(),
    (SELECT id FROM template),
    1,
    'execute_label_print',
    'workflow',
    'always',
    jsonb_build_object('poll_interval_seconds', 1, 'max_retries', 200),
    'label_print_execute',
    'v1',
    TRUE,
    now(),
    now()
  ),
  (
    gen_random_uuid(),
    (SELECT id FROM template),
    2,
    'finalize_label_print',
    'workflow',
    'always',
    jsonb_build_object('decision_category', 'label_print', 'max_retries', 20),
    'label_print_finalize',
    'v1',
    TRUE,
    now(),
    now()
  ),
  (
    gen_random_uuid(),
    (SELECT id FROM template),
    3,
    'complete_workflow',
    'workflow',
    'always',
    jsonb_build_object('action', 'complete'),
    'workflow_control',
    'v1',
    TRUE,
    now(),
    now()
  );

DO $$
DECLARE
  v_current jsonb;
  v_commands jsonb := '[]'::jsonb;
  v_updated jsonb := '[]'::jsonb;
  v_item jsonb;
  v_execution jsonb;
  v_params jsonb;
  v_found boolean := false;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_command_registry global settings missing';
  END IF;

  v_commands := COALESCE(v_current->'commands', '[]'::jsonb);

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_commands) LOOP
    IF v_item->>'key' = 'shipments.print_labels' THEN
      v_found := true;
      v_execution := COALESCE(v_item->'execution', '{}'::jsonb);
      v_params := COALESCE(v_execution->'params', '{}'::jsonb);

      v_params := v_params || jsonb_build_object(
        'output_url_paths', jsonb_build_array(
          'context.label_print.bundle_response.signed_url',
          'context.label_print.bundle_response.file_url',
          'context.label_print.execute_response.bundle.signed_url',
          'context.label_print.execute_response.bundle.file_url',
          'metadata.label_print.bundle_response.signed_url',
          'metadata.label_print.bundle_response.file_url',
          'step_result.bundle.signed_url',
          'step_result.bundle.output_url',
          'step_result.bundle.file_url',
          'step_result.execute.bundle.signed_url',
          'step_result.execute.bundle.output_url',
          'step_result.execute.bundle.file_url',
          'async_body.bundle.signed_url',
          'async_body.bundle.output_url',
          'async_body.bundle.file_url'
        )
      );

      v_execution := jsonb_set(v_execution, '{type}', '"print"', true);
      v_execution := jsonb_set(v_execution, '{rpc}', '"ui_execute_command_v1"', true);
      v_execution := jsonb_set(v_execution, '{params}', v_params, true);
      v_item := jsonb_set(v_item, '{execution}', v_execution, true);
      v_item := jsonb_set(v_item, '{workflow_key}', '"labels_print_workflow_v2"', true);
    END IF;

    v_updated := v_updated || jsonb_build_array(v_item);
  END LOOP;

  IF v_found IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'shipments.print_labels command missing in ui_command_registry';
  END IF;

  v_current := jsonb_set(v_current, '{commands}', v_updated, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Switch shipments.print_labels to labels_print_workflow_v2 hybrid execute path',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202603062500_labels_print_workflow_v2_hybrid_execute'));
COMMIT;

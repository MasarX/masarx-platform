-- Plan: Batch 8 proof-of-delivery photo contract / Step: E02
-- Migration: POD photo-proof enforcement for delivered route-stop finalization
-- Purpose:
-- - Keep UC102 photo-proof enforcement canonical and row-driven through pod_policy + dispatch_evidence_policy.
-- - Fail closed before shipment mutation when a delivered route_stop completion lacks the required proof photos.
-- - Distinguish proof photos from signature artifacts via canonical mobile artifact metadata.artifact_kind.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604051130_b08_uc102_photo_proof_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH current_rows AS (
  SELECT
    s.id AS settings_id,
    s.settings_version_id,
    sv.version,
    sv.value
  FROM public.settings s
  JOIN public.settings_versions sv
    ON sv.id = s.settings_version_id
  WHERE s.category = 'pod_policy'
),
rewritten AS (
  SELECT
    cr.settings_id,
    cr.settings_version_id,
    cr.version,
    cr.value,
    jsonb_strip_nulls(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              COALESCE(cr.value, '{}'::jsonb),
              '{version}',
              to_jsonb(GREATEST(COALESCE(NULLIF(cr.value->>'version', '')::INT, cr.version, 1), 2)),
              TRUE
            ),
            '{requirements,completed}',
            COALESCE(cr.value->'requirements'->'completed', '{}'::jsonb)
              || jsonb_build_object(
                'photo_required',
                COALESCE(
                  (cr.value->'requirements'->'completed'->>'photo_required')::boolean,
                  (cr.value->'requirements'->'delivered'->>'photo')::boolean,
                  FALSE
                ),
                'signature_required',
                COALESCE(
                  (cr.value->'requirements'->'completed'->>'signature_required')::boolean,
                  (cr.value->'requirements'->'delivered'->>'signature')::boolean,
                  FALSE
                ),
                'otp_required',
                COALESCE(
                  (cr.value->'requirements'->'completed'->>'otp_required')::boolean,
                  (cr.value->'requirements'->'delivered'->>'otp')::boolean,
                  FALSE
                ),
                'min_artifact_count',
                COALESCE(
                  (cr.value->'requirements'->'completed'->>'min_artifact_count')::int,
                  CASE
                    WHEN COALESCE((cr.value->'requirements'->'delivered'->>'photo')::boolean, FALSE) THEN 1
                    ELSE 0
                  END
                )
              ),
            TRUE
          ),
          '{requirements,exception}',
          COALESCE(cr.value->'requirements'->'exception', '{}'::jsonb)
            || jsonb_build_object(
              'exception_reason_required', COALESCE((cr.value->'requirements'->'exception'->>'exception_reason_required')::boolean, TRUE),
              'notes_required_for_other', COALESCE((cr.value->'requirements'->'exception'->>'notes_required_for_other')::boolean, TRUE),
              'min_artifact_count', COALESCE((cr.value->'requirements'->'exception'->>'min_artifact_count')::int, 0)
            ),
          TRUE
        ),
        '{binary_evidence}',
        COALESCE(cr.value->'binary_evidence', '{}'::jsonb)
          || jsonb_build_object(
            'bucket_id', COALESCE(NULLIF(cr.value->'binary_evidence'->>'bucket_id', ''), 'fieldops-evidence'),
            'allowed_mime_types', COALESCE(cr.value->'binary_evidence'->'allowed_mime_types', '["image/jpeg","image/png","application/pdf"]'::jsonb),
            'max_file_bytes', COALESCE((cr.value->'binary_evidence'->>'max_file_bytes')::bigint, 5242880),
            'max_items', COALESCE((cr.value->'binary_evidence'->>'max_items')::int, 6)
          ),
        TRUE
      )
    ) AS next_value
  FROM current_rows cr
),
changed AS (
  SELECT
    r.settings_id,
    r.settings_version_id,
    r.version,
    r.next_value
  FROM rewritten r
  WHERE r.next_value IS DISTINCT FROM r.value
),
applied AS (
  UPDATE public.settings_versions sv
     SET value = c.next_value,
         schema_version = GREATEST(COALESCE(sv.schema_version, 1), 2),
         version = GREATEST(COALESCE(sv.version, 1), COALESCE(c.version, 1)),
         change_reason = COALESCE(NULLIF(sv.change_reason, ''), 'Normalize pod_policy completed proof requirements'),
         updated_at = now()
    FROM changed c
   WHERE sv.id = c.settings_version_id
  RETURNING sv.id, sv.value, c.settings_id
)
UPDATE public.settings s
   SET cached_value = a.value,
       last_updated = now()
  FROM applied a
 WHERE s.id = a.settings_id;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_route_stop_finalize_v5(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload JSONB := COALESCE(v_ctx->'payload', '{}'::jsonb);
  v_task_event_payload JSONB := '{}'::jsonb;

  v_route_stop_id UUID := NULL;
  v_stop RECORD;
  v_ship RECORD;

  v_policy_ctx JSONB := '{}'::jsonb;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_kind_policy JSONB := '{}'::jsonb;
  v_defaults JSONB := '{}'::jsonb;
  v_outcome_policy JSONB := '{}'::jsonb;
  v_exception_meta JSONB := NULL;

  v_stop_kind TEXT := NULL;
  v_outcome_reason TEXT := NULL;
  v_new_status TEXT := NULL;

  v_evidence_row RECORD;
  v_evidence_policy JSONB := '{}'::jsonb;
  v_evidence_paths JSONB := '[]'::jsonb;
  v_artifact_ids UUID[] := NULL;
  v_path TEXT;
  v_matches JSONB;
  v_elem JSONB;
  v_uuid UUID;

  v_pod_row RECORD;
  v_pod_policy JSONB := '{}'::jsonb;
  v_completed_requirements JSONB := '{}'::jsonb;
  v_legacy_delivered_requirements JSONB := '{}'::jsonb;
  v_pod_enabled BOOLEAN := TRUE;
  v_photo_required BOOLEAN := FALSE;
  v_min_artifact_count INT := 0;
  v_valid_artifact_count INT := 0;
  v_photo_artifact_count INT := 0;
  v_resp public.workflow_handler_response;
  v_operation_result JSONB := '{}'::jsonb;
  v_followup_task_ids JSONB := '[]'::jsonb;
  v_followup_task_id_text TEXT;
  v_followup_task_id UUID := NULL;
  v_task RECORD;
  v_assignment_defaults JSONB := '{}'::jsonb;
  v_assigned_to UUID := NULL;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  IF jsonb_typeof(v_payload) <> 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  v_task_event_payload := COALESCE(v_payload->'task_event_payload', '{}'::jsonb);
  BEGIN
    v_route_stop_id := NULLIF(v_ctx->>'resource_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_stop_id := NULL;
  END;
  v_outcome_reason := lower(NULLIF(btrim(COALESCE(v_task_event_payload->>'status_reason', '')), ''));

  IF v_route_stop_id IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: missing resource_id(route_stop_id) (workflow_run_id=% step_id=%)', p_run.id, p_step.id
      USING ERRCODE = '23514';
  END IF;

  SELECT
    rs.id AS route_stop_id,
    rs.organization_id,
    rs.client_id,
    rs.shipment_id,
    rs.stop_kind,
    rs.route_run_id,
    rr.branch_id
  INTO v_stop
  FROM public.route_stops rs
  JOIN public.route_runs rr ON rr.id = rs.route_run_id
  WHERE rs.id = v_route_stop_id
  LIMIT 1;

  IF v_stop.shipment_id IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: route_stop % not found', v_route_stop_id USING ERRCODE = '23503';
  END IF;

  SELECT
    s.id AS shipment_id,
    s.organization_id,
    s.client_id,
    s.sender_id,
    s.status AS shipment_status
  INTO v_ship
  FROM public.shipments s
  WHERE s.id = v_stop.shipment_id
    AND s.client_id = v_stop.client_id
  LIMIT 1;

  IF v_ship.shipment_id IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: shipment % not found for client %', v_stop.shipment_id, v_stop.client_id
      USING ERRCODE = '23503';
  END IF;

  v_stop_kind := lower(COALESCE(NULLIF(btrim(COALESCE(v_stop.stop_kind, '')), ''), 'delivery'));

  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'resource_id', v_stop.branch_id,
    'organization_id', v_stop.organization_id,
    'client_id', v_stop.client_id,
    'sender_id', v_ship.sender_id
  ));

  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row_from_policy_context_v1('dispatch_stop_policy', v_policy_ctx)
   LIMIT 1;

  v_policy := COALESCE(v_policy_row.value, '{}'::jsonb);
  IF jsonb_typeof(v_policy) <> 'object' THEN
    v_policy := '{}'::jsonb;
  END IF;

  v_defaults := COALESCE(v_policy->'defaults', '{}'::jsonb);
  IF jsonb_typeof(v_defaults) <> 'object' THEN
    v_defaults := '{}'::jsonb;
  END IF;

  v_kind_policy := COALESCE(v_policy->'stop_kind_map'->v_stop_kind, '{}'::jsonb);
  IF jsonb_typeof(v_kind_policy) <> 'object' THEN
    v_kind_policy := '{}'::jsonb;
  END IF;

  v_new_status := lower(NULLIF(btrim(COALESCE(v_kind_policy->>'shipment_status', '')), ''));

  IF v_outcome_reason IS NOT NULL THEN
    v_outcome_policy := COALESCE(v_kind_policy->'outcome_map'->v_outcome_reason, '{}'::jsonb);
    IF jsonb_typeof(v_outcome_policy) <> 'object' THEN
      v_outcome_policy := '{}'::jsonb;
    END IF;

    v_exception_meta := NULL;
    SELECT lv.metadata
      INTO v_exception_meta
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'dispatch_exception_reason'
       AND lv.value = v_outcome_reason
       AND lv.status = 'active'
     LIMIT 1;

    IF jsonb_typeof(v_exception_meta) <> 'object' THEN
      v_exception_meta := NULL;
    END IF;

    v_new_status := lower(NULLIF(btrim(COALESCE(
      v_outcome_policy->>'shipment_status',
      v_exception_meta->>'default_shipment_status',
      v_new_status
    )), ''));
  END IF;

  IF v_stop_kind <> 'delivery' OR v_new_status IS DISTINCT FROM 'delivered' THEN
    v_resp := workflow_handlers.execute_route_stop_finalize_v4(p_step, p_run, p_operation_result);
  ELSE
    SELECT *
      INTO v_evidence_row
      FROM public.resolve_settings_row_from_policy_context_v1('dispatch_evidence_policy', v_policy_ctx)
     LIMIT 1;

    v_evidence_policy := COALESCE(v_evidence_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_evidence_policy) <> 'object' THEN
      v_evidence_policy := '{}'::jsonb;
    END IF;

    v_evidence_paths := COALESCE(v_evidence_policy->'artifact_id_paths', '[]'::jsonb);
    IF jsonb_typeof(v_evidence_paths) <> 'array' THEN
      v_evidence_paths := '[]'::jsonb;
    END IF;

    v_artifact_ids := ARRAY[]::uuid[];
    FOR v_path IN
      SELECT jsonb_array_elements_text(v_evidence_paths)
    LOOP
      v_path := NULLIF(btrim(COALESCE(v_path, '')), '');
      IF v_path IS NULL THEN
        CONTINUE;
      END IF;

      BEGIN
        v_matches := jsonb_path_query_array(v_task_event_payload, v_path::jsonpath);
      EXCEPTION
        WHEN others THEN
          v_matches := '[]'::jsonb;
      END;

      IF jsonb_typeof(v_matches) <> 'array' THEN
        CONTINUE;
      END IF;

      FOR v_elem IN
        SELECT jsonb_array_elements(v_matches)
      LOOP
        IF jsonb_typeof(v_elem) IS DISTINCT FROM 'string' THEN
          CONTINUE;
        END IF;

        BEGIN
          v_uuid := NULLIF(btrim(COALESCE(v_elem#>>'{}', '')), '')::uuid;
        EXCEPTION
          WHEN others THEN
            v_uuid := NULL;
        END;

        IF v_uuid IS NOT NULL THEN
          v_artifact_ids := array_append(v_artifact_ids, v_uuid);
        END IF;
      END LOOP;
    END LOOP;

    IF array_length(v_artifact_ids, 1) IS NULL THEN
      v_artifact_ids := NULL;
    ELSE
      SELECT array_agg(DISTINCT x)
        INTO v_artifact_ids
        FROM unnest(v_artifact_ids) AS x;
    END IF;

    SELECT *
      INTO v_pod_row
      FROM public.resolve_pod_policy(
        jsonb_strip_nulls(
          jsonb_build_object(
            'organization_id', v_stop.organization_id,
            'client_id', v_stop.client_id,
            'sender_id', v_ship.sender_id,
            'resource_type', 'route_stop',
            'resource_id', v_route_stop_id
          )
        )
      )
     LIMIT 1;

    v_pod_policy := COALESCE(v_pod_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_pod_policy) <> 'object' THEN
      v_pod_policy := '{}'::jsonb;
    END IF;

    BEGIN
      v_pod_enabled := COALESCE((v_pod_policy->>'enabled')::boolean, TRUE);
    EXCEPTION
      WHEN others THEN
        v_pod_enabled := TRUE;
    END;

    IF NOT v_pod_enabled THEN
      v_resp := workflow_handlers.execute_route_stop_finalize_v4(p_step, p_run, p_operation_result);
    ELSE
      v_completed_requirements := COALESCE(v_pod_policy->'requirements'->'completed', '{}'::jsonb);
      IF jsonb_typeof(v_completed_requirements) <> 'object' THEN
        v_completed_requirements := '{}'::jsonb;
      END IF;

      v_legacy_delivered_requirements := COALESCE(v_pod_policy->'requirements'->'delivered', '{}'::jsonb);
      IF jsonb_typeof(v_legacy_delivered_requirements) <> 'object' THEN
        v_legacy_delivered_requirements := '{}'::jsonb;
      END IF;

      BEGIN
        v_photo_required := COALESCE(
          (v_completed_requirements->>'photo_required')::boolean,
          (v_legacy_delivered_requirements->>'photo')::boolean,
          FALSE
        );
      EXCEPTION
        WHEN others THEN
          v_photo_required := COALESCE((v_legacy_delivered_requirements->>'photo')::boolean, FALSE);
      END;

      BEGIN
        v_min_artifact_count := COALESCE(
          (v_completed_requirements->>'min_artifact_count')::int,
          CASE
            WHEN COALESCE((v_legacy_delivered_requirements->>'photo')::boolean, FALSE) THEN 1
            ELSE 0
          END,
          0
        );
      EXCEPTION
        WHEN others THEN
          v_min_artifact_count := CASE
            WHEN COALESCE((v_legacy_delivered_requirements->>'photo')::boolean, FALSE) THEN 1
            ELSE 0
          END;
      END;

      IF v_photo_required OR v_min_artifact_count > 0 THEN
        SELECT
          COUNT(*)::int,
          COUNT(*) FILTER (
            WHERE lower(COALESCE(NULLIF(btrim(COALESCE(a.metadata->>'artifact_kind', '')), ''), '')) = 'photo'
          )::int
          INTO v_valid_artifact_count, v_photo_artifact_count
          FROM public.artifacts a
         WHERE a.organization_id = v_stop.organization_id
           AND v_artifact_ids IS NOT NULL
           AND a.id = ANY (v_artifact_ids);

        IF v_min_artifact_count > 0 AND v_valid_artifact_count < v_min_artifact_count THEN
          RAISE EXCEPTION 'route_stop_finalize: pod proof artifacts required (minimum %, found %)', v_min_artifact_count, v_valid_artifact_count
            USING ERRCODE = '23514';
        END IF;

        IF v_photo_required AND v_photo_artifact_count < 1 THEN
          RAISE EXCEPTION 'route_stop_finalize: pod photo artifacts required (minimum 1, found %)', v_photo_artifact_count
            USING ERRCODE = '23514';
        END IF;
      END IF;

      v_resp := workflow_handlers.execute_route_stop_finalize_v4(p_step, p_run, p_operation_result);
    END IF;
  END IF;

  IF COALESCE(v_resp.status, '') <> 'completed' THEN
    RETURN v_resp;
  END IF;

  v_operation_result := COALESCE(v_resp.operation_result, '{}'::jsonb);
  v_followup_task_ids := COALESCE(v_operation_result->'followup_task_ids', '[]'::jsonb);
  IF jsonb_typeof(v_followup_task_ids) <> 'array' THEN
    RETURN v_resp;
  END IF;

  FOR v_followup_task_id_text IN
    SELECT value
      FROM jsonb_array_elements_text(v_followup_task_ids) AS ids(value)
  LOOP
    BEGIN
      v_followup_task_id := NULLIF(v_followup_task_id_text, '')::uuid;
    EXCEPTION
      WHEN others THEN
        v_followup_task_id := NULL;
    END;

    IF v_followup_task_id IS NULL THEN
      CONTINUE;
    END IF;

    SELECT
      t.id,
      t.assigned_to,
      tt.metadata
      INTO v_task
      FROM public.tasks t
      JOIN public.task_types tt
        ON tt.id = t.task_type_id
     WHERE t.id = v_followup_task_id
     LIMIT 1;

    IF v_task.id IS NULL OR v_task.assigned_to IS NOT NULL THEN
      CONTINUE;
    END IF;

    v_assignment_defaults := '{}'::jsonb;
    IF jsonb_typeof(COALESCE(v_task.metadata, '{}'::jsonb)) = 'object'
       AND jsonb_typeof(COALESCE(v_task.metadata, '{}'::jsonb)->'assignment_defaults') = 'object' THEN
      v_assignment_defaults := COALESCE(v_task.metadata, '{}'::jsonb)->'assignment_defaults';
    END IF;

    IF v_assignment_defaults = '{}'::jsonb THEN
      CONTINUE;
    END IF;

    v_assigned_to := public.resolve_task_assignee_user_v1(
      v_stop.organization_id,
      v_stop.branch_id,
      v_assignment_defaults
    );

    IF v_assigned_to IS NULL THEN
      CONTINUE;
    END IF;

    PERFORM *
      FROM public.assign_task_system_v1(
        v_followup_task_id,
        v_assigned_to,
        format('dispatch_stop_followup_assign:%s:%s', p_run.id, v_followup_task_id),
        'Auto-assigned from task type assignment_defaults',
        'dispatch_engine'
      );
  END LOOP;

  RETURN v_resp;
END;
$function$;

ALTER TABLE public.operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

INSERT INTO public.operation_handlers (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'route_stop_finalize',
  'workflow_handlers',
  'execute_route_stop_finalize_v5',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v5',
  TRUE,
  'Finalize a dispatch route_stop execution through v4 after enforcing pod_policy photo/min-artifact requirements for delivered delivery stops using canonical dispatch evidence extraction.',
  'docs/product/guides/handlers-cookbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

ALTER TABLE public.operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

DO $do$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'dispatch_route_stop_finalize_v1'
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.workflow_template_steps
     SET handler_version = 'v5',
         updated_at = now()
   WHERE workflow_template_id = v_template_id
     AND handler_key = 'route_stop_finalize';
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604051130_b08_uc102_photo_proof_contract_v1'));
COMMIT;

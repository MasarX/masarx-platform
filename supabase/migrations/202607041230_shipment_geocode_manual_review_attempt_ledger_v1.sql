-- Migration: Shipment geocode manual-review attempt ledger
-- Purpose:
--   Keep low-confidence/no-match shipment geocoding review paths audit-complete
--   by recording a canonical geocoding_attempts decision row when the workflow
--   reaches manual review without a provider/local attempt row.

BEGIN;

SELECT pg_advisory_lock(hashtext('202607041230_shipment_geocode_manual_review_attempt_ledger_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_geocode_manual_review_enqueue_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_queue TEXT := COALESCE(v_metadata->>'queue_assignment', v_metadata->>'queue_key', 'address_ops');
    v_sla INTEGER := COALESCE((v_metadata->>'sla_minutes')::INT, 60);
    v_ctx RECORD;
    v_required BOOLEAN := COALESCE(
        p_run.context->'geocoding'->>'manual_review_required',
        'false'
    )::BOOLEAN;
    v_reason TEXT := COALESCE(
        p_run.context->'geocoding'->>'manual_review_reason',
        'geocoding_low_confidence'
    );
    v_task_id UUID;
    v_attempt_id UUID;
    v_attempt_order INTEGER;
    v_confidence NUMERIC(5,4);
    v_response workflow_handler_response;
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

    IF NOT v_required THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'enqueued', FALSE,
            'reason', 'manual_review_not_required'
        );
        RETURN v_response;
    END IF;

    SELECT *
    INTO v_ctx
    FROM public.geocoding_extract_context(p_run);

    INSERT INTO public.manual_review_tasks (
        organization_id,
        client_id,
        sender_id,
        address_id,
        shipment_id,
        task_type,
        reason,
        status,
        queue_assignment,
        sla_minutes,
        sla_due_at,
        metadata
    )
    VALUES (
        v_ctx.organization_id,
        v_ctx.client_id,
        v_ctx.sender_id,
        v_ctx.address_id,
        v_ctx.shipment_id,
        'geocoding',
        v_reason,
        'pending',
        v_queue,
        v_sla,
        now() + (v_sla || ' minutes')::INTERVAL,
        jsonb_build_object(
            'workflow_run_id', p_step.workflow_run_id,
            'workflow_step_id', p_step.workflow_template_step_id
        )
    )
    RETURNING id INTO v_task_id;

    SELECT ga.id
      INTO v_attempt_id
      FROM public.geocoding_attempts ga
      JOIN public.workflow_run_steps wrs
        ON wrs.id = ga.workflow_run_step_id
     WHERE ga.address_id = v_ctx.address_id
       AND wrs.workflow_run_id = p_step.workflow_run_id
     ORDER BY ga.created_at DESC, ga.updated_at DESC
     LIMIT 1;

    IF v_attempt_id IS NULL THEN
        SELECT COALESCE(MAX(ga.attempt_order), 0) + 1
          INTO v_attempt_order
          FROM public.geocoding_attempts ga
         WHERE ga.address_id = v_ctx.address_id;

        v_confidence := CASE
            WHEN NULLIF(p_run.context#>>'{geocoding,confidence}', '') ~ '^[0-9]+(\.[0-9]+)?$'
                THEN LEAST(GREATEST((p_run.context#>>'{geocoding,confidence}')::NUMERIC, 0), 1)
            WHEN NULLIF(p_run.context#>>'{geocoding,geocoding_match,score}', '') ~ '^[0-9]+(\.[0-9]+)?$'
                THEN LEAST(GREATEST((p_run.context#>>'{geocoding,geocoding_match,score}')::NUMERIC, 0), 1)
            ELSE NULL
        END;

        INSERT INTO public.geocoding_attempts (
            organization_id,
            client_id,
            sender_id,
            address_id,
            shipment_id,
            workflow_run_step_id,
            provider_name,
            attempt_order,
            attempt_type,
            status,
            confidence,
            decision_outcome,
            metadata,
            created_at,
            updated_at
        )
        VALUES (
            v_ctx.organization_id,
            v_ctx.client_id,
            v_ctx.sender_id,
            v_ctx.address_id,
            v_ctx.shipment_id,
            p_step.id,
            'manual_review_gate',
            v_attempt_order,
            'manual_review',
            'deferred',
            v_confidence,
            'manual_review_required',
            jsonb_strip_nulls(jsonb_build_object(
                'workflow_run_id', p_step.workflow_run_id,
                'workflow_step_id', p_step.id,
                'workflow_template_step_id', p_step.workflow_template_step_id,
                'manual_review_task_id', v_task_id,
                'manual_review_reason', v_reason,
                'routing_reason', COALESCE(NULLIF(p_run.context#>>'{geocoding,manual_review_reason}', ''), v_reason),
                'decision_source', 'workflow_handlers.execute_geocode_manual_review_enqueue_v1',
                'thresholds', p_run.context#>'{geocoding,thresholds}',
                'selected_attempt_id', NULLIF(p_run.context#>>'{geocoding,selected_attempt_id}', ''),
                'selected_geocode', p_run.context#>'{geocoding,selected_geocode}',
                'match', p_run.context#>'{geocoding,geocoding_match}'
            )),
            now(),
            now()
        )
        RETURNING id INTO v_attempt_id;
    END IF;

    UPDATE public.manual_review_tasks
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'geocoding_attempt_id', v_attempt_id
           ),
           updated_at = now()
     WHERE id = v_task_id;

    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
        'enqueued', TRUE,
        'task_id', v_task_id,
        'geocoding_attempt_id', v_attempt_id
    );
    v_response.context_patch := jsonb_build_object(
        'geocoding', jsonb_build_object(
            'manual_review_task_id', v_task_id,
            'manual_review_attempt_id', v_attempt_id,
            'selected_attempt_id', v_attempt_id
        )
    );

    RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_geocode_manual_review_enqueue_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Enqueues a geocoding manual review task and records a deferred manual_review geocoding_attempts ledger row when no provider/local attempt exists for the workflow.';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_manual_review_select JSONB := jsonb_build_array(
    'id',
    'organization_id',
    'client_id',
    'sender_id',
    'address_id',
    'shipment_id',
    'task_type',
    'status',
    'reason',
    'queue_assignment',
    'assigned_to',
    'sla_due_at',
    'resource_type',
    'resource_id',
    'resolution_outcome',
    'resolution_notes',
    'resolved_by',
    'resolved_at',
    'created_at',
    'updated_at'
  );
  v_manual_review_filters JSONB := jsonb_build_array(
    jsonb_build_object('key','id','column','id','op','eq'),
    jsonb_build_object('key','address_id','column','address_id','op','eq'),
    jsonb_build_object('key','shipment_id','column','shipment_id','op','eq'),
    jsonb_build_object('key','status','column','status','op','eq'),
    jsonb_build_object('key','task_type','column','task_type','op','eq'),
    jsonb_build_object('key','queue_assignment','column','queue_assignment','op','eq'),
    jsonb_build_object('key','assigned_to','column','assigned_to','op','eq'),
    jsonb_build_object('key','resource_type','column','resource_type','op','eq'),
    jsonb_build_object('key','resource_id','column','resource_id','op','eq'),
    jsonb_build_object('key','resolution_outcome','column','resolution_outcome','op','eq')
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

  FOR v_resource IN SELECT * FROM jsonb_array_elements(v_resources) LOOP
    IF v_resource->>'key' = 'manual_review_tasks' THEN
      v_resource := jsonb_set(v_resource, '{select}', v_manual_review_select, true);
      v_resource := jsonb_set(v_resource, '{filters}', v_manual_review_filters, true);
    END IF;
    v_updated := v_updated || jsonb_build_array(v_resource);
  END LOOP;

  v_current := jsonb_set(v_current, '{resources}', v_updated, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Expose address-linked shipment geocode review task lineage',
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
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202607041230_shipment_geocode_manual_review_attempt_ledger_v1'));

COMMIT;

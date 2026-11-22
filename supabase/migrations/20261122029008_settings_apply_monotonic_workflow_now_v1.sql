-- Migration: Preserve settings apply monotonic closeout with workflow time
-- Why:
--   - 202604121730 made prior settings_versions closeout monotonic.
--   - 202604150500 later switched the handler to workflow_now() but regressed
--     that monotonic effective_until guard.

BEGIN;
SELECT pg_advisory_xact_lock(hashtext('20261122029008_settings_apply_monotonic_workflow_now_v1'));
SET LOCAL search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_settings_apply_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_task_id UUID := NULLIF(v_ctx->>'manual_review_task_id', '')::UUID;

    v_task public.manual_review_tasks%ROWTYPE;
    v_settings_version_id UUID;
    v_sv public.settings_versions%ROWTYPE;

    v_org UUID;
    v_now TIMESTAMPTZ := public.workflow_now();
    v_resp workflow_handler_response;
BEGIN
    IF v_task_id IS NULL THEN
        RAISE EXCEPTION 'settings_apply: manual_review_task_id missing from workflow context (workflow_run_id=%)', p_run.id;
    END IF;

    SELECT * INTO v_task FROM public.manual_review_tasks mrt WHERE mrt.id = v_task_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'settings_apply: manual_review_task_id % not found', v_task_id;
    END IF;

    IF v_task.status <> 'resolved' OR v_task.resolution_outcome IS DISTINCT FROM 'approved' THEN
        v_resp.status := 'failed';
        v_resp.last_error := 'settings_apply: approval missing or rejected';
        v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
          'manual_review_task_id', v_task_id,
          'resolution_outcome', v_task.resolution_outcome,
          'resolution_notes', v_task.resolution_notes
        ));
        RETURN v_resp;
    END IF;

    IF v_task.resource_type = 'settings_version' AND v_task.resource_id IS NOT NULL THEN
      v_settings_version_id := v_task.resource_id;
    ELSE
      v_settings_version_id := NULLIF(v_ctx->>'resource_id', '')::UUID;
    END IF;

    IF v_settings_version_id IS NULL THEN
      RAISE EXCEPTION 'settings_apply: settings_version_id missing (manual_review_task_id=%)', v_task_id;
    END IF;

    SELECT *
      INTO v_sv
      FROM public.settings_versions sv
     WHERE sv.id = v_settings_version_id
     LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'settings_apply: settings_versions row not found for id=%', v_settings_version_id;
    END IF;

    v_org := COALESCE(v_task.organization_id, NULLIF(v_ctx->'payload'->>'organization_id', '')::UUID, public.current_user_org_id());
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'settings_apply: organization_id missing for decision log (settings_version_id=%)', v_settings_version_id;
    END IF;

    -- Keep append-only history monotonic even when the previous row was future-dated.
    UPDATE public.settings_versions
       SET effective_until = GREATEST(
             v_now,
             effective_from + INTERVAL '1 microsecond'
           )
     WHERE category = v_sv.category
       AND scope_type = v_sv.scope_type
       AND scope_hash = v_sv.scope_hash
       AND approved_at IS NOT NULL
       AND effective_until IS NULL
       AND id <> v_settings_version_id;

    UPDATE public.settings_versions
       SET approved_at = COALESCE(approved_at, v_task.resolved_at, v_now),
           approved_by = COALESCE(approved_by, v_task.resolved_by),
           effective_from = CASE WHEN approved_at IS NULL THEN v_now ELSE effective_from END
     WHERE id = v_settings_version_id
       AND scope_hash = v_sv.scope_hash;

    INSERT INTO public.settings (
      id,
      category,
      scope_type,
      scope_id,
      scope_hash,
      settings_version_id,
      cached_value,
      last_updated
    ) VALUES (
      gen_random_uuid(),
      v_sv.category,
      v_sv.scope_type,
      v_sv.scope_id,
      v_sv.scope_hash,
      v_settings_version_id,
      v_sv.value,
      v_now
    )
    ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
    SET scope_id = EXCLUDED.scope_id,
        settings_version_id = EXCLUDED.settings_version_id,
        cached_value = EXCLUDED.cached_value,
        last_updated = EXCLUDED.last_updated;

    PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'settings',
        p_resource_type := 'settings_version',
        p_resource_id := v_settings_version_id,
        p_decision_point := 'apply',
        p_decision_outcome := 'applied',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'category', v_sv.category,
          'scope_type', v_sv.scope_type,
          'scope_id', v_sv.scope_id,
          'manual_review_task_id', v_task_id,
          'approved_by', v_task.resolved_by
        )),
        p_decision_reason := NULL
    );

    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'settings_version_id', v_settings_version_id,
      'category', v_sv.category,
      'scope_type', v_sv.scope_type,
      'scope_id', v_sv.scope_id
    ));
    v_resp.context_patch := jsonb_strip_nulls(jsonb_build_object(
      'settings_applied', jsonb_build_object(
        'settings_version_id', v_settings_version_id,
        'category', v_sv.category,
        'scope_type', v_sv.scope_type,
        'scope_id', v_sv.scope_id,
        'applied_at', v_now
      )
    ));
    RETURN v_resp;
END;
$$;

COMMIT;

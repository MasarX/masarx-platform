-- Keep target-neutral reprints separate from the canonical shipment reprint path.

BEGIN;

CREATE FUNCTION public.request_label_artifact_reprint_v1(
    p_label_id UUID,
    p_reprint_reason TEXT,
    p_actor_id UUID,
    p_requested_source TEXT,
    p_is_privileged BOOLEAN
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
    v_label public.label_artifacts%ROWTYPE;
    v_template_snapshot JSONB;
    v_template_version INTEGER;
    v_template_id UUID;
    v_retry JSONB;
    v_max_attempts INTEGER;
    v_job_id UUID;
    v_context JSONB;
    v_workflow_run_id UUID;
    v_workflow_run_step_id UUID;
    v_created_wrapper BOOLEAN := FALSE;
    v_reprint_reason TEXT := NULLIF(btrim(COALESCE(p_reprint_reason, '')), '');
    v_source_job public.label_jobs%ROWTYPE;
BEGIN
    SELECT * INTO v_label
    FROM public.label_artifacts
    WHERE id = p_label_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Label % not found', p_label_id;
    END IF;

    IF p_is_privileged IS NOT TRUE
       AND public.current_user_org_id() IS DISTINCT FROM v_label.organization_id THEN
        RAISE EXCEPTION 'Access denied for label %', p_label_id;
    END IF;

    IF v_label.source_label_job_id IS NOT NULL THEN
        SELECT *
        INTO v_source_job
        FROM public.label_jobs
        WHERE id = v_label.source_label_job_id
        LIMIT 1;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Source label job % not found for label_artifact %', v_label.source_label_job_id, p_label_id;
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
            FROM public.resolve_label_template(
                v_label.organization_id,
                v_label.client_id,
                NULL::uuid,
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

    v_context := jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_label.organization_id,
        'client_id', v_label.client_id,
        'label_artifact_id', p_label_id,
        'target_type', v_label.target_type,
        'target_id', v_label.target_id,
        'target_box_id', v_label.target_box_id,
        'label_type', v_label.label_type,
        'job_purpose', 'reprint',
        'requested_source', p_requested_source,
        'source_label_job_id', v_label.source_label_job_id
    ));

    SELECT workflow_run_id, workflow_run_step_id, created_wrapper
    INTO v_workflow_run_id, v_workflow_run_step_id, v_created_wrapper
    FROM public.ensure_label_job_workflow_context(v_context)
    LIMIT 1;

    INSERT INTO public.label_jobs (
        organization_id,
        client_id,
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
        reprint_reason,
        renderer_hint,
        retry_state,
        workflow_run_step_id
    )
    VALUES (
        v_label.organization_id,
        COALESCE(v_label.client_id, v_source_job.client_id),
        v_label.target_type,
        v_label.target_id,
        v_label.target_box_id,
        jsonb_strip_nulls(COALESCE(v_label.metadata, '{}'::jsonb) || jsonb_build_object(
            'source_label_artifact_id', p_label_id,
            'source_label_job_id', v_label.source_label_job_id,
            'reprint_reason', v_reprint_reason
        )),
        v_label.label_type,
        v_template_id,
        COALESCE(v_template_version, 1),
        v_template_snapshot,
        'pending',
        0,
        COALESCE(v_max_attempts, 5),
        now(),
        'reprint',
        gen_random_uuid()::text,
        p_actor_id,
        p_requested_source,
        v_reprint_reason,
        v_template_snapshot -> 'label_config' ->> 'provider_hint',
        COALESCE(v_retry, '[]'::jsonb),
        v_workflow_run_step_id
    )
    RETURNING id INTO v_job_id;

    IF v_created_wrapper AND v_job_id IS NOT NULL THEN
      UPDATE public.workflow_run_steps
      SET operation_result = jsonb_strip_nulls(jsonb_build_object(
            'label_job_id', v_job_id,
            'label_type', v_label.label_type,
            'job_purpose', 'reprint',
            'source_label_artifact_id', p_label_id
          )),
          updated_at = now()
      WHERE id = v_workflow_run_step_id;

      UPDATE public.workflow_runs
      SET context = jsonb_strip_nulls(COALESCE(context, '{}'::jsonb) || jsonb_build_object(
            'label_job_id', v_job_id,
            'label_job_status', 'pending',
            'source_label_artifact_id', p_label_id
          )),
          updated_at = now()
      WHERE id = v_workflow_run_id;
    END IF;

    PERFORM public.log_decision(
        p_organization_id := v_label.organization_id,
        p_decision_category := 'label_job',
        p_resource_type := 'label_job',
        p_resource_id := v_job_id,
        p_decision_point := 'request_label_reprint',
        p_decision_outcome := 'enqueued',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'label_artifact_id', p_label_id,
            'label_type', v_label.label_type,
            'template_id', v_template_id,
            'template_version', v_template_version,
            'requested_source', p_requested_source,
            'source_label_job_id', v_label.source_label_job_id,
            'target_type', v_label.target_type,
            'target_id', v_label.target_id,
            'target_box_id', v_label.target_box_id
        )),
        p_decision_reason := v_reprint_reason
    );

    RETURN v_job_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.request_label_artifact_reprint_v1(UUID, TEXT, UUID, TEXT, BOOLEAN)
    FROM PUBLIC, anon, authenticated, service_role;

COMMIT;

-- Migration: UI workflow run starter + draft preview support
BEGIN;
SELECT pg_advisory_lock(hashtext('202601192200_ui_start_workflow_run_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION start_workflow_run(
    p_workflow_template_id UUID,
    p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_template workflow_templates%ROWTYPE;
    v_run_id UUID;
    v_now TIMESTAMPTZ := now();
    v_idem_key TEXT;
    v_entry_point TEXT := COALESCE(NULLIF(p_context->>'trigger_source', ''), 'webhook');
    v_inserted BOOLEAN := FALSE;
    v_version INTEGER;
    v_allow_inactive_raw TEXT;
    v_allow_inactive BOOLEAN := FALSE;
    v_scope_type TEXT;
    v_scope_id UUID;
BEGIN
    SELECT * INTO v_template
    FROM workflow_templates
    WHERE id = p_workflow_template_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'start_workflow_run: template % not found', p_workflow_template_id;
    END IF;

    IF v_template.status <> 'active' THEN
        v_allow_inactive_raw := lower(COALESCE(NULLIF(p_context #>> '{ui,allow_inactive}', ''), ''));
        v_allow_inactive := v_allow_inactive_raw IN ('1', 't', 'true', 'y', 'yes');

        IF v_allow_inactive THEN
            v_scope_type := public.current_user_scope_type();
            v_scope_id := public.current_user_scope_id();
            PERFORM public.assert_capability_v1('workflow_runs.write', v_scope_type, v_scope_id);
        ELSE
            RAISE EXCEPTION 'start_workflow_run: template % is not active', p_workflow_template_id;
        END IF;
    END IF;

    v_idem_key := compute_workflow_idempotency_key(p_workflow_template_id, p_context);

    IF v_idem_key IS NOT NULL THEN
        SELECT id INTO v_run_id
        FROM workflow_runs
        WHERE workflow_template_id = p_workflow_template_id
          AND idempotency_key = v_idem_key
        LIMIT 1;
        IF v_run_id IS NOT NULL THEN
            PERFORM set_config('app.workflow_run_id', v_run_id::text, true);
            RETURN v_run_id;
        END IF;
    END IF;

    v_run_id := gen_random_uuid();
    PERFORM set_config('app.workflow_run_id', v_run_id::text, true);
    v_version := resolve_template_version(v_template.id);

    BEGIN
        INSERT INTO workflow_runs (
            id,
            workflow_template_id,
            workflow_template_version,
            triggered_by_request_id,
            entry_point,
            workflow_status,
            context,
            metadata,
            idempotency_key,
            created_at,
            updated_at
        )
        VALUES (
            v_run_id,
            v_template.id,
            v_version,
            NULL,
            v_entry_point,
            'pending',
            COALESCE(p_context, '{}'::jsonb),
            jsonb_build_object('template_notes', v_template.notes),
            v_idem_key,
            v_now,
            v_now
        );
        v_inserted := TRUE;
    EXCEPTION WHEN unique_violation THEN
        IF v_idem_key IS NULL THEN RAISE; END IF;
        SELECT id INTO v_run_id
        FROM workflow_runs
        WHERE workflow_template_id = p_workflow_template_id
          AND idempotency_key = v_idem_key
        LIMIT 1;
        IF v_run_id IS NULL THEN RAISE; END IF;
        PERFORM set_config('app.workflow_run_id', v_run_id::text, true);
        v_inserted := FALSE;
    END;

    IF v_inserted THEN
        WITH step_src AS (
            SELECT DISTINCT ON (wts.sequence_order)
                wts.id               AS template_step_id,
                wts.sequence_order   AS seq,
                wts.operation_name   AS op_name,
                wts.metadata         AS meta,
                wts.handler_key      AS hkey,
                COALESCE(NULLIF(wts.handler_version, ''), 'v1') AS hver,
                wts.updated_at
            FROM workflow_template_steps wts
            WHERE wts.workflow_template_id = v_template.id
              AND wts.enabled = TRUE
            ORDER BY wts.sequence_order, wts.updated_at DESC
        )
        INSERT INTO workflow_run_steps (
            id,
            workflow_run_id,
            workflow_template_step_id,
            sequence_order,
            step_status,
            operation_name,
            max_retries,
            metadata,
            handler_key,
            handler_version,
            enqueued_at,
            created_at,
            updated_at
        )
        SELECT
            gen_random_uuid(),
            v_run_id,
            template_step_id,
            seq,
            'pending',
            op_name,
            COALESCE(NULLIF(meta->>'max_retries', '')::INT, 3),
            COALESCE(meta, '{}'::jsonb),
            hkey,
            hver,
            v_now,
            v_now,
            v_now
        FROM step_src
        ORDER BY seq;
    END IF;

    RETURN v_run_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_start_workflow_run_v1(
  p_workflow_template_id UUID,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_require_active BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_require_active BOOLEAN := COALESCE(p_require_active, TRUE);
  v_context JSONB;
  v_run_id UUID;
BEGIN
  PERFORM public.assert_capability_v1('workflow_runs.write', v_scope_type, v_scope_id);

  v_context := jsonb_build_object(
    'trigger_source', 'manual',
    'organization_id', public.current_user_org_id(),
    'requested_by', auth.uid(),
    'payload', COALESCE(p_payload, '{}'::jsonb),
    'ui', jsonb_build_object(
      'allow_inactive', (NOT v_require_active),
      'workflow_template_id', p_workflow_template_id
    )
  );

  v_run_id := start_workflow_run(p_workflow_template_id, v_context);

  RETURN jsonb_build_object(
    'status', 'workflow_started',
    'workflow_template_id', p_workflow_template_id,
    'workflow_run_id', v_run_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_start_workflow_run_v1(UUID, JSONB, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_start_workflow_run_v1(UUID, JSONB, BOOLEAN) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601192200_ui_start_workflow_run_v1'));
COMMIT;


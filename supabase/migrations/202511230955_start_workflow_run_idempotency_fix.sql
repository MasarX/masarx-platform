-- Migration: start_workflow_run idempotency materialization guard
-- Purpose: Avoid duplicate step materialization when a concurrent session inserts the run.

BEGIN;

SET search_path TO public;

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
BEGIN
    SELECT * INTO v_template
    FROM workflow_templates
    WHERE id = p_workflow_template_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'start_workflow_run: template % not found', p_workflow_template_id;
    END IF;

    IF v_template.status <> 'active' THEN
        RAISE EXCEPTION 'start_workflow_run: template % is not active', p_workflow_template_id;
    END IF;

    v_idem_key := compute_workflow_idempotency_key(p_workflow_template_id, p_context);

    IF v_idem_key IS NOT NULL THEN
        SELECT id INTO v_run_id
        FROM workflow_runs
        WHERE workflow_template_id = p_workflow_template_id
          AND idempotency_key = v_idem_key
        LIMIT 1;
        IF v_run_id IS NOT NULL THEN
            -- Existing run: do not re-materialize steps
            RETURN v_run_id;
        END IF;
    END IF;

    v_run_id := gen_random_uuid();

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
            v_template.version,
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
        v_inserted := FALSE;
    END;

    IF v_inserted THEN
        -- Materialize steps only when we created the run
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
            wts.id,
            wts.sequence_order,
            'pending',
            wts.operation_name,
            COALESCE(NULLIF(wts.metadata->>'max_retries', '')::INT, 3),
            COALESCE(wts.metadata, '{}'::jsonb),
            wts.handler_key,
            COALESCE(NULLIF(wts.handler_version, ''), 'v1'),
            v_now,
            v_now,
            v_now
        FROM workflow_template_steps wts
        WHERE wts.workflow_template_id = v_template.id
          AND wts.enabled = TRUE
        ORDER BY wts.sequence_order;
    END IF;

    RETURN v_run_id;
END;
$$;

COMMENT ON FUNCTION start_workflow_run(UUID, JSONB)
  IS 'Create or reuse a workflow run with idempotency and guard against duplicate step materialization under concurrency.';

COMMIT;


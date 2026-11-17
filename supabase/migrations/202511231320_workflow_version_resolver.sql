-- Migration: Workflow version resolver and start_workflow_run update
-- Purpose: Remove implicit version usage; add resolver and update starter to call it.

BEGIN;

SET search_path TO public;

-- 1) Version resolver (future-proof: adjust to read workflow_template_versions if added)
CREATE OR REPLACE FUNCTION resolve_template_version(p_workflow_template_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((SELECT version FROM workflow_templates WHERE id = p_workflow_template_id), 1)
$$;

COMMENT ON FUNCTION resolve_template_version(UUID)
  IS 'Returns the active version for the given workflow template (reads from workflow_templates.version; future-proof for versions table).';

-- 2) Update start_workflow_run to use the resolver
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
            RETURN v_run_id;
        END IF;
    END IF;

    v_run_id := gen_random_uuid();
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

COMMENT ON FUNCTION start_workflow_run(UUID, JSONB)
  IS 'Create or reuse a workflow run with idempotency; uses resolve_template_version() and dedupes steps by sequence_order.';

COMMIT;


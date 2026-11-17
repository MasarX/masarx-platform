-- Migration: start_workflow_run idempotency guard
-- Purpose: Ensure concurrent starts for the same logical context reuse a single run
--          to prevent duplicate step materialization. Fully dynamic and settings-free.
-- Notes:
--   - Adds workflow_runs.idempotency_key (TEXT) + unique index with template scope.
--   - Introduces compute_workflow_idempotency_key(UUID, JSONB) helper.
--   - Replaces start_workflow_run(...) to use the idempotency guard and tolerate
--     concurrent unique violations by returning the existing run.

BEGIN;

SET search_path TO public;

-- 1) Add idempotency_key to workflow_runs (nullable for backward compatibility)
ALTER TABLE IF EXISTS workflow_runs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Unique per template when key present
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_unique_template_key
  ON workflow_runs(workflow_template_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN workflow_runs.idempotency_key
  IS 'Optional deduplication key to reuse an existing run when the same logical context is started concurrently.';

-- 2) Helper: derive idempotency key from context in a dynamic, non-hardcoded way
CREATE OR REPLACE FUNCTION compute_workflow_idempotency_key(
    p_workflow_template_id UUID,
    p_context JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_ctx JSONB := jsonb_strip_nulls(COALESCE(p_context, '{}'::jsonb));
    v_key TEXT;
    v_rt TEXT;
    v_rid TEXT;
    v_uuid UUID;
BEGIN
    -- Explicit key wins when caller provides one
    v_key := NULLIF(v_ctx->>'idempotency_key', '');
    IF v_key IS NOT NULL THEN
        RETURN lower(v_key);
    END IF;

    -- Common dynamic keys (no hardcoded org IDs)
    v_rt := NULLIF(v_ctx->>'resource_type', '');
    v_rid := NULLIF(v_ctx->>'resource_id', '');
    IF v_rt IS NOT NULL AND v_rid IS NOT NULL THEN
        RETURN lower(format('rt:%s:rid:%s', v_rt, v_rid));
    END IF;

    v_uuid := NULLIF(v_ctx->>'domain_event_id', '')::UUID;
    IF v_uuid IS NOT NULL THEN
        RETURN lower(format('de:%s', v_uuid));
    END IF;

    v_uuid := NULLIF(v_ctx->>'shipment_id', '')::UUID;
    IF v_uuid IS NOT NULL THEN
        RETURN lower(format('shipment:%s', v_uuid));
    END IF;

    v_uuid := NULLIF(v_ctx->>'address_id', '')::UUID;
    IF v_uuid IS NOT NULL THEN
        RETURN lower(format('address:%s', v_uuid));
    END IF;

    -- No safe dynamic key available -> return NULL to allow multiple independent runs
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION compute_workflow_idempotency_key(UUID, JSONB)
  IS 'Derives a stable, dynamic idempotency key from context (explicit key > resource pair > domain_event_id > shipment_id > address_id). Returns NULL if no safe key exists.';

-- 3) Replace start_workflow_run to use idempotency guard and dynamic entry_point
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

    -- Compute idempotency key and reuse an existing run if present
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
    EXCEPTION
        WHEN unique_violation THEN
            -- Another session inserted the same (template_id, idempotency_key) run; reuse it
            IF v_idem_key IS NULL THEN
                RAISE;
            END IF;
            SELECT id INTO v_run_id
            FROM workflow_runs
            WHERE workflow_template_id = p_workflow_template_id
              AND idempotency_key = v_idem_key
            LIMIT 1;
            IF v_run_id IS NULL THEN
                RAISE;
            END IF;
    END;

    -- Materialize steps for this run
    INSERT INTO workflow_run_steps (
        id,
        workflow_run_id,
        workflow_template_step_id,
        sequence_order,
        step_status,
        operation_name,
        max_retries,
        metadata,
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
        v_now,
        v_now,
        v_now
    FROM workflow_template_steps wts
    WHERE wts.workflow_template_id = v_template.id
      AND wts.enabled = TRUE
    ORDER BY wts.sequence_order;

    RETURN v_run_id;
END;
$$;

COMMENT ON FUNCTION start_workflow_run(UUID, JSONB)
  IS 'Create or reuse a workflow run for the given template/context. Uses a dynamic idempotency key to avoid duplicate starts.';

COMMIT;


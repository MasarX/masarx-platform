-- Migration: workflow inline kick org guard + context resolver
-- Purpose:
--   - Resolve workflow organization context once and reuse it for inline kick + decisions.
--   - Skip inline kick when organization context is missing (avoids false failures).
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-15
BEGIN;
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.resolve_workflow_context_org_id(
  p_context JSONB,
  p_workflow_template_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_org UUID;
  v_client UUID;
BEGIN
  BEGIN
    v_org := NULLIF(p_context->>'organization_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_org := NULL;
  END;

  IF v_org IS NULL THEN
    BEGIN
      v_client := NULLIF(p_context->>'client_id', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_client := NULL;
    END;

    IF v_client IS NOT NULL THEN
      SELECT organization_id
        INTO v_org
        FROM public.clients
       WHERE id = v_client;
    END IF;
  END IF;

  IF v_org IS NULL AND p_workflow_template_id IS NOT NULL THEN
    SELECT wt.scope_id
      INTO v_org
      FROM public.workflow_templates wt
     WHERE wt.id = p_workflow_template_id
       AND wt.scope_id IS NOT NULL
     LIMIT 1;
  END IF;

  RETURN v_org;
END;
$$;

COMMENT ON FUNCTION public.resolve_workflow_context_org_id(JSONB, UUID)
  IS 'Resolve organization_id from workflow context (organization_id/client_id) or template scope.';

CREATE OR REPLACE FUNCTION public.record_workflow_decision(
    p_workflow_run_id UUID,
    p_step_id UUID,
    p_payload JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_run public.workflow_runs%ROWTYPE;
    v_org UUID;
    v_inputs JSONB;
    v_decision_id UUID;
    v_settings_resolution_id UUID;
    v_correlation_id UUID;
BEGIN
    SELECT *
      INTO v_run
      FROM public.workflow_runs
     WHERE id = p_workflow_run_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'record_workflow_decision: workflow_run % not found', p_workflow_run_id;
    END IF;

    v_correlation_id := public.current_correlation_id();
    v_org := public.resolve_workflow_context_org_id(v_run.context, v_run.workflow_template_id);

    IF v_correlation_id IS NULL THEN
        BEGIN
            v_correlation_id := NULLIF(v_run.context->>'correlation_id', '')::UUID;
        EXCEPTION
            WHEN others THEN
                v_correlation_id := NULL;
        END;
    END IF;

    IF v_org IS NULL THEN
        RAISE EXCEPTION 'record_workflow_decision: unable to resolve organization_id for workflow_run_id=%', p_workflow_run_id;
    END IF;

    v_inputs := COALESCE(p_payload, '{}'::jsonb) || jsonb_build_object('workflow_run_step_id', p_step_id);

    BEGIN
        v_settings_resolution_id := NULLIF(v_inputs->>'settings_resolution_id', '')::UUID;
    EXCEPTION
        WHEN others THEN
            v_settings_resolution_id := NULL;
    END;

    v_decision_id := public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'workflow',
        p_resource_type := 'workflow_run',
        p_resource_id := p_workflow_run_id,
        p_decision_point := COALESCE(NULLIF(v_inputs->>'decision_point', ''), 'step_decision'),
        p_decision_outcome := COALESCE(v_inputs->>'status', 'unknown'),
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := v_inputs,
        p_decision_reason := COALESCE(NULLIF(v_inputs->>'decision_reason', ''), 'Workflow decision recorded'),
        p_settings_resolution_id := v_settings_resolution_id
    );

    RETURN v_decision_id;
END;
$$;

COMMENT ON FUNCTION public.record_workflow_decision(UUID, UUID, JSONB)
  IS 'Write workflow decisions to decision_log via log_decision. organization_id resolves from workflow context (no arbitrary fallbacks).';
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
    v_policy_ctx JSONB;
    v_defaults JSONB;
    v_inline_kick BOOLEAN := FALSE;
    v_inline_error TEXT := NULL;
    v_inline_org UUID;
    v_decision_payload JSONB;
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

    v_policy_ctx := COALESCE(p_context, '{}'::jsonb);
    SELECT value
      INTO v_defaults
      FROM public.resolve_settings_row_from_context('workflow_defaults', v_policy_ctx)
     LIMIT 1;
    IF v_defaults IS NULL THEN
        v_defaults := public.resolve_settings('workflow_defaults', 'global', NULL);
    END IF;

    BEGIN
        v_inline_kick := NULLIF(v_defaults->>'inline_kick_on_start', '')::BOOLEAN;
    EXCEPTION
        WHEN others THEN
            v_inline_kick := NULL;
    END;
    IF v_inline_kick IS NULL THEN
        v_inline_kick := FALSE;
    END IF;

    v_inline_org := public.resolve_workflow_context_org_id(v_policy_ctx, v_template.id);

    IF v_inline_kick AND v_inline_org IS NOT NULL AND COALESCE(NULLIF(current_setting('masarx.workflow_engine', true), ''), '0') <> '1' THEN
        BEGIN
            PERFORM public.progress_workflow_run(v_run_id);
            v_decision_payload := jsonb_build_object(
                'status', 'inline_kick_success',
                'decision_point', 'workflow_inline_kick',
                'decision_reason', 'Inline kick executed on workflow start',
                'workflow_run_step_id', NULL
            );
            BEGIN
                PERFORM record_workflow_decision(v_run_id, NULL, v_decision_payload);
            EXCEPTION
                WHEN OTHERS THEN
                    NULL;
            END;
        EXCEPTION
            WHEN OTHERS THEN
                v_inline_error := SQLERRM;
                v_decision_payload := jsonb_build_object(
                    'status', 'inline_kick_failed',
                    'decision_point', 'workflow_inline_kick',
                    'decision_reason', v_inline_error,
                    'workflow_run_step_id', NULL
                );
                BEGIN
                    PERFORM record_workflow_decision(v_run_id, NULL, v_decision_payload);
                EXCEPTION
                    WHEN OTHERS THEN
                        NULL;
                END;
        END;
    END IF;

    RETURN v_run_id;
END;
$$;
COMMIT;

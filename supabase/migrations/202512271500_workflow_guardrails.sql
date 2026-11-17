-- Migration: Workflow guardrails + workflow context + decision provenance
-- Purpose:
--   - Enforce workflow-only inserts for guarded resources via row-driven guardrails.
--   - Set workflow context on workflow engine entry points.
--   - Propagate settings_resolution_id from workflow decision payloads.
-- Date: 2025-12-27

BEGIN;

CREATE TABLE IF NOT EXISTS public.workflow_guardrails (
    resource_table TEXT PRIMARY KEY,
    enforcement_mode TEXT NOT NULL DEFAULT 'enforce',
    enforce_on TEXT[] NOT NULL DEFAULT ARRAY['INSERT']::TEXT[],
    required_context_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    context_match JSONB NOT NULL DEFAULT '{}'::jsonb,
    allow_roles TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT workflow_guardrails_enforcement_mode_ck CHECK (enforcement_mode IN ('enforce', 'warn', 'disabled'))
);

COMMENT ON TABLE public.workflow_guardrails IS 'Row-driven workflow guardrails for write enforcement (context + allowed operations).';
COMMENT ON COLUMN public.workflow_guardrails.resource_table IS 'Table name guarded by workflow guardrails.';
COMMENT ON COLUMN public.workflow_guardrails.enforce_on IS 'Operations to enforce (INSERT/UPDATE/DELETE).';
COMMENT ON COLUMN public.workflow_guardrails.required_context_keys IS 'Session context keys required for enforcement (app.*).';
COMMENT ON COLUMN public.workflow_guardrails.context_match IS 'Optional map of context key -> column name for value matching.';
COMMENT ON COLUMN public.workflow_guardrails.allow_roles IS 'Database roles allowed to bypass guardrails (empty = none).';

ALTER TABLE public.workflow_guardrails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_guardrails_service_policy ON public.workflow_guardrails;
CREATE POLICY workflow_guardrails_service_policy ON public.workflow_guardrails
    FOR ALL
    TO service_role
    USING (TRUE)
    WITH CHECK (TRUE);

DROP TRIGGER IF EXISTS trg_workflow_guardrails_set_updated_at ON public.workflow_guardrails;
CREATE TRIGGER trg_workflow_guardrails_set_updated_at
    BEFORE UPDATE ON public.workflow_guardrails
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.enforce_workflow_guardrails()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_guard public.workflow_guardrails%ROWTYPE;
    v_key TEXT;
    v_context TEXT;
    v_row JSONB := to_jsonb(NEW);
    v_match_col TEXT;
    v_expected TEXT;
BEGIN
    SELECT *
      INTO v_guard
      FROM public.workflow_guardrails
     WHERE resource_table = TG_TABLE_NAME
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF v_guard.enforcement_mode <> 'enforce' THEN
        RETURN NEW;
    END IF;

    IF v_guard.enforce_on IS NOT NULL AND array_length(v_guard.enforce_on, 1) IS NOT NULL THEN
        IF NOT (TG_OP = ANY(v_guard.enforce_on)) THEN
            RETURN NEW;
        END IF;
    END IF;

    IF v_guard.allow_roles IS NOT NULL AND current_user = ANY(v_guard.allow_roles) THEN
        RETURN NEW;
    END IF;

    FOREACH v_key IN ARRAY COALESCE(v_guard.required_context_keys, ARRAY[]::TEXT[]) LOOP
        BEGIN
            v_context := current_setting('app.' || v_key, true);
        EXCEPTION
            WHEN others THEN
                v_context := NULL;
        END;

        IF v_context IS NULL OR btrim(v_context) = '' THEN
            RAISE EXCEPTION 'workflow guardrails: missing context % for %.%', v_key, TG_TABLE_SCHEMA, TG_TABLE_NAME;
        END IF;

        v_match_col := NULL;
        IF v_guard.context_match ? v_key THEN
            v_match_col := v_guard.context_match->>v_key;
        END IF;

        IF v_match_col IS NOT NULL AND btrim(v_match_col) <> '' THEN
            v_expected := v_row->>v_match_col;
        ELSE
            v_expected := v_row->>v_key;
        END IF;

        IF v_expected IS NOT NULL AND btrim(v_expected) <> '' AND v_expected <> v_context THEN
            RAISE EXCEPTION 'workflow guardrails: context % mismatch for %.%', v_key, TG_TABLE_SCHEMA, TG_TABLE_NAME;
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_workflow_guardrails()
    IS 'Generic workflow guardrails trigger enforcing context requirements from workflow_guardrails.';

INSERT INTO public.workflow_guardrails (
    resource_table,
    enforcement_mode,
    enforce_on,
    required_context_keys,
    context_match,
    allow_roles,
    notes
)
VALUES
    (
        'workflow_runs',
        'enforce',
        ARRAY['INSERT']::TEXT[],
        ARRAY['workflow_run_id']::TEXT[],
        jsonb_build_object('workflow_run_id', 'id'),
        ARRAY[]::TEXT[],
        'Guard workflow run creation to require workflow context.'
    ),
    (
        'workflow_run_steps',
        'enforce',
        ARRAY['INSERT']::TEXT[],
        ARRAY['workflow_run_id']::TEXT[],
        jsonb_build_object('workflow_run_id', 'workflow_run_id'),
        ARRAY[]::TEXT[],
        'Guard workflow step creation to require workflow context.'
    )
ON CONFLICT (resource_table) DO UPDATE
SET enforcement_mode = EXCLUDED.enforcement_mode,
    enforce_on = EXCLUDED.enforce_on,
    required_context_keys = EXCLUDED.required_context_keys,
    context_match = EXCLUDED.context_match,
    allow_roles = EXCLUDED.allow_roles,
    notes = EXCLUDED.notes,
    updated_at = now();

DROP TRIGGER IF EXISTS trg_workflow_runs_guardrails ON public.workflow_runs;
CREATE TRIGGER trg_workflow_runs_guardrails
    BEFORE INSERT OR UPDATE ON public.workflow_runs
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_workflow_guardrails();

DROP TRIGGER IF EXISTS trg_workflow_run_steps_guardrails ON public.workflow_run_steps;
CREATE TRIGGER trg_workflow_run_steps_guardrails
    BEFORE INSERT OR UPDATE ON public.workflow_run_steps
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_workflow_guardrails();


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
    v_client UUID;
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

    BEGIN
        v_org := NULLIF(v_run.context->>'organization_id', '')::UUID;
    EXCEPTION
        WHEN others THEN
            v_org := NULL;
    END;

    IF v_org IS NULL THEN
        BEGIN
            v_client := NULLIF(v_run.context->>'client_id', '')::UUID;
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

    IF v_org IS NULL THEN
        SELECT wt.scope_id
          INTO v_org
          FROM public.workflow_templates wt
         WHERE wt.id = v_run.workflow_template_id
           AND wt.scope_id IS NOT NULL
         LIMIT 1;
    END IF;

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

CREATE OR REPLACE FUNCTION public.progress_workflow_run(p_workflow_run_id uuid, p_operation_result jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'workflow_handlers', 'extensions', 'pg_temp'
AS $function$

DECLARE

    v_run workflow_runs%ROWTYPE;

    v_step workflow_run_steps%ROWTYPE;

    v_template_step workflow_template_steps%ROWTYPE;

    v_handler operation_handlers%ROWTYPE;

    v_handler_key TEXT;

    v_response_json JSONB;

    v_step_status TEXT;

    v_now TIMESTAMPTZ := now();

    v_error TEXT;

    v_context JSONB;

    v_duration_ms INT;

    v_next_run_at TIMESTAMPTZ;

    v_retry_attempt INT;

    v_operation_result JSONB;

    v_proc REGPROCEDURE;

    v_decision_payload JSONB;

    v_decision_id UUID;

    v_context_patch JSONB;

    v_skip_handler_key TEXT;

    v_skip_handler_version TEXT;

BEGIN

    SELECT *

    INTO v_run

    FROM workflow_runs

    WHERE id = p_workflow_run_id

    FOR UPDATE;



    IF NOT FOUND THEN

        RAISE EXCEPTION 'progress_workflow_run: workflow % not found', p_workflow_run_id;

    END IF;

    PERFORM set_config('app.workflow_run_id', p_workflow_run_id::text, true);
    PERFORM set_config('app.workflow_run_step_id', '', true);

    IF v_run.workflow_status IN ('completed', 'failed', 'cancelled') THEN

        RETURN jsonb_build_object(

            'workflow_run_id', p_workflow_run_id,

            'status', v_run.workflow_status

        );

    END IF;



    -- Scheduling gate: only execute pending steps when run_at is due.
    SELECT *

    INTO v_step

    FROM workflow_run_steps

    WHERE workflow_run_id = p_workflow_run_id

      AND step_status = 'pending'

      AND run_at <= v_now

    ORDER BY run_at, sequence_order

    LIMIT 1

    FOR UPDATE;



    IF NOT FOUND THEN

        SELECT MIN(run_at)
        INTO v_next_run_at
        FROM workflow_run_steps
        WHERE workflow_run_id = p_workflow_run_id
          AND step_status = 'pending';

        -- No pending steps remain: finalize the run.
        IF v_next_run_at IS NULL THEN
            UPDATE workflow_runs
            SET workflow_status = 'completed',
                current_step_id = NULL,
                completed_at = COALESCE(completed_at, v_now),
                updated_at = v_now
            WHERE id = p_workflow_run_id;

            RETURN jsonb_build_object(
                'workflow_run_id', p_workflow_run_id,
                'status', 'completed'
            );
        END IF;

        -- Pending steps exist but are scheduled in the future.
        RETURN jsonb_build_object(
            'workflow_run_id', p_workflow_run_id,
            'status', 'waiting',
            'next_run_at', v_next_run_at
        );

    END IF;

    PERFORM set_config('app.workflow_run_step_id', v_step.id::text, true);



    SELECT *

    INTO v_template_step

    FROM workflow_template_steps

    WHERE id = v_step.workflow_template_step_id;



    -- Skip disabled template steps (row-driven control).
    IF COALESCE(v_template_step.enabled, TRUE) IS FALSE THEN

        -- Mark the run as started/in_progress for audit consistency.
        UPDATE workflow_runs

        SET workflow_status = 'in_progress',

            current_step_id = v_step.workflow_template_step_id,

            started_at = COALESCE(started_at, v_now),

            updated_at = v_now

        WHERE id = p_workflow_run_id;



        v_skip_handler_key := COALESCE(NULLIF(v_step.handler_key, ''), NULLIF(v_template_step.handler_key, ''), 'disabled_step');
        v_skip_handler_version := COALESCE(NULLIF(v_step.handler_version, ''), NULLIF(v_template_step.handler_version, ''), NULL);

        v_operation_result := public.jsonb_deep_merge(
          COALESCE(v_step.operation_result, '{}'::jsonb),
          jsonb_strip_nulls(jsonb_build_object(
            'status', 'skipped',
            'reason', 'template_step_disabled',
            'workflow_template_step_id', v_step.workflow_template_step_id,
            'operation_name', v_template_step.operation_name
          ))
        );

        UPDATE workflow_run_steps

        SET step_status = 'completed',

            operation_started_at = COALESCE(operation_started_at, v_now),

            operation_completed_at = v_now,

            duration_ms = COALESCE(duration_ms, 0),

            operation_result = v_operation_result,

            last_error = NULL,

            updated_at = v_now

        WHERE id = v_step.id;



        v_decision_payload := jsonb_build_object(

            'status', 'completed',

            'handler_key', v_skip_handler_key,

            'handler_version', v_skip_handler_version,

            'operation_result', v_operation_result,

            'response', jsonb_build_object('status', 'completed', 'skipped', TRUE, 'reason', 'template_step_disabled'),

            'workflow_run_step_id', v_step.id

        );

        v_decision_id := record_workflow_decision(p_workflow_run_id, v_step.id, v_decision_payload);

        UPDATE workflow_run_steps

        SET decision_log_id = v_decision_id,

            updated_at = v_now

        WHERE id = v_step.id;



        -- Complete the run immediately when nothing remains.
        IF NOT EXISTS (
          SELECT 1
          FROM workflow_run_steps
          WHERE workflow_run_id = p_workflow_run_id
            AND step_status = 'pending'
        ) THEN
          UPDATE workflow_runs
          SET workflow_status = 'completed',
              current_step_id = NULL,
              completed_at = COALESCE(completed_at, v_now),
              updated_at = v_now
          WHERE id = p_workflow_run_id;
        END IF;

        RETURN jsonb_build_object(
          'workflow_run_id', p_workflow_run_id,
          'step_id', v_step.id,
          'status', 'completed',
          'skipped', TRUE
        );
    END IF;



    v_handler_key := COALESCE(

        NULLIF(v_step.handler_key, ''),

        NULLIF(v_template_step.handler_key, ''),

        CASE

            WHEN v_template_step.operation_settings_category = 'operation_template' THEN 'outbound_http'

            ELSE NULL

        END

    );



    IF v_handler_key IS NULL THEN

        RAISE EXCEPTION 'progress_workflow_run: handler_key unresolved for step %', v_step.id;

    END IF;



    SELECT *

    INTO v_handler

    FROM operation_handlers

    WHERE handler_key = v_handler_key

      AND is_active = TRUE

    LIMIT 1;



    IF NOT FOUND THEN

        RAISE EXCEPTION 'progress_workflow_run: handler % not registered or inactive', v_handler_key;

    END IF;



    v_proc := to_regprocedure(format('%I.%I%s', v_handler.handler_schema, v_handler.handler_name, v_handler.handler_signature));

    IF v_proc IS NULL THEN

        RAISE EXCEPTION 'progress_workflow_run: handler function %I.%I%s missing',

            v_handler.handler_schema,

            v_handler.handler_name,

            v_handler.handler_signature;

    END IF;



    UPDATE workflow_runs

    SET workflow_status = 'in_progress',

        current_step_id = v_step.workflow_template_step_id,

        started_at = COALESCE(started_at, v_now),

        updated_at = v_now

    WHERE id = p_workflow_run_id;



    UPDATE workflow_run_steps

    SET step_status = 'in_progress',

        operation_started_at = v_now,

        handler_key = v_handler_key,

        handler_version = v_handler.handler_version,

        updated_at = v_now

    WHERE id = v_step.id;



    v_step.step_status := 'in_progress';

    v_step.handler_key := v_handler_key;

    v_step.handler_version := v_handler.handler_version;

    v_step.operation_started_at := v_now;



    EXECUTE format(

        'SELECT to_jsonb(%I.%I($1,$2,$3))',

        v_handler.handler_schema,

        v_handler.handler_name

    )

    INTO v_response_json

    USING v_step, v_run, p_operation_result;


    v_context_patch := (v_response_json->'context_patch')::jsonb;




    IF v_response_json->>'status' IS NULL OR btrim(v_response_json->>'status') = '' THEN

        RAISE EXCEPTION 'progress_workflow_run: handler % returned NULL status', v_handler_key;

    END IF;



    v_step_status := lower(btrim(v_response_json->>'status'));

    v_step_status := translate(v_step_status, E'\"()', '');

    IF v_step_status = '' THEN

        RAISE EXCEPTION 'progress_workflow_run: handler % returned NULL status', v_handler_key;

    END IF;

    IF v_step_status LIKE 'pending%' THEN

        v_step_status := 'pending';

    ELSIF v_step_status LIKE 'in_progress%' THEN

        v_step_status := 'in_progress';

    ELSIF v_step_status LIKE 'completed%' THEN

        v_step_status := 'completed';

    ELSIF v_step_status LIKE 'failed%' THEN

        v_step_status := 'failed';

    ELSE

        RAISE EXCEPTION 'progress_workflow_run: handler % returned invalid status %', v_handler_key, v_response_json->>'status';

    END IF;



    v_operation_result := COALESCE((v_response_json->'operation_result')::jsonb, p_operation_result);

    v_retry_attempt := COALESCE(

        (v_response_json->>'retry_attempt')::INT,

        LEAST(v_step.retry_attempt + 1, v_step.max_retries)

    );

    v_next_run_at := (v_response_json->>'next_run_at')::TIMESTAMPTZ;



    IF v_context_patch IS NOT NULL

       AND jsonb_typeof(v_context_patch) = 'object' THEN


        v_context := public.jsonb_deep_merge(COALESCE(v_run.context, '{}'::jsonb), v_context_patch);

        v_context := jsonb_set(

            v_context,

            '{workflow,context_patch}',

            jsonb_strip_nulls(

                public.jsonb_deep_merge(

                    COALESCE(COALESCE(v_run.context, '{}'::jsonb)->'workflow'->'context_patch', '{}'::jsonb),

                    v_context_patch

                )

            ),

            TRUE

        );

    ELSE

        v_context := COALESCE(v_run.context, '{}'::jsonb);

    END IF;



    IF v_step_status = 'completed' THEN

        v_duration_ms := GREATEST(0, (extract(epoch FROM now() - COALESCE(v_step.operation_started_at, v_now)) * 1000)::INT);

        UPDATE workflow_run_steps

        SET step_status = 'completed',

            operation_completed_at = now(),

            duration_ms = COALESCE(duration_ms, v_duration_ms),

            operation_result = v_operation_result,

            last_error = NULL,

            updated_at = now()

        WHERE id = v_step.id;

    ELSIF v_step_status = 'pending' THEN

        UPDATE workflow_run_steps

        SET step_status = 'pending',

            operation_started_at = NULL,

            operation_completed_at = NULL,

            run_at = COALESCE(v_next_run_at, now()),

            retry_attempt = v_retry_attempt,

            max_retries = COALESCE((v_response_json->>'max_retries')::INT, max_retries),

            last_error = NULL,

            operation_result = v_operation_result,

            updated_at = now()

        WHERE id = v_step.id;

    ELSIF v_step_status = 'in_progress' THEN

        UPDATE workflow_run_steps

        SET operation_result = COALESCE(v_operation_result, workflow_run_steps.operation_result),

            last_error = NULL,

            updated_at = now()

        WHERE id = v_step.id;



        IF v_handler_key = 'outbound_http' THEN

            UPDATE workflow_run_steps wrs

            SET operation_result = sub.payload

            FROM (

                SELECT jsonb_build_object(

                           'outbound_call_id', oc.id,

                           'headers', oc.headers,

                           'body', oc.body

                       ) AS payload

                FROM outbound_calls oc

                WHERE oc.workflow_run_step_id = v_step.id

                ORDER BY oc.created_at DESC

                LIMIT 1

            ) sub

            WHERE wrs.id = v_step.id;

        END IF;

    ELSE

        UPDATE workflow_run_steps

        SET step_status = 'failed',

            operation_completed_at = now(),

            last_error = COALESCE(v_response_json->>'last_error', 'handler_failure'),

            operation_result = v_operation_result,

            updated_at = now()

        WHERE id = v_step.id;

    END IF;



    IF v_step_status = 'failed' THEN

        UPDATE workflow_runs

        SET workflow_status = 'failed',

            failure_reason = COALESCE(v_response_json->>'last_error', 'handler_failure'),

            last_error = jsonb_build_object('error', COALESCE(v_response_json->>'last_error', 'handler_failure')),

            context = v_context,

            updated_at = now()

        WHERE id = p_workflow_run_id;



        v_decision_payload := jsonb_build_object(

            'status', v_step_status,

            'handler_key', v_handler_key,

            'handler_version', v_handler.handler_version,

            'operation_result', v_operation_result,

            'response', v_response_json,

            'workflow_run_step_id', v_step.id

        );

        v_decision_id := record_workflow_decision(p_workflow_run_id, v_step.id, v_decision_payload);

        UPDATE workflow_run_steps

        SET decision_log_id = v_decision_id,

            updated_at = now()

        WHERE id = v_step.id;



        RETURN jsonb_build_object(

            'workflow_run_id', p_workflow_run_id,

            'status', 'failed',

            'handler_key', v_handler_key,

            'error', COALESCE(v_response_json->>'last_error', 'handler_failure')

        );

    END IF;



    IF v_response_json->>'workflow_status' IS NOT NULL THEN

        IF v_response_json->>'workflow_status' = 'completed' THEN

            UPDATE workflow_runs

            SET workflow_status = 'completed',

                current_step_id = NULL,

                completed_at = COALESCE(completed_at, now()),

                context = v_context,

                updated_at = now()

            WHERE id = p_workflow_run_id;

        ELSE

            UPDATE workflow_runs

            SET workflow_status = v_response_json->>'workflow_status',

                context = v_context,

                updated_at = now()

            WHERE id = p_workflow_run_id;

        END IF;

    ELSE

        UPDATE workflow_runs

        SET context = v_context,

            updated_at = now()

        WHERE id = p_workflow_run_id;

    END IF;



    v_decision_payload := jsonb_build_object(

        'status', v_step_status,

        'handler_key', v_handler_key,

        'handler_version', v_handler.handler_version,

        'operation_result', v_operation_result,

        'response', v_response_json,

        'workflow_run_step_id', v_step.id

    );

    v_decision_id := record_workflow_decision(p_workflow_run_id, v_step.id, v_decision_payload);



    UPDATE workflow_run_steps

    SET decision_log_id = v_decision_id,

        updated_at = now()

    WHERE id = v_step.id;



    RETURN jsonb_build_object(

        'workflow_run_id', p_workflow_run_id,

        'step_id', v_step.id,

        'status', v_step_status,

        'handler_key', v_handler_key,

        'next_run_at', v_next_run_at

    );

EXCEPTION

    WHEN OTHERS THEN

        v_error := SQLERRM;



        IF v_step.id IS NOT NULL THEN

            UPDATE workflow_run_steps

            SET step_status = 'failed',

                last_error = v_error,

                updated_at = now()

            WHERE id = v_step.id;

        END IF;



        UPDATE workflow_runs

        SET workflow_status = 'failed',

            failure_reason = v_error,

            last_error = jsonb_build_object('error', v_error),

            updated_at = now()

        WHERE id = p_workflow_run_id;



        RETURN jsonb_build_object(

            'workflow_run_id', p_workflow_run_id,

            'status', 'failed',

            'error', v_error

        );



END;
$function$;

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

COMMENT ON FUNCTION start_workflow_run(UUID, JSONB)
  IS 'Create or reuse a workflow run with idempotency; uses resolve_template_version() and dedupes steps by sequence_order.';

CREATE OR REPLACE FUNCTION public.ensure_outbound_call_has_step()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $$
DECLARE
    v_run_id UUID;
    v_step_id UUID;
    v_template_id CONSTANT UUID := '99990000-0000-0000-0000-000000350000';
    v_template_step_id CONSTANT UUID := '99990000-0000-0000-0000-000000350101';
    v_step_status TEXT;
    v_run_status TEXT;
    v_operation_started_at TIMESTAMPTZ;
    v_operation_completed_at TIMESTAMPTZ;
    v_duration_ms INT;
    v_now TIMESTAMPTZ := COALESCE(NEW.created_at, now());
    v_failure_reason TEXT;
    v_last_error JSONB;
    v_context JSONB := COALESCE(NEW.context, '{}'::jsonb);
BEGIN
    IF NEW.workflow_run_step_id IS NULL THEN
        v_step_status := CASE
            WHEN NEW.status = 'completed' THEN 'completed'
            WHEN NEW.status IN ('failed', 'permanently_failed') THEN 'failed'
            WHEN NEW.status = 'pending' THEN 'pending'
            ELSE 'in_progress'
        END;

        v_run_status := CASE
            WHEN v_step_status = 'completed' THEN 'completed'
            WHEN v_step_status = 'failed' THEN 'failed'
            WHEN v_step_status = 'pending' THEN 'pending'
            ELSE 'in_progress'
        END;

        v_operation_started_at := CASE
            WHEN v_step_status IN ('in_progress', 'completed', 'failed') THEN v_now
            ELSE NULL
        END;

        v_operation_completed_at := CASE
            WHEN v_step_status IN ('completed', 'failed') THEN COALESCE(NEW.completed_at, v_now)
            ELSE NULL
        END;

        IF v_operation_started_at IS NOT NULL AND v_operation_completed_at IS NOT NULL THEN
            v_duration_ms := GREATEST(
                0,
                (EXTRACT(EPOCH FROM (v_operation_completed_at - v_operation_started_at)) * 1000)::INT
            );
        ELSE
            v_duration_ms := NULL;
        END IF;

        v_failure_reason := CASE
            WHEN v_run_status = 'failed' THEN COALESCE(NEW.error_message, 'legacy_outbound_failure')
            ELSE NULL
        END;

        v_last_error := CASE
            WHEN v_run_status = 'failed' THEN jsonb_build_object(
                'error', COALESCE(NEW.error_message, 'legacy_outbound_failure'),
                'status', NEW.status
            )
            ELSE NULL
        END;

        v_context := jsonb_strip_nulls(
            jsonb_build_object(
                'legacy_auto_attach', TRUE,
                'outbound_call_id', NEW.id,
                'call_type', NEW.call_type,
                'job_context', v_context
            )
        );

        v_run_id := gen_random_uuid();
        v_step_id := gen_random_uuid();

        PERFORM set_config('app.workflow_run_id', v_run_id::text, true);
        PERFORM set_config('app.workflow_run_step_id', v_step_id::text, true);

        INSERT INTO public.workflow_runs (
            id,
            workflow_template_id,
            workflow_template_version,
            entry_point,
            workflow_status,
            current_step_id,
            context,
            metadata,
            created_at,
            started_at,
            updated_at,
            completed_at,
            failure_reason,
            last_error
        )
        VALUES (
            v_run_id,
            v_template_id,
            1,
            'legacy_bridge',
            v_run_status,
            CASE WHEN v_run_status = 'completed' THEN NULL ELSE v_template_step_id END,
            v_context,
            jsonb_build_object('legacy_auto_attach', TRUE),
            v_now,
            v_operation_started_at,
            v_now,
            CASE WHEN v_run_status IN ('completed', 'failed') THEN v_operation_completed_at ELSE NULL END,
            v_failure_reason,
            v_last_error
        );

        INSERT INTO public.workflow_run_steps (
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
            operation_result,
            operation_started_at,
            operation_completed_at,
            duration_ms,
            last_error,
            retry_attempt,
            enqueued_at,
            created_at,
            updated_at
        )
        VALUES (
            v_step_id,
            v_run_id,
            v_template_step_id,
            1,
            v_step_status,
            'legacy_outbound_job',
            GREATEST(NEW.max_retries, 1),
            jsonb_strip_nulls(jsonb_build_object(
                'legacy_auto_attach', TRUE,
                'original_status', NEW.status
            )),
            'outbound_http',
            'v1',
            jsonb_strip_nulls(jsonb_build_object(
                'outbound_call_id', NEW.id,
                'status', NEW.status,
                'response_status_code', NEW.response_status_code
            )),
            v_operation_started_at,
            v_operation_completed_at,
            v_duration_ms,
            CASE WHEN v_step_status = 'failed' THEN COALESCE(NEW.error_message, 'legacy_outbound_failure') ELSE NULL END,
            GREATEST(NEW.retry_count, 1),
            v_now,
            v_now,
            v_now
        );

        NEW.workflow_run_step_id := v_step_id;
    END IF;

    IF NEW.workflow_run_step_id IS NULL THEN
        RAISE EXCEPTION 'workflow_run_step_id is required for outbound_calls inserts/updates';
    END IF;

    RETURN NEW;
END;
$$;


COMMIT;

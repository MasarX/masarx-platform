BEGIN;
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

BEGIN

    SELECT *

    INTO v_run

    FROM workflow_runs

    WHERE id = p_workflow_run_id

    FOR UPDATE;



    IF NOT FOUND THEN

        RAISE EXCEPTION 'progress_workflow_run: workflow % not found', p_workflow_run_id;

    END IF;



    IF v_run.workflow_status IN ('completed', 'failed', 'cancelled') THEN

        RETURN jsonb_build_object(

            'workflow_run_id', p_workflow_run_id,

            'status', v_run.workflow_status

        );

    END IF;



    SELECT *

    INTO v_step

    FROM workflow_run_steps

    WHERE workflow_run_id = p_workflow_run_id

      AND step_status = 'pending'

    ORDER BY sequence_order

    LIMIT 1

    FOR UPDATE;



    IF NOT FOUND THEN

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



    SELECT *

    INTO v_template_step

    FROM workflow_template_steps

    WHERE id = v_step.workflow_template_step_id;



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

      AND is_active = TRUE;



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

    v_step_status := translate(v_step_status, E'"()', '');

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

        v_context := COALESCE(v_run.context, '{}'::jsonb) || v_context_patch;

        v_context := jsonb_set(

            v_context,

            '{workflow,context_patch}',

            jsonb_strip_nulls(

                COALESCE(

                    COALESCE(v_run.context, '{}'::jsonb)->'workflow'->'context_patch',

                    '{}'::jsonb

                ) || v_context_patch

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



        v_decision_payload := jsonb_build_object(

            'status', 'failed',

            'handler_key', v_handler_key,

            'handler_version', v_handler.handler_version,

            'error', v_error,

            'workflow_run_step_id', v_step.id

        );

        v_decision_id := record_workflow_decision(p_workflow_run_id, v_step.id, v_decision_payload);



        IF v_step.id IS NOT NULL THEN

            UPDATE workflow_run_steps

            SET decision_log_id = v_decision_id,

                updated_at = now()

            WHERE id = v_step.id;

        END IF;



        RETURN jsonb_build_object(

            'workflow_run_id', p_workflow_run_id,

            'status', 'failed',

            'error', v_error

        );

END;

$function$;

COMMIT;

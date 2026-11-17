-- Migration: Enforce workflow linkage for outbound_calls
-- Purpose: Prevent future inserts without workflow_run_step_id and harden schema.
-- Date: 2025-11-14

BEGIN;

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

DROP TRIGGER IF EXISTS trg_outbound_calls_require_step ON outbound_calls;

CREATE TRIGGER trg_outbound_calls_require_step
BEFORE INSERT OR UPDATE ON outbound_calls
FOR EACH ROW
EXECUTE FUNCTION public.ensure_outbound_call_has_step();

ALTER TABLE outbound_calls
    ALTER COLUMN workflow_run_step_id SET NOT NULL;

COMMENT ON COLUMN outbound_calls.workflow_run_step_id
    IS 'FK to workflow_run_steps.id; required for every outbound job.';

COMMIT;

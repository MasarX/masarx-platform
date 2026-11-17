-- Plan: PLAN-202512-comms-reply-low-latency / Step: S04
-- Migration: Guard domain_event completion hook to prevent workflow blockage
-- Purpose:
--   - finalize_domain_event_from_run() must never raise when the referenced domain_event row is missing.
--   - Avoids stuck workflow_runs caused by AFTER UPDATE trigger failures.
-- Date: 2025-12-16

BEGIN;

CREATE OR REPLACE FUNCTION public.finalize_domain_event_from_run()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_domain_event_id UUID;
    v_outcome TEXT := lower(NEW.workflow_status);
    v_reason TEXT := COALESCE(NEW.failure_reason, NEW.last_error->>'error');
    v_update_status TEXT;
    v_org UUID;
    v_correlation UUID;
BEGIN
    -- Parse domain_event_id defensively (never block workflow runs on bad context).
    BEGIN
        v_domain_event_id := NULLIF(NEW.context->>'domain_event_id', '')::UUID;
    EXCEPTION
        WHEN others THEN
            RETURN NEW;
    END;

    IF v_domain_event_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF v_outcome NOT IN ('completed', 'failed', 'cancelled') THEN
        RETURN NEW;
    END IF;

    v_update_status := CASE
        WHEN v_outcome = 'completed' THEN 'completed'
        WHEN v_outcome = 'failed' THEN 'failed'
        ELSE 'skipped'
    END;

    SELECT organization_id
      INTO v_org
      FROM public.domain_events
     WHERE id = v_domain_event_id;

    -- If the domain_event row is missing (or org cannot be resolved), do not raise.
    -- The workflow engine must keep progressing; we only lose the domain_event linkage.
    IF v_org IS NULL THEN
        RETURN NEW;
    END IF;

    v_correlation := NULL;
    BEGIN
        v_correlation := NULLIF(NEW.context->>'correlation_id', '')::UUID;
    EXCEPTION
        WHEN others THEN
            v_correlation := NULL;
    END;

    UPDATE public.domain_events
       SET status = v_update_status,
           error_reason = CASE WHEN v_update_status = 'failed' THEN v_reason ELSE error_reason END,
           processed_at = now(),
           updated_at = now(),
           workflow_run_id = COALESCE(workflow_run_id, NEW.id)
     WHERE id = v_domain_event_id;

    PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'domain_event',
        p_resource_type := 'domain_event',
        p_resource_id := v_domain_event_id,
        p_decision_point := 'workflow_completion',
        p_decision_outcome := v_update_status,
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := v_correlation,
        p_decision_inputs := jsonb_build_object(
            'workflow_run_id', NEW.id,
            'outcome', v_update_status
        ),
        p_decision_reason := v_reason
    );

    RETURN NEW;
END;
$$;

COMMIT;


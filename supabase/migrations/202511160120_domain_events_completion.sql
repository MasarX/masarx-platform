-- Migration: Domain event completion hook from workflow runs

BEGIN;

CREATE OR REPLACE FUNCTION finalize_domain_event_from_run()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_domain_event_id UUID := NULLIF(NEW.context->>'domain_event_id', '')::UUID;
    v_outcome TEXT := lower(NEW.workflow_status);
    v_reason TEXT := COALESCE(NEW.failure_reason, NEW.last_error->>'error');
    v_update_status TEXT;
    v_org UUID;
    v_correlation UUID := NULLIF(NEW.context->>'correlation_id', '')::UUID;
BEGIN
    IF v_domain_event_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF v_outcome NOT IN ('completed', 'failed', 'cancelled') THEN
        RETURN NEW;
    END IF;

    IF v_outcome = 'completed' THEN
        v_update_status := 'completed';
    ELSIF v_outcome = 'failed' THEN
        v_update_status := 'failed';
    ELSE
        v_update_status := 'skipped';
    END IF;

    SELECT organization_id
    INTO v_org
    FROM domain_events
    WHERE id = v_domain_event_id;

    UPDATE domain_events
    SET status = v_update_status,
        error_reason = CASE WHEN v_update_status = 'failed' THEN v_reason ELSE error_reason END,
        processed_at = now(),
        updated_at = now(),
        workflow_run_id = COALESCE(workflow_run_id, NEW.id)
    WHERE id = v_domain_event_id;

    PERFORM log_decision(
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

DROP TRIGGER IF EXISTS trg_workflow_runs_domain_event ON workflow_runs;
CREATE TRIGGER trg_workflow_runs_domain_event
    AFTER UPDATE ON workflow_runs
    FOR EACH ROW
    WHEN (OLD.workflow_status IS DISTINCT FROM NEW.workflow_status AND NEW.workflow_status IN ('completed','failed','cancelled'))
    EXECUTE FUNCTION finalize_domain_event_from_run();

COMMIT;

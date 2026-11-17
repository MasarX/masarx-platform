-- Migration: Domain events worker — drain pending in bounded loops
-- Purpose: Improve reliability by processing multiple batches per invocation
--          (bounded) so newly enqueued events are handled even with backlog.
-- Notes: Still honours cron_config batch_size; loops up to 20 batches or until no rows.

BEGIN;

SET search_path TO public;

CREATE OR REPLACE FUNCTION run_domain_events_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_total_processed INT := 0;
    v_error BOOLEAN := FALSE;
    v_event RECORD;
    v_policy JSONB;
    v_template UUID;
    v_context_patch JSONB;
    v_workflow_context JSONB;
    v_run UUID;
    v_org UUID;
    v_resolved_org UUID;
    v_loop INT := 0;
    v_processed_this_loop INT;
BEGIN
    SELECT * INTO v_throttle FROM check_throttle('domain_events_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    PERFORM create_next_partitions();

    v_context := create_request_context('domain_events_worker');

    LOOP
        EXIT WHEN v_loop >= 20; -- bounded safety
        v_processed_this_loop := 0;

        FOR v_event IN
            SELECT *
            FROM domain_events
            WHERE status = 'pending'
            ORDER BY created_at ASC
            LIMIT v_throttle.batch_size
            FOR UPDATE SKIP LOCKED
        LOOP
            BEGIN
                v_org := v_event.organization_id;

                IF v_org IS NULL OR NOT EXISTS (SELECT 1 FROM organizations WHERE id = v_org) THEN
                    v_resolved_org := NULL;
                    IF v_event.resource_type IS NOT NULL AND v_event.resource_id IS NOT NULL THEN
                        BEGIN
                            v_resolved_org := resolve_organization_id_strict(v_event.resource_type, v_event.resource_id);
                        EXCEPTION WHEN others THEN v_resolved_org := NULL; END;
                    END IF;

                    IF v_resolved_org IS NULL THEN
                        UPDATE domain_events
                        SET status = 'failed',
                            error_reason = 'organization_not_found',
                            processed_at = now(),
                            updated_at = now()
                        WHERE id = v_event.id;
                        CONTINUE;
                    END IF;

                    UPDATE domain_events
                    SET organization_id = v_resolved_org,
                        updated_at = now()
                    WHERE id = v_event.id;

                    v_org := v_resolved_org;
                    v_event.organization_id := v_resolved_org;
                END IF;

                v_policy := resolve_domain_event_policy(v_org, v_event.event_type);
                v_template := NULLIF(v_policy->>'workflow_template_id', '')::UUID;
                v_context_patch := COALESCE(v_policy->'context_patch', '{}'::jsonb);

                IF v_template IS NULL THEN
                    UPDATE domain_events
                    SET status = 'skipped',
                        error_reason = 'policy_not_found',
                        processed_at = now(),
                        updated_at = now()
                    WHERE id = v_event.id;

                    PERFORM log_decision(
                        p_organization_id := v_org,
                        p_decision_category := 'domain_event',
                        p_resource_type := 'domain_event',
                        p_resource_id := v_event.id,
                        p_decision_point := 'dispatch',
                        p_decision_outcome := 'skipped',
                        p_performed_by_system := 'domain_events_worker',
                        p_correlation_id := v_event.correlation_id,
                        p_decision_inputs := jsonb_build_object(
                            'event_type', v_event.event_type,
                            'resource_type', v_event.resource_type,
                            'resource_id', v_event.resource_id,
                            'reason', 'policy_not_found'
                        )
                    );

                ELSE
                    v_workflow_context := jsonb_strip_nulls(
                        jsonb_build_object(
                            'domain_event_id', v_event.id,
                            'event_type', v_event.event_type,
                            'resource_type', v_event.resource_type,
                            'resource_id', v_event.resource_id,
                            'payload', v_event.payload,
                            'trigger_source', 'domain_event',
                            'correlation_id', v_event.correlation_id
                        )
                    ) || jsonb_strip_nulls(COALESCE(v_context_patch, '{}'::jsonb));

                    v_run := start_workflow_run(v_template, v_workflow_context);

                    UPDATE domain_events
                    SET status = 'processing',
                        workflow_run_id = v_run,
                        processed_at = now(),
                        updated_at = now()
                    WHERE id = v_event.id;

                    PERFORM log_decision(
                        p_organization_id := v_org,
                        p_decision_category := 'domain_event',
                        p_resource_type := 'domain_event',
                        p_resource_id := v_event.id,
                        p_decision_point := 'dispatch',
                        p_decision_outcome := 'enqueued',
                        p_performed_by_system := 'domain_events_worker',
                        p_correlation_id := v_event.correlation_id,
                        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                            'workflow_run_id', v_run,
                            'workflow_template_id', v_template,
                            'event_type', v_event.event_type,
                            'resource_type', v_event.resource_type,
                            'resource_id', v_event.resource_id
                        ))
                    );
                END IF;

                v_processed_this_loop := v_processed_this_loop + 1;
                v_total_processed := v_total_processed + 1;
            EXCEPTION
                WHEN OTHERS THEN
                    v_error := TRUE;
                    UPDATE domain_events
                    SET status = 'failed',
                        error_reason = SQLERRM,
                        processed_at = now(),
                        updated_at = now()
                    WHERE id = v_event.id;

                    IF v_org IS NOT NULL THEN
                        PERFORM log_decision(
                            p_organization_id := v_org,
                            p_decision_category := 'domain_event',
                            p_resource_type := 'domain_event',
                            p_resource_id := v_event.id,
                            p_decision_point := 'dispatch',
                            p_decision_outcome := 'error',
                            p_performed_by_system := 'domain_events_worker',
                            p_correlation_id := v_event.correlation_id,
                            p_decision_reason := SQLERRM,
                            p_decision_inputs := jsonb_build_object(
                                'event_type', v_event.event_type,
                                'resource_type', v_event.resource_type,
                                'resource_id', v_event.resource_id
                            )
                        );
                    END IF;
            END;
        END LOOP;

        EXIT WHEN v_processed_this_loop = 0; -- done draining
        v_loop := v_loop + 1;
    END LOOP;

    PERFORM complete_request_context(v_context, v_error, v_total_processed);
    PERFORM update_cron_config('domain_events_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_total_processed,
        'error_occurred', v_error
    );
END;
$$;

COMMIT;


-- Migration: Ensure claim_pending_edge_jobs logs opt-out skips
-- Purpose: Make opt-out enforcement auditable by guaranteeing decision_log entries are written when jobs are skipped on edge-claim.
-- Date: 2025-12-14

BEGIN;

CREATE OR REPLACE FUNCTION public.claim_pending_edge_jobs(p_batch INT DEFAULT 10)
RETURNS TABLE (
    job_id UUID,
    dispatch JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_limit INT := GREATEST(COALESCE(p_batch, 10), 1);
    v_candidate RECORD;
    v_optout JSONB;
    v_selected_ids UUID[] := ARRAY[]::UUID[];
    v_org_text TEXT;
BEGIN
    IF to_regclass('public.outbound_calls') IS NULL THEN
        RETURN;
    END IF;

    FOR v_candidate IN
        SELECT
            oc.id,
            oc.call_type,
            oc.shipment_id,
            oc.context
        FROM public.outbound_calls oc
        WHERE oc.status IN ('pending_edge', 'failed')
          AND oc.scheduled_at <= now()
          AND (oc.lease_expires_at IS NULL OR oc.lease_expires_at < now())
          AND (oc.status <> 'failed' OR oc.retry_count < oc.max_retries)
        ORDER BY oc.priority DESC, oc.scheduled_at
        LIMIT v_limit
        FOR UPDATE SKIP LOCKED
    LOOP
        v_optout := public.should_skip_outbound_call_for_opt_out(
            v_candidate.call_type,
            v_candidate.shipment_id,
            COALESCE(v_candidate.context, '{}'::jsonb)
        );

        IF COALESCE((v_optout->>'skip')::BOOLEAN, FALSE) THEN
            UPDATE public.outbound_calls oc
               SET status = 'skipped',
                   error_message = COALESCE(v_optout->>'reason', 'skipped'),
                   completed_at = now(),
                   lease_expires_at = NULL
             WHERE oc.id = v_candidate.id;

            v_org_text := COALESCE(v_candidate.context->>'organization_id', '');
            IF v_org_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                PERFORM public.log_decision(
                    p_organization_id := v_org_text::UUID,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_candidate.id,
                    p_decision_point := 'opt_out_enforcement',
                    p_decision_outcome := 'skipped',
                    p_performed_by_system := 'claim_pending_edge_jobs',
                    p_correlation_id := NULL,
                    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                      'reason', v_optout->>'reason',
                      'recipient_id', v_optout->>'recipient_id',
                      'channel', v_optout->>'channel'
                    )),
                    p_decision_reason := 'Outbound call suppressed by opt-out policy.'
                );
            END IF;

            CONTINUE;
        END IF;

        v_selected_ids := array_append(v_selected_ids, v_candidate.id);
    END LOOP;

    IF array_length(v_selected_ids, 1) IS NULL THEN
        RETURN;
    END IF;

    UPDATE public.outbound_calls oc
       SET status = 'in_progress_edge',
           lease_expires_at = now() + interval '5 minutes'
     WHERE oc.id = ANY(v_selected_ids);

    RETURN QUERY
    SELECT
        oc.id AS job_id,
        jsonb_build_object(
            'url', COALESCE((oc.context->'edge_dispatch')->>'url', spec->>'url'),
            'method', COALESCE(upper((oc.context->'edge_dispatch')->>'method'), upper(spec->>'method'), 'POST'),
            'headers', COALESCE((oc.context->'edge_dispatch')->'headers', spec->'headers', '{}'::jsonb),
            'body', COALESCE((oc.context->'edge_dispatch')->'body', spec->'body', '{}'::jsonb),
            'timeout_seconds', COALESCE(
                NULLIF((oc.context->'edge_dispatch')->>'timeout_seconds', '')::INT,
                NULLIF(spec->>'timeout_seconds', '')::INT,
                30
            )
        ) AS dispatch
    FROM public.outbound_calls oc
    CROSS JOIN LATERAL public.get_job_call_spec(oc.id) AS spec
    WHERE oc.id = ANY(v_selected_ids);
END;
$$;

COMMIT;


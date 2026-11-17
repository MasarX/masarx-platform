-- Plan: PLAN-202512-comms-reply-pr-merge-v1 / Step: S04
-- Migration: claim_pending_edge_jobs spec guard (skip invalid jobs)
-- Purpose:
--   - Harden edge dispatch claiming so a single misconfigured outbound_call cannot crash the entire batch.
--   - When get_job_call_spec() fails (e.g., missing auth_config), mark the job permanently_failed and continue.
-- Date: 2025-12-17

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
    v_org_text TEXT;
    v_org_id UUID;
    v_spec JSONB;
    v_dispatch JSONB;
    v_error TEXT;
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

        -- Spec resolution can fail when a job is misconfigured (e.g., auth_config missing).
        -- Do not crash the whole batch: mark permanently_failed and continue claiming other jobs.
        BEGIN
            v_spec := public.get_job_call_spec(v_candidate.id);
        EXCEPTION
            WHEN others THEN
                v_error := SQLERRM;

                UPDATE public.outbound_calls oc
                   SET status = 'permanently_failed',
                       error_message = v_error,
                       completed_at = now(),
                       lease_expires_at = NULL
                 WHERE oc.id = v_candidate.id;

                v_org_id := NULL;
                v_org_text := COALESCE(v_candidate.context->>'organization_id', '');
                IF v_org_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                    v_org_id := v_org_text::UUID;
                END IF;

                IF v_org_id IS NOT NULL THEN
                    PERFORM public.log_decision(
                        p_organization_id := v_org_id,
                        p_decision_category := 'outbound_call',
                        p_resource_type := 'outbound_call',
                        p_resource_id := v_candidate.id,
                        p_decision_point := 'edge_claim_spec',
                        p_decision_outcome := 'permanently_failed',
                        p_performed_by_system := 'claim_pending_edge_jobs',
                        p_correlation_id := NULL,
                        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                          'call_type', v_candidate.call_type,
                          'reason', 'spec_resolution_failed',
                          'error', v_error
                        )),
                        p_decision_reason := 'Edge claim skipped due to invalid job spec (get_job_call_spec failure).'
                    );
                END IF;

                CONTINUE;
        END;

        UPDATE public.outbound_calls oc
           SET status = 'in_progress_edge',
               lease_expires_at = now() + interval '5 minutes'
         WHERE oc.id = v_candidate.id;

        v_dispatch := jsonb_build_object(
            'url', COALESCE((v_candidate.context->'edge_dispatch')->>'url', v_spec->>'url'),
            'method', COALESCE(upper((v_candidate.context->'edge_dispatch')->>'method'), upper(v_spec->>'method'), 'POST'),
            'headers', COALESCE((v_candidate.context->'edge_dispatch')->'headers', v_spec->'headers', '{}'::jsonb),
            'body', COALESCE((v_candidate.context->'edge_dispatch')->'body', v_spec->'body', '{}'::jsonb),
            'timeout_seconds', COALESCE(
                NULLIF((v_candidate.context->'edge_dispatch')->>'timeout_seconds', '')::INT,
                NULLIF(v_spec->>'timeout_seconds', '')::INT,
                30
            )
        );

        job_id := v_candidate.id;
        dispatch := v_dispatch;
        RETURN NEXT;
    END LOOP;
END;
$$;

COMMIT;


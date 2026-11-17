-- Migration: send_comms_reply dispatch wrapper (restore edge/inline dispatch)
-- Purpose:
--   - Preserve the canonical send_comms_reply body (disambiguation + compliance) as send_comms_reply_core.
--   - Reintroduce policy-driven dispatch.mode=edge/inline behavior and return dispatch metadata for callers/tests.
-- Date: 2025-12-24

BEGIN;

-- Turn the current canonical function into the core implementation so we can wrap it without re-copying the full body.
ALTER FUNCTION public.send_comms_reply(uuid, uuid, jsonb, uuid)
  RENAME TO send_comms_reply_core;

CREATE OR REPLACE FUNCTION public.send_comms_reply(
    p_webhook_id uuid,
    p_webhook_source_id uuid,
    p_comm jsonb,
    p_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_result jsonb := '{}'::jsonb;
    v_queued boolean := false;
    v_outbound_call_id uuid := NULL;

    v_policy_row record;
    v_policy jsonb := NULL;
    v_dispatch_cfg jsonb := NULL;
    v_dispatch_mode text := NULL;
    v_dispatch_timeout_seconds int := NULL;
    v_dispatch_poll_max_seconds int := NULL;
    v_dispatch_poll_interval_ms int := NULL;
    v_dispatch_pending_reschedule_seconds int := NULL;
    v_dispatch_lease_seconds int := NULL;
    v_dispatch_result jsonb := NULL;

    v_corr uuid := NULL;
BEGIN
    v_result := COALESCE(
      public.send_comms_reply_core(p_webhook_id, p_webhook_source_id, p_comm, p_organization_id),
      '{}'::jsonb
    );

    v_queued := COALESCE((v_result->>'queued')::boolean, false);
    v_outbound_call_id := NULLIF(v_result->>'outbound_call_id', '')::uuid;

    -- Best-effort parse correlation_id for inline dispatch diagnostics (do not fail the reply workflow).
    BEGIN
      v_corr := (p_comm->>'correlation_id')::uuid;
    EXCEPTION
      WHEN others THEN
        v_corr := NULL;
    END;

    -- Parse dispatch config (optional; legacy policies may omit dispatch).
    SELECT *
      INTO v_policy_row
      FROM public.resolve_settings_row('comms_reply_policy', 'source', p_webhook_source_id)
      LIMIT 1;

    v_policy := COALESCE(v_policy_row.value, NULL);
    v_dispatch_cfg := CASE
      WHEN v_policy IS NULL THEN NULL
      ELSE v_policy->'dispatch'
    END;

    IF v_dispatch_cfg IS NOT NULL AND jsonb_typeof(v_dispatch_cfg) = 'object' THEN
      v_dispatch_mode := lower(NULLIF(v_dispatch_cfg->>'mode', ''));

      v_dispatch_timeout_seconds := NULLIF(v_dispatch_cfg->>'timeout_seconds', '')::int;
      v_dispatch_poll_max_seconds := NULLIF(v_dispatch_cfg->>'poll_max_seconds', '')::int;
      v_dispatch_poll_interval_ms := NULLIF(v_dispatch_cfg->>'poll_interval_ms', '')::int;
      v_dispatch_pending_reschedule_seconds := NULLIF(v_dispatch_cfg->>'pending_reschedule_seconds', '')::int;
      v_dispatch_lease_seconds := NULLIF(v_dispatch_cfg->>'lease_seconds', '')::int;
    END IF;

    IF v_queued AND v_outbound_call_id IS NOT NULL AND v_dispatch_mode = 'edge' THEN
      IF v_dispatch_timeout_seconds IS NULL OR v_dispatch_timeout_seconds <= 0 THEN
        RAISE EXCEPTION 'comms_reply_policy_invalid_dispatch_timeout';
      END IF;

      UPDATE public.outbound_calls oc
         SET status = 'pending_edge',
             scheduled_at = LEAST(oc.scheduled_at, now()),
             lease_expires_at = NULL,
             context = jsonb_set(
               COALESCE(oc.context, '{}'::jsonb),
               '{edge_dispatch}',
               jsonb_strip_nulls(jsonb_build_object(
                 'timeout_seconds', v_dispatch_timeout_seconds,
                 'immediate', TRUE
               )),
               TRUE
             )
       WHERE oc.id = v_outbound_call_id;

      v_dispatch_result := jsonb_strip_nulls(jsonb_build_object(
        'status', 'queued',
        'mode', 'edge',
        'timeout_seconds', v_dispatch_timeout_seconds
      ));
    ELSIF v_queued AND v_outbound_call_id IS NOT NULL AND v_dispatch_mode = 'inline' THEN
      IF v_dispatch_timeout_seconds IS NULL OR v_dispatch_timeout_seconds <= 0 THEN
        RAISE EXCEPTION 'comms_reply_policy_invalid_dispatch_timeout';
      END IF;
      IF v_dispatch_poll_max_seconds IS NULL OR v_dispatch_poll_max_seconds < 0 THEN
        RAISE EXCEPTION 'comms_reply_policy_invalid_dispatch_poll_max';
      END IF;
      IF v_dispatch_poll_interval_ms IS NULL OR v_dispatch_poll_interval_ms <= 0 THEN
        RAISE EXCEPTION 'comms_reply_policy_invalid_dispatch_poll_interval';
      END IF;
      IF v_dispatch_pending_reschedule_seconds IS NULL OR v_dispatch_pending_reschedule_seconds <= 0 THEN
        RAISE EXCEPTION 'comms_reply_policy_invalid_dispatch_pending_reschedule';
      END IF;
      IF v_dispatch_lease_seconds IS NULL OR v_dispatch_lease_seconds <= 0 THEN
        RAISE EXCEPTION 'comms_reply_policy_invalid_dispatch_lease';
      END IF;

      BEGIN
        v_dispatch_result := public.dispatch_outbound_call_inline(
          v_outbound_call_id,
          jsonb_strip_nulls(jsonb_build_object(
            'timeout_seconds', v_dispatch_timeout_seconds,
            'poll_max_seconds', v_dispatch_poll_max_seconds,
            'poll_interval_ms', v_dispatch_poll_interval_ms,
            'pending_reschedule_seconds', v_dispatch_pending_reschedule_seconds,
            'lease_seconds', v_dispatch_lease_seconds,
            'performed_by_system', 'comms_reply_inline_dispatch',
            'correlation_id', v_corr
          ))
        );
      EXCEPTION
        WHEN others THEN
          v_dispatch_result := jsonb_build_object('status', 'error', 'reason', SQLERRM);
      END;
    END IF;

    RETURN jsonb_strip_nulls(
      v_result
      || jsonb_strip_nulls(jsonb_build_object(
        'dispatch_mode', v_dispatch_mode,
        'dispatch', v_dispatch_result
      ))
    );
END;
$$;

COMMENT ON FUNCTION public.send_comms_reply(uuid, uuid, jsonb, uuid)
  IS 'Wrapper around send_comms_reply_core that applies policy-driven dispatch (queue/inline/edge) and returns dispatch metadata.';

COMMIT;


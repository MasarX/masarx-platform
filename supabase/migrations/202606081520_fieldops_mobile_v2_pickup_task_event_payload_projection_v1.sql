-- Date: 2026-06-08
--
-- Mobile V2 pickup closeout writes through submit_fieldops_proof_v1. Keep the
-- task event payload aligned with the route-stop proof metadata so same-context
-- device proof and backend readback can assert pickup handoff/failure fields
-- directly from the canonical task event.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606081520_fieldops_mobile_v2_pickup_task_event_payload_projection_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_definition TEXT;
  v_updated TEXT;
BEGIN
  SELECT pg_get_functiondef('public.submit_fieldops_proof_v1(uuid,text,jsonb,uuid)'::regprocedure)
    INTO v_definition;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1 is required before pickup task-event projection patch'
      USING ERRCODE = '42883';
  END IF;

  IF position('handover_contact_name' IN v_definition) > 0
     AND position('confirmed_quantity' IN v_definition) > 0
     AND position('exception_notes' IN v_definition) > 0 THEN
    v_updated := v_definition;
  ELSE
    v_updated := replace(
      v_definition,
      '    ''pod_methods'', NULLIF(btrim(COALESCE(v_evidence->>''pod_methods'', '''')), ''''),',
      '    ''pod_methods'', NULLIF(btrim(COALESCE(v_evidence->>''pod_methods'', '''')), ''''),
    ''confirmed_quantity'', CASE
      WHEN COALESCE(v_evidence->>''confirmed_quantity'', v_evidence #>> ''{pickup,confirmed_quantity}'') ~ ''^[0-9]+$''
      THEN COALESCE(v_evidence->>''confirmed_quantity'', v_evidence #>> ''{pickup,confirmed_quantity}'')::int
      ELSE NULL
    END,
    ''handover_contact_name'', NULLIF(btrim(COALESCE(
      v_evidence->>''handover_contact_name'',
      v_evidence #>> ''{pickup,handover_contact_name}'',
      ''''
    )), ''''),
    ''handover_notes'', NULLIF(btrim(COALESCE(
      v_evidence->>''handover_notes'',
      v_evidence #>> ''{pickup,handover_notes}'',
      ''''
    )), ''''),
    ''receipt_context'', NULLIF(btrim(COALESCE(
      v_evidence->>''receipt_context'',
      v_evidence #>> ''{pickup,receipt_context}'',
      ''''
    )), ''''),
    ''reason_code'', NULLIF(btrim(COALESCE(v_evidence->>''reason_code'', v_status_reason, '''')), ''''),
    ''status_reason'', NULLIF(btrim(COALESCE(v_status_reason, v_evidence->>''status_reason'', '''')), ''''),
    ''exception_reason'', NULLIF(btrim(COALESCE(
      v_evidence->>''exception_reason'',
      v_evidence->>''reason_code'',
      v_status_reason,
      ''''
    )), ''''),
    ''exception_notes'', NULLIF(btrim(COALESCE(
      v_evidence->>''exception_notes'',
      v_evidence #>> ''{pickup,failure_notes}'',
      ''''
    )), ''''),'
    );

    IF v_updated = v_definition THEN
      RAISE EXCEPTION 'submit_fieldops_proof_v1 pickup task-event projection marker not found'
        USING ERRCODE = '42883';
    END IF;
  END IF;

  EXECUTE v_updated;
END $$;

REVOKE ALL ON FUNCTION public.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_proof_v1(
  p_stop_id UUID,
  p_outcome TEXT,
  p_evidence JSONB DEFAULT '{}'::jsonb,
  p_idempotency_key UUID DEFAULT gen_random_uuid()
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_proof_v1(p_stop_id, p_outcome, p_evidence, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202606081520_fieldops_mobile_v2_pickup_task_event_payload_projection_v1'));
COMMIT;

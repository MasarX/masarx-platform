-- Migration: workflow intake dynamic error_status fix v2
-- Purpose:
--   - Address db-lint polymorphic type warning by ensuring jsonb_set inputs
--     have concrete types in workflow_intake_webhook wrapper.

BEGIN;

CREATE OR REPLACE FUNCTION public.workflow_intake_webhook(
  p_token   text,
  p_headers jsonb,
  p_raw_body text,
  p_payload jsonb DEFAULT NULL::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_result jsonb;
  v_org_id uuid;
  v_defaults jsonb;
  v_status int;
  v_status_async int;
  v_status_error int;
  v_workflow_run_id uuid;
  v_ack_outcome text;
BEGIN
  -- Delegate actual intake work to the core implementation.
  v_result := public.workflow_intake_webhook_core(p_token, p_headers, p_raw_body, p_payload);

  -- Derive organization id from token so we can resolve webhook intake defaults.
  BEGIN
    SELECT organization_id
    INTO v_org_id
    FROM get_webhook_source_by_token(p_token)
    LIMIT 1;
  EXCEPTION
    WHEN others THEN
      v_org_id := NULL;
  END;

  IF v_org_id IS NOT NULL THEN
    v_defaults := resolve_webhook_intake_defaults(v_org_id);
    v_status_async := (v_defaults->>'accepted_async_status')::int;
    v_status_error := (v_defaults->>'error_status')::int;
  ELSE
    v_defaults := NULL;
    v_status_async := NULL;
    v_status_error := NULL;
  END IF;

  v_status := COALESCE((v_result->>'status')::int, 0);
  v_workflow_run_id := NULLIF(v_result->>'workflow_run_id', '')::uuid;
  v_ack_outcome := COALESCE(v_result->>'ack_outcome', '');

  -- When no workflow_run_id is recorded and the core returned the accepted_async
  -- status for a successful ack, treat this as a misconfigured workflow template
  -- and upgrade the status to the dynamic error_status from defaults.
  IF v_defaults IS NOT NULL
     AND v_workflow_run_id IS NULL
     AND v_ack_outcome = 'ack_sent'
     AND v_status_async IS NOT NULL
     AND v_status = v_status_async THEN
    -- Upgrade status and annotate response metadata.
    v_result := jsonb_set(
      v_result,
      '{status}',
      to_jsonb(COALESCE(v_status_error, v_status))
    );

    v_result := jsonb_set(
      v_result,
      '{response_outcome}',
      to_jsonb('response_failed'::text)
    );

    v_result := jsonb_set(
      v_result,
      '{response_reason}',
      to_jsonb('workflow_template_missing'::text)
    );

    -- Provide a stable error message while preserving any existing body shape.
    v_result := jsonb_set(
      v_result,
      '{body}',
      COALESCE(
        (v_result->'body') || jsonb_build_object('error', 'Webhook workflow template not configured'),
        jsonb_build_object('error', 'Webhook workflow template not configured')
      )
    );
  END IF;

  RETURN v_result;
END;
$function$;

-- Ensure privileges remain aligned with prior definitions
REVOKE EXECUTE ON FUNCTION public.workflow_intake_webhook(text, jsonb, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workflow_intake_webhook(text, jsonb, text, jsonb) TO edge_webhook_role;
GRANT EXECUTE ON FUNCTION public.workflow_intake_webhook(text, jsonb, text, jsonb) TO service_role;

COMMIT;


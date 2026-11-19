-- Console V2 first-tenant webhook remediation: live webhook receiver must
-- execute the same source mapping that the operator tester validates.

BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_def TEXT;
  v_old TEXT := E'  v_payload_for_db := COALESCE(v_intent_resolution->''transformed_payload'', v_payload, ''{}''::jsonb);\n';
  v_new TEXT := E'  v_payload_for_db := COALESCE(v_intent_resolution->''transformed_payload'', v_payload, ''{}''::jsonb);\n\n  IF v_source.mapping_config_id IS NOT NULL THEN\n    v_payload_for_db := public.apply_mapping_config(v_payload_for_db, v_source.mapping_config_id);\n  END IF;\n';
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb) not found';
  END IF;

  IF position('public.apply_mapping_config(v_payload_for_db, v_source.mapping_config_id)' IN v_def) > 0 THEN
    RETURN;
  END IF;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_webhook_core_v1 mapping insertion marker not found';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END;
$do$;

COMMENT ON FUNCTION public.workflow_intake_webhook_core_v1(TEXT, JSONB, TEXT, JSONB)
  IS 'Workflow intake entrypoint: resolves policy, records ACK via decision_log, applies source mapping_config_id to transformed_payload, enqueues workflow runs, and only plans shipment id/tracking when workflow.intent = shipment_create.';

COMMIT;

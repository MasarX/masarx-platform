-- API Gateway outbound body_fields auth secret strip.
-- Request mapping can rebuild the outbound payload after the original inbound
-- body was redacted. Keep outbound_calls/workflow context secret-free while
-- preserving get_job_call_spec dispatch-time credential injection.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606010100_api_gateway_outbound_body_fields_secret_strip_v1'));

DO $$
DECLARE
  v_def TEXT;
  v_next TEXT;
  v_marker TEXT := E'  v_safe_outbound_body := public.redact_sensitive_json(COALESCE(v_outbound_body, ''{}''::jsonb));\n\n  IF COALESCE((v_request_mapping->>''mapped'')::BOOLEAN, FALSE) THEN';
  v_replacement TEXT := E'  v_safe_outbound_body := COALESCE(v_outbound_body, ''{}''::jsonb);\n  IF v_auth_mode = ''body_fields''\n     AND jsonb_typeof(v_safe_outbound_body) = ''object''\n     AND jsonb_typeof(v_auth_fields) = ''object'' THEN\n    SELECT COALESCE(\n      jsonb_object_agg(kv.key, kv.value) FILTER (WHERE kv.key IS NOT NULL),\n      ''{}''::jsonb\n    )\n      INTO v_safe_outbound_body\n      FROM jsonb_each(v_safe_outbound_body) AS kv(key, value)\n     WHERE kv.key NOT IN (\n       SELECT key FROM jsonb_each_text(v_auth_fields)\n       UNION\n       SELECT value FROM jsonb_each_text(v_auth_fields)\n        WHERE value IS NOT NULL AND btrim(value) <> ''''\n     );\n  END IF;\n\n  v_safe_outbound_body := public.redact_sensitive_json(COALESCE(v_safe_outbound_body, ''{}''::jsonb));\n\n  IF COALESCE((v_request_mapping->>''mapped'')::BOOLEAN, FALSE) THEN';
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 definition not found';
  END IF;

  IF position('FROM jsonb_each(v_safe_outbound_body) AS kv(key, value)' IN v_def) > 0
     AND position('SELECT value FROM jsonb_each_text(v_auth_fields)' IN v_def) > 0 THEN
    RAISE NOTICE 'workflow_intake_api_gateway_v1 already strips body_fields auth keys from mapped outbound bodies';
    RETURN;
  END IF;

  IF position(v_marker IN v_def) = 0 THEN
    RAISE EXCEPTION 'Expected mapped outbound body redaction marker not found in workflow_intake_api_gateway_v1';
  END IF;

  v_next := replace(v_def, v_marker, v_replacement);
  EXECUTE v_next;

  SELECT pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
    INTO v_def;

  IF position('FROM jsonb_each(v_safe_outbound_body) AS kv(key, value)' IN v_def) = 0
     OR position('SELECT value FROM jsonb_each_text(v_auth_fields)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 outbound body_fields strip patch did not apply';
  END IF;
END $$;

COMMENT ON FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  IS 'Intakes authenticated API Gateway requests, resolves route/source/provider context, applies route-bound request mapping, records redacted request readback, strips mapped body_fields auth keys before persistence, and enqueues provider dispatch.';

SELECT pg_advisory_unlock(hashtext('202606010100_api_gateway_outbound_body_fields_secret_strip_v1'));

COMMIT;

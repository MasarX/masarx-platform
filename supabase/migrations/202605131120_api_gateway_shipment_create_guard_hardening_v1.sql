-- Harden the first API Gateway shipment-create guard pass after auditor review:
-- postprocess shipment-create routes are shipment-create even without workflow
-- intent, ambiguous phone numbers fail closed, and invalid phones become
-- operator-visible terminal failures instead of quiet skipped postprocess.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605131120_api_gateway_shipment_create_guard_hardening_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.api_gateway_route_canonical_intent_v1(
  p_policy jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_intent text;
BEGIN
  v_intent := lower(NULLIF(btrim(COALESCE(
    p_policy #>> '{workflow,intent}',
    p_policy #>> '{workflow,canonical_intent}',
    p_policy #>> '{postprocess,canonical_intent}',
    p_policy #>> '{postprocess,intent}',
    p_policy #>> '{intake,canonical_intent}',
    p_policy #>> '{intake,intent}',
    p_policy ->> 'canonical_intent'
  )), ''));

  IF v_intent IN ('shipment_create', 'shipment.created', 'shipments.create') THEN
    RETURN 'shipment.create';
  END IF;

  IF v_intent IS NULL
     AND COALESCE(p_policy #>> '{postprocess,mode}', '') = 'shipment_create_v1' THEN
    RETURN 'shipment.create';
  END IF;

  RETURN v_intent;
END;
$function$;

COMMENT ON FUNCTION public.api_gateway_route_canonical_intent_v1(jsonb)
  IS 'Resolves row-driven API Gateway route intent from policy JSON; shipment-create postprocess routes are shipment.create even without an explicit workflow intent.';

CREATE OR REPLACE FUNCTION public.normalize_phone_number_e164_v1(
  p_phone TEXT,
  p_default_country_code TEXT DEFAULT '966'
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_raw TEXT := NULLIF(btrim(COALESCE(p_phone, '')), '');
  v_digits TEXT;
  v_country TEXT := regexp_replace(COALESCE(p_default_country_code, ''), '[^0-9]', '', 'g');
  v_candidate TEXT;
BEGIN
  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;

  IF public.is_e164_phone_number(v_raw) THEN
    RETURN v_raw;
  END IF;

  v_digits := regexp_replace(v_raw, '[^0-9]', '', 'g');
  IF v_digits IS NULL OR v_digits = '' THEN
    RETURN NULL;
  END IF;

  IF left(v_digits, 2) = '00' AND length(v_digits) > 2 THEN
    v_candidate := '+' || substr(v_digits, 3);
  ELSIF v_country <> '' AND left(v_digits, length(v_country)) = v_country THEN
    v_candidate := '+' || v_digits;
  ELSIF v_country <> '' AND left(v_digits, 1) = '0' AND length(v_digits) > 1 THEN
    v_candidate := '+' || v_country || substr(v_digits, 2);
  ELSE
    RETURN NULL;
  END IF;

  IF public.is_e164_phone_number(v_candidate) THEN
    RETURN v_candidate;
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.normalize_phone_number_e164_v1(TEXT, TEXT)
  IS 'Normalizes strict E.164 phone numbers, international 00 prefixes, and country-policy local leading-zero numbers. Ambiguous national numbers without country context fail closed.';

UPDATE public.api_routes
   SET policy = COALESCE(policy, '{}'::jsonb)
         || jsonb_build_object(
              'recipient_phone',
              COALESCE(policy->'recipient_phone', '{}'::jsonb)
                || jsonb_build_object('default_country_code', '966')
            ),
       updated_at = now()
 WHERE COALESCE(policy #>> '{postprocess,mode}', '') = 'shipment_create_v1'
   AND COALESCE(policy #>> '{recipient_phone,default_country_code}', '') = '';

DO $$
DECLARE
  v_function_def TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'workflow_handlers.process_api_gateway_shipment_create_v1(public.outbound_calls, jsonb, public.api_gateway_requests, public.api_routes)'::regprocedure
  )
    INTO v_function_def;

  IF v_function_def IS NULL THEN
    RAISE EXCEPTION 'process_api_gateway_shipment_create_v1 definition not found';
  END IF;

  v_function_def := replace(
    v_function_def,
    E'v_recipient_phone_e164 := public.normalize_phone_number_e164_v1(v_recipient_phone, ''966'');',
    E'v_recipient_phone_e164 := public.normalize_phone_number_e164_v1(\n      v_recipient_phone,\n      NULLIF(v_policy #>> ''{recipient_phone,default_country_code}'', '''')\n    );'
  );

  IF v_function_def LIKE '%v_recipient_phone_e164 := public.normalize_phone_number_e164_v1(v_recipient_phone, ''966'');%' THEN
    RAISE EXCEPTION 'process_api_gateway_shipment_create_v1 hardening patch did not apply';
  END IF;

  EXECUTE v_function_def;
END $$;

DO $$
DECLARE
  v_function_def TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'workflow_handlers.process_api_gateway_outbound_response_v1(public.outbound_calls, jsonb)'::regprocedure
  )
    INTO v_function_def;

  IF v_function_def IS NULL THEN
    RAISE EXCEPTION 'process_api_gateway_outbound_response_v1 definition not found';
  END IF;

  v_function_def := replace(
    v_function_def,
    E'  IF v_mode = ''shipment_create_v1'' THEN\n    RETURN workflow_handlers.process_api_gateway_shipment_create_v1(\n      p_job,\n      COALESCE(p_response, ''{}''::jsonb),\n      v_request,\n      v_route\n    );\n  END IF;',
    E'  IF v_mode = ''shipment_create_v1'' THEN\n    v_result := workflow_handlers.process_api_gateway_shipment_create_v1(\n      p_job,\n      COALESCE(p_response, ''{}''::jsonb),\n      v_request,\n      v_route\n    );\n\n    IF v_result #>> ''{postprocess,reason}'' = ''recipient_phone_not_e164_normalizable'' THEN\n      UPDATE public.outbound_calls\n         SET status = ''permanently_failed'',\n             response_status_code = 422,\n             error_message = ''recipient_phone_not_e164_normalizable'',\n             updated_at = now()\n       WHERE id = p_job.id;\n\n      v_result := jsonb_set(v_result, ''{postprocess,status}'', to_jsonb(''failed''::text), TRUE);\n    END IF;\n\n    RETURN v_result;\n  END IF;'
  );

  IF v_function_def NOT LIKE '%recipient_phone_not_e164_normalizable%'
     OR v_function_def NOT LIKE '%response_status_code = 422%' THEN
    RAISE EXCEPTION 'process_api_gateway_outbound_response_v1 terminal phone failure patch did not apply';
  END IF;

  EXECUTE v_function_def;
END $$;

DO $$
DECLARE
  v_function_def TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps, public.workflow_runs, jsonb)'::regprocedure
  )
    INTO v_function_def;

  IF v_function_def IS NULL THEN
    RAISE EXCEPTION 'execute_shipment_create_v1 definition not found';
  END IF;

  v_function_def := replace(
    v_function_def,
    E'v_recipient_phone_e164 := public.normalize_phone_number_e164_v1(v_recipient_phone, ''966'');',
    E'v_recipient_phone_e164 := public.normalize_phone_number_e164_v1(\n        v_recipient_phone,\n        COALESCE(\n          NULLIF(v_ctx_patch #>> ''{recipient_phone,default_country_code}'', ''''),\n          NULLIF(v_ctx #>> ''{recipient_phone,default_country_code}'', '''')\n        )\n      );'
  );

  IF v_function_def LIKE '%v_recipient_phone_e164 := public.normalize_phone_number_e164_v1(v_recipient_phone, ''966'');%' THEN
    RAISE EXCEPTION 'execute_shipment_create_v1 phone policy patch did not apply';
  END IF;

  EXECUTE v_function_def;
END $$;

SELECT pg_advisory_unlock(hashtext('202605131120_api_gateway_shipment_create_guard_hardening_v1'));
COMMIT;

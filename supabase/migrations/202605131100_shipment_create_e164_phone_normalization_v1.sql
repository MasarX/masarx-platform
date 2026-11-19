-- Shipment-create intake must normalize recipient phone numbers before writing
-- backend recipient truth. The E.164 guard is intentionally strict, so API and
-- webhook workflow paths must convert provider-local numbers before insert.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605131100_shipment_create_e164_phone_normalization_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
    v_candidate := '+' || v_digits;
  END IF;

  IF public.is_e164_phone_number(v_candidate) THEN
    RETURN v_candidate;
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.normalize_phone_number_e164_v1(TEXT, TEXT)
  IS 'Normalizes provider/local recipient phone numbers to strict E.164 for shipment-create intake. Defaults to Saudi country code 966 when local numbers start with 0.';

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

  IF v_function_def NOT LIKE '%v_recipient_phone_e164 TEXT;%' THEN
    v_function_def := replace(
      v_function_def,
      E'  v_recipient_name TEXT;\n  v_recipient_phone TEXT;\n  v_client_reference TEXT;',
      E'  v_recipient_name TEXT;\n  v_recipient_phone TEXT;\n  v_recipient_phone_e164 TEXT;\n  v_client_reference TEXT;'
    );
  END IF;

  IF v_function_def NOT LIKE '%v_recipient_phone_e164 := public.normalize_phone_number_e164_v1(v_recipient_phone, ''966'');%' THEN
    v_function_def := replace(
      v_function_def,
      E'  v_recipient_name := workflow_handlers.resolve_path_text(v_request_body, v_extract->>''recipient_name_path'');\n  v_recipient_phone := workflow_handlers.resolve_path_text(v_request_body, v_extract->>''recipient_phone_path'');\n  v_client_reference := workflow_handlers.resolve_path_text(v_request_body, v_extract->>''client_reference_path'');',
      E'  v_recipient_name := workflow_handlers.resolve_path_text(v_request_body, v_extract->>''recipient_name_path'');\n  v_recipient_phone := workflow_handlers.resolve_path_text(v_request_body, v_extract->>''recipient_phone_path'');\n  IF v_recipient_phone IS NOT NULL THEN\n    v_recipient_phone_e164 := public.normalize_phone_number_e164_v1(v_recipient_phone, ''966'');\n  END IF;\n  v_client_reference := workflow_handlers.resolve_path_text(v_request_body, v_extract->>''client_reference_path'');'
    );
  END IF;

  v_function_def := replace(
    v_function_def,
    E'  IF v_recipient_phone IS NOT NULL AND btrim(v_recipient_phone) <> '''' THEN\n    SELECT id INTO v_recipient_id\n    FROM public.recipients\n    WHERE client_id = v_client\n      AND phone_number = v_recipient_phone\n    ORDER BY created_at DESC\n    LIMIT 1;\n  END IF;\n\n  IF v_recipient_id IS NULL THEN',
    E'  IF v_recipient_phone_e164 IS NOT NULL THEN\n    SELECT id INTO v_recipient_id\n    FROM public.recipients\n    WHERE client_id = v_client\n      AND organization_id = v_org\n      AND (\n        phone_number = v_recipient_phone_e164\n        OR phone_number_normalized = public.normalize_phone_number(v_recipient_phone_e164)\n      )\n    ORDER BY created_at DESC\n    LIMIT 1;\n  END IF;\n\n  IF v_recipient_id IS NULL AND v_recipient_phone_e164 IS NULL THEN\n    PERFORM public.log_decision(\n      p_organization_id := v_org,\n      p_decision_category := ''transformation'',\n      p_resource_type := ''api_gateway_request'',\n      p_resource_id := v_request.id,\n      p_decision_point := ''recipient_phone_normalization'',\n      p_decision_outcome := ''failed'',\n      p_performed_by_system := ''workflow_handlers.process_api_gateway_shipment_create_v1'',\n      p_correlation_id := v_corr,\n      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(\n        ''recipient_phone'', v_recipient_phone,\n        ''provider_name'', v_provider_name,\n        ''reason'', ''recipient_phone_not_e164_normalizable''\n      ))\n    );\n\n    RETURN v_result || jsonb_build_object(\n      ''handled'', TRUE,\n      ''postprocess'', jsonb_build_object(\n        ''status'', ''skipped'',\n        ''reason'', ''recipient_phone_not_e164_normalizable''\n      )\n    );\n  END IF;\n\n  IF v_recipient_id IS NULL THEN'
  );

  v_function_def := replace(
    v_function_def,
    E'      COALESCE(NULLIF(v_recipient_phone, ''''), ''unknown''),',
    E'      v_recipient_phone_e164,'
  );

  IF v_function_def NOT LIKE '%v_recipient_phone_e164 TEXT;%'
     OR v_function_def NOT LIKE '%recipient_phone_not_e164_normalizable%'
     OR position(E'AND phone_number = v_recipient_phone\n' in v_function_def) > 0 THEN
    RAISE EXCEPTION 'process_api_gateway_shipment_create_v1 E.164 recipient patch did not apply';
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

  IF v_function_def NOT LIKE '%v_recipient_phone_e164 TEXT;%' THEN
    v_function_def := replace(
      v_function_def,
      E'    v_recipient_phone_normalized TEXT;\n    v_recipient_email TEXT',
      E'    v_recipient_phone_normalized TEXT;\n    v_recipient_phone_e164 TEXT;\n    v_recipient_email TEXT'
    );
  END IF;

  v_function_def := replace(
    v_function_def,
    E'    IF v_recipient_phone IS NOT NULL THEN\n      v_recipient_phone_normalized := public.normalize_phone_number(v_recipient_phone);\n    END IF;',
    E'    IF v_recipient_phone IS NOT NULL THEN\n      v_recipient_phone_e164 := public.normalize_phone_number_e164_v1(v_recipient_phone, ''966'');\n      v_recipient_phone_normalized := public.normalize_phone_number(COALESCE(v_recipient_phone_e164, v_recipient_phone));\n    END IF;'
  );

  v_function_def := replace(
    v_function_def,
    E'    IF v_recipient_id IS NULL AND v_recipient_name IS NOT NULL AND v_recipient_phone IS NOT NULL THEN\n      INSERT INTO public.recipients (',
    E'    IF v_recipient_id IS NULL AND v_recipient_name IS NOT NULL AND v_recipient_phone IS NOT NULL AND v_recipient_phone_e164 IS NULL THEN\n      RAISE EXCEPTION ''execute_shipment_create_v1 recipient phone must be E.164 or normalizable: %'', v_recipient_phone;\n    END IF;\n\n    IF v_recipient_id IS NULL AND v_recipient_name IS NOT NULL AND v_recipient_phone_e164 IS NOT NULL THEN\n      INSERT INTO public.recipients ('
  );

  v_function_def := replace(
    v_function_def,
    E'        v_recipient_phone,\n        ''pending'',',
    E'        v_recipient_phone_e164,\n        ''pending'','
  );

  IF v_function_def NOT LIKE '%v_recipient_phone_e164 TEXT;%'
     OR v_function_def NOT LIKE '%execute_shipment_create_v1 recipient phone must be E.164 or normalizable%'
     OR position(E'        v_recipient_phone,\n        ''pending'',' in v_function_def) > 0 THEN
    RAISE EXCEPTION 'execute_shipment_create_v1 E.164 recipient patch did not apply';
  END IF;

  EXECUTE v_function_def;
END $$;

SELECT pg_advisory_unlock(hashtext('202605131100_shipment_create_e164_phone_normalization_v1'));
COMMIT;

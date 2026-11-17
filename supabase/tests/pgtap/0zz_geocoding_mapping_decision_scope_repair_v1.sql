-- pgTAP: geocoding mapping fallback and step-scoped decision provenance repair

SET search_path TO public, pgtap, workflow_handlers, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(20);

CREATE OR REPLACE FUNCTION pg_temp.test_geocoding_mapping_decision_scope_repair_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_mapping_id UUID := gen_random_uuid();
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_source UUID := gen_random_uuid();
  v_webhook UUID := gen_random_uuid();
  v_template UUID := gen_random_uuid();
  v_template_step UUID := gen_random_uuid();
  v_run UUID := gen_random_uuid();
  v_step UUID := gen_random_uuid();
  v_run_row public.workflow_runs%ROWTYPE;
  v_step_row public.workflow_run_steps%ROWTYPE;
  v_intake_response public.workflow_handler_response;
  v_intake_address_id UUID;
  v_api_gateway_address JSONB;
  v_api_gateway_address_id UUID;
  v_result JSONB;
  v_address_def TEXT;
  v_log_def TEXT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (
    v_mapping_id,
    'webhook_inbound',
    'pgtap-geocoding-mapping-decision-scope-' || left(v_mapping_id::text, 8),
    jsonb_build_object(
      'transforms',
      jsonb_build_object(
        'address',
        jsonb_build_object(
          'line1', 'missing.line1|payload.destination.addressLine1',
          'city', jsonb_build_array('missing.city', 'payload.destination.city'),
          'lat', '$.payload.destination.coordinates.lat',
          'lng', '$.payload.destination.coordinates.lng',
          'short_code', '$.payload.destination.shortNationalAddress'
        )
      )
    ),
    1,
    'pgTAP geocoding mapping fallback repair'
  );

  v_result := public.apply_mapping_config(
    jsonb_build_object(
      'payload',
      jsonb_build_object(
        'destination',
        jsonb_build_object(
          'addressLine1', 'King Fahd Road',
          'city', 'Riyadh',
          'coordinates', jsonb_build_object('lat', 24.7136)
        )
      )
    ),
    v_mapping_id
  );

  RETURN NEXT is(
    v_result #>> '{address,line1}',
    'King Fahd Road',
    'apply_mapping_config resolves pipe-delimited fallback paths'
  );
  RETURN NEXT is(
    v_result #>> '{address,city}',
    'Riyadh',
    'apply_mapping_config resolves array fallback paths'
  );
  RETURN NEXT is(
    v_result #>> '{address,lat}',
    '24.7136',
    'apply_mapping_config resolves JSONPath transform values'
  );

  SELECT pg_get_functiondef('workflow_handlers.execute_address_intake_v1(public.workflow_run_steps, public.workflow_runs, jsonb)'::regprocedure)
    INTO v_address_def;
  SELECT pg_get_functiondef('workflow_handlers.geocoding_log_match(uuid, uuid, jsonb, jsonb)'::regprocedure)
    INTO v_log_def;

  RETURN NEXT ok(
    position('workflow_handlers.resolve_path_text(v_payload' IN v_address_def) > 0
      AND position('workflow_handlers.resolve_path_text(v_transformed_payload' IN v_address_def) > 0,
    'execute_address_intake_v1 resolves raw payload first and transformed payload as fallback'
  );
  RETURN NEXT is(
    workflow_handlers.resolve_path_text(
      jsonb_build_object(
        'payload',
        jsonb_build_object(
          'destination',
          jsonb_build_object('shortNationalAddress', 'RRRD2929')
        )
      ),
      '$.payload.destination.shortNationalAddress'
    ),
    'RRRD2929',
    'resolve_path_text accepts JSONPath-style $. mapping paths'
  );
  RETURN NEXT ok(
    position('provided_coordinates' IN v_address_def) > 0,
    'execute_address_intake_v1 carries provided coordinate readback into workflow context'
  );
  RETURN NEXT ok(
    position('sa_short_code' IN v_address_def) > 0
      AND position('v_short_code' IN v_address_def) > 0,
    'execute_address_intake_v1 persists submitted Saudi short address'
  );
  RETURN NEXT ok(
    position('''short_code'', v_short_code' IN v_address_def) > 0
      AND position('jsonb_strip_nulls(jsonb_build_object(' IN v_address_def) > 0,
    'execute_address_intake_v1 carries short code into geocoding context'
  );
  RETURN NEXT ok(
    position('''workflow_run_step''' IN v_log_def) > 0
      AND position('''workflow_run'', p_run_id' IN v_log_def) = 0,
    'geocoding_log_match writes decision_log rows scoped to workflow_run_step'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.canonical_cities c
       WHERE lower(c.name_canonical) = 'riyadh'
         AND c.country_code = 'SA'
         AND (
           c.name_arabic = U&'\0627\0644\0631\064A\0627\0636'
           OR U&'\0627\0644\0631\064A\0627\0636' = ANY(COALESCE(c.alternate_names, ARRAY[]::text[]))
         )
    ),
    'Riyadh canonical city keeps correct Arabic alias for local lookup'
  );
  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
        FROM public.canonical_cities c
       WHERE lower(c.name_canonical) = 'riyadh'
         AND c.country_code = 'SA'
         AND (
           c.name_arabic IS DISTINCT FROM U&'\0627\0644\0631\064A\0627\0636'
           OR NOT (U&'\0627\0644\0631\064A\0627\0636' = ANY(COALESCE(c.alternate_names, ARRAY[]::text[])))
           OR lower(COALESCE(c.province, '')) <> 'riyadh'
         )
    ),
    'All Riyadh canonical rows keep Arabic alias and local province normalization'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Geocoding Decision Scope Org', 'geocoding-decision-scope-' || left(v_org::text, 8));
  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Geocoding Decision Scope Client', 'geocoding-decision-scope-client-' || left(v_client::text, 8), 'active');
  INSERT INTO public.senders (id, client_id, name, brand_name, status)
  VALUES (v_sender, v_client, 'Geocoding Decision Scope Sender', 'Geocoding Decision Scope Sender', 'active');

  v_api_gateway_address := workflow_handlers.api_gateway_materialize_address_v1(
    v_org,
    v_client,
    jsonb_build_object(
      'shipment',
      jsonb_build_object(
        'destination',
        jsonb_build_object(
          'addressLine1', 'King Abdullah Road',
          'city', 'Riyadh',
          'shortNationalAddress', 'ryad7334',
          'coordinates', jsonb_build_object('lat', 24.7254, 'lng', 46.7111)
        )
      )
    ),
    jsonb_build_object(
      'destination_line1_path', '$.shipment.destination.addressLine1',
      'destination_city_path', '$.shipment.destination.city',
      'destination_short_code_path', '$.shipment.destination.shortNationalAddress',
      'destination_lat_path', '$.shipment.destination.coordinates.lat',
      'destination_lng_path', '$.shipment.destination.coordinates.lng'
    ),
    'destination'
  );
  v_api_gateway_address_id := NULLIF(v_api_gateway_address->>'address_id', '')::UUID;

  RETURN NEXT ok(
    COALESCE((v_api_gateway_address->>'created')::BOOLEAN, FALSE)
      AND v_api_gateway_address_id IS NOT NULL,
    'api gateway materializes address from JSONPath-style mapped payload'
  );
  RETURN NEXT is(
    (SELECT a.sa_short_code FROM public.addresses a WHERE a.id = v_api_gateway_address_id),
    'RYAD7334',
    'api gateway materialization persists normalized Saudi short address'
  );
  RETURN NEXT ok(
    (v_api_gateway_address #>> '{provided_coordinates,latitude}')::NUMERIC = 24.7254
      AND (v_api_gateway_address #>> '{provided_coordinates,longitude}')::NUMERIC = 46.7111,
    'api gateway materialization carries provided coordinate readback'
  );

  INSERT INTO public.webhook_sources (id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, sender_id, enabled)
  VALUES (v_source, v_org, 'geocoding-decision-scope-' || left(v_source::text, 8), 'Geocoding Decision Scope Source', 'generic', 'geo-token-' || left(v_source::text, 8), v_mapping_id, v_sender, true);
  INSERT INTO public.webhook_inbox (
    id,
    organization_id,
    webhook_source_id,
    provider_type,
    external_id,
    event_type,
    processing_status,
    correlation_id,
    idempotency_key,
    raw_payload,
    transformed_payload,
    created_at
  )
  VALUES (
    v_webhook,
    v_org,
    v_source,
    'generic',
    'geocoding-decision-scope-event-' || left(v_webhook::text, 8),
    'shipment.created',
    'pending',
    v_run,
    'geocoding-decision-scope-idempotency-' || left(v_webhook::text, 8),
    jsonb_build_object(
      'payload',
      jsonb_build_object(
        'destination',
        jsonb_build_object(
          'addressLine1', 'King Fahd Road',
          'city', 'Riyadh',
          'shortNationalAddress', 'rrrd2929',
          'coordinates', jsonb_build_object('lat', 24.7136, 'lng', 46.6753)
        )
      )
    ),
    '{}'::jsonb,
    now()
  );

  INSERT INTO public.workflow_templates (id, name, description, version, status, scope_type, scope_id)
  VALUES (v_template, 'pgtap_geocoding_decision_scope_' || left(v_template::text, 8), 'pgTAP geocoding decision scope', 1, 'active', 'tenant', v_org);
  INSERT INTO public.workflow_template_steps (id, workflow_template_id, sequence_order, operation_name, transition_condition, handler_key, handler_version, enabled)
  VALUES (v_template_step, v_template, 1, 'geocode', 'always', 'workflow_control', 'v1', true);

  PERFORM set_config('app.workflow_run_id', v_run::text, true);

  INSERT INTO public.workflow_runs (id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context)
  VALUES (
    v_run,
    v_template,
    1,
    'pgtap',
    'pending',
    jsonb_build_object(
      'workflow_run_id', v_run,
      'organization_id', v_org,
      'client_id', v_client,
      'sender_id', v_sender,
      'webhook_source_id', v_source,
      'webhook_id', v_webhook,
      'mapping_config_id', v_mapping_id
    )
  );
  INSERT INTO public.workflow_run_steps (id, workflow_run_id, workflow_template_step_id, sequence_order, step_status, operation_name, handler_key, handler_version, max_retries)
  VALUES (v_step, v_run, v_template_step, 1, 'pending', 'geocode', 'workflow_control', 'v1', 1);

  SELECT * INTO v_run_row FROM public.workflow_runs WHERE id = v_run;
  SELECT * INTO v_step_row FROM public.workflow_run_steps WHERE id = v_step;
  v_intake_response := workflow_handlers.execute_address_intake_v1(v_step_row, v_run_row, '{}'::jsonb);
  v_intake_address_id := NULLIF(v_intake_response.operation_result->>'address_id', '')::UUID;

  RETURN NEXT ok(
    v_intake_response.status = 'completed'
      AND COALESCE((v_intake_response.operation_result->>'created')::BOOLEAN, FALSE)
      AND v_intake_address_id IS NOT NULL,
    'execute_address_intake_v1 materializes webhook address input'
  );
  RETURN NEXT is(
    (SELECT a.sa_short_code FROM public.addresses a WHERE a.id = v_intake_address_id),
    'RRRD2929',
    'execute_address_intake_v1 persists normalized Saudi short address on address row'
  );
  RETURN NEXT is(
    (SELECT (a.raw_input::jsonb)->>'sa_short_code' FROM public.addresses a WHERE a.id = v_intake_address_id),
    'RRRD2929',
    'execute_address_intake_v1 preserves Saudi short address in raw input readback'
  );
  RETURN NEXT ok(
    v_intake_response.context_patch #>> '{geocoding,short_code}' = 'RRRD2929'
      AND (v_intake_response.context_patch #>> '{geocoding,provided_coordinates,latitude}')::NUMERIC = 24.7136
      AND (v_intake_response.context_patch #>> '{geocoding,provided_coordinates,longitude}')::NUMERIC = 46.6753,
    'execute_address_intake_v1 carries short address and coordinates into geocoding context'
  );

  PERFORM workflow_handlers.geocoding_log_match(
    v_run,
    v_step,
    jsonb_build_object('logging', jsonb_build_object('log_scoring_details', true)),
    jsonb_build_object('plugin', 'local_lookup', 'match_type', 'exact')
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.decision_log dl
       WHERE dl.resource_type = 'workflow_run_step'
         AND dl.resource_id = v_step
         AND dl.correlation_id = v_run
         AND dl.decision_inputs->>'workflow_run_id' = v_run::text
         AND dl.settings_resolution_id IS NOT NULL
    ),
    'geocoding_log_match persists step-scoped decision and settings resolution lineage'
  );
  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
        FROM public.decision_log dl
       WHERE dl.resource_type = 'workflow_run'
         AND dl.resource_id = v_run
         AND dl.decision_category = 'geocoding'
    ),
    'geocoding_log_match no longer writes run-scoped geocoding decisions'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_geocoding_mapping_decision_scope_repair_v1();

SELECT * FROM finish();

ROLLBACK;

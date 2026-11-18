-- pgTAP: geocoding mapping fallback and step-scoped decision provenance repair

SET search_path TO public, pgtap, workflow_handlers, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(19);

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
  v_template UUID := gen_random_uuid();
  v_template_step UUID := gen_random_uuid();
  v_run UUID := gen_random_uuid();
  v_step UUID := gen_random_uuid();
  v_result JSONB;
  v_address_def TEXT;
  v_create_def TEXT;
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
          'sa_short_code', '$.payload.destination.shortNationalAddress'
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
          'coordinates', jsonb_build_object('lat', 24.7136, 'lng', 46.6753),
          'shortNationalAddress', 'RNQA7082'
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
  RETURN NEXT is(
    v_result #>> '{address,lng}',
    '46.6753',
    'apply_mapping_config resolves JSONPath longitude transform values'
  );
  RETURN NEXT is(
    v_result #>> '{address,sa_short_code}',
    'RNQA7082',
    'apply_mapping_config resolves Saudi short national address aliases'
  );
  RETURN NEXT is(
    workflow_handlers.resolve_path_text(
      jsonb_build_object('payload', jsonb_build_object('destination', jsonb_build_object('coordinates', jsonb_build_object('lat', 24.7136)))),
      'missing.path|$.payload.destination.coordinates.lat'
    ),
    '24.7136',
    'resolve_path_text resolves pipe-delimited JSONPath fallbacks for address intake'
  );
  RETURN NEXT is(
    workflow_handlers.resolve_path_text(
      jsonb_build_object('payload', jsonb_build_object('destination', jsonb_build_object('city', 'Riyadh'))),
      jsonb_build_array('missing.city', 'payload.destination.city')::text
    ),
    'Riyadh',
    'resolve_path_text preserves JSON-array path mapping compatibility for address intake'
  );

  SELECT pg_get_functiondef('workflow_handlers.execute_address_intake_v1(public.workflow_run_steps, public.workflow_runs, jsonb)'::regprocedure)
    INTO v_address_def;
  SELECT pg_get_functiondef('workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps, public.workflow_runs, jsonb)'::regprocedure)
    INTO v_create_def;
  SELECT pg_get_functiondef('workflow_handlers.geocoding_log_match(uuid, uuid, jsonb, jsonb)'::regprocedure)
    INTO v_log_def;

  RETURN NEXT ok(
    position('workflow_handlers.resolve_path_text(v_payload' IN v_address_def) > 0
      AND position('workflow_handlers.resolve_path_text(v_transformed_payload' IN v_address_def) > 0,
    'execute_address_intake_v1 resolves raw payload first and transformed payload as fallback'
  );
  RETURN NEXT ok(
    position('provided_coordinates' IN v_address_def) > 0,
    'execute_address_intake_v1 carries provided coordinate readback into workflow context'
  );
  RETURN NEXT ok(
    position('ST_MakePoint(v_lng, v_lat)' IN v_address_def) > 0
      AND position('v_coordinates' IN v_address_def) > 0
      AND position('coordinates,' IN v_address_def) > 0,
    'execute_address_intake_v1 persists provided coordinates into canonical addresses.coordinates'
  );
  RETURN NEXT ok(
    position('sa_short_code' IN v_address_def) > 0
      AND position('workflow_handlers.geocoding_get_plugin' IN v_address_def) > 0,
    'execute_address_intake_v1 normalizes and persists Saudi short national address through policy plugin settings'
  );
  RETURN NEXT ok(
    position('address_sa_short_code_from_payload_v1(v_payload_address)' IN v_create_def) > 0
      AND position('address_coordinates_from_payload_v1(v_payload_address)' IN v_create_def) > 0
      AND position('sa_short_code,' IN v_create_def) > 0
      AND position('v_address_coordinates' IN v_create_def) > 0,
    'execute_shipment_create_v1 projects API/webhook SNA and coordinates into canonical address columns'
  );
  RETURN NEXT ok(
    position('reverse_geocode' IN v_address_def) > 0
      AND position('reverse_geocode_on_hit' IN v_address_def) > 0,
    'execute_address_intake_v1 carries policy-backed reverse geocode intent for short-code coordinate hits'
  );
  RETURN NEXT ok(
    position('public.resolve_settings(''address_policy''' IN v_address_def) > 0
      AND position('address_policy_country_default_missing' IN v_address_def) > 0
      AND position('NULLIF(v_country, ''''), ''SA''' IN v_address_def) = 0,
    'execute_address_intake_v1 resolves missing country from address_policy and fails closed when policy is missing'
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
  INSERT INTO public.webhook_sources (id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, sender_id, enabled)
  VALUES (v_source, v_org, 'geocoding-decision-scope-' || left(v_source::text, 8), 'Geocoding Decision Scope Source', 'generic', 'geo-token-' || left(v_source::text, 8), v_mapping_id, v_sender, true);

  INSERT INTO public.workflow_templates (id, name, description, version, status, scope_type)
  VALUES (v_template, 'pgtap_geocoding_decision_scope_' || left(v_template::text, 8), 'pgTAP geocoding decision scope', 1, 'active', 'tenant');
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
      'webhook_source_id', v_source
    )
  );
  INSERT INTO public.workflow_run_steps (id, workflow_run_id, workflow_template_step_id, sequence_order, step_status, operation_name, handler_key, handler_version, max_retries)
  VALUES (v_step, v_run, v_template_step, 1, 'pending', 'geocode', 'workflow_control', 'v1', 1);

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

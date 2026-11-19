-- Test Suite: Geocoding source-scoped policy context

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SET search_path TO public, workflow_handlers, pgtap, extensions, pg_temp;

SELECT plan(9);

SELECT has_function(
  'public',
  'geocoding_resolve_policy',
  ARRAY['uuid', 'uuid', 'uuid', 'uuid'],
  'geocoding_resolve_policy supports webhook source context'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_category_registry
    WHERE category = 'geocoding_policy'
      AND allowed_scopes ? 'source'
      AND allowed_scopes ? 'sender'
      AND allowed_scopes ? 'client'
  ),
  'geocoding_policy allows source, sender, and client scoped exceptions'
);

CREATE FUNCTION pg_temp.test_geocoding_source_policy_context() RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_source UUID := gen_random_uuid();
  v_mapping UUID := gen_random_uuid();
  v_address UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_template UUID := gen_random_uuid();
  v_run_source UUID := gen_random_uuid();
  v_run_sender UUID := gen_random_uuid();
  v_run_client UUID := gen_random_uuid();
  v_base_policy JSONB;
  v_source_policy JSONB;
  v_sender_policy JSONB;
  v_client_policy JSONB;
  v_extract RECORD;
  v_policy_record RECORD;
  v_workflow_run public.workflow_runs%ROWTYPE;
  v_resolved JSONB;
BEGIN
  v_base_policy := COALESCE(
    public.resolve_settings('geocoding_policy', 'global', NULL),
    jsonb_build_object(
      'version', 1,
      'provider_priority', jsonb_build_array(),
      'local_lookup', jsonb_build_object('enabled', true, 'source', 'postgis', 'allow_provider_fallback', false),
      'matching_plugins', jsonb_build_array(
        jsonb_build_object('name', 'short_code', 'enabled', true, 'params', jsonb_build_object('country', 'SA', 'code_type', 'sa_short_code')),
        jsonb_build_object('name', 'fuzzy', 'enabled', true, 'params', jsonb_build_object('min_confidence', 0.65))
      ),
      'metadata', jsonb_build_object('provider_strategy', 'postgis_canonical_local_then_manual_review'),
      'decision_workflow_id', 'workflow_geocoding_standard'
    )
  );

  v_client_policy := jsonb_set(
    v_base_policy,
    '{metadata}',
    COALESCE(v_base_policy->'metadata', '{}'::jsonb) || jsonb_build_object('scope_marker', 'client_exception'),
    true
  );
  v_sender_policy := jsonb_set(
    v_base_policy,
    '{metadata}',
    COALESCE(v_base_policy->'metadata', '{}'::jsonb) || jsonb_build_object('scope_marker', 'sender_exception'),
    true
  );
  v_source_policy := jsonb_set(
    v_base_policy,
    '{metadata}',
    COALESCE(v_base_policy->'metadata', '{}'::jsonb) || jsonb_build_object('scope_marker', 'source_exception'),
    true
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'pgTAP Geocoding Source Policy Org', 'pgtap-geocoding-source-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'pgTAP Geocoding Source Policy Client', 'pgtap-geo-src-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, status)
  VALUES (v_sender, v_client, 'pgTAP Geocoding Source Policy Sender', 'pgTAP Geo Source Sender', 'active');

  INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes, organization_id)
  VALUES (
    v_mapping,
    'webhook_inbound',
    'pgtap-geocoding-source-policy-' || left(v_mapping::text, 8),
    '{}'::jsonb,
    1,
    'pgTAP geocoding source policy fixture',
    v_org
  );

  INSERT INTO public.webhook_sources (
    id,
    organization_id,
    source_identifier,
    name,
    provider_type,
    auth_token,
    mapping_config_id,
    rate_limit_per_hour,
    enabled,
    sender_id
  )
  VALUES (
    v_source,
    v_org,
    'pgtap-geocoding-source-' || left(v_source::text, 8),
    'pgTAP Geocoding Source',
    'provider',
    'pgtap-geocoding-source-token-' || left(v_source::text, 8),
    v_mapping,
    500,
    TRUE,
    v_sender
  );

  INSERT INTO public.addresses (
    id,
    organization_id,
    client_id,
    raw_input,
    line1,
    city,
    province,
    country,
    validation_status
  )
  VALUES (
    v_address,
    v_org,
    v_client,
    jsonb_build_object('line1', 'TEST0000', 'country', 'SA'),
    'TEST0000',
    'Riyadh',
    'Riyadh',
    'SA',
    'pending'
  );

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    destination_address_id,
    status,
    metadata
  )
  VALUES (
    v_shipment,
    v_org,
    v_client,
    v_sender,
    'delivery',
    'PGTAP-GEO-SOURCE-' || left(v_shipment::text, 8),
    v_address,
    'pending',
    jsonb_build_object('webhook_source_id', v_source)
  );

  INSERT INTO public.workflow_templates (id, name, description, version, status, scope_type)
  VALUES (
    v_template,
    'pgtap_geocoding_source_policy_context_v1',
    'pgTAP geocoding source policy context fixture',
    1,
    'active',
    'global'
  );

  PERFORM set_config('app.workflow_run_id', v_run_source::text, true);
  INSERT INTO public.workflow_runs (
    id,
    workflow_template_id,
    workflow_template_version,
    entry_point,
    workflow_status,
    context
  )
  VALUES (
    v_run_source,
    v_template,
    1,
    'pgtap',
    'pending',
    jsonb_build_object(
      'organization_id', v_org,
      'client_id', v_client,
      'sender_id', v_sender,
      'webhook_source_id', v_source,
      'shipment_id', v_shipment,
      'address_id', v_address
    )
  );

  PERFORM set_config('app.workflow_run_id', v_run_sender::text, true);
  INSERT INTO public.workflow_runs (
    id,
    workflow_template_id,
    workflow_template_version,
    entry_point,
    workflow_status,
    context
  )
  VALUES (
    v_run_sender,
    v_template,
    1,
    'pgtap',
    'pending',
    jsonb_build_object(
      'organization_id', v_org,
      'client_id', v_client,
      'sender_id', v_sender
    )
  );

  PERFORM set_config('app.workflow_run_id', v_run_client::text, true);
  INSERT INTO public.workflow_runs (
    id,
    workflow_template_id,
    workflow_template_version,
    entry_point,
    workflow_status,
    context
  )
  VALUES (
    v_run_client,
    v_template,
    1,
    'pgtap',
    'pending',
    jsonb_build_object(
      'organization_id', v_org,
      'client_id', v_client
    )
  );

  PERFORM public.upsert_settings_value_v1(
    'geocoding_policy',
    'client',
    v_client,
    v_client_policy,
    1,
    'pgTAP geocoding client exception'
  );
  PERFORM public.upsert_settings_value_v1(
    'geocoding_policy',
    'sender',
    v_sender,
    v_sender_policy,
    1,
    'pgTAP geocoding sender exception'
  );
  PERFORM public.upsert_settings_value_v1(
    'geocoding_policy',
    'source',
    v_source,
    v_source_policy,
    1,
    'pgTAP geocoding source exception'
  );

  SELECT *
    INTO v_extract
    FROM public.geocoding_extract_policy_context_v1((SELECT wr FROM public.workflow_runs wr WHERE wr.id = v_run_source));

  RETURN NEXT is(v_extract.webhook_source_id, v_source, 'geocoding context extracts webhook source for shipment/address workflow');
  RETURN NEXT is(v_extract.sender_id, v_sender, 'geocoding context keeps shipment sender aligned with source sender');

  SELECT *
    INTO v_policy_record
    FROM public.geocoding_resolve_policy(v_org, v_client, v_sender, v_source)
    LIMIT 1;

  RETURN NEXT is(v_policy_record.scope_type, 'source', 'public geocoding resolver prefers source override');
  RETURN NEXT is(v_policy_record.policy #>> '{metadata,scope_marker}', 'source_exception', 'source policy marker wins over sender/client');

  SELECT * INTO v_workflow_run FROM public.workflow_runs WHERE id = v_run_source;
  v_resolved := workflow_handlers.geocoding_resolve_policy_for_run(v_workflow_run);
  RETURN NEXT is(v_resolved #>> '{metadata,scope_marker}', 'source_exception', 'workflow geocoding resolver uses source override');

  SELECT * INTO v_workflow_run FROM public.workflow_runs WHERE id = v_run_sender;
  v_resolved := workflow_handlers.geocoding_resolve_policy_for_run(v_workflow_run);
  RETURN NEXT is(v_resolved #>> '{metadata,scope_marker}', 'sender_exception', 'workflow geocoding resolver falls back to sender override');

  SELECT * INTO v_workflow_run FROM public.workflow_runs WHERE id = v_run_client;
  v_resolved := workflow_handlers.geocoding_resolve_policy_for_run(v_workflow_run);
  RETURN NEXT is(v_resolved #>> '{metadata,scope_marker}', 'client_exception', 'workflow geocoding resolver falls back to client override');
END;
$$;
SELECT * FROM pg_temp.test_geocoding_source_policy_context();

SELECT * FROM finish();

ROLLBACK;

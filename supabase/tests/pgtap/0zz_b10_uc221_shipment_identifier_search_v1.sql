-- Plan: B10 UC221 shipment identifier search / Step: E01
-- pgTAP: shipment identifier search UI contract

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

CREATE OR REPLACE FUNCTION pg_temp.test_b10_uc221_shipment_identifier_search_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_registry JSONB := NULL;
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_operator UUID := gen_random_uuid();
  v_role_id UUID := NULL;
  v_recipient UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_tracking TEXT := 'UC221-' || upper(left(v_shipment::text, 8));
  v_reference TEXT := 'UC221-REF-' || upper(left(v_shipment::text, 8));
  v_phone TEXT := '+966551234567';
  v_search_ids UUID[] := ARRAY[]::uuid[];
  v_list JSONB := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT cached_value
    INTO v_registry
    FROM public.settings
   WHERE category = 'ui_read_registry'
   LIMIT 1;

  RETURN NEXT has_function(
    'public',
    'ui_search_shipment_identifier_ids_v1',
    ARRAY['text[]'],
    'public.ui_search_shipment_identifier_ids_v1 exists'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'public.ui_search_shipment_identifier_ids_v1(text[])',
      'EXECUTE'
    ),
    'authenticated can execute public.ui_search_shipment_identifier_ids_v1'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS resource(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(resource.value->'filters', '[]'::jsonb)) AS filter(value)
      WHERE resource.value->>'key' = 'shipments'
        AND filter.value->>'key' = 'identifier'
        AND filter.value->>'resolver' = 'shipment_identifier'
    ),
    'ui_read_registry exposes shipments.identifier with shipment_identifier resolver'
  );
  RETURN NEXT matches(
    pg_get_functiondef('public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'::regprocedure),
    'ui_filter_flat_sql_v1',
    'ui_list_resource_v1 uses shared flat-filter compilation'
  );
  RETURN NEXT matches(
    pg_get_functiondef('public.ui_resource_metrics_v1(text,jsonb,text[])'::regprocedure),
    'ui_filter_flat_sql_v1',
    'ui_resource_metrics_v1 uses shared flat-filter compilation'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'UC221 Search Org', 'uc221-search-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status)
  VALUES (v_client, v_org, 'UC221 Search Client', 'uc221-client-' || left(v_client::text, 8), 'standard', 'active');

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'UC221 Search Sender', 'active');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_operator,
    v_org,
    'uc221-search-' || left(v_operator::text, 8) || '@example.com',
    'UC221 Operator',
    'ops_admin',
    'tenant'
  );

  SELECT role_id
    INTO v_role_id
    FROM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin']::TEXT[], v_operator)
   LIMIT 1;

  IF v_role_id IS NOT NULL THEN
    INSERT INTO public.rbac_user_role_assignments (
      organization_id,
      user_id,
      role_id,
      assigned_by_user_id,
      metadata
    )
    VALUES (
      v_org,
      v_operator,
      v_role_id,
      v_operator,
      '{"seed":true,"source":"pgtap","template_key":"ops_admin"}'::jsonb
    )
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO public.recipients (
    id,
    organization_id,
    client_id,
    name,
    phone_number,
    phone_number_normalized,
    preferred_language
  )
  VALUES (
    v_recipient,
    v_org,
    v_client,
    'UC221 Recipient',
    v_phone,
    public.normalize_phone_number(v_phone),
    'en'
  );

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    status,
    recipient_id,
    box_count
  )
  VALUES (
    v_shipment,
    v_org,
    v_client,
    v_sender,
    'delivery',
    v_tracking,
    'pending',
    v_recipient,
    1
  );

  INSERT INTO public.shipment_reference_numbers (
    organization_id,
    client_id,
    shipment_id,
    reference_type,
    reference_value,
    source_type,
    metadata
  )
  VALUES (
    v_org,
    v_client,
    v_shipment,
    'client_reference_number',
    v_reference,
    'pgtap',
    '{}'::jsonb
  );

  PERFORM set_config('request.jwt.claim.sub', v_operator::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_operator::text, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_search_ids := public.ui_search_shipment_identifier_ids_v1(ARRAY[v_tracking, v_reference, v_phone]);
  RETURN NEXT ok(
    v_shipment = ANY(COALESCE(v_search_ids, ARRAY[]::uuid[])),
    'ui_search_shipment_identifier_ids_v1 resolves shipment from tracking/reference/phone inputs'
  );

  v_list := public.ui_list_resource_v1(
    'shipments',
    jsonb_build_object('identifier', v_reference),
    10,
    0,
    NULL
  );
  RETURN NEXT is(
    (v_list->>'total')::INT,
    1,
    'ui_list_resource_v1 filters shipments by identifier'
  );
  RETURN NEXT is(
    v_list->'items'->0->>'id',
    v_shipment::text,
    'ui_list_resource_v1 returns the matched shipment row'
  );

  RETURN NEXT is(
    (public.ui_resource_metrics_v1(
      'shipments',
      jsonb_build_object('identifier', v_tracking),
      ARRAY['box_count']
    )->>'total')::INT,
    1,
    'ui_resource_metrics_v1 honors the identifier filter'
  );
END;
$function$;

SELECT * FROM pg_temp.test_b10_uc221_shipment_identifier_search_v1();

SELECT * FROM finish();

ROLLBACK;

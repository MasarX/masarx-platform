-- Plan: PLAN-202603-customer-shipment-change-review-flow / Step: S95
-- pgTAP: Public tracking policy + service helpers v1

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(88);

SELECT ok(to_regclass('public.public_tracking_access_events') IS NOT NULL, 'public_tracking_access_events table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='public_tracking_access_events'), 'RLS enabled on public_tracking_access_events');
SELECT ok(EXISTS(SELECT 1 FROM public.settings_category_registry WHERE category = 'public_tracking_policy'), 'public_tracking_policy settings category exists');
SELECT ok(EXISTS(
  SELECT 1
  FROM public.settings
  WHERE category = 'public_tracking_policy'
    AND scope_type = 'global'
    AND scope_id IS NULL
), 'public_tracking_policy global default exists');
SELECT is(
  public.public_tracking_policy_v1('{}'::jsonb) #>> '{notifications,task,organization_slug}',
  NULL,
  'public_tracking_policy global reviewer task org slug is optional and resolves via runtime fallback'
);
SELECT ok(to_regprocedure('public.public_tracking_lookup_v1(jsonb)') IS NOT NULL, 'public_tracking_lookup_v1 exists');
SELECT ok(to_regprocedure('public.public_tracking_verify_v1(jsonb)') IS NOT NULL, 'public_tracking_verify_v1 exists');
SELECT ok(to_regprocedure('public.public_tracking_session_v1(jsonb)') IS NOT NULL, 'public_tracking_session_v1 exists');
SELECT ok(to_regprocedure('public.public_tracking_create_request_v1(jsonb)') IS NOT NULL, 'public_tracking_create_request_v1 exists');
SELECT ok(to_regprocedure('public.public_tracking_submit_request_v2(jsonb)') IS NOT NULL, 'public_tracking_submit_request_v2 exists');
SELECT ok(to_regprocedure('public.public_tracking_apply_support_case_v1(jsonb)') IS NOT NULL, 'public_tracking_apply_support_case_v1 exists');
SELECT ok(to_regprocedure('public.public_tracking_review_request_v1(jsonb)') IS NOT NULL, 'public_tracking_review_request_v1 exists');
SELECT ok(to_regprocedure('public.public_tracking_close_review_task_v1(uuid,jsonb)') IS NOT NULL, 'public_tracking_close_review_task_v1 exists');
SELECT ok(EXISTS(
  SELECT 1
  FROM pg_trigger
  WHERE tgname = 'trg_public_tracking_close_review_task'
    AND tgrelid = 'public.support_cases'::regclass
    AND NOT tgisinternal
), 'public tracking support case closeout trigger exists');
SELECT ok(to_regprocedure('public.public_tracking_validate_location_change_v1(jsonb)') IS NOT NULL, 'public_tracking_validate_location_change_v1 exists');
SELECT ok(to_regprocedure('public.public_tracking_sync_active_route_stops_v1(jsonb)') IS NOT NULL, 'public_tracking_sync_active_route_stops_v1 exists');
SELECT ok(
  to_regprocedure('workflow_handlers.record_shipment_action_v1(uuid,text,text,jsonb,text,text,text,uuid,timestamptz)') IS NOT NULL,
  'record_shipment_action_v1 retains the canonical 9-argument signature'
);
SELECT ok(
  to_regprocedure('workflow_handlers.record_shipment_action_v1(uuid,text,text,jsonb,text,text,text,uuid)') IS NULL,
  'legacy 8-argument record_shipment_action_v1 overload is removed to avoid ambiguous dispatch'
);
SELECT ok(to_regprocedure('api.public_tracking_lookup_v1(jsonb)') IS NOT NULL, 'api.public_tracking_lookup_v1 exists');
SELECT ok(to_regprocedure('api.public_tracking_verify_v1(jsonb)') IS NOT NULL, 'api.public_tracking_verify_v1 exists');
SELECT ok(to_regprocedure('api.public_tracking_session_v1(jsonb)') IS NOT NULL, 'api.public_tracking_session_v1 exists');
SELECT ok(to_regprocedure('api.public_tracking_create_request_v1(jsonb)') IS NOT NULL, 'api.public_tracking_create_request_v1 exists');
SELECT ok(to_regprocedure('api.public_tracking_submit_request_v2(jsonb)') IS NOT NULL, 'api.public_tracking_submit_request_v2 exists');
SELECT ok(to_regprocedure('api.public_tracking_apply_support_case_v1(jsonb)') IS NOT NULL, 'api.public_tracking_apply_support_case_v1 exists');
SELECT ok(to_regprocedure('api.public_tracking_review_request_v1(jsonb)') IS NOT NULL, 'api.public_tracking_review_request_v1 exists');
SELECT ok(has_function_privilege('service_role', 'public.public_tracking_lookup_v1(jsonb)', 'EXECUTE'), 'service_role can execute public_tracking_lookup_v1');
SELECT ok(NOT has_function_privilege('authenticated', 'public.public_tracking_lookup_v1(jsonb)', 'EXECUTE'), 'authenticated cannot execute public_tracking_lookup_v1');
SELECT ok(has_function_privilege('service_role', 'api.public_tracking_lookup_v1(jsonb)', 'EXECUTE'), 'service_role can execute api.public_tracking_lookup_v1');
SELECT ok(has_function_privilege('service_role', 'api.public_tracking_verify_v1(jsonb)', 'EXECUTE'), 'service_role can execute api.public_tracking_verify_v1');
SELECT ok(has_function_privilege('service_role', 'api.public_tracking_session_v1(jsonb)', 'EXECUTE'), 'service_role can execute api.public_tracking_session_v1');
SELECT ok(has_function_privilege('service_role', 'api.public_tracking_create_request_v1(jsonb)', 'EXECUTE'), 'service_role can execute api.public_tracking_create_request_v1');
SELECT ok(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'support_cases'
      AND column_name = 'request_outcome'
  ),
  'support_cases.request_outcome projection column exists'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS item
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND item->>'key' = 'customer_shipment_changes'
  ),
  'customer_shipment_changes ui read resource is registered'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS item
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND item->>'key' = 'customer_shipment_changes'
      AND jsonb_array_length(COALESCE(item->'columns', '[]'::jsonb)) >= 9
  ),
  'customer_shipment_changes global ui read resource includes review-centric columns'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS item
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type IN ('tenant', 'client', 'sender')
      AND item->>'key' = 'customer_shipment_changes'
  )
  OR EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS item
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type IN ('tenant', 'client', 'sender')
      AND item->>'key' = 'customer_shipment_changes'
      AND jsonb_array_length(COALESCE(item->'columns', '[]'::jsonb)) >= 9
  ),
  'customer_shipment_changes scoped ui read resources stay review-aligned when scoped overrides exist'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS item
    WHERE s.category = 'ui_read_registry'
      AND item->>'key' = 'customer_shipment_changes'
      AND COALESCE((item->>'strict_columns')::BOOLEAN, FALSE)
  ),
  'customer_shipment_changes registry entries opt into strict configured columns'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
      AND COALESCE(sv.value #>> ARRAY['resource_map','customer_shipment_changes','write'], '') = 'manual_review.resolve'
  ),
  'customer_shipment_changes write capability maps to manual_review.resolve through access_control_policy'
);

CREATE OR REPLACE FUNCTION pg_temp.run_public_tracking_service_checks()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_org UUID := '2a100000-0000-0000-0000-000000000001'::uuid;
  v_client UUID := '2a100000-0000-0000-0000-000000000201'::uuid;
  v_sender UUID := '2a100000-0000-0000-0000-000000000301'::uuid;
  v_other_org UUID := '2a100000-0000-0000-0000-000000000111'::uuid;
  v_other_user UUID := '2a100000-0000-0000-0000-000000000112'::uuid;
  v_sibling_client UUID := '2a100000-0000-0000-0000-000000000211'::uuid;
  v_sibling_sender UUID := '2a100000-0000-0000-0000-000000000311'::uuid;
  v_client_user UUID := '2a100000-0000-0000-0000-000000000113'::uuid;
  v_sender_user UUID := '2a100000-0000-0000-0000-000000000114'::uuid;
  v_recipient_one UUID := '2a100000-0000-0000-0000-000000000401'::uuid;
  v_recipient_two UUID := '2a100000-0000-0000-0000-000000000402'::uuid;
  v_address UUID := '2a100000-0000-0000-0000-000000000451'::uuid;
  v_city UUID := '2a100000-0000-0000-0000-000000000461'::uuid;
  v_district UUID := '2a100000-0000-0000-0000-000000000462'::uuid;
  v_zone UUID := '2a100000-0000-0000-0000-000000000463'::uuid;
  v_branch UUID := '2a100000-0000-0000-0000-000000000464'::uuid;
  v_ship_ok UUID := '2a100000-0000-0000-0000-000000000501'::uuid;
  v_ship_ambiguous UUID := '2a100000-0000-0000-0000-000000000502'::uuid;
  v_validation_missing JSONB;
  v_validation_ok JSONB;
  v_verify JSONB;
  v_verify_review JSONB;
  v_session JSONB;
  v_request JSONB;
  v_request_review JSONB;
  v_request_reject JSONB;
  v_cross_tenant_result JSONB;
  v_sibling_client_result JSONB;
  v_sibling_sender_result JSONB;
  v_review_result JSONB;
  v_reject_result JSONB;
  v_session_token TEXT;
  v_review_session_token TEXT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Public Tracking Org', 'public-tracking-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_other_org, 'Other Review Org', 'other-review-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES
    (v_client, v_org, 'Public Tracking Client', 'public-tracking-client', 'active'),
    (v_sibling_client, v_org, 'Sibling Tracking Client', 'sibling-tracking-client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES
    (v_sender, v_client, 'Public Tracking Sender', 'active'),
    (v_sibling_sender, v_client, 'Sibling Tracking Sender', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    access_scope_type,
    access_scope_id,
    status
  )
  VALUES (
    v_other_user,
    v_other_org,
    'other-reviewer@example.com',
    'Other Reviewer',
    'ops_admin',
    'tenant',
    NULL,
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type,
    access_scope_type, access_scope_id, status
  ) VALUES
    (
      v_client_user, v_org, 'sibling-client-reviewer@example.com', 'Sibling Client Reviewer',
      'ops_admin', 'client', v_sibling_client, 'active'
    ),
    (
      v_sender_user, v_org, 'sibling-sender-reviewer@example.com', 'Sibling Sender Reviewer',
      'ops_admin', 'sender', v_sibling_sender, 'active'
    )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.recipients (id, organization_id, client_id, name, phone_number, email)
  VALUES
    (v_recipient_one, v_org, v_client, 'John Receiver', '+966500001123', 'john.receiver@example.com'),
    (v_recipient_two, v_org, v_client, 'Jane Receiver', '+966511111123', 'jane.receiver@example.com')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.addresses (
    id,
    organization_id,
    client_id,
    raw_input,
    district,
    city,
    province,
    postal_code,
    country,
    building_number,
    validation_status
  )
  VALUES (
    v_address,
    v_org,
    v_client,
    'Tower 1, Olaya, Riyadh',
    'Al Olaya',
    'Riyadh',
    'Riyadh',
    '12345',
    'SA',
    '44',
    'valid'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    carrier_reference_number,
    client_reference_number,
    box_count,
    status,
    recipient_id,
    destination_address_id,
    promised_delivery_date
  )
  VALUES
    (
      v_ship_ok,
      v_org,
      v_client,
      v_sender,
      'delivery',
      'PGTAP-SVC-TRACK-001',
      'PGTAP-SVC-CARRIER-AMB',
      'PGTAP-SVC-ORDER-001',
      1,
      'in_transit',
      v_recipient_one,
      v_address,
      (workflow_now() + interval '1 day')::date
    ),
    (
      v_ship_ambiguous,
      v_org,
      v_client,
      v_sender,
      'delivery',
      'PGTAP-SVC-TRACK-002',
      'PGTAP-SVC-CARRIER-AMB',
      'PGTAP-SVC-ORDER-002',
      1,
      'pending',
      v_recipient_two,
      v_address,
      (workflow_now() + interval '2 day')::date
  )
  ON CONFLICT DO NOTHING;

  SELECT public.public_tracking_validate_location_change_v1(
    jsonb_build_object(
      'shipment_id', v_ship_ok,
      'client_id', v_client,
      'map_pin', jsonb_build_object('lat', 24.7061, 'lng', 46.6818)
    )
  )
  INTO v_validation_missing;

  RETURN NEXT ok(
    COALESCE((v_validation_missing->>'ok')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE
    AND (v_validation_missing #>> '{error,code}') IN ('canonical_district_missing', 'zone_unmapped'),
    'location-change validation fails closed when no canonical geography is mapped for the shipment organization'
  );

  INSERT INTO public.canonical_cities (
    id,
    organization_id,
    name_canonical,
    name_arabic,
    alternate_names,
    province,
    country_code,
    source,
    metadata,
    centroid,
    is_active
  )
  VALUES (
    v_city,
    v_org,
    'Riyadh',
    'Riyadh',
    ARRAY['Riyadh', 'Riyadh City']::text[],
    'Riyadh',
    'SA',
    'manual_seed',
    jsonb_build_object('seed', true, 'source', 'pgtap_public_tracking'),
    ST_SetSRID(ST_MakePoint(46.6818, 24.7061), 4326)::geography,
    TRUE
  )
  ON CONFLICT (organization_id, name_canonical) WHERE source_city_id IS NULL DO UPDATE
  SET
    name_arabic = EXCLUDED.name_arabic,
    alternate_names = EXCLUDED.alternate_names,
    province = EXCLUDED.province,
    country_code = EXCLUDED.country_code,
    source = EXCLUDED.source,
    metadata = COALESCE(public.canonical_cities.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    centroid = COALESCE(EXCLUDED.centroid, public.canonical_cities.centroid),
    is_active = EXCLUDED.is_active,
    updated_at = workflow_now()
  RETURNING id INTO v_city;

  INSERT INTO public.canonical_districts (
    id,
    organization_id,
    city_id,
    name_canonical,
    name_arabic,
    alternate_names,
    source,
    metadata,
    centroid,
    is_active
  )
  VALUES (
    v_district,
    v_org,
    v_city,
    'Al Olaya',
    'Al Olaya',
    ARRAY['Al Olaya', 'Olaya']::text[],
    'manual_seed',
    jsonb_build_object('seed', true, 'source', 'pgtap_public_tracking'),
    ST_SetSRID(ST_MakePoint(46.6818, 24.7061), 4326)::geography,
    TRUE
  )
  ON CONFLICT (organization_id, city_id, name_canonical) WHERE source_district_id IS NULL DO UPDATE
  SET
    name_arabic = EXCLUDED.name_arabic,
    alternate_names = EXCLUDED.alternate_names,
    source = EXCLUDED.source,
    metadata = COALESCE(public.canonical_districts.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    centroid = COALESCE(EXCLUDED.centroid, public.canonical_districts.centroid),
    is_active = EXCLUDED.is_active,
    updated_at = workflow_now()
  RETURNING id INTO v_district;

  INSERT INTO public.zones (id, organization_id, name, slug, is_active)
  VALUES (v_zone, v_org, 'Public Tracking Test Zone', 'pgtap-public-tracking-zone', TRUE)
  ON CONFLICT (organization_id, slug) DO UPDATE
  SET
    name = EXCLUDED.name,
    is_active = EXCLUDED.is_active,
    updated_at = workflow_now()
  RETURNING id INTO v_zone;

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'pgtap-public-tracking', 'Public Tracking Test Branch', 'Asia/Riyadh', TRUE)
  ON CONFLICT (organization_id, code) DO UPDATE
  SET
    name = EXCLUDED.name,
    timezone = EXCLUDED.timezone,
    is_active = EXCLUDED.is_active,
    updated_at = workflow_now()
  RETURNING id INTO v_branch;

  INSERT INTO public.zone_districts (zone_id, canonical_district_id)
  VALUES (v_zone, v_district)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.branch_zones (branch_id, zone_id, priority)
  VALUES (v_branch, v_zone, 0)
  ON CONFLICT (zone_id) DO UPDATE
  SET
    branch_id = EXCLUDED.branch_id,
    priority = EXCLUDED.priority;

  SELECT public.public_tracking_validate_location_change_v1(
    jsonb_build_object(
      'shipment_id', v_ship_ok,
      'client_id', v_client,
      'map_pin', jsonb_build_object('lat', 24.7061, 'lng', 46.6818)
    )
  )
  INTO v_validation_ok;

  RETURN NEXT ok(COALESCE((v_validation_ok->>'ok')::BOOLEAN, FALSE), 'location-change validation passes once canonical coverage exists');
  RETURN NEXT is(v_validation_ok #>> '{validation,zone_id}', v_zone::text, 'location-change validation resolves the canonical zone');
  RETURN NEXT is(v_validation_ok #>> '{validation,branch_id}', v_branch::text, 'location-change validation resolves the branch from coverage');

  INSERT INTO public.shipment_reference_numbers (
    organization_id,
    client_id,
    shipment_id,
    reference_type,
    reference_value,
    source_type
  )
  VALUES
    (v_org, v_client, v_ship_ok, 'carrier_reference_number', 'PGTAP-SVC-CARRIER-AMB', 'system'),
    (v_org, v_client, v_ship_ok, 'client_reference_number', 'PGTAP-SVC-ORDER-001', 'system'),
    (v_org, v_client, v_ship_ambiguous, 'client_reference_number', 'PGTAP-SVC-ORDER-002', 'system'),
    (v_org, v_client, v_ship_ambiguous, 'carrier_reference_number', 'PGTAP-SVC-CARRIER-AMB', 'system')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.shipment_actions (
    id,
    shipment_id,
    organization_id,
    client_id,
    action_type,
    action_category,
    canonical_status,
    timestamp,
    created_at,
    performed_by_system
  )
  VALUES (
    gen_random_uuid(),
    v_ship_ok,
    v_org,
    v_client,
    'status_change',
    'operational',
    'in_transit',
    workflow_now(),
    workflow_now(),
    'pgtap_public_tracking'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.public_tracking_resolve_candidate_v1('PGTAP-SVC-CARRIER-AMB', '123')),
    0,
    'ambiguous reference resolves to zero public candidates'
  );

  SELECT public.public_tracking_verify_v1(jsonb_build_object(
    'reference', 'PGTAP-SVC-ORDER-001',
    'phone_last3', '123',
    'ip_hash', 'hash-verify-1'
  ))
  INTO v_verify;

  v_session_token := v_verify->>'session_token';

  RETURN NEXT ok(COALESCE((v_verify->>'ok')::BOOLEAN, FALSE), 'verify RPC returns ok=true');
  RETURN NEXT ok(v_session_token IS NOT NULL, 'verify RPC returns a session token');

  SELECT public.public_tracking_session_v1(jsonb_build_object(
    'session_token', v_session_token,
    'ip_hash', 'hash-session-1'
  ))
  INTO v_session;

  RETURN NEXT ok(COALESCE((v_session->>'ok')::BOOLEAN, FALSE), 'session RPC rehydrates verified session');
  RETURN NEXT ok(COALESCE(v_session#>>'{tracking,recipient,phone}', '') LIKE '%123', 'masked phone exposes only last 3 digits');
  RETURN NEXT ok(position('*' IN COALESCE(v_session#>>'{tracking,recipient,phone}', '')) > 0, 'masked phone retains masking characters');
  RETURN NEXT ok((v_session#>>'{tracking,address,short_national_address}') <> '44 12345', 'masked short national address does not expose the raw value');

  SELECT public.public_tracking_create_request_v1(jsonb_build_object(
    'session_token', v_session_token,
    'ip_hash', 'hash-request-1',
    'request_type', 'location_change',
    'payload', jsonb_build_object(
      'address_text', 'Tower 4, gate B, service road',
      'short_national_address', 'RAHA1234',
      'map_pin', jsonb_build_object('lat', 24.7061, 'lng', 46.6818),
      'landmark', 'Near the red tower',
      'drop_point', 'Reception, gate, loading bay',
      'notes', 'Use service entrance'
    )
  ))
  INTO v_request;

  RETURN NEXT ok(COALESCE((v_request->>'ok')::BOOLEAN, FALSE), 'request RPC returns ok=true');
  RETURN NEXT is((SELECT request_source FROM public.support_cases WHERE id = (v_request->>'support_case_id')::uuid), 'public_tracking', 'support case request_source is derived from metadata');
  RETURN NEXT is((SELECT request_type_key FROM public.support_cases WHERE id = (v_request->>'support_case_id')::uuid), 'location_change', 'support case request_type_key is derived from metadata');
  RETURN NEXT is(v_request->>'outcome', 'applied', 'default policy auto-applies the customer shipment change');
  RETURN NEXT is((SELECT status_reason FROM public.support_cases WHERE id = (v_request->>'support_case_id')::uuid), 'applied', 'auto-applied request resolves the support case as applied');
  RETURN NEXT is(
    (
      SELECT metadata #>> ARRAY['requested_snapshot','address','landmark']
      FROM public.support_cases
      WHERE id = (v_request->>'support_case_id')::uuid
    ),
    'Near the red tower',
    'requested snapshot persists landmark details'
  );
  RETURN NEXT is(
    (
      SELECT metadata #>> ARRAY['requested_snapshot','address','drop_point']
      FROM public.support_cases
      WHERE id = (v_request->>'support_case_id')::uuid
    ),
    'Reception, gate, loading bay',
    'requested snapshot persists drop-point details'
  );
  RETURN NEXT ok(EXISTS(
    SELECT 1
    FROM public.support_case_events sce
    WHERE sce.support_case_id = (v_request->>'support_case_id')::uuid
      AND sce.event_type = 'requested'
      AND COALESCE(jsonb_array_length(sce.payload->'changed_fields'), 0) > 0
  ), 'requested event stores immutable changed_fields snapshot');
  RETURN NEXT ok(EXISTS(
    SELECT 1
    FROM public.support_case_events sce
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(sce.payload->'changed_fields', '[]'::jsonb)) AS field(value)
    WHERE sce.support_case_id = (v_request->>'support_case_id')::uuid
      AND sce.event_type = 'requested'
      AND field.value = 'address.landmark'
  ), 'requested event changed_fields includes landmark');
  RETURN NEXT ok(EXISTS(
    SELECT 1
    FROM public.support_case_events sce
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(sce.payload->'changed_fields', '[]'::jsonb)) AS field(value)
    WHERE sce.support_case_id = (v_request->>'support_case_id')::uuid
      AND sce.event_type = 'requested'
      AND field.value = 'address.drop_point'
  ), 'requested event changed_fields includes drop-point details');
  RETURN NEXT ok(EXISTS(
    SELECT 1
    FROM public.support_case_events sce
    WHERE sce.support_case_id = (v_request->>'support_case_id')::uuid
      AND sce.event_type = 'applied'
      AND sce.payload->>'apply_outcome' = 'applied'
  ), 'applied event is written for auto-applied shipment changes');
  RETURN NEXT is(
    (
      SELECT sce.payload #>> ARRAY['apply_result','validation','reason']
      FROM public.support_case_events sce
      WHERE sce.support_case_id = (v_request->>'support_case_id')::uuid
        AND sce.event_type = 'applied'
      ORDER BY sce.created_at DESC
      LIMIT 1
    ),
    'serviceable',
    'applied event carries serviceability validation evidence'
  );
  RETURN NEXT is((SELECT zone_id::text FROM public.shipments WHERE id = v_ship_ok), v_zone::text, 'auto-applied location change updates shipment zone projection');
  RETURN NEXT is((SELECT branch_id::text FROM public.shipments WHERE id = v_ship_ok), v_branch::text, 'auto-applied location change updates shipment branch projection');
  RETURN NEXT ok(EXISTS(
    SELECT 1
    FROM public.outbound_calls oc
    WHERE oc.context->>'source' = 'public_tracking'
      AND oc.context->>'support_case_id' = v_request->>'support_case_id'
      AND oc.body->>'stage' = 'received'
  ), 'auto-applied request enqueues requester received notification');
  RETURN NEXT ok(EXISTS(
    SELECT 1
    FROM public.outbound_calls oc
    WHERE oc.context->>'source' = 'public_tracking'
      AND oc.context->>'support_case_id' = v_request->>'support_case_id'
      AND oc.body->>'stage' = 'applied'
  ), 'auto-applied request enqueues requester applied notification');

  PERFORM public.upsert_settings_value_v1(
    'public_tracking_policy',
    'sender',
    v_sender,
    public.deep_merge_jsonb(
      public.public_tracking_policy_v1(jsonb_build_object(
        'organization_id', v_org,
        'client_id', v_client,
        'sender_id', v_sender
      )),
      jsonb_build_object(
        'actions', jsonb_build_object(
          'location_change', jsonb_build_object('execution_mode', 'review_required')
        )
      )
    ),
    1,
    'pgtap public tracking review-required override'
  );

  SELECT public.public_tracking_verify_v1(jsonb_build_object(
    'reference', 'PGTAP-SVC-ORDER-002',
    'phone_last3', '123',
    'ip_hash', 'hash-verify-review'
  ))
  INTO v_verify_review;

  v_review_session_token := v_verify_review->>'session_token';

  SELECT public.public_tracking_submit_request_v2(jsonb_build_object(
    'session_token', v_review_session_token,
    'ip_hash', 'hash-request-review',
    'request_type', 'location_change',
    'payload', jsonb_build_object(
      'address_text', 'Warehouse 12, south gate',
      'short_national_address', 'WARE1234',
      'map_pin', jsonb_build_object('lat', 24.7061, 'lng', 46.6818),
      'landmark', 'South loading fence',
      'drop_point', 'Security desk gate 2',
      'notes', 'Ring the side gate bell'
    )
  ))
  INTO v_request_review;

  RETURN NEXT is(v_request_review->>'outcome', 'pending_review', 'review-required policy keeps the shipment change pending review');
  RETURN NEXT is((SELECT status FROM public.support_cases WHERE id = (v_request_review->>'support_case_id')::uuid), 'open', 'pending review request stays open');
  RETURN NEXT ok(
    COALESCE(
      (
        SELECT (metadata #>> ARRAY['review_task','queued'])::BOOLEAN
        FROM public.support_cases
        WHERE id = (v_request_review->>'support_case_id')::uuid
      ),
      FALSE
    ),
    'pending review request stores reviewer task metadata on the support case'
  );
  RETURN NEXT ok(EXISTS(
    SELECT 1
    FROM public.tasks t
    WHERE t.id = (
      SELECT NULLIF(metadata #>> ARRAY['review_task','task_id'], '')::UUID
      FROM public.support_cases
      WHERE id = (v_request_review->>'support_case_id')::uuid
    )
      AND t.resource_type = 'support_case'
      AND t.resource_id = (v_request_review->>'support_case_id')::uuid
  ), 'pending review request creates reviewer task work');
  RETURN NEXT ok(EXISTS(
    SELECT 1
    FROM public.outbound_calls oc
    WHERE oc.context->>'source' = 'public_tracking'
      AND oc.context->>'support_case_id' = v_request_review->>'support_case_id'
      AND oc.body->>'stage' = 'received'
  ), 'pending review request enqueues requester received notification');

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_client_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_client_user::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT public.public_tracking_review_request_v1(jsonb_build_object(
    'support_case_id', (v_request_review->>'support_case_id')::uuid,
    'decision', 'approved',
    'reason', 'Sibling client review attempt'
  )) INTO v_sibling_client_result;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '{}', true);
  RETURN NEXT is(
    v_sibling_client_result #>> '{error,code}',
    'request_not_found',
    'client reviewer receives generic absence for a sibling client shipment change'
  );

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_sender_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_sender_user::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT public.public_tracking_review_request_v1(jsonb_build_object(
    'support_case_id', (v_request_review->>'support_case_id')::uuid,
    'decision', 'approved',
    'reason', 'Sibling sender review attempt'
  )) INTO v_sibling_sender_result;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '{}', true);
  RETURN NEXT is(
    v_sibling_sender_result #>> '{error,code}',
    'request_not_found',
    'sender reviewer receives generic absence for a sibling sender shipment change'
  );

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_other_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_other_user::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT public.public_tracking_review_request_v1(jsonb_build_object(
    'support_case_id', (v_request_review->>'support_case_id')::uuid,
    'decision', 'approved',
    'reason', 'Cross-tenant review attempt'
  ))
  INTO v_cross_tenant_result;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '{}', true);

  RETURN NEXT is(
    v_cross_tenant_result #>> '{error,code}',
    'request_not_found',
    'tenant reviewer receives generic absence for a different tenant shipment change'
  );

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  SELECT public.public_tracking_review_request_v1(jsonb_build_object(
    'support_case_id', (v_request_review->>'support_case_id')::uuid,
    'decision', 'approved',
    'reason', 'Approved in pgTAP'
  ))
  INTO v_review_result;

  RETURN NEXT ok(COALESCE((v_review_result->>'ok')::BOOLEAN, FALSE), 'review RPC approves the pending shipment change');
  RETURN NEXT is(v_review_result->>'outcome', 'applied', 'review approval applies the shipment change through the canonical engine');
  RETURN NEXT is((SELECT status_reason FROM public.support_cases WHERE id = (v_request_review->>'support_case_id')::uuid), 'applied', 'approved review resolves the support case as applied');
  RETURN NEXT is((
    SELECT t.status
    FROM public.support_cases sc
    JOIN public.tasks t
      ON t.id = NULLIF(sc.metadata #>> ARRAY['review_task','task_id'], '')::uuid
    WHERE sc.id = (v_request_review->>'support_case_id')::uuid
  ), 'completed', 'review approval completes the linked reviewer task');
  RETURN NEXT ok(EXISTS(
    SELECT 1
    FROM public.support_cases sc
    JOIN public.task_events te
      ON te.task_id = NULLIF(sc.metadata #>> ARRAY['review_task','task_id'], '')::uuid
    WHERE sc.id = (v_request_review->>'support_case_id')::uuid
      AND te.event_type = 'status_changed'
      AND te.to_status = 'completed'
      AND te.actor_system = 'public_tracking_review_closeout_v1'
      AND te.payload->>'request_outcome' = 'applied'
      AND te.payload->>'support_case_id' = v_request_review->>'support_case_id'
  ), 'review approval writes task closeout event with applied lineage');
  RETURN NEXT ok(EXISTS(
    SELECT 1
    FROM public.support_case_events sce
    WHERE sce.support_case_id = (v_request_review->>'support_case_id')::uuid
      AND sce.event_type = 'applied'
      AND sce.payload->>'apply_outcome' = 'applied'
  ), 'review approval writes an applied support_case_event');
  RETURN NEXT ok(EXISTS(
    SELECT 1
    FROM public.outbound_calls oc
    WHERE oc.context->>'source' = 'public_tracking'
      AND oc.context->>'support_case_id' = v_request_review->>'support_case_id'
      AND oc.body->>'stage' = 'applied'
  ), 'review approval enqueues requester applied notification');

  SELECT public.public_tracking_review_request_v1(jsonb_build_object(
    'support_case_id', (v_request_review->>'support_case_id')::uuid,
    'decision', 'approved',
    'reason', 'Idempotent review readback'
  ))
  INTO v_review_result;

  RETURN NEXT ok(
    COALESCE((v_review_result->>'ok')::BOOLEAN, FALSE)
      AND COALESCE((v_review_result->>'already_processed')::BOOLEAN, FALSE)
      AND jsonb_typeof(v_review_result->'current_snapshot') = 'object'
      AND v_review_result->'current_snapshot' <> '{}'::jsonb,
    'already-processed review returns the matching canonical current snapshot'
  );

  SELECT public.public_tracking_submit_request_v2(jsonb_build_object(
    'session_token', v_review_session_token,
    'ip_hash', 'hash-request-review-reject',
    'request_type', 'location_change',
    'payload', jsonb_build_object(
      'address_text', 'Warehouse 18, west gate',
      'short_national_address', 'WARE5678',
      'map_pin', jsonb_build_object('lat', 24.79, 'lng', 46.75),
      'landmark', 'West lot checkpoint',
      'drop_point', 'Dispatch counter west gate',
      'notes', 'Reject this change in pgTAP'
    )
  ))
  INTO v_request_reject;

  RETURN NEXT is(v_request_reject->>'outcome', 'pending_review', 'second review-required request also stays pending review');

  SELECT public.public_tracking_review_request_v1(jsonb_build_object(
    'support_case_id', (v_request_reject->>'support_case_id')::uuid,
    'decision', 'rejected',
    'reason', 'Rejected in pgTAP'
  ))
  INTO v_reject_result;

  RETURN NEXT ok(COALESCE((v_reject_result->>'ok')::BOOLEAN, FALSE), 'review RPC rejects a pending shipment change');
  RETURN NEXT is(v_reject_result->>'outcome', 'rejected', 'review rejection returns rejected outcome');
  RETURN NEXT is((SELECT status_reason FROM public.support_cases WHERE id = (v_request_reject->>'support_case_id')::uuid), 'rejected', 'review rejection resolves the support case as rejected');
  RETURN NEXT is((
    SELECT t.status
    FROM public.support_cases sc
    JOIN public.tasks t
      ON t.id = NULLIF(sc.metadata #>> ARRAY['review_task','task_id'], '')::uuid
    WHERE sc.id = (v_request_reject->>'support_case_id')::uuid
  ), 'completed', 'review rejection completes the linked reviewer task');
  RETURN NEXT ok(EXISTS(
    SELECT 1
    FROM public.support_cases sc
    JOIN public.task_events te
      ON te.task_id = NULLIF(sc.metadata #>> ARRAY['review_task','task_id'], '')::uuid
    WHERE sc.id = (v_request_reject->>'support_case_id')::uuid
      AND te.event_type = 'status_changed'
      AND te.to_status = 'completed'
      AND te.actor_system = 'public_tracking_review_closeout_v1'
      AND te.payload->>'request_outcome' = 'rejected'
      AND te.payload->>'support_case_id' = v_request_reject->>'support_case_id'
  ), 'review rejection writes task closeout event with rejected lineage');
  RETURN NEXT ok(EXISTS(
    SELECT 1
    FROM public.support_case_events sce
    WHERE sce.support_case_id = (v_request_reject->>'support_case_id')::uuid
      AND sce.event_type = 'rejected'
  ), 'review rejection writes a rejected support_case_event');
  RETURN NEXT ok(EXISTS(
    SELECT 1
    FROM public.outbound_calls oc
    WHERE oc.context->>'source' = 'public_tracking'
      AND oc.context->>'support_case_id' = v_request_reject->>'support_case_id'
      AND oc.body->>'stage' = 'rejected'
  ), 'review rejection enqueues requester rejected notification');
END;
$$;

SELECT * FROM pg_temp.run_public_tracking_service_checks();
SELECT finish();
ROLLBACK;

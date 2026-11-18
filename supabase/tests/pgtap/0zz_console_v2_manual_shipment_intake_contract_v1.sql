-- pgTAP: Console V2 manual shipment intake backend contract.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(65);

SELECT has_function(
  'public',
  'ui_create_manual_shipment_intake_v1',
  ARRAY['jsonb'],
  'public.ui_create_manual_shipment_intake_v1(jsonb) exists'
);

SELECT has_function(
  'api',
  'ui_create_manual_shipment_intake_v1',
  ARRAY['jsonb'],
  'api.ui_create_manual_shipment_intake_v1(jsonb) exists'
);

SELECT has_function(
  'public',
  'label_jobs_fill_shipment_target_lineage_v1',
  ARRAY[]::text[],
  'shipment label job target-lineage guard exists'
);

SELECT function_privs_are(
  'public',
  'ui_create_manual_shipment_intake_v1',
  ARRAY['jsonb'],
  'anon',
  ARRAY[]::text[],
  'public manual shipment intake is not executable by anon'
);

SELECT function_privs_are(
  'public',
  'ui_create_manual_shipment_intake_v1',
  ARRAY['jsonb'],
  'authenticated',
  ARRAY['EXECUTE'],
  'public manual shipment intake is executable by authenticated'
);

SELECT function_privs_are(
  'api',
  'ui_create_manual_shipment_intake_v1',
  ARRAY['jsonb'],
  'anon',
  ARRAY[]::text[],
  'api manual shipment intake wrapper is not executable by anon'
);

SELECT function_privs_are(
  'api',
  'ui_create_manual_shipment_intake_v1',
  ARRAY['jsonb'],
  'authenticated',
  ARRAY['EXECUTE'],
  'api manual shipment intake wrapper is executable by authenticated'
);

SELECT matches(
  pg_get_functiondef('api.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure),
  'public\.ui_create_manual_shipment_intake_v1',
  'api wrapper delegates to public.ui_create_manual_shipment_intake_v1'
);

SELECT matches(
  pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure),
  'public\.ui_create_shipment_v1',
  'manual shipment intake creates shipments through ui_create_shipment_v1'
);

SELECT matches(
  pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure),
  'public\.recipient_create_v1',
  'manual shipment intake creates inline recipients through recipient_create_v1'
);

SELECT matches(
  pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure),
  'public\.shipment_amend_cancel_v1',
  'manual shipment intake applies address changes through shipment_amend_cancel_v1'
);

SELECT matches(
  pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure),
  'public\.request_label_generation',
  'manual shipment intake queues labels through request_label_generation'
);

SELECT matches(
  lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure)),
  'dry_run',
  'manual shipment intake includes a dry_run branch'
);

SELECT matches(
  lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure)),
  'normalize_phone_number',
  'manual shipment intake checks normalized phone for inline recipient duplicates'
);

SELECT matches(
  lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure)),
  'recipients\.write',
  'manual shipment intake dry-run path fail-closes inline recipient creation on recipients.write capability'
);

SELECT matches(
  lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure)),
  'recipient_id is not in the selected client scope',
  'manual shipment intake validates existing recipient against selected client scope'
);

SELECT ok(
  lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure)) LIKE '%recipient_id%'
  AND lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure)) LIKE '%new_recipient%'
  AND lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure)) LIKE '%exactly one%',
  'manual shipment intake enforces exactly one recipient mode'
);

SELECT ok(
  NOT (
    lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure)) ~ 'insert[[:space:]]+into[[:space:]]+(public\.)?shipments'
    OR lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure)) ~ 'update[[:space:]]+(public\.)?shipments'
    OR lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure)) ~ 'insert[[:space:]]+into[[:space:]]+(public\.)?label_jobs'
    OR lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure)) ~ 'insert[[:space:]]+into[[:space:]]+(public\.)?labels'
    OR lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure)) ~ 'insert[[:space:]]+into[[:space:]]+(public\.)?addresses'
    OR lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure)) ~ 'insert[[:space:]]+into[[:space:]]+(public\.)?basket_items'
  ),
  'manual shipment intake wrapper does not directly write shipment, label, address, or basket tables'
);

SELECT has_function(
  'public',
  'apply_shipment_planning_projection_v1',
  ARRAY[]::text[],
  'shipment planning projection trigger function exists'
);

SELECT has_trigger(
  'public',
  'shipments',
  'trg_shipments_planning_projection_v1',
  'shipments planning projection trigger exists'
);

CREATE OR REPLACE FUNCTION pg_temp.exercise_manual_shipment_intake_dry_run()
RETURNS SETOF text
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-000071930001';
  v_ops uuid := '00000000-0000-0000-0000-000071930002';
  v_client uuid := '00000000-0000-0000-0000-000071930003';
  v_sender uuid := '00000000-0000-0000-0000-000071930004';
  v_recipient_count_before integer;
  v_address_count_before integer;
  v_label_count_before integer;
  v_shipment_count_before integer;
  v_result jsonb;
BEGIN
  EXECUTE 'RESET ROLE';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Manual Intake Org', 'console-v2-manual-intake')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES (
    v_ops,
    v_org,
    'console-v2-manual-intake@example.test',
    'Console V2 Manual Intake',
    'ops_admin',
    'active',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         user_type = EXCLUDED.user_type,
         status = EXCLUDED.status,
         access_scope_type = EXCLUDED.access_scope_type,
         access_scope_id = EXCLUDED.access_scope_id;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Console V2 Manual Intake Client', 'console-v2-manual-intake-client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, status)
  VALUES (v_sender, v_client, 'Console V2 Manual Intake Sender', 'Console V2 Manual Intake Sender', 'active')
  ON CONFLICT (id) DO NOTHING;

  SELECT COUNT(*) INTO v_recipient_count_before FROM public.recipients;
  SELECT COUNT(*) INTO v_address_count_before FROM public.addresses;
  SELECT COUNT(*) INTO v_label_count_before FROM public.label_jobs;
  SELECT COUNT(*) INTO v_shipment_count_before FROM public.shipments;

  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_ops::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config(
    'request.jwt.claim',
    json_build_object('sub', v_ops::text, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_result := api.ui_create_manual_shipment_intake_v1(
    jsonb_build_object(
      'dry_run', true,
      'client_id', v_client::text,
      'sender_id', v_sender::text,
      'client_reference_number', 'MANUAL-INTAKE-DRY-001',
      'new_recipient', jsonb_build_object(
        'name', 'Manual Intake Dry Recipient',
        'phone_number', '+12025550196',
        'preferred_language', 'en'
      ),
      'destination_address', jsonb_build_object(
        'address_line1', 'Dry Run Street 1',
        'address_city', 'Riyadh',
        'address_country', 'SA'
      ),
      'label', jsonb_build_object(
        'label_type', 'shipping',
        'job_purpose', 'primary'
      )
    )
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(v_result->>'status', 'manual_shipment_intake_preview', 'dry-run returns manual shipment intake preview status');
  RETURN NEXT is(v_result->>'dry_run', 'true', 'dry-run reports dry_run true');
  RETURN NEXT ok(NULLIF(v_result->'shipment_preview'->>'workflow_template_id', '') IS NOT NULL, 'dry-run returns nested shipment workflow template evidence');
  RETURN NEXT ok(NULLIF(v_result->'shipment_preview'->>'correlation_id', '') IS NOT NULL, 'dry-run returns nested shipment correlation evidence');
  RETURN NEXT is(v_result->'shipment_preview'->>'tracking_will_be_reserved', 'true', 'dry-run reports backend tracking reservation intent');
  RETURN NEXT is((SELECT COUNT(*)::text FROM public.recipients), v_recipient_count_before::text, 'dry-run does not create recipients');
  RETURN NEXT is((SELECT COUNT(*)::text FROM public.addresses), v_address_count_before::text, 'dry-run does not create addresses');
  RETURN NEXT is((SELECT COUNT(*)::text FROM public.label_jobs), v_label_count_before::text, 'dry-run does not create label jobs');
  RETURN NEXT is((SELECT COUNT(*)::text FROM public.shipments), v_shipment_count_before::text, 'dry-run does not create shipments');
END;
$function$;

SELECT * FROM pg_temp.exercise_manual_shipment_intake_dry_run();

CREATE OR REPLACE FUNCTION pg_temp.exercise_manual_shipment_intake_create()
RETURNS SETOF text
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-000071930101';
  v_ops uuid := '00000000-0000-0000-0000-000071930102';
  v_client uuid := '00000000-0000-0000-0000-000071930103';
  v_sender uuid := '00000000-0000-0000-0000-000071930104';
  v_result jsonb;
  v_shipment_id uuid;
  v_recipient_id uuid;
  v_label_job_id uuid;
  v_destination_address_id uuid;
  v_service_level uuid;
  v_governed_service_level uuid;
  v_service_offering uuid;
  v_governed_service_offering uuid;
  v_service_level_key text := 'a2z_standard_service_level_20260615';
  v_branch uuid;
  v_zone uuid;
  v_candidate_count integer;
  v_duplicate_result jsonb;
  v_shipment_count_before_duplicate integer;
  v_recipient_count_before_duplicate integer;
  v_address_count_before_duplicate integer;
  v_label_count_before_duplicate integer;
BEGIN
  EXECUTE 'RESET ROLE';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Manual Intake Create Org', 'console-v2-manual-intake-create')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES (
    v_ops,
    v_org,
    'console-v2-manual-intake-create@example.test',
    'Console V2 Manual Intake Create',
    'ops_admin',
    'active',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         user_type = EXCLUDED.user_type,
         status = EXCLUDED.status,
         access_scope_type = EXCLUDED.access_scope_type,
         access_scope_id = EXCLUDED.access_scope_id;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Console V2 Manual Intake Create Client', 'console-v2-manual-intake-create-client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, status)
  VALUES (v_sender, v_client, 'Console V2 Manual Intake Create Sender', 'Console V2 Manual Intake Create Sender', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES (gen_random_uuid(), v_org, 'mi7130', 'Manual Intake Create Hub')
  RETURNING id INTO v_branch;

  INSERT INTO public.zones (id, organization_id, name, slug)
  VALUES (gen_random_uuid(), v_org, 'Manual Intake Create Zone', 'manual-intake-create-zone')
  RETURNING id INTO v_zone;

  INSERT INTO public.branch_zones (branch_id, zone_id, priority)
  VALUES (v_branch, v_zone, 10);

  INSERT INTO public.service_levels (id, organization_id, key, name, is_active)
  VALUES (gen_random_uuid(), v_org, v_service_level_key, 'A2Z Standard Service Level', TRUE)
  ON CONFLICT (organization_id, key) DO UPDATE
     SET is_active = TRUE,
         name = EXCLUDED.name
  RETURNING id INTO v_service_level;

  INSERT INTO public.service_levels (id, organization_id, key, name, is_active)
  VALUES (gen_random_uuid(), v_org, 'standard', 'Standard', TRUE)
  ON CONFLICT (organization_id, key) DO UPDATE
     SET is_active = TRUE,
         name = EXCLUDED.name
  RETURNING id INTO v_governed_service_level;

  INSERT INTO public.service_offerings (service_level_id, branch_id, zone_id, effective_from, is_active, priority)
  VALUES (v_service_level, v_branch, v_zone, '2026-01-01T00:00:00Z', TRUE, 10)
  RETURNING id INTO v_service_offering;

  INSERT INTO public.service_offerings (service_level_id, branch_id, zone_id, effective_from, is_active, priority)
  VALUES (v_governed_service_level, v_branch, v_zone, '2026-01-01T00:00:00Z', TRUE, 20)
  RETURNING id INTO v_governed_service_offering;

  INSERT INTO public.branch_capacity_windows (
    branch_id,
    zone_id,
    service_level_id,
    effective_from,
    capacity,
    is_active,
    priority
  )
  VALUES (
    v_branch,
    v_zone,
    v_service_level,
    '2026-01-01T00:00:00Z',
    jsonb_build_object('max_stops', 50),
    TRUE,
    10
  );

  PERFORM public.upsert_settings_value_v1(
    'shipment_operation_policy',
    'tenant',
    v_org,
    jsonb_build_object(
      'version', 1,
      'address', jsonb_build_object(
        'allowed_statuses', jsonb_build_array('pending'),
        'workflow_template_name', 'shipment_update_address_v1',
        'default_country_code', 'SA',
        're_geocode', FALSE
      )
    ),
    1,
    'console v2 manual intake create address policy'
  );

  PERFORM public.upsert_settings_value_v1(
    'label_design',
    'tenant',
    v_org,
    jsonb_build_object(
      'templates',
      jsonb_build_object(
        'default',
        jsonb_build_object(
          'template_key', 'manual_intake_default',
          'version', '1.0.0',
          'page', jsonb_build_object('width_inch', 4, 'height_inch', 6, 'dpi', 203, 'orientation', 'portrait'),
          'blocks', '[]'::jsonb,
          'assets', '[]'::jsonb,
          'max_attempts', 3,
          'retry_backoff_seconds', jsonb_build_array(30, 60)
        ),
        'shipping',
        jsonb_build_object(
          'template_key', 'manual_intake_shipping',
          'version', '1.0.0',
          'page', jsonb_build_object('width_inch', 4, 'height_inch', 6, 'dpi', 203, 'orientation', 'portrait'),
          'blocks', '[]'::jsonb,
          'assets', '[]'::jsonb,
          'max_attempts', 3,
          'retry_backoff_seconds', jsonb_build_array(30, 60)
        )
      )
    ),
    2,
    'console v2 manual intake create label design'
  );

  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', v_ops::text,
      'role', 'authenticated',
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  PERFORM set_config(
    'request.jwt.claim',
    jsonb_build_object('sub', v_ops::text, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_result := api.ui_create_manual_shipment_intake_v1(
    jsonb_build_object(
      'client_id', v_client::text,
      'sender_id', v_sender::text,
      'client_reference_number', 'MANUALINTAKECREATE001',
      'tracking_number', 'MANUALINTAKECREATE001',
      'service_offering_id', (
        SELECT v_governed_service_offering::text
      ),
      'metadata', jsonb_build_object(
        'service_offering_id', (
          SELECT v_governed_service_offering::text
        ),
        'promised_delivery_date', '2026-05-07',
        'priority_score', 95
      ),
      'new_recipient', jsonb_build_object(
        'name', 'Manual Intake Create Recipient',
        'phone_number', '+12025550197',
        'preferred_language', 'en'
      ),
      'destination_address', jsonb_build_object(
        'line1', 'Manual Intake Create Street 1',
        'district', 'Al Olaya',
        'city', 'Riyadh',
        'province', 'Riyadh',
        'country', 'SA',
        'postal_code', '12345',
        'sa_short_code', 'rnqa7083',
        'latitude', 24.7137,
        'longitude', 46.6754,
        'coordinates', jsonb_build_object('latitude', 24.7137, 'longitude', 46.6754)
      ),
      'label', jsonb_build_object(
        'label_type', 'shipping',
        'job_purpose', 'primary'
      ),
      'idempotency_key', 'manual-intake-create-address-719301'
    )
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  v_shipment_id := NULLIF(v_result->>'shipment_id', '')::uuid;
  v_recipient_id := NULLIF(v_result->>'recipient_id', '')::uuid;
  v_label_job_id := NULLIF(v_result->>'label_job_id', '')::uuid;

  UPDATE public.shipments
     SET service_level = 'standard',
         metadata = jsonb_strip_nulls(
           COALESCE(metadata, '{}'::jsonb)
           || jsonb_build_object(
             'service_offering_id', v_service_offering,
             'service_level_id', v_service_level,
             'service_level_key', v_service_level_key,
             'service_offering_branch_id', v_branch,
             'service_offering_zone_id', v_zone
           )
         )
   WHERE id = v_shipment_id
     AND client_id = v_client;

  SELECT destination_address_id
    INTO v_destination_address_id
    FROM public.shipments
     WHERE id = v_shipment_id
     AND client_id = v_client;

  RETURN NEXT is(v_result->>'status', 'manual_shipment_intake_created', 'manual intake actual create reports created status');
  RETURN NEXT ok(NULLIF(v_result->'shipment_result'->>'workflow_run_id', '') IS NOT NULL, 'manual intake actual create returns nested workflow run evidence');
  RETURN NEXT ok(NULLIF(v_result->'shipment_result'->>'correlation_id', '') IS NOT NULL, 'manual intake actual create returns nested correlation evidence');
  RETURN NEXT is(v_result->'shipment_result'->>'tracking_number', 'MANUALINTAKECREATE001', 'manual intake actual create returns nested tracking evidence');
  RETURN NEXT ok(v_recipient_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.recipients
     WHERE id = v_recipient_id
       AND client_id = v_client
       AND phone_number_normalized = public.normalize_phone_number('+12025550197')
  ), 'manual intake actual create persists inline recipient');
  RETURN NEXT ok(v_shipment_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.shipments
     WHERE id = v_shipment_id
       AND client_id = v_client
       AND recipient_id = v_recipient_id
       AND tracking_number = 'MANUALINTAKECREATE001'
       AND metadata->>'source' = 'ui.manual_create'
  ), 'manual intake actual create persists shipment with recipient link');
  RETURN NEXT is((
    SELECT promised_delivery_date::text
      FROM public.shipments
     WHERE id = v_shipment_id
  ), '2026-05-07', 'manual intake actual create persists promised delivery date for planning');
  RETURN NEXT is((
    SELECT metadata->>'service_offering_branch_id'
      FROM public.shipments
     WHERE id = v_shipment_id
  ), v_branch::text, 'manual intake actual create persists service-offering branch lineage');
  RETURN NEXT is((
    SELECT metadata->>'service_offering_zone_id'
      FROM public.shipments
     WHERE id = v_shipment_id
  ), v_zone::text, 'manual intake actual create persists service-offering zone lineage');
  RETURN NEXT is((
    SELECT metadata->>'service_level_key'
      FROM public.shipments
     WHERE id = v_shipment_id
  ), 'standard', 'manual intake actual create persists governed service-level lineage written by create RPC');
  RETURN NEXT is((
    SELECT branch_id::text
      FROM public.shipments
     WHERE id = v_shipment_id
  ), v_branch::text, 'manual intake actual create projects service-offering branch onto shipment row');
  RETURN NEXT is((
    SELECT zone_id::text
      FROM public.shipments
     WHERE id = v_shipment_id
  ), v_zone::text, 'manual intake actual create projects service-offering zone onto shipment row');
  RETURN NEXT is((
    SELECT service_level
      FROM public.shipments
     WHERE id = v_shipment_id
  ), 'standard', 'manual intake actual create keeps governed service-level tier on shipment row');
  RETURN NEXT ok(EXISTS (
    SELECT 1
      FROM public.list_delivery_slots_v1(
        jsonb_build_object(
          'shipment_id', v_shipment_id,
          'client_id', v_client,
          'start_date', '2026-05-07',
          'days', 1,
          'include_unavailable', false
        )
      ) slots
  ), 'manual intake actual create exposes delivery slots without metadata-only fallback');

  -- Route-candidate fixture: A2Z keeps the shipment row on governed tier
  -- "standard" while tenant Product/Catalog lineage remains in metadata.
  UPDATE public.shipments
     SET service_level = 'standard',
         metadata = jsonb_strip_nulls(
           COALESCE(metadata, '{}'::jsonb)
           || jsonb_build_object(
             'service_offering_id', v_service_offering,
             'service_level_id', v_service_level,
             'service_level_key', v_service_level_key,
             'service_offering_branch_id', v_branch,
             'service_offering_zone_id', v_zone
           )
         )
   WHERE id = v_shipment_id
     AND client_id = v_client;

  SELECT COUNT(*)::int
    INTO v_candidate_count
    FROM public.route_plan_delivery_wave_candidates_v1(
      jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'planned_date', '2026-05-07'
      )
    ) c
   WHERE c.shipment_id = v_shipment_id;

  RETURN NEXT is(v_candidate_count, 1, 'route-candidate fixture resolves tenant service-level lineage with governed shipment tier');
  RETURN NEXT ok(v_destination_address_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.addresses
     WHERE id = v_destination_address_id
       AND client_id = v_client
       AND normalized_line1 = 'Manual Intake Create Street 1'
  ), 'manual intake actual create persists destination address through address amendment');
  RETURN NEXT is((
    SELECT sa_short_code
      FROM public.addresses
     WHERE id = v_destination_address_id
       AND client_id = v_client
  ), 'RNQA7083', 'manual intake actual create projects Saudi short national address onto addresses.sa_short_code');
  RETURN NEXT ok((
    SELECT coordinates IS NOT NULL
      FROM public.addresses
     WHERE id = v_destination_address_id
       AND client_id = v_client
  ), 'manual intake actual create persists provided coordinates onto addresses.coordinates');
  RETURN NEXT ok((
    SELECT abs(ST_Y(coordinates::geometry) - 24.7137) < 0.000001
       AND abs(ST_X(coordinates::geometry) - 46.6754) < 0.000001
      FROM public.addresses
     WHERE id = v_destination_address_id
       AND client_id = v_client
  ), 'manual intake actual create stores provided coordinates as the canonical PostGIS point');
  RETURN NEXT ok(v_label_job_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.label_jobs
     WHERE id = v_label_job_id
       AND shipment_id = v_shipment_id
       AND client_id = v_client
       AND label_type = 'shipping'
       AND job_purpose = 'primary'
       AND status = 'pending'
       AND requested_source = 'console_v2.manual_shipment_intake'
  ), 'manual intake actual create queues pending primary shipping label job');
  RETURN NEXT ok(v_label_job_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.label_jobs
     WHERE id = v_label_job_id
       AND shipment_id = v_shipment_id
       AND target_type = 'shipment'
       AND target_id = v_shipment_id
       AND target_metadata->>'shipment_id' = v_shipment_id::text
  ), 'manual intake actual create label job carries shipment target lineage');
  RETURN NEXT ok(EXISTS (
    SELECT 1
      FROM public.shipment_actions
     WHERE shipment_id = v_shipment_id
       AND action_type = 'address_update'
       AND action_data->>'idempotency_key' = 'manual-intake-create-address-719301'
  ), 'manual intake actual create records address amendment lineage');
  RETURN NEXT ok(v_result->'address_result'->>'workflow_status' = 'completed', 'manual intake address amendment completes before label queueing');

  SELECT COUNT(*) INTO v_shipment_count_before_duplicate FROM public.shipments;
  SELECT COUNT(*) INTO v_recipient_count_before_duplicate FROM public.recipients;
  SELECT COUNT(*) INTO v_address_count_before_duplicate FROM public.addresses;
  SELECT COUNT(*) INTO v_label_count_before_duplicate FROM public.label_jobs;

  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', v_ops::text,
      'role', 'authenticated',
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  PERFORM set_config(
    'request.jwt.claim',
    jsonb_build_object('sub', v_ops::text, 'role', 'authenticated')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_duplicate_result := api.ui_create_manual_shipment_intake_v1(
    jsonb_build_object(
      'client_id', v_client::text,
      'sender_id', v_sender::text,
      'client_reference_number', 'MANUALINTAKECREATE001',
      'recipient_id', v_recipient_id::text,
      'destination_address', jsonb_build_object(
        'line1', 'Manual Intake Duplicate Replay Street',
        'district', 'Al Olaya',
        'city', 'Riyadh',
        'province', 'Riyadh',
        'country', 'SA'
      ),
      'label', jsonb_build_object(
        'label_type', 'shipping',
        'job_purpose', 'primary'
      ),
      'idempotency_key', 'manual-intake-duplicate-address-719301'
    )
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(v_duplicate_result->>'status', 'manual_shipment_intake_reused', 'manual intake duplicate client reference returns reuse status');
  RETURN NEXT is(v_duplicate_result->>'operation', 'reused_client_reference', 'manual intake duplicate client reference reports reuse operation');
  RETURN NEXT is(v_duplicate_result->>'shipment_id', v_shipment_id::text, 'manual intake duplicate client reference returns the existing shipment id');
  RETURN NEXT is(v_duplicate_result->>'tracking_number', 'MANUALINTAKECREATE001', 'manual intake duplicate client reference returns existing tracking number');
  RETURN NEXT is(v_duplicate_result->>'duplicate_reused', 'true', 'manual intake duplicate client reference flags duplicate reuse');
  RETURN NEXT is(v_duplicate_result->'address_result'->>'skipped', 'true', 'manual intake duplicate client reference skips address amendment');
  RETURN NEXT is(v_duplicate_result->'label_result'->>'skipped', 'true', 'manual intake duplicate client reference skips label queueing');
  RETURN NEXT ok(EXISTS (
    SELECT 1
      FROM public.decision_log dl
     WHERE dl.id = NULLIF(v_duplicate_result->>'decision_log_id', '')::uuid
       AND dl.resource_id = v_shipment_id
       AND dl.decision_point = 'manual_shipment_duplicate_reference'
       AND dl.decision_outcome = 'reused_client_reference'
  ), 'manual intake duplicate client reference records decision log lineage');
  RETURN NEXT is((SELECT COUNT(*)::text FROM public.shipments), v_shipment_count_before_duplicate::text, 'manual intake duplicate client reference creates no extra shipment');
  RETURN NEXT is((SELECT COUNT(*)::text FROM public.recipients), v_recipient_count_before_duplicate::text, 'manual intake duplicate client reference creates no extra recipient');
  RETURN NEXT is((SELECT COUNT(*)::text FROM public.addresses), v_address_count_before_duplicate::text, 'manual intake duplicate client reference creates no extra address');
  RETURN NEXT is((SELECT COUNT(*)::text FROM public.label_jobs), v_label_count_before_duplicate::text, 'manual intake duplicate client reference creates no extra label job');
  RETURN NEXT is((
    SELECT destination_address_id::text
      FROM public.shipments
     WHERE id = v_shipment_id
  ), v_destination_address_id::text, 'manual intake duplicate client reference keeps original destination address');
END;
$function$;

SELECT * FROM pg_temp.exercise_manual_shipment_intake_create();

SELECT * FROM finish();
ROLLBACK;

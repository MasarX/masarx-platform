-- pgTAP: Console V2 pickup failure retry configuration.
-- The Failures tab retries through create_pickup_wave_v1, so failed pickup
-- rows require a row-driven reason taxonomy and pickup policy retry allowance.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions
    WHERE category = 'pickup_failure_reason'
      AND owner_role = 'operations'
      AND approval_policy = 'tier_1'
      AND is_mutable = false
  ),
  'pickup_failure_reason lookup definition exists with operations ownership'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_failure_reason'
      AND lv.value IN (
        'sender_not_ready',
        'sender_unavailable',
        'pickup_not_ready',
        'business_closed',
        'no_answer',
        'phone_unreachable',
        'address_invalid',
        'address_not_found',
        'driver_unavailable',
        'vehicle_unavailable',
        'access_restricted',
        'quantity_mismatch',
        'other'
      )
      AND lv.status = 'active'
  ),
  13,
  'pickup_failure_reason has active retry and exception taxonomy values'
);

SELECT is(
  (
    SELECT lv.metadata ->> 'retryable'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_failure_reason'
      AND lv.value = 'no_answer'
  ),
  'true',
  'retryable pickup failures expose retryable metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(s.cached_value #> '{wave,allowed_shipment_statuses}', '[]'::jsonb)) status(value)
    WHERE s.category = 'pickup_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND status.value = 'pickup_failed'
  ),
  'pickup_policy allows retry wave creation for pickup_failed shipments'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
      FROM public.settings s
     WHERE s.category = 'pickup_policy'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(COALESCE(s.cached_value #> '{wave,allowed_shipment_statuses}', '[]'::jsonb)) status(value)
          WHERE status.value = 'pickup_failed'
       )
  ),
  0,
  'every effective pickup_policy scope allows retry from pickup_failed shipments'
);

SELECT ok(
  (public.pickup_policy_default_v1() #> '{wave,allowed_shipment_statuses}') @> jsonb_build_array('pickup_failed'),
  'pickup_policy_default_v1 includes pickup_failed retry wave status'
);

SELECT has_function(
  'public',
  'create_pickup_wave_base_v1',
  ARRAY['jsonb'],
  'public.create_pickup_wave_base_v1 keeps the canonical base implementation behind the retryable wrapper'
);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_pickup_failure_retry_enforcement_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_route_runs_before INT := 0;
  v_route_stops_before INT := 0;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Pickup Failure Retry Guard Org', 'pickup-retry-guard-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Pickup Failure Retry Guard Client', 'pickup-retry-guard-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Pickup Failure Retry Guard Sender', 'Pickup Failure Retry Guard Sender', TRUE, 'active');

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    status,
    box_count
  )
  VALUES (
    v_shipment,
    v_org,
    v_client,
    v_sender,
    'pickup',
    'PFR-GUARD-' || upper(left(v_shipment::text, 8)),
    'pickup_failed',
    1
  );

  INSERT INTO public.shipment_actions (
    organization_id,
    client_id,
    shipment_id,
    action_type,
    action_category,
    canonical_status,
    action_data,
    notes,
    timestamp,
    performed_by_system
  )
  VALUES (
    v_org,
    v_client,
    v_shipment,
    'pickup_attempt_failed',
    'exception',
    'pickup_failed',
    jsonb_build_object('status_reason', 'address_invalid', 'task_event_payload', jsonb_build_object('status_reason', 'address_invalid')),
    'pgtap non-retryable pickup failure guard',
    now(),
    'pgtap'
  );

  SELECT COUNT(*)::INT INTO v_route_runs_before FROM public.route_runs WHERE organization_id = v_org;
  SELECT COUNT(*)::INT INTO v_route_stops_before FROM public.route_stops WHERE organization_id = v_org;

  RETURN NEXT throws_ok(
    format(
      $q$ SELECT public.create_pickup_wave_v1(jsonb_build_object('organization_id', %L::uuid, 'shipment_ids', jsonb_build_array(%L::uuid), 'idempotency_key', 'pgtap-non-retryable-pickup-failure')) $q$,
      v_org::text,
      v_shipment::text
    ),
    '23514',
    NULL,
    'pickup_failed shipments with non-retryable failure reasons cannot be retried into a pickup wave'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.route_runs WHERE organization_id = v_org),
    v_route_runs_before,
    'non-retryable pickup retry writes no route_runs'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.route_stops WHERE organization_id = v_org),
    v_route_stops_before,
    'non-retryable pickup retry writes no route_stops'
  );
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_pickup_failure_retry_enforcement_v1();

SELECT * FROM finish();
ROLLBACK;

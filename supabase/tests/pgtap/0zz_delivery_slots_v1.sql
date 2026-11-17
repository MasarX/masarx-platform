-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S95
-- pgTAP: Delivery slots (list + reserve) + shipment promise apply helper

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(21);

SELECT has_function(
  'public',
  'apply_shipment_promise_v1',
  ARRAY[
    'uuid','uuid','uuid','date','timestamptz','timestamptz','timestamptz','timestamptz','uuid','text','text','text','jsonb','text'
  ],
  'apply_shipment_promise_v1(...) exists'
);

SELECT has_function(
  'public',
  'compute_delivery_slot_v1',
  ARRAY['jsonb'],
  'compute_delivery_slot_v1(jsonb) exists'
);

SELECT has_function(
  'public',
  'list_delivery_slots_v1',
  ARRAY['jsonb'],
  'list_delivery_slots_v1(jsonb) exists'
);

SELECT has_function(
  'public',
  'reserve_delivery_slot_v1',
  ARRAY['jsonb'],
  'reserve_delivery_slot_v1(jsonb) exists'
);

SELECT ok(
  has_function_privilege('service_role', 'public.list_delivery_slots_v1(jsonb)', 'EXECUTE'),
  'service_role can EXECUTE list_delivery_slots_v1'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.list_delivery_slots_v1(jsonb)', 'EXECUTE'),
  'authenticated cannot EXECUTE list_delivery_slots_v1'
);

SELECT ok(
  has_function_privilege('service_role', 'public.reserve_delivery_slot_v1(jsonb)', 'EXECUTE'),
  'service_role can EXECUTE reserve_delivery_slot_v1'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.reserve_delivery_slot_v1(jsonb)', 'EXECUTE'),
  'authenticated cannot EXECUTE reserve_delivery_slot_v1'
);

SELECT ok(
  has_function_privilege('service_role', 'public.compute_delivery_slot_v1(jsonb)', 'EXECUTE'),
  'service_role can EXECUTE compute_delivery_slot_v1'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.compute_delivery_slot_v1(jsonb)', 'EXECUTE'),
  'authenticated cannot EXECUTE compute_delivery_slot_v1'
);

CREATE TEMP TABLE tmp_delivery_slots_v1_results (
  case_key TEXT PRIMARY KEY,
  list_is_available BOOLEAN,
  list_reason TEXT,
  reserve_json JSONB,
  action_count INT,
  promised_delivery_date DATE
) ON COMMIT DROP;

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_zone UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_window UUID := gen_random_uuid();

  v_shipment_existing UUID := gen_random_uuid();
  v_shipment_target UUID := gen_random_uuid();

  v_policy_ver UUID;
  v_policy JSONB;

  v_list RECORD;
  v_reserved JSONB;
  v_reserved_again JSONB;
  v_actions INT;
  v_promised_date DATE;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Slots Org', 'slots-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Slots Client', 'slots-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Slots Sender', 'Slots Sender', TRUE, 'active');

  INSERT INTO public.zones (id, organization_id, name, slug, is_active)
  VALUES (v_zone, v_org, 'Slots Zone', 'slots-zone-' || left(v_zone::text, 8), TRUE);

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'slots-branch-' || left(v_branch::text, 8), 'Slots Branch', 'UTC', TRUE);

  INSERT INTO public.branch_zones (branch_id, zone_id)
  VALUES (v_branch, v_zone);

  -- Sender promise policy enables calendar + capacity.
  v_policy := jsonb_build_object(
    'version', 3,
    'enabled', true,
    'timezone', 'UTC',
    'use_branch_timezone', true,
    'cutoff_time', '16:00',
    'default_service_level', 'standard',
    'default_transit_days', 1,
    'service_level_transit_days', jsonb_build_object('standard', 1),
    'delivery_window_start', '09:00',
    'delivery_window_end', '18:00',
    'calendar_enabled', true,
    'calendar_blackout_event_types', jsonb_build_array('holiday'),
    'calendar_max_shift_days', 7,
    'capacity_enabled', true,
    'capacity_behavior', 'shift',
    'capacity_usage_mode', 'shipments_by_promised_date',
    'capacity_limit_key', 'max_shipments',
    'capacity_demand', 1,
    'capacity_max_shift_days', 7
  );

  SELECT up.settings_version_id
    INTO v_policy_ver
    FROM public.upsert_settings_value_v1(
      p_category := 'shipment_promise_policy',
      p_scope_type := 'sender',
      p_scope_id := v_sender,
      p_value := v_policy,
      p_schema_version := 3,
      p_change_reason := 'pgtap delivery_slots_v1'
    ) AS up
   LIMIT 1;

  -- Capacity window: one slot/day, max 1 shipment.
  INSERT INTO public.branch_capacity_windows (
    id,
    branch_id,
    zone_id,
    effective_from,
    effective_to,
    window_start_local,
    window_end_local,
    capacity,
    is_active,
    metadata
  )
  VALUES (
    v_window,
    v_branch,
    v_zone,
    '2026-01-01T00:00:00Z'::timestamptz,
    NULL,
    '09:00'::time,
    '12:00'::time,
    jsonb_build_object('max_shipments', 1),
    TRUE,
    jsonb_build_object('pgtap', TRUE)
  );

  -- Blackout on 2026-02-04.
  INSERT INTO public.calendar_events (
    organization_id,
    branch_id,
    event_type,
    starts_at,
    ends_at,
    timezone,
    reason,
    is_active,
    metadata
  )
  VALUES (
    v_org,
    v_branch,
    'holiday',
    '2026-02-04T00:00:00Z'::timestamptz,
    '2026-02-05T00:00:00Z'::timestamptz,
    'UTC',
    'pgtap blackout',
    TRUE,
    jsonb_build_object('pgtap', TRUE)
  );

  -- Existing shipment consumes capacity for 2026-02-01 slot.
  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    status,
    zone_id,
    service_level,
    branch_id,
    promised_delivery_date,
    promised_window_start_at,
    promised_window_end_at,
    promised_delivery_at,
    created_at,
    updated_at
  )
  VALUES (
    v_shipment_existing,
    v_org,
    v_client,
    v_sender,
    'delivery',
    'pgtap-slots-exist-' || left(v_shipment_existing::text, 8),
    'created',
    v_zone,
    'standard',
    v_branch,
    '2026-02-01'::date,
    '2026-02-01T09:00:00Z'::timestamptz,
    '2026-02-01T12:00:00Z'::timestamptz,
    '2026-02-01T12:00:00Z'::timestamptz,
    now(),
    now()
  )
  ON CONFLICT (id, client_id) DO NOTHING;

  -- Target shipment to reserve (no branch_id pre-projection; derived from zone_id).
  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    status,
    zone_id,
    service_level,
    created_at,
    updated_at
  )
  VALUES (
    v_shipment_target,
    v_org,
    v_client,
    v_sender,
    'delivery',
    'pgtap-slots-target-' || left(v_shipment_target::text, 8),
    'created',
    v_zone,
    'standard',
    now(),
    now()
  )
  ON CONFLICT (id, client_id) DO NOTHING;

  -- List: capacity exceeded (2026-02-01).
  SELECT r.is_available, r.reason
    INTO v_list
    FROM public.list_delivery_slots_v1(jsonb_build_object(
      'shipment_id', v_shipment_target,
      'client_id', v_client,
      'start_date', '2026-02-01'::date,
      'days', 1,
      'include_unavailable', true
    )) r
   LIMIT 1;

  INSERT INTO tmp_delivery_slots_v1_results (case_key, list_is_available, list_reason)
  VALUES ('list_capacity_full', v_list.is_available, v_list.reason);

  -- Reserve attempt should be rejected (capacity exceeded).
  v_reserved := public.reserve_delivery_slot_v1(jsonb_build_object(
    'shipment_id', v_shipment_target,
    'client_id', v_client,
    'slot_date', '2026-02-01'::date,
    'window_start_local', '09:00',
    'window_end_local', '12:00',
    'performed_by_system', 'pgtap'
  ));

  INSERT INTO tmp_delivery_slots_v1_results (case_key, reserve_json)
  VALUES ('reserve_capacity_full', v_reserved);

  -- Reserve should succeed on 2026-02-03.
  v_reserved := public.reserve_delivery_slot_v1(jsonb_build_object(
    'shipment_id', v_shipment_target,
    'client_id', v_client,
    'slot_date', '2026-02-03'::date,
    'window_start_local', '09:00',
    'window_end_local', '12:00',
    'performed_by_system', 'pgtap'
  ));

  SELECT s.promised_delivery_date
    INTO v_promised_date
    FROM public.shipments s
   WHERE s.id = v_shipment_target
     AND s.client_id = v_client
   LIMIT 1;

  SELECT COUNT(*)::INT
    INTO v_actions
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_shipment_target
     AND sa.action_type = 'delivery_slot_reserved';

  INSERT INTO tmp_delivery_slots_v1_results (case_key, reserve_json, action_count, promised_delivery_date)
  VALUES ('reserve_ok', v_reserved, v_actions, v_promised_date);

  -- Repeating reservation to same slot should be idempotent (no new action).
  v_reserved_again := public.reserve_delivery_slot_v1(jsonb_build_object(
    'shipment_id', v_shipment_target,
    'client_id', v_client,
    'slot_date', '2026-02-03'::date,
    'window_start_local', '09:00',
    'window_end_local', '12:00',
    'performed_by_system', 'pgtap'
  ));

  SELECT COUNT(*)::INT
    INTO v_actions
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_shipment_target
     AND sa.action_type = 'delivery_slot_reserved';

  INSERT INTO tmp_delivery_slots_v1_results (case_key, reserve_json, action_count)
  VALUES ('reserve_ok_repeat', v_reserved_again, v_actions);

  -- List: blackout day should be unavailable.
  SELECT r.is_available, r.reason
    INTO v_list
    FROM public.list_delivery_slots_v1(jsonb_build_object(
      'shipment_id', v_shipment_target,
      'client_id', v_client,
      'start_date', '2026-02-04'::date,
      'days', 1,
      'include_unavailable', true
    )) r
   LIMIT 1;

  INSERT INTO tmp_delivery_slots_v1_results (case_key, list_is_available, list_reason)
  VALUES ('list_blackout', v_list.is_available, v_list.reason);
END $$;

SELECT is(
  (SELECT list_reason FROM tmp_delivery_slots_v1_results WHERE case_key = 'list_capacity_full'),
  'capacity_exceeded',
  'List marks slot unavailable when capacity is exceeded'
);

SELECT is(
  (SELECT list_is_available::text FROM tmp_delivery_slots_v1_results WHERE case_key = 'list_capacity_full'),
  'false',
  'List returns is_available=false when capacity is exceeded'
);

SELECT is(
  (SELECT reserve_json->>'reserved' FROM tmp_delivery_slots_v1_results WHERE case_key = 'reserve_capacity_full'),
  'false',
  'Reserve rejects slot when capacity is exceeded'
);

SELECT is(
  (SELECT reserve_json->>'reason' FROM tmp_delivery_slots_v1_results WHERE case_key = 'reserve_capacity_full'),
  'capacity_exceeded',
  'Reserve returns reason=capacity_exceeded'
);

SELECT is(
  (SELECT reserve_json->>'reserved' FROM tmp_delivery_slots_v1_results WHERE case_key = 'reserve_ok'),
  'true',
  'Reserve succeeds when capacity is available'
);

SELECT is(
  (SELECT reserve_json->>'updated' FROM tmp_delivery_slots_v1_results WHERE case_key = 'reserve_ok'),
  'true',
  'Reserve updates shipment on first reservation'
);

SELECT is(
  (SELECT promised_delivery_date::text FROM tmp_delivery_slots_v1_results WHERE case_key = 'reserve_ok'),
  '2026-02-03',
  'Reserve persists promised_delivery_date on shipment'
);

SELECT is(
  (SELECT action_count::text FROM tmp_delivery_slots_v1_results WHERE case_key = 'reserve_ok'),
  '1',
  'Reserve emits delivery_slot_reserved exactly once'
);

SELECT is(
  (SELECT reserve_json->>'updated' FROM tmp_delivery_slots_v1_results WHERE case_key = 'reserve_ok_repeat'),
  'false',
  'Repeat reserve is idempotent (updated=false)'
);

SELECT is(
  (SELECT action_count::text FROM tmp_delivery_slots_v1_results WHERE case_key = 'reserve_ok_repeat'),
  '1',
  'Repeat reserve does not emit a second delivery_slot_reserved action'
);

SELECT is(
  (SELECT list_reason FROM tmp_delivery_slots_v1_results WHERE case_key = 'list_blackout'),
  'blackout',
  'List marks slot unavailable when calendar blackout overlaps'
);

SELECT finish();
ROLLBACK;

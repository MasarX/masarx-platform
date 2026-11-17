-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S95
-- pgTAP: shipment_promise_policy capacity shifting (compute_shipment_promise_v2)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

CREATE TEMP TABLE tmp_sla_promise_capacity_windows_v1 (
  window_id UUID,
  promised_delivery_date DATE,
  debug JSONB
) ON COMMIT DROP;

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_zone UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_window UUID := gen_random_uuid();
  v_existing_shipment UUID := gen_random_uuid();

  v_policy JSONB;
  v_res RECORD;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Promise Capacity Org', 'pcap-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Promise Capacity Client', 'pcap-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Promise Capacity Sender', 'Promise Capacity Sender', TRUE, 'active');

  INSERT INTO public.zones (id, organization_id, name, slug, is_active)
  VALUES (v_zone, v_org, 'PCAP Zone', 'pcap-zone-' || left(v_zone::text, 8), TRUE);

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'pcap-branch-' || left(v_branch::text, 8), 'PCAP Branch', 'UTC', TRUE);

  INSERT INTO public.branch_zones (branch_id, zone_id)
  VALUES (v_branch, v_zone);

  -- Capacity window allows only 1 shipment/day (baseline promise is 2026-01-22).
  INSERT INTO public.branch_capacity_windows (
    id,
    branch_id,
    zone_id,
    effective_from,
    effective_to,
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
    jsonb_build_object('max_shipments', 1),
    TRUE,
    jsonb_build_object('pgtap', TRUE)
  );

  -- Existing promised shipment consumes the full capacity for 2026-01-22.
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
    created_at,
    updated_at
  )
  VALUES (
    v_existing_shipment,
    v_org,
    v_client,
    v_sender,
    'delivery',
    'pgtap-pcap-' || left(v_existing_shipment::text, 8),
    'created',
    v_zone,
    'standard',
    v_branch,
    '2026-01-22'::date,
    now(),
    now()
  )
  ON CONFLICT (id, client_id) DO NOTHING;

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
    'calendar_enabled', false,
    'capacity_enabled', true,
    'capacity_behavior', 'shift',
    'capacity_usage_mode', 'shipments_by_promised_date',
    'capacity_limit_key', 'max_shipments',
    'capacity_demand', 1,
    'capacity_max_shift_days', 7
  );

  SELECT *
    INTO v_res
    FROM public.compute_shipment_promise_v2(
      p_now := '2026-01-21T10:00:00Z'::timestamptz,
      p_timezone := 'UTC',
      p_context := jsonb_build_object(
        'organization_id', v_org,
        'branch_id', v_branch,
        'zone_id', v_zone,
        'service_type', 'delivery',
        'service_level', 'standard'
      ),
      p_policy := v_policy
    )
   LIMIT 1;

  INSERT INTO tmp_sla_promise_capacity_windows_v1 (window_id, promised_delivery_date, debug)
  VALUES (v_window, v_res.promised_delivery_date, v_res.debug);
END $$;

SELECT is(
  (SELECT promised_delivery_date::text FROM tmp_sla_promise_capacity_windows_v1),
  '2026-01-23',
  'Promise date shifts by 1 day when branch capacity is exceeded'
);

SELECT is(
  (SELECT debug->>'capacity_shift_days' FROM tmp_sla_promise_capacity_windows_v1),
  '1',
  'Debug includes capacity_shift_days=1'
);

SELECT ok(
  (
    SELECT (debug->'capacity_window_ids') @> to_jsonb(ARRAY[window_id::text])
    FROM tmp_sla_promise_capacity_windows_v1
  ),
  'Debug includes capacity_window_ids containing the matching window id'
);

SELECT is(
  (SELECT debug->>'capacity_limit' FROM tmp_sla_promise_capacity_windows_v1),
  '1',
  'Debug includes capacity_limit'
);

SELECT is(
  (SELECT debug->>'capacity_exceeded' FROM tmp_sla_promise_capacity_windows_v1),
  'true',
  'Debug includes capacity_exceeded=true when shifting occurred'
);

-- When capacity is disabled, baseline promise should not shift.
SELECT is(
  (
    SELECT r.promised_delivery_date::text
    FROM public.compute_shipment_promise_v2(
      p_now := '2026-01-21T10:00:00Z'::timestamptz,
      p_timezone := 'UTC',
      p_context := jsonb_build_object(
        'organization_id', (SELECT debug->>'organization_id' FROM tmp_sla_promise_capacity_windows_v1)::uuid,
        'branch_id', (SELECT debug->>'branch_id' FROM tmp_sla_promise_capacity_windows_v1)::uuid,
        'zone_id', (SELECT debug->>'zone_id' FROM tmp_sla_promise_capacity_windows_v1)::uuid,
        'service_type', 'delivery',
        'service_level', 'standard'
      ),
      p_policy := jsonb_build_object(
        'enabled', true,
        'timezone', 'UTC',
        'cutoff_time', '16:00',
        'default_transit_days', 1,
        'delivery_window_start', '09:00',
        'delivery_window_end', '18:00',
        'capacity_enabled', false
      )
    ) r
    LIMIT 1
  ),
  '2026-01-22',
  'Baseline promise does not shift when capacity_enabled=false'
);

-- When capacity behavior is ignore, baseline promise should not shift.
SELECT is(
  (
    SELECT r.promised_delivery_date::text
    FROM public.compute_shipment_promise_v2(
      p_now := '2026-01-21T10:00:00Z'::timestamptz,
      p_timezone := 'UTC',
      p_context := jsonb_build_object(
        'organization_id', (SELECT debug->>'organization_id' FROM tmp_sla_promise_capacity_windows_v1)::uuid,
        'branch_id', (SELECT debug->>'branch_id' FROM tmp_sla_promise_capacity_windows_v1)::uuid,
        'zone_id', (SELECT debug->>'zone_id' FROM tmp_sla_promise_capacity_windows_v1)::uuid,
        'service_type', 'delivery',
        'service_level', 'standard'
      ),
      p_policy := jsonb_build_object(
        'enabled', true,
        'timezone', 'UTC',
        'cutoff_time', '16:00',
        'default_transit_days', 1,
        'delivery_window_start', '09:00',
        'delivery_window_end', '18:00',
        'capacity_enabled', true,
        'capacity_behavior', 'ignore',
        'capacity_limit_key', 'max_shipments'
      )
    ) r
    LIMIT 1
  ),
  '2026-01-22',
  'Baseline promise does not shift when capacity_behavior=ignore'
);

SELECT finish();
ROLLBACK;

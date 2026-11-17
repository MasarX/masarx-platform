-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S95
-- pgTAP: shipment_promise_policy calendar blackout shifting (compute_shipment_promise_v2)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

CREATE TEMP TABLE tmp_sla_promise_calendar_events_v2 (
  event_id UUID,
  promised_delivery_date DATE,
  promised_window_start_at TIMESTAMPTZ,
  promised_window_end_at TIMESTAMPTZ,
  debug JSONB
) ON COMMIT DROP;

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_zone UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_event UUID := gen_random_uuid();

  v_policy JSONB;
  v_res RECORD;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Promise Calendar Org', 'promise-cal-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Promise Calendar Client', 'pcal-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Promise Calendar Sender', 'Promise Calendar Sender', TRUE, 'active');

  INSERT INTO public.zones (id, organization_id, name, slug, is_active)
  VALUES (v_zone, v_org, 'PCAL Zone', 'pcal-zone-' || left(v_zone::text, 8), TRUE);

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'pcal-branch-' || left(v_branch::text, 8), 'PCAL Branch', 'UTC', TRUE);

  INSERT INTO public.branch_zones (branch_id, zone_id)
  VALUES (v_branch, v_zone);

  -- Holiday on the baseline promised date (2026-01-22 UTC) should push to 2026-01-23.
  INSERT INTO public.calendar_events (
    id,
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
    v_event,
    v_org,
    v_branch,
    'holiday',
    '2026-01-22T00:00:00Z'::timestamptz,
    '2026-01-23T00:00:00Z'::timestamptz,
    'UTC',
    'pgTAP holiday blackout',
    TRUE,
    jsonb_build_object('pgtap', TRUE)
  );

  v_policy := jsonb_build_object(
    'version', 2,
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
    'calendar_max_shift_days', 7
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

  INSERT INTO tmp_sla_promise_calendar_events_v2
    (event_id, promised_delivery_date, promised_window_start_at, promised_window_end_at, debug)
  VALUES (v_event, v_res.promised_delivery_date, v_res.promised_window_start_at, v_res.promised_window_end_at, v_res.debug);
END $$;

SELECT is(
  (SELECT promised_delivery_date::text FROM tmp_sla_promise_calendar_events_v2),
  '2026-01-23',
  'Promise date shifts by 1 day when blackout calendar event matches'
);

SELECT is(
  (SELECT debug->>'calendar_shift_days' FROM tmp_sla_promise_calendar_events_v2),
  '1',
  'Debug includes calendar_shift_days=1'
);

SELECT ok(
  (
    SELECT (debug->'calendar_event_ids') @> to_jsonb(ARRAY[event_id::text])
    FROM tmp_sla_promise_calendar_events_v2
  ),
  'Debug includes calendar_event_ids containing the blackout event id'
);

SELECT is(
  (SELECT promised_window_start_at FROM tmp_sla_promise_calendar_events_v2),
  '2026-01-23T09:00:00Z'::timestamptz,
  'Calendar shift moves the delivery window start to the promised date'
);

SELECT is(
  (SELECT promised_window_end_at FROM tmp_sla_promise_calendar_events_v2),
  '2026-01-23T18:00:00Z'::timestamptz,
  'Calendar shift moves the delivery window end to the promised date'
);

-- When calendar is disabled, baseline promise should not shift.
SELECT is(
  (
    SELECT r.promised_delivery_date::text
    FROM public.compute_shipment_promise_v2(
      p_now := '2026-01-21T10:00:00Z'::timestamptz,
      p_timezone := 'UTC',
      p_context := jsonb_build_object(
        'organization_id', gen_random_uuid(),
        'branch_id', gen_random_uuid(),
        'zone_id', gen_random_uuid(),
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
        'calendar_enabled', false
      )
    ) r
    LIMIT 1
  ),
  '2026-01-22',
  'Baseline promise does not shift when calendar_enabled=false'
);

SELECT * FROM finish();
ROLLBACK;

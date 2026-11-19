-- pgTAP: Console V2 pickup request lifecycle lookup.
-- The requests tab reads api.pickup_requests_list_v1, which projects pickup
-- shipment status values directly.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions
    WHERE category = 'pickup_request_status'
      AND owner_role = 'operations'
      AND approval_policy = 'tier_1'
      AND is_mutable = false
  ),
  'pickup_request_status lookup definition exists with operations ownership'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_request_status'
      AND lv.value IN (
        'pending',
        'pickup_requested',
        'scheduled',
        'pickup_scheduled',
        'assigned',
        'completed',
        'failed',
        'pickup_failed',
        'cancelled'
      )
      AND lv.status = 'active'
  ),
  9,
  'pickup_request_status has active UI and shipment-backed lifecycle values'
);

SELECT is(
  (
    SELECT lv.metadata ->> 'lifecycle'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_request_status'
      AND lv.value = 'pickup_requested'
  ),
  'requested',
  'pickup_requested maps to the requested lifecycle'
);

SELECT is(
  (
    SELECT lv.metadata ->> 'lifecycle'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_request_status'
      AND lv.value = 'pickup_scheduled'
  ),
  'scheduled',
  'pickup_scheduled maps to the scheduled lifecycle'
);

SELECT is(
  (
    SELECT lv.metadata ->> 'tone'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_request_status'
      AND lv.value = 'pickup_scheduled'
  ),
  'info',
  'pickup_scheduled uses the info tone'
);

SELECT is(
  (
    SELECT lv.metadata ->> 'is_terminal'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_request_status'
      AND lv.value = 'completed'
  ),
  'true',
  'completed pickup requests are terminal'
);

SELECT is(
  (
    SELECT lv.metadata ->> 'is_terminal'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_request_status'
      AND lv.value = 'failed'
  ),
  'true',
  'failed pickup requests are terminal'
);

SELECT is(
  (
    SELECT lv.metadata ->> 'is_terminal'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_request_status'
      AND lv.value = 'pickup_failed'
  ),
  'true',
  'pickup_failed pickup requests are terminal'
);

SELECT is(
  (
    SELECT lv.metadata ->> 'is_terminal'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_request_status'
      AND lv.value = 'cancelled'
  ),
  'true',
  'cancelled pickup requests are terminal'
);

SELECT * FROM finish();
ROLLBACK;

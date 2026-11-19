-- Test Suite: FieldOps Mobile V2 reschedule readback
-- Validates submit_fieldops_reschedule_v1 writes canonical route-stop window
-- truth and stop-detail readback exposes the new window plus decision lineage
-- in the same authenticated Mobile V2 context.

SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(14);

SELECT has_function(
  'public',
  'submit_fieldops_reschedule_v1',
  ARRAY['uuid','timestamptz','timestamptz','text','uuid'],
  'public.submit_fieldops_reschedule_v1 exists'
);

SELECT has_function(
  'api',
  'submit_fieldops_reschedule_v1',
  ARRAY['uuid','timestamptz','timestamptz','text','uuid'],
  'api.submit_fieldops_reschedule_v1 wrapper exists'
);

SELECT has_function(
  'public',
  'resolve_fieldops_stop_detail_v1',
  ARRAY['uuid','text','jsonb'],
  'public.resolve_fieldops_stop_detail_v1 exists'
);

SELECT has_function(
  'api',
  'resolve_fieldops_stop_detail_v1',
  ARRAY['uuid','text','jsonb'],
  'api.resolve_fieldops_stop_detail_v1 wrapper exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.submit_fieldops_reschedule_v1(uuid,timestamptz,timestamptz,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.submit_fieldops_reschedule_v1(uuid,timestamptz,timestamptz,text,uuid)', 'EXECUTE'),
  'api reschedule write grants authenticated and revokes anon'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.resolve_fieldops_stop_detail_v1(uuid,text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.resolve_fieldops_stop_detail_v1(uuid,text,jsonb)', 'EXECUTE'),
  'api stop-detail read grants authenticated and revokes anon'
);

CREATE TEMP TABLE pgtap_mobile_reschedule_ctx AS
WITH ids AS (
  SELECT
    gen_random_uuid() AS org_id,
    gen_random_uuid() AS driver_id,
    gen_random_uuid() AS other_driver_id,
    gen_random_uuid() AS client_id,
    gen_random_uuid() AS sender_id,
    gen_random_uuid() AS branch_id,
    gen_random_uuid() AS route_run_id,
    gen_random_uuid() AS route_stop_id,
    gen_random_uuid() AS shipment_id,
    gen_random_uuid() AS idempotency_key
)
SELECT
  org_id,
  driver_id,
  other_driver_id,
  client_id,
  sender_id,
  branch_id,
  route_run_id,
  route_stop_id,
  shipment_id,
  idempotency_key,
  '2026-06-01 09:00:00+03'::timestamptz AS original_start,
  '2026-06-01 10:00:00+03'::timestamptz AS original_end,
  '2026-06-02 15:30:00+03'::timestamptz AS new_start,
  '2026-06-02 17:00:00+03'::timestamptz AS new_end,
  'Mobile V2 same-context reschedule readback'::text AS note
FROM ids;

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{}'::text, true);
END $$;

SELECT throws_ok(
  format(
    'SELECT api.submit_fieldops_reschedule_v1(%L::uuid, %L::timestamptz, %L::timestamptz, %L, %L::uuid)',
    route_stop_id,
    new_start,
    new_end,
    note,
    idempotency_key
  ),
  '42501',
  NULL,
  'api reschedule write fails closed for unauthenticated callers'
)
FROM pgtap_mobile_reschedule_ctx;

DO $$
BEGIN
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
END $$;

INSERT INTO public.organizations (id, name, slug)
SELECT org_id, 'pgTAP mobile reschedule', 'pgt-mobile-resched-' || substr(org_id::text, 1, 8)
FROM pgtap_mobile_reschedule_ctx
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  PERFORM set_config('app.organization_onboarding_source', '', true);
END $$;

INSERT INTO public.clients (id, organization_id, name, slug, status)
SELECT client_id, org_id, 'pgTAP mobile reschedule client', 'pgt-mobile-resched-c-' || substr(client_id::text, 1, 8), 'active'
FROM pgtap_mobile_reschedule_ctx
ON CONFLICT DO NOTHING;

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
SELECT sender_id, client_id, 'pgTAP mobile reschedule sender', 'pgTAP mobile reschedule sender', TRUE, 'active'
FROM pgtap_mobile_reschedule_ctx
ON CONFLICT DO NOTHING;

SELECT public.bootstrap_tenant_onboarding_v1(
  org_id,
  'pgtap:fieldops-mobile-reschedule-readback-fixture-bootstrap'
)
FROM pgtap_mobile_reschedule_ctx;

INSERT INTO public.users (id, organization_id, email, full_name, status)
SELECT driver_id, org_id, 'pgt-mobile-resched-' || substr(driver_id::text, 1, 8) || '@e.test', 'Reschedule Driver', 'active'
FROM pgtap_mobile_reschedule_ctx
UNION ALL
SELECT other_driver_id, org_id, 'pgt-mobile-resched-' || substr(other_driver_id::text, 1, 8) || '@e.test', 'Other Driver', 'active'
FROM pgtap_mobile_reschedule_ctx
ON CONFLICT DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug)
SELECT client_id, org_id, 'pgTAP mobile reschedule client', 'pgt-mobile-resched-c-' || substr(client_id::text, 1, 8)
FROM pgtap_mobile_reschedule_ctx
ON CONFLICT DO NOTHING;

INSERT INTO public.branches (id, organization_id, name, code, branch_type, timezone, is_active)
SELECT branch_id, org_id, 'pgTAP mobile reschedule branch', 'pgt-rs-' || substr(branch_id::text, 1, 8), 'primary', 'Asia/Riyadh', TRUE
FROM pgtap_mobile_reschedule_ctx
ON CONFLICT DO NOTHING;

INSERT INTO public.shipments (
  id,
  organization_id,
  client_id,
  service_type,
  tracking_number,
  box_count,
  priority_score,
  status,
  status_updated_at,
  service_level,
  metadata
)
SELECT
  shipment_id,
  org_id,
  client_id,
  'delivery',
  'PGTRS' || upper(replace(substr(shipment_id::text, 1, 8), '-', '')),
  1,
  50,
  'out_for_delivery',
  now(),
  'standard',
  jsonb_build_object('proof', 'mobile-v2-reschedule-readback')
FROM pgtap_mobile_reschedule_ctx
ON CONFLICT DO NOTHING;

INSERT INTO public.route_runs (
  id,
  organization_id,
  branch_id,
  driver_user_id,
  status,
  planned_date,
  planned_start_at,
  metadata
)
SELECT
  route_run_id,
  org_id,
  branch_id,
  driver_id,
  'in_progress',
  CURRENT_DATE,
  now(),
  jsonb_build_object('proof', 'mobile-v2-reschedule-readback')
FROM pgtap_mobile_reschedule_ctx
ON CONFLICT DO NOTHING;

INSERT INTO public.route_stops (
  id,
  organization_id,
  route_run_id,
  client_id,
  shipment_id,
  stop_kind,
  sequence_order,
  planned_window_start_at,
  planned_window_end_at,
  metadata
)
SELECT
  route_stop_id,
  org_id,
  route_run_id,
  client_id,
  shipment_id,
  'delivery',
  1,
  original_start,
  original_end,
  jsonb_build_object('proof', 'mobile-v2-reschedule-readback')
FROM pgtap_mobile_reschedule_ctx
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  v_driver_id UUID;
BEGIN
  SELECT driver_id INTO v_driver_id FROM pgtap_mobile_reschedule_ctx;
  PERFORM set_config('request.jwt.claim.sub', v_driver_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_driver_id::text, 'role', 'authenticated')::text,
    true
  );
END $$;

CREATE TEMP TABLE pgtap_mobile_reschedule_write AS
SELECT api.submit_fieldops_reschedule_v1(
  route_stop_id,
  new_start,
  new_end,
  note,
  idempotency_key
) AS payload
FROM pgtap_mobile_reschedule_ctx;

SELECT ok(
  (payload->>'ok')::boolean
  AND payload->>'state' = 'rescheduled'
  AND payload->>'stop_id' = route_stop_id::text
  AND (payload->>'stop_found')::boolean,
  'api reschedule write returns backend-confirmed rescheduled state'
)
FROM pgtap_mobile_reschedule_write
CROSS JOIN pgtap_mobile_reschedule_ctx;

SELECT ok(
  rs.planned_window_start_at = ctx.new_start
  AND rs.planned_window_end_at = ctx.new_end,
  'reschedule write updates canonical route_stops planned window'
)
FROM public.route_stops rs
JOIN pgtap_mobile_reschedule_ctx ctx ON ctx.route_stop_id = rs.id;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.decision_log dl
    JOIN pgtap_mobile_reschedule_write w ON dl.id = (w.payload->>'decision_log_id')::uuid
    JOIN pgtap_mobile_reschedule_ctx ctx ON TRUE
    WHERE dl.organization_id = ctx.org_id
      AND dl.decision_category = 'fieldops_reschedule'
      AND dl.resource_type = 'route_stop'
      AND dl.resource_id = ctx.route_stop_id
      AND dl.decision_point = 'reschedule_stop'
      AND dl.decision_outcome = 'rescheduled'
      AND dl.performed_by_system = 'fieldops_mobile_v2'
      AND dl.correlation_id = ctx.idempotency_key
      AND dl.decision_reason = ctx.note
      AND (dl.decision_inputs->>'window_start')::timestamptz = ctx.new_start
      AND (dl.decision_inputs->>'window_end')::timestamptz = ctx.new_end
      AND (dl.decision_inputs->>'stop_found')::boolean
  ),
  'decision_log stores canonical reschedule decision truth'
);

SELECT ok(
  (public.resolve_fieldops_stop_detail_v1(ctx.route_stop_id, 'driver', '{}'::jsonb)->>'window') = '15:30'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.resolve_fieldops_stop_detail_v1(ctx.route_stop_id, 'driver', '{}'::jsonb)->'timeline') AS item(row)
    WHERE item.row->>'id' = w.payload->>'decision_log_id'
      AND item.row->>'label' = ctx.note
  ),
  'public stop-detail readback exposes new window and reschedule decision without context reset'
)
FROM pgtap_mobile_reschedule_ctx ctx
CROSS JOIN pgtap_mobile_reschedule_write w;

SELECT ok(
  (api.resolve_fieldops_stop_detail_v1(ctx.route_stop_id, 'driver', '{}'::jsonb)->>'window') = '15:30'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(api.resolve_fieldops_stop_detail_v1(ctx.route_stop_id, 'driver', '{}'::jsonb)->'timeline') AS item(row)
    WHERE item.row->>'id' = w.payload->>'decision_log_id'
      AND item.row->>'label' = ctx.note
  ),
  'api stop-detail wrapper exposes the same window and decision readback'
)
FROM pgtap_mobile_reschedule_ctx ctx
CROSS JOIN pgtap_mobile_reschedule_write w;

CREATE TEMP TABLE pgtap_mobile_reschedule_replay AS
SELECT api.submit_fieldops_reschedule_v1(
  route_stop_id,
  new_start,
  new_end,
  note,
  idempotency_key
) AS payload
FROM pgtap_mobile_reschedule_ctx;

SELECT ok(
  replay.payload->>'state' = 'replayed'
  AND replay.payload->>'decision_log_id' = write.payload->>'decision_log_id'
  AND (
    SELECT count(*)
    FROM public.decision_log dl
    JOIN pgtap_mobile_reschedule_ctx ctx ON TRUE
    WHERE dl.organization_id = ctx.org_id
      AND dl.decision_category = 'fieldops_reschedule'
      AND dl.correlation_id = ctx.idempotency_key
  ) = 1,
  'idempotent replay keeps the same decision id and does not duplicate lineage'
)
FROM pgtap_mobile_reschedule_replay replay
CROSS JOIN pgtap_mobile_reschedule_write write;

SELECT ok(
  (api.resolve_fieldops_stop_detail_v1(ctx.route_stop_id, 'driver', '{}'::jsonb)->>'window') = '15:30'
  AND rs.planned_window_start_at = ctx.new_start
  AND rs.planned_window_end_at = ctx.new_end,
  'same-context stop-detail readback remains aligned after idempotent replay'
)
FROM pgtap_mobile_reschedule_ctx ctx
JOIN public.route_stops rs ON rs.id = ctx.route_stop_id;

SELECT * FROM finish();
ROLLBACK;

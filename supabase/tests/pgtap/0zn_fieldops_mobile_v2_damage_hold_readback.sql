-- Test Suite: FieldOps Mobile V2 damage-hold readback
-- Validates row-driven categories, latest hold readback, and real hold queue
-- projection after submit_fieldops_damage_hold_v1.

SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(17);

SELECT has_function(
  'public',
  'resolve_fieldops_latest_damage_hold_v1',
  ARRAY['text','jsonb'],
  'public.resolve_fieldops_latest_damage_hold_v1 exists'
);

SELECT has_function(
  'api',
  'resolve_fieldops_latest_damage_hold_v1',
  ARRAY['text','jsonb'],
  'api.resolve_fieldops_latest_damage_hold_v1 wrapper exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.resolve_fieldops_latest_damage_hold_v1(text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.resolve_fieldops_latest_damage_hold_v1(text,jsonb)', 'EXECUTE'),
  'public latest damage-hold resolver grants authenticated and revokes anon'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.resolve_fieldops_latest_damage_hold_v1(text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.resolve_fieldops_latest_damage_hold_v1(text,jsonb)', 'EXECUTE'),
  'api latest damage-hold resolver grants authenticated and revokes anon'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_category_registry
    WHERE category = 'mobile_damage_severity_policy'
      AND requires_global_default
      AND safe_missing_behavior = 'hard_fail'
  ),
  'mobile_damage_severity_policy category registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'mobile_damage_severity_policy'
      AND jsonb_array_length(s.cached_value->'severities') >= 5
  ),
  'mobile_damage_severity_policy global cache has damage categories'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.resolve_fieldops_hold_v1(text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.resolve_fieldops_hold_v1(text,jsonb)', 'EXECUTE'),
  'api hold queue resolver grants authenticated and revokes anon'
);

CREATE TEMP TABLE pgtap_mobile_damage_hold_ctx AS
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
  shipment_id AS parcel_id,
  idempotency_key
FROM ids;

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{}', true);
END $$;

SELECT throws_ok(
  'SELECT public.resolve_fieldops_latest_damage_hold_v1(''driver'', ''{}''::jsonb)',
  '42501'
);

DO $$
BEGIN
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
END $$;

INSERT INTO public.organizations (id, name, slug)
SELECT org_id, 'pgTAP mobile damage hold', 'pgt-mobile-dh-' || substr(org_id::text, 1, 8)
FROM pgtap_mobile_damage_hold_ctx
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  PERFORM set_config('app.organization_onboarding_source', '', true);
END $$;

INSERT INTO public.users (id, organization_id, email, full_name, status)
SELECT driver_id, org_id, 'pgt-mobile-dh-' || substr(driver_id::text, 1, 8) || '@e.test', 'Damage Driver', 'active'
FROM pgtap_mobile_damage_hold_ctx
UNION ALL
SELECT other_driver_id, org_id, 'pgt-mobile-dh-' || substr(other_driver_id::text, 1, 8) || '@e.test', 'Other Driver', 'active'
FROM pgtap_mobile_damage_hold_ctx
ON CONFLICT DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug)
SELECT client_id, org_id, 'pgTAP mobile damage hold client', 'pgt-mobile-dh-c-' || substr(client_id::text, 1, 8)
FROM pgtap_mobile_damage_hold_ctx
ON CONFLICT DO NOTHING;

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
SELECT sender_id, client_id, 'pgTAP mobile damage hold sender', 'pgTAP mobile damage hold sender', TRUE, 'active'
FROM pgtap_mobile_damage_hold_ctx
ON CONFLICT DO NOTHING;

SELECT public.bootstrap_tenant_onboarding_v1(
  org_id,
  'pgtap:fieldops-mobile-damage-hold-readback-fixture-bootstrap'
)
FROM pgtap_mobile_damage_hold_ctx;

INSERT INTO public.branches (id, organization_id, name, code, branch_type, timezone, is_active)
SELECT branch_id, org_id, 'pgTAP mobile damage hold branch', 'pgt-dh-' || substr(branch_id::text, 1, 8), 'primary', 'Asia/Riyadh', TRUE
FROM pgtap_mobile_damage_hold_ctx
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
  'PGTDH' || upper(replace(substr(shipment_id::text, 1, 8), '-', '')),
  1,
  50,
  'out_for_delivery',
  now(),
  'standard',
  jsonb_build_object('proof', 'damage-hold-readback')
FROM pgtap_mobile_damage_hold_ctx
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
  jsonb_build_object('proof', 'damage-hold-readback')
FROM pgtap_mobile_damage_hold_ctx
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
  now(),
  now() + interval '1 hour',
  jsonb_build_object('proof', 'damage-hold-readback')
FROM pgtap_mobile_damage_hold_ctx
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  v_driver_id UUID;
BEGIN
  SELECT driver_id INTO v_driver_id FROM pgtap_mobile_damage_hold_ctx;
  PERFORM set_config('request.jwt.claim.sub', v_driver_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_driver_id::text, 'role', 'authenticated')::text,
    true
  );
END $$;

SELECT ok(
  jsonb_array_length(public.resolve_fieldops_stop_detail_v1(route_stop_id, 'driver', '{}'::jsonb)->'parcels') = 1
  AND public.resolve_fieldops_stop_detail_v1(route_stop_id, 'driver', '{}'::jsonb)->'parcels'->0->>'id' = shipment_id::text
  AND public.resolve_fieldops_stop_detail_v1(route_stop_id, 'driver', '{}'::jsonb)->'parcels'->0->>'code' = (
    SELECT tracking_number FROM public.shipments WHERE id = shipment_id
  )
  AND public.resolve_fieldops_stop_detail_v1(route_stop_id, 'driver', '{}'::jsonb)->>'parcelsTotalLabel' = '1x',
  'stop detail projects shipment-level parcel when shipment_boxes are absent'
)
FROM pgtap_mobile_damage_hold_ctx;

SELECT ok(
  public.resolve_fieldops_latest_damage_hold_v1('driver', '{}'::jsonb)->'latest_damage_hold' = 'null'::jsonb,
  'latest damage-hold readback is null before submit'
);

CREATE TEMP TABLE pgtap_mobile_damage_hold_write AS
SELECT public.submit_fieldops_damage_hold_v1(
  parcel_id,
  'crushed',
  'Crushed corner and leaking contents',
  'damage-hold/proof.jpg',
  idempotency_key
) AS payload
FROM pgtap_mobile_damage_hold_ctx;

SELECT ok(
  (public.resolve_fieldops_latest_damage_hold_v1('driver', '{}'::jsonb)->'latest_damage_hold'->>'hold_id') = (payload->>'hold_id')
  AND (public.resolve_fieldops_latest_damage_hold_v1('driver', '{}'::jsonb)->'latest_damage_hold'->>'decision_log_id') = (payload->>'decision_log_id')
  AND (public.resolve_fieldops_latest_damage_hold_v1('driver', '{}'::jsonb)->'latest_damage_hold'->>'parcel_id') = (payload->>'parcel_id')
  AND (public.resolve_fieldops_latest_damage_hold_v1('driver', '{}'::jsonb)->'latest_damage_hold'->>'severity_id') = 'crushed'
  AND (public.resolve_fieldops_latest_damage_hold_v1('driver', '{}'::jsonb)->'latest_damage_hold'->>'state') = 'open'
  AND (public.resolve_fieldops_latest_damage_hold_v1('driver', '{}'::jsonb)->'latest_damage_hold'->>'note') = 'Crushed corner and leaking contents'
  AND (public.resolve_fieldops_latest_damage_hold_v1('driver', '{}'::jsonb)->'latest_damage_hold'->>'photo_storage_path') = 'damage-hold/proof.jpg',
  'public latest damage-hold resolver returns the submitted hold'
)
FROM pgtap_mobile_damage_hold_write;

SELECT ok(
  (api.resolve_fieldops_latest_damage_hold_v1('driver', '{}'::jsonb)->'latest_damage_hold'->>'hold_id') = (payload->>'hold_id')
  AND (api.resolve_fieldops_latest_damage_hold_v1('driver', '{}'::jsonb)->'latest_damage_hold'->>'decision_log_id') = (payload->>'decision_log_id'),
  'api latest damage-hold wrapper returns the same readback'
)
FROM pgtap_mobile_damage_hold_write;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(api.resolve_fieldops_hold_v1('loader', '{}'::jsonb)) AS item(row)
    JOIN pgtap_mobile_damage_hold_write w ON TRUE
    WHERE item.row->>'id' = w.payload->>'hold_id'
      AND item.row->>'reason' = 'damage'
      AND item.row->>'status' = 'open'
      AND item.row->>'note' = 'Crushed corner and leaking contents'
      AND item.row->>'photo_storage_path' = 'damage-hold/proof.jpg'
  ),
  'hold queue resolver returns the new open damage hold'
);

SELECT ok(
  public.resolve_fieldops_stop_detail_v1(route_stop_id, 'driver', '{}'::jsonb)->'parcels'->0->>'status' = 'damaged',
  'stop detail marks shipment-level parcel damaged after open hold readback'
)
FROM pgtap_mobile_damage_hold_ctx;

SELECT ok(
  jsonb_typeof(api.resolve_fieldops_hold_v1('loader', '{}'::jsonb)) = 'array',
  'api hold queue resolver returns a jsonb array'
);

DO $$
DECLARE
  v_other_driver_id UUID;
BEGIN
  SELECT other_driver_id INTO v_other_driver_id FROM pgtap_mobile_damage_hold_ctx;
  PERFORM set_config('request.jwt.claim.sub', v_other_driver_id::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_other_driver_id::text, 'role', 'authenticated')::text,
    true
  );
END $$;

SELECT ok(
  public.resolve_fieldops_latest_damage_hold_v1('driver', '{}'::jsonb)->'latest_damage_hold' = 'null'::jsonb,
  'latest damage-hold readback is scoped to submitting driver'
);

DO $$
DECLARE
  v_driver_id UUID;
BEGIN
  SELECT driver_id INTO v_driver_id FROM pgtap_mobile_damage_hold_ctx;
  PERFORM set_config('request.jwt.claim.sub', v_driver_id::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_driver_id::text, 'role', 'authenticated')::text,
    true
  );
END $$;

SELECT ok(
  (public.resolve_fieldops_latest_damage_hold_v1('driver', '{}'::jsonb)->'latest_damage_hold'->>'hold_id') = (payload->>'hold_id'),
  'submitting driver can still read the same latest damage hold'
)
FROM pgtap_mobile_damage_hold_write;

SELECT * FROM finish();
ROLLBACK;

-- Test Suite: Mobile V2 login/profile handoff + first task visibility
-- Validates the backend contract that native FieldOps Mobile V2 relies on
-- after an approved driver signs in: policy resolves V2-on, the approved
-- driver profile is active, and the first assigned route stop is visible
-- through the canonical task resolver.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

DO $$
DECLARE
  v_org_id uuid := '280395b3-5e50-43ad-9a4f-f2dc2edb25f6';
  v_user_id uuid := '280395b3-5e50-43ad-9a4f-f2dc2edb25f7';
  v_client_id uuid := '280395b3-5e50-43ad-9a4f-f2dc2edb25f8';
  v_address_id uuid := '280395b3-5e50-43ad-9a4f-f2dc2edb25f9';
  v_geocode_id uuid := '280395b3-5e50-43ad-9a4f-f2dc2edb25fa';
  v_branch_id uuid := '280395b3-5e50-43ad-9a4f-f2dc2edb25fb';
  v_run_id uuid := '280395b3-5e50-43ad-9a4f-f2dc2edb25fc';
  v_shipment_id uuid := '280395b3-5e50-43ad-9a4f-f2dc2edb25fd';
  v_stop_id uuid := '280395b3-5e50-43ad-9a4f-f2dc2edb25fe';
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org_id, 'Mobile V2 Login First Task pgTAP', 'mobile-v2-login-first-task-pgtap')
  ON CONFLICT (id) DO NOTHING;

  PERFORM public.upsert_settings_value_v1(
    'mobile_shell_policy', 'tenant', v_org_id,
    '{"version":1,"v2_enabled":true}'::jsonb, 1, 'Fixture tenant rollout opt-in'
  );

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status)
  VALUES (
    v_user_id,
    v_org_id,
    'mobile-v2-login-first-task-pgtap@example.test',
    'Mobile V2 First Task Driver',
    'driver',
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.driver_profiles (id, organization_id, user_id, driver_code, status, hired_at, metadata)
  VALUES (
    gen_random_uuid(),
    v_org_id,
    v_user_id,
    'DRV-PGTAP-V2',
    'active',
    now(),
    jsonb_build_object('source', '0zz_mobile_v2_login_first_task_proof_v1')
  )
  ON CONFLICT (organization_id, user_id)
  DO UPDATE
    SET status = 'active',
        metadata = EXCLUDED.metadata;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client_id, v_org_id, 'Mobile V2 First Task Client', 'mobile-v2-first-task-client')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.addresses (
    id, organization_id, client_id, raw_input, normalized_line1, district,
    city, province, country, building_number, postal_code, sa_short_code,
    validation_status
  )
  VALUES (
    v_address_id, v_org_id, v_client_id, 'TEST0000 Olaya Riyadh',
    'TEST0000 Olaya Riyadh', 'Olaya', 'Riyadh', 'Riyadh', 'SA',
    '4419', '12212', 'TEST0000', 'valid'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.geocodes (
    id, organization_id, client_id, address_id, provider_name, coordinates,
    confidence_score, accuracy_type, metadata, is_primary
  )
  VALUES (
    v_geocode_id, v_org_id, v_client_id, v_address_id, 'pgtap-fieldops-geocode',
    ST_SetSRID(ST_MakePoint(46.6753, 24.7136), 4326)::geography,
    0.97, 'rooftop', jsonb_build_object('match_strategy', 'sa_short_code_registry'),
    TRUE
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.branches (id, organization_id, name, code, branch_type, timezone, is_active)
  VALUES (v_branch_id, v_org_id, 'Mobile V2 First Task Branch', 'mobile-v2-first-task', 'primary', 'Asia/Riyadh', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.route_runs (id, organization_id, branch_id, driver_user_id, status, planned_date, planned_start_at)
  VALUES (v_run_id, v_org_id, v_branch_id, v_user_id, 'in_progress', CURRENT_DATE, now() + INTERVAL '30 minutes')
  ON CONFLICT (id) DO UPDATE
    SET driver_user_id = EXCLUDED.driver_user_id,
        status = EXCLUDED.status;

  INSERT INTO public.shipments (
    id, organization_id, client_id, service_type, tracking_number, box_count,
    priority_score, promised_delivery_date, service_level, status, status_updated_at,
    destination_address_id
  )
  VALUES (
    v_shipment_id, v_org_id, v_client_id, 'delivery', 'MVT-FIRST-TASK',
    1, 90, CURRENT_DATE, 'standard', 'pending', now(), v_address_id
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.route_stops (
    id, organization_id, route_run_id, client_id, shipment_id,
    stop_kind, sequence_order, planned_window_start_at, metadata
  )
  VALUES (
    v_stop_id, v_org_id, v_run_id, v_client_id, v_shipment_id,
    'delivery', 1, now() + INTERVAL '30 minutes',
    jsonb_build_object('area', 'Olaya')
  )
  ON CONFLICT (id) DO UPDATE
    SET route_run_id = EXCLUDED.route_run_id,
        shipment_id = EXCLUDED.shipment_id,
        metadata = EXCLUDED.metadata;

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', v_user_id::text, 'organization_id', v_org_id::text)::text,
    TRUE
  );
  PERFORM set_config('request.jwt.claim.sub', v_user_id::text, TRUE);
END $$;

SELECT is(
  (public.resolve_mobile_shell_policy('driver', '{}'::jsonb)->>'v2_enabled')::boolean,
  TRUE,
  'approved driver tenant resolves mobile_shell_policy.v2_enabled=true'
);

SELECT is(
  (SELECT status FROM public.users WHERE email = 'mobile-v2-login-first-task-pgtap@example.test'),
  'active',
  'approved driver handoff user is active'
);

SELECT is(
  (SELECT status FROM public.driver_profiles WHERE user_id = '280395b3-5e50-43ad-9a4f-f2dc2edb25f7'::uuid),
  'active',
  'approved driver profile is active'
);

SELECT is(
  (SELECT COUNT(*)::int FROM public.resolve_fieldops_tasks_v1('driver', '{}'::jsonb)),
  1,
  'driver sees exactly one first assigned task'
);

SELECT is(
  (SELECT task_id FROM public.resolve_fieldops_tasks_v1('driver', '{}'::jsonb) LIMIT 1),
  'stop:280395b3-5e50-43ad-9a4f-f2dc2edb25fe',
  'first task resolves to the assigned route stop'
);

SELECT is(
  (SELECT code FROM public.resolve_fieldops_tasks_v1('driver', '{}'::jsonb) LIMIT 1),
  'MVT-FIRST-TASK',
  'first task exposes shipment tracking code'
);

SELECT is(
  (SELECT meta->>'short_national_address' FROM public.resolve_fieldops_tasks_v1('driver', '{}'::jsonb) LIMIT 1),
  'TEST0000',
  'first task carries backend geocoding/address metadata'
);

SELECT * FROM finish();

ROLLBACK;

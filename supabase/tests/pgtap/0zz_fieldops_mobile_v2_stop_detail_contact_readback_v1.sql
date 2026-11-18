-- Focused Mobile V2 route lifecycle guard:
-- stop-detail contact phone must come from backend contact truth when present,
-- including existing shipment metadata fallback, and must stay absent when no
-- backend contact truth exists.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

DO $$
DECLARE
  v_org_id uuid := '3c73d2d0-0606-4000-8000-000000000001';
  v_user_id uuid := '3c73d2d0-0606-4000-8000-000000000002';
  v_client_id uuid := '3c73d2d0-0606-4000-8000-000000000003';
  v_branch_id uuid := '3c73d2d0-0606-4000-8000-000000000004';
  v_address_id uuid := '3c73d2d0-0606-4000-8000-000000000005';
  v_recipient_id uuid := '3c73d2d0-0606-4000-8000-000000000006';
  v_ship_with_phone uuid := '3c73d2d0-0606-4000-8000-000000000007';
  v_ship_without_phone uuid := '3c73d2d0-0606-4000-8000-000000000008';
  v_ship_with_metadata_phone uuid := '3c73d2d0-0606-4000-8000-00000000000c';
  v_run_id uuid := '3c73d2d0-0606-4000-8000-000000000009';
  v_stop_with_phone uuid := '3c73d2d0-0606-4000-8000-00000000000a';
  v_stop_without_phone uuid := '3c73d2d0-0606-4000-8000-00000000000b';
  v_stop_with_metadata_phone uuid := '3c73d2d0-0606-4000-8000-00000000000d';
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org_id, 'Mobile V2 Stop Detail Contact pgTAP', 'mobile-v2-stop-contact-pgtap')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status)
  VALUES (v_user_id, v_org_id, 'mobile-v2-stop-contact-pgtap@example.test', 'Mobile V2 Contact Driver', 'driver', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client_id, v_org_id, 'Mobile V2 Stop Contact Client', 'mobile-v2-stop-contact-client')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, name, code, branch_type, timezone, is_active)
  VALUES (v_branch_id, v_org_id, 'Mobile V2 Stop Contact Branch', 'mobile-v2-stop-contact', 'primary', 'Asia/Riyadh', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.addresses (
    id, organization_id, client_id, raw_input, normalized_line1, city, province, country, validation_status
  )
  VALUES (
    v_address_id, v_org_id, v_client_id, 'TEST0000 Olaya Riyadh', 'TEST0000 Olaya Riyadh', 'Riyadh', 'Riyadh', 'SA', 'valid'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.recipients (id, organization_id, client_id, name, phone_number, preferred_language)
  VALUES (v_recipient_id, v_org_id, v_client_id, 'Contact Readback Recipient', '+966550000012', 'ar')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.shipments (
    id, organization_id, client_id, service_type, tracking_number, box_count,
    priority_score, status, status_updated_at, recipient_id, destination_address_id, service_level,
    metadata
  )
  VALUES
    (v_ship_with_phone, v_org_id, v_client_id, 'delivery', 'MVT-CONTACT-PHONE', 1, 90, 'pending', now(), v_recipient_id, v_address_id, 'standard', '{}'::jsonb),
    (v_ship_without_phone, v_org_id, v_client_id, 'delivery', 'MVT-CONTACT-NONE', 1, 90, 'pending', now(), NULL, v_address_id, 'standard', '{}'::jsonb),
    (v_ship_with_metadata_phone, v_org_id, v_client_id, 'delivery', 'MVT-CONTACT-META', 1, 90, 'pending', now(), NULL, v_address_id, 'standard', jsonb_build_object('customer_phone', '+966555551234'))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.route_runs (id, organization_id, branch_id, driver_user_id, status, planned_date, planned_start_at)
  VALUES (v_run_id, v_org_id, v_branch_id, v_user_id, 'in_progress', CURRENT_DATE, now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.route_stops (
    id, organization_id, route_run_id, client_id, shipment_id, stop_kind, sequence_order, planned_window_start_at
  )
  VALUES
    (v_stop_with_phone, v_org_id, v_run_id, v_client_id, v_ship_with_phone, 'delivery', 1, now()),
    (v_stop_without_phone, v_org_id, v_run_id, v_client_id, v_ship_without_phone, 'delivery', 2, now()),
    (v_stop_with_metadata_phone, v_org_id, v_run_id, v_client_id, v_ship_with_metadata_phone, 'delivery', 3, now())
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('request.jwt.claim.sub', v_user_id::text, TRUE);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', v_user_id::text, 'organization_id', v_org_id::text)::text,
    TRUE
  );
END $$;

SELECT is(
  public.resolve_fieldops_stop_detail_v1(
    '3c73d2d0-0606-4000-8000-00000000000a'::uuid,
    'driver',
    '{}'::jsonb
  )->>'customerPhone',
  '+966550000012',
  'public stop-detail resolver returns recipient phone from backend truth'
);

SELECT is(
  api.resolve_fieldops_stop_detail_v1(
    '3c73d2d0-0606-4000-8000-00000000000a'::uuid,
    'driver',
    '{}'::jsonb
  )->>'customerPhone',
  '+966550000012',
  'api stop-detail wrapper returns recipient phone from backend truth'
);

SELECT is(
  public.resolve_fieldops_stop_detail_v1(
    '3c73d2d0-0606-4000-8000-00000000000d'::uuid,
    'driver',
    '{}'::jsonb
  )->>'customerPhone',
  '+966555551234',
  'public stop-detail resolver returns shipment metadata phone from backend truth'
);

SELECT is(
  api.resolve_fieldops_stop_detail_v1(
    '3c73d2d0-0606-4000-8000-00000000000d'::uuid,
    'driver',
    '{}'::jsonb
  )->>'customerPhone',
  '+966555551234',
  'api stop-detail wrapper returns shipment metadata phone from backend truth'
);

SELECT ok(
  NOT (
    public.resolve_fieldops_stop_detail_v1(
      '3c73d2d0-0606-4000-8000-00000000000b'::uuid,
      'driver',
      '{}'::jsonb
    ) ? 'customerPhone'
  ),
  'stop-detail resolver omits customerPhone when backend has no recipient phone'
);

SELECT * FROM finish();

ROLLBACK;

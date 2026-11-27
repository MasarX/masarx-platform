-- pgTAP coverage for resolve_fieldops_stop_detail_v1 (Mobile V2 stop-detail
-- aggregator). This closes Audit 2 P0 #3 — the FE was rendering off a
-- preview-only fixture and there was no resolver path that could populate
-- the same shape from canonical tables.
--
-- Assertions:
--   1) public.* + api.* exist with the expected signatures
--   2) SECURITY DEFINER on public.*
--   3) authenticated has EXECUTE; anon does NOT
--   4) Unauthenticated caller raises 42501
--   5) NULL stop_id raises 22023
--   6) Non-existent stop raises 22023
--   7) Cross-org caller (auth'd to other tenant) raises 42501
--   8) Wrong-driver caller in driver role raises 42501
--   9) Happy path: caller auth'd as the assigned driver of org A receives
--      a JSONB envelope with the expected keys + tenant-scoped values
--  10) Envelope.hazards reflects row state (COD chip present; OTP chip
--      derived from row metadata)
--  11) Envelope.parcels reflects shipment_boxes rows
--  12) Envelope.parcelsTotalLabel matches aggregate
--  13) Envelope.cod populated from shipments.cod_amount + currency
--  14) decision_log audit row written with the resolver name + caller org
--  15) Supervisor role bypass: same-org supervisor receives the envelope
--      even when they are not the driver of record
--
-- Single transaction; ROLLBACK at end keeps the DB clean.

SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(24);

-- ===========================================================================
-- A) Existence + signature
-- ===========================================================================

SELECT has_function('public', 'resolve_fieldops_stop_detail_v1',
  ARRAY['uuid','text','jsonb'],
  'public.resolve_fieldops_stop_detail_v1(uuid, text, jsonb) exists');

SELECT has_function('api', 'resolve_fieldops_stop_detail_v1',
  ARRAY['uuid','text','jsonb'],
  'api.resolve_fieldops_stop_detail_v1(uuid, text, jsonb) mirror exists');

-- ===========================================================================
-- B) SECURITY DEFINER on public.*
-- ===========================================================================

SELECT ok(
  (SELECT prosecdef
     FROM pg_proc
    WHERE proname = 'resolve_fieldops_stop_detail_v1'
      AND pronamespace = 'public'::regnamespace
    LIMIT 1),
  'public.resolve_fieldops_stop_detail_v1 is SECURITY DEFINER'
);

-- ===========================================================================
-- C) Grants
-- ===========================================================================

SELECT ok(
  has_function_privilege('authenticated',
    'public.resolve_fieldops_stop_detail_v1(uuid, text, jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon',
    'public.resolve_fieldops_stop_detail_v1(uuid, text, jsonb)', 'EXECUTE'),
  'authenticated has EXECUTE; anon revoked'
);

-- ===========================================================================
-- D) Unauthenticated -> 42501
-- ===========================================================================

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{}', true);

  PERFORM throws_ok(
    'SELECT public.resolve_fieldops_stop_detail_v1(gen_random_uuid(), ''driver'', ''{}''::jsonb)',
    '42501',
    NULL,
    'unauthenticated caller raises 42501'
  );
END $$;

-- ===========================================================================
-- E) Happy path + cross-tenant + role variants.
--    All seeded fixture data scoped to ephemeral orgs so ROLLBACK leaves no
--    residue.
-- ===========================================================================

DO $$
DECLARE
  v_org_a    UUID := gen_random_uuid();
  v_org_b    UUID := gen_random_uuid();
  v_driver_a UUID := gen_random_uuid();
  v_driver_b UUID := gen_random_uuid();
  v_other_driver_a UUID := gen_random_uuid();
  v_supervisor_a   UUID := gen_random_uuid();
  v_client_a UUID := gen_random_uuid();
  v_client_b UUID := gen_random_uuid();
  v_branch_a UUID := gen_random_uuid();
  v_branch_b UUID := gen_random_uuid();
  v_addr_a   UUID := gen_random_uuid();
  v_recip_a  UUID := gen_random_uuid();
  v_run_a    UUID := gen_random_uuid();
  v_run_b    UUID := gen_random_uuid();
  v_stop_a   UUID := gen_random_uuid();
  v_stop_a2  UUID := gen_random_uuid();
  v_stop_b   UUID := gen_random_uuid();
  v_ship_a   UUID := gen_random_uuid();
  v_ship_b   UUID := gen_random_uuid();
  v_envelope JSONB;
  v_hazards  JSONB;
  v_parcels  JSONB;
  v_otp_ok   BOOLEAN;
  v_cod_ok   BOOLEAN;
  v_correlation UUID := gen_random_uuid();
BEGIN
  ------------------------------------------------------------------------
  -- Seed: two orgs (A + B), each with a client/branch/run/stop/shipment.
  ------------------------------------------------------------------------
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org_a, 'pgT stop-detail A', 'pgt-sd-' || substr(v_org_a::text, 1, 8)),
         (v_org_b, 'pgT stop-detail B', 'pgt-sd-' || substr(v_org_b::text, 1, 8))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, status)
  VALUES
    (v_driver_a,       v_org_a, 'pgt-sd-' || substr(v_driver_a::text, 1, 8) || '@e.test', 'Driver A', 'active'),
    (v_other_driver_a, v_org_a, 'pgt-sd-' || substr(v_other_driver_a::text, 1, 8) || '@e.test', 'Driver A2', 'active'),
    (v_supervisor_a,   v_org_a, 'pgt-sd-' || substr(v_supervisor_a::text, 1, 8) || '@e.test', 'Supervisor A', 'active'),
    (v_driver_b,       v_org_b, 'pgt-sd-' || substr(v_driver_b::text, 1, 8) || '@e.test', 'Driver B', 'active')
  ON CONFLICT DO NOTHING;

  UPDATE public.users SET user_type = 'ops_admin' WHERE id = v_supervisor_a;
  INSERT INTO public.rbac_roles (organization_id, key, name)
  VALUES (v_org_a, 'supervisor', 'Supervisor');
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id)
  SELECT v_org_a, v_supervisor_a, id FROM public.rbac_roles
  WHERE organization_id = v_org_a AND key = 'supervisor';
  INSERT INTO public.mobile_v2_active_role (user_id, organization_id, role_key)
  VALUES (v_supervisor_a, v_org_a, 'supervisor');

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client_a, v_org_a, 'Client A', 'pgt-sd-c-' || substr(v_client_a::text, 1, 8)),
         (v_client_b, v_org_b, 'Client B', 'pgt-sd-c-' || substr(v_client_b::text, 1, 8))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.branches (id, organization_id, name, code, branch_type, timezone, is_active)
  VALUES
    (v_branch_a, v_org_a, 'Branch A', 'pgt-sd-b-' || substr(v_branch_a::text, 1, 8), 'primary', 'Asia/Riyadh', TRUE),
    (v_branch_b, v_org_b, 'Branch B', 'pgt-sd-b-' || substr(v_branch_b::text, 1, 8), 'primary', 'Asia/Riyadh', TRUE)
  ON CONFLICT DO NOTHING;

  -- Address for the delivery destination (org A).
  INSERT INTO public.addresses (
    id, organization_id, client_id, raw_input, normalized_line1, normalized_line2,
    city, province, validation_status, country
  ) VALUES (
    v_addr_a, v_org_a, v_client_a,
    'Al Murooj 4419 Apt 12, Riyadh',
    'Al Murooj 4419 Apt 12',
    'Building 4419',
    'Riyadh',
    'Riyadh',
    'valid',
    'SA'
  ) ON CONFLICT DO NOTHING;

  -- Recipient.
  INSERT INTO public.recipients (
    id, organization_id, client_id, name, phone_number, preferred_language
  ) VALUES (
    v_recip_a, v_org_a, v_client_a, 'Hessa Al-Saud', '+966550000012', 'ar'
  ) ON CONFLICT DO NOTHING;

  ------------------------------------------------------------------------
  -- Shipments. Org A carries COD + otp_required metadata for the happy
  -- path. Org B is a benign delivery used only for the cross-tenant assert.
  ------------------------------------------------------------------------
  INSERT INTO public.shipments (
    id, organization_id, client_id, service_type, tracking_number, box_count,
    priority_score, status, status_updated_at, recipient_id,
    destination_address_id, service_level, cod_amount, cod_currency,
    special_instructions, metadata
  ) VALUES (
    v_ship_a, v_org_a, v_client_a, 'delivery', 'MX-003-' || substr(v_ship_a::text, 1, 4),
    2, 75, 'pending', now(), v_recip_a,
    v_addr_a, 'standard', 320.00, 'SAR',
    'Apt 12, 3rd floor — no elevator',
    jsonb_build_object('otp_required', TRUE)
  ),
  (
    v_ship_b, v_org_b, v_client_b, 'delivery', 'WB-' || substr(v_ship_b::text, 1, 8),
    1, 50, 'pending', now(), NULL,
    NULL, 'economy', NULL, 'SAR', NULL, '{}'::jsonb
  )
  ON CONFLICT DO NOTHING;

  -- Shipment boxes for org A's shipment (drives parcels + total-weight).
  -- shipment_boxes_barcode_format constraint requires [A-Z0-9]+:[0-9]+ (no
  -- dashes in the prefix), so we strip dashes from the substring.
  INSERT INTO public.shipment_boxes (
    shipment_id, organization_id, client_id, box_number, barcode, weight_kg, status
  ) VALUES
    (v_ship_a, v_org_a, v_client_a, 1, 'MX003' || upper(replace(substr(v_ship_a::text, 1, 4), '-', '')) || ':1', 1.2, 'pending'),
    (v_ship_a, v_org_a, v_client_a, 2, 'MX003' || upper(replace(substr(v_ship_a::text, 1, 4), '-', '')) || ':2', 0.9, 'pending')
  ON CONFLICT DO NOTHING;

  ------------------------------------------------------------------------
  -- Route runs + stops.
  --   Run A: driver = v_driver_a. Two stops (sequence 1 + 3 to mimic
  --          "Stop 3 of 12" semantics — total stops on the run is 2
  --          here; assertion uses the actual count).
  --   Run B: driver = v_driver_b (cross-tenant).
  ------------------------------------------------------------------------
  INSERT INTO public.route_runs (
    id, organization_id, branch_id, driver_user_id, status, planned_date,
    planned_start_at, metadata
  ) VALUES
    (v_run_a, v_org_a, v_branch_a, v_driver_a, 'in_progress', CURRENT_DATE,
     now(), jsonb_build_object('kind', 'delivery')),
    (v_run_b, v_org_b, v_branch_b, v_driver_b, 'in_progress', CURRENT_DATE,
     now(), jsonb_build_object('kind', 'delivery'))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.route_stops (
    id, organization_id, route_run_id, client_id, shipment_id, stop_kind,
    sequence_order, planned_window_start_at, planned_window_end_at, metadata
  ) VALUES
    (v_stop_a, v_org_a, v_run_a, v_client_a, v_ship_a, 'delivery',
     3, now() + interval '30 minutes', now() + interval '90 minutes',
     jsonb_build_object('eta_min', 12, 'distance_km', 2.3,
                        'address_note', 'Apt 12, 3rd floor — no elevator')),
    (v_stop_a2, v_org_a, v_run_a, v_client_a, v_ship_a, 'delivery',
     1, now() - interval '60 minutes', now() - interval '30 minutes',
     jsonb_build_object('status', 'done')),
    (v_stop_b, v_org_b, v_run_b, v_client_b, v_ship_b, 'delivery',
     1, now(), now() + interval '60 minutes', '{}'::jsonb)
  ON CONFLICT DO NOTHING;

  ------------------------------------------------------------------------
  -- F) NULL stop_id -> 22023.
  ------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_driver_a::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_driver_a::text, 'role', 'authenticated')::text,
    true);

  PERFORM throws_ok(
    'SELECT public.resolve_fieldops_stop_detail_v1(NULL::uuid, ''driver'', ''{}''::jsonb)',
    '22023',
    NULL,
    'NULL stop_id raises 22023'
  );

  ------------------------------------------------------------------------
  -- G) Non-existent stop -> 22023.
  ------------------------------------------------------------------------
  PERFORM throws_ok(
    format('SELECT public.resolve_fieldops_stop_detail_v1(%L::uuid, ''driver'', ''{}''::jsonb)',
           gen_random_uuid()),
    '22023',
    NULL,
    'non-existent stop raises 22023'
  );

  ------------------------------------------------------------------------
  -- H) Cross-tenant: driver_a (org A) requests stop_b (org B) -> 42501.
  ------------------------------------------------------------------------
  PERFORM throws_ok(
    format('SELECT public.resolve_fieldops_stop_detail_v1(%L::uuid, ''driver'', ''{}''::jsonb)',
           v_stop_b),
    '42501',
    NULL,
    'cross-org stop raises 42501'
  );

  ------------------------------------------------------------------------
  -- I) Wrong-driver same-org in driver role -> 42501.
  --    other_driver_a is in org A but is not the run.driver_user_id.
  ------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_other_driver_a::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_other_driver_a::text, 'role', 'authenticated')::text,
    true);

  PERFORM throws_ok(
    format('SELECT public.resolve_fieldops_stop_detail_v1(%L::uuid, ''driver'', ''{}''::jsonb)',
           v_stop_a),
    '42501',
    NULL,
    'driver role + wrong-driver same-org raises 42501'
  );

  ------------------------------------------------------------------------
  -- J) Happy path: driver_a authenticated, requests stop_a as 'driver'.
  ------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_driver_a::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_driver_a::text, 'role', 'authenticated')::text,
    true);

  v_envelope := public.resolve_fieldops_stop_detail_v1(
    v_stop_a,
    'driver',
    jsonb_build_object('correlation_id', v_correlation::text)
  );

  PERFORM ok(
    v_envelope IS NOT NULL,
    'happy path returns non-NULL envelope'
  );

  PERFORM ok(
    (v_envelope ? 'id')
    AND (v_envelope ? 'seq')
    AND (v_envelope ? 'customerName')
    AND (v_envelope ? 'trackingCode')
    AND (v_envelope ? 'hazards')
    AND (v_envelope ? 'parcels')
    AND (v_envelope ? 'proofChecklist')
    AND (v_envelope ? 'timeline'),
    'envelope contains the MobileV2StopDetail keys'
  );

  PERFORM is(
    v_envelope->>'customerName',
    'Hessa Al-Saud',
    'envelope.customerName matches recipients.name'
  );

  PERFORM is(
    (v_envelope->>'seq')::int,
    3,
    'envelope.seq matches route_stops.sequence_order'
  );

  PERFORM is(
    v_envelope->>'stopType',
    'delivery',
    'envelope.stopType matches route_stops.stop_kind'
  );

  PERFORM is(
    v_envelope->>'customerInitials',
    'HA',
    'envelope.customerInitials derived from name'
  );

  ------------------------------------------------------------------------
  -- K) Hazards reflect row state — COD + OTP chips both present.
  ------------------------------------------------------------------------
  v_hazards := v_envelope->'hazards';

  v_cod_ok := EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_hazards) chip
     WHERE chip->>'label' LIKE 'Collect 320%'
       AND chip->>'tone' = 'accent'
  );
  PERFORM ok(v_cod_ok, 'envelope.hazards contains COD collect chip');

  v_otp_ok := EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_hazards) chip
     WHERE chip->>'label' = 'OTP required'
       AND chip->>'tone' = 'info'
  );
  PERFORM ok(v_otp_ok, 'envelope.hazards contains OTP-required chip');

  ------------------------------------------------------------------------
  -- L) Parcels list + total label.
  ------------------------------------------------------------------------
  v_parcels := v_envelope->'parcels';

  PERFORM is(
    jsonb_array_length(v_parcels),
    2,
    'envelope.parcels has both shipment_boxes rows'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_parcels) p
       WHERE p->>'status' = 'pending'
         AND p->>'description' LIKE 'standard · ~%kg'
    ),
    'envelope.parcels[].description carries service_level + weight'
  );

  PERFORM is(
    v_envelope->>'parcelsTotalLabel',
    '2x · 2.1 kg',
    'envelope.parcelsTotalLabel aggregates units + weight'
  );

  ------------------------------------------------------------------------
  -- M) COD envelope.
  ------------------------------------------------------------------------
  PERFORM is(
    (v_envelope->'cod'->>'amount')::numeric,
    320.00::numeric,
    'envelope.cod.amount matches shipments.cod_amount'
  );

  PERFORM is(
    v_envelope->'cod'->>'currency',
    'SAR',
    'envelope.cod.currency matches shipments.cod_currency'
  );

  ------------------------------------------------------------------------
  -- N) decision_log audit row written.
  ------------------------------------------------------------------------
  PERFORM ok(
    EXISTS (
      SELECT 1 FROM public.decision_log dl
       WHERE dl.organization_id = v_org_a
         AND dl.decision_category = 'fieldops_stop_detail_read'
         AND dl.resource_type = 'route_stop'
         AND dl.resource_id = v_stop_a
         AND dl.correlation_id = v_correlation
    ),
    'decision_log row written with resolver decision_category + correlation_id'
  );

  ------------------------------------------------------------------------
  -- O) Supervisor role bypass: same-org supervisor reads the stop even
  --    though they are not the assigned driver.
  ------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_supervisor_a::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_supervisor_a::text, 'role', 'authenticated')::text,
    true);

  v_envelope := public.resolve_fieldops_stop_detail_v1(
    v_stop_a,
    'supervisor',
    '{}'::jsonb
  );

  PERFORM ok(
    v_envelope IS NOT NULL AND (v_envelope->>'customerName') = 'Hessa Al-Saud',
    'supervisor role bypass: same-org supervisor receives the envelope'
  );

  ------------------------------------------------------------------------
  -- Reset session JWT claims.
  ------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  ------------------------------------------------------------------------
  -- The surrounding pgTAP transaction rolls back these rows. Avoid explicit
  -- cleanup here because tenant onboarding triggers may create scoped sender
  -- rows whose RLS delete policy differs from this test's read persona.
  ------------------------------------------------------------------------
END $$;

SELECT * FROM finish();
ROLLBACK;

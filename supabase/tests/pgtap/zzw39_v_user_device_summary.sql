-- pgTAP: public.v_user_device_summary projection contract (shape/RLS/projection)
-- Spec-Issue: W39 — REAUDIT4/REAUDIT5 PLATFORM P1 carry-forward closure
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

-- 1) View exists.
SELECT has_view(
  'public', 'v_user_device_summary',
  'public.v_user_device_summary view exists'
);

-- 2) View exposes the canonical FE-projection columns.
SELECT columns_are(
  'public', 'v_user_device_summary',
  ARRAY[
    'id', 'organization_id', 'user_id',
    'device_platform', 'device_identifier_sha256', 'device_label',
    'app_version', 'os_version',
    'last_seen_at', 'revoked_at', 'revoked_by_user_id',
    'revoked_reason', 'is_revoked', 'push_token_cleared',
    'created_at', 'updated_at',
    'platform', 'device_id',
    'model', 'attestation_status', 'attestation_trusted_at',
    'is_attestation_trusted', 'is_attestation_pending',
    'is_attestation_failed', 'is_attestation_revoked',
    'metadata'
  ],
  'v_user_device_summary exposes FE-projection columns'
);

-- 3) View is created with security_invoker = true (W35d posture).
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'v_user_device_summary'
       AND c.relkind = 'v'
       AND COALESCE(c.reloptions, '{}'::TEXT[]) @> ARRAY['security_invoker=true']
  ),
  'v_user_device_summary is created WITH (security_invoker = true)'
);

-- 4) Service-role baseline grant.
SELECT ok(
  has_table_privilege('service_role', 'public.v_user_device_summary', 'SELECT'),
  'service_role has SELECT on v_user_device_summary'
);

-- 5) anon has no SELECT (least-privilege parity with W23 paired views).
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_user_device_summary', 'SELECT'),
  'anon has no SELECT on v_user_device_summary'
);

-- 6) authenticated has SELECT (registry-driven hooks read through this seam).
SELECT ok(
  has_table_privilege('authenticated', 'public.v_user_device_summary', 'SELECT'),
  'authenticated has SELECT on v_user_device_summary'
);

-- 7) Underlying base table remains SSOT (the view does not replace user_devices).
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'user_devices'
       AND c.relkind = 'r'
  ),
  'public.user_devices remains a base table (SSOT preserved)'
);

-- 8) Projection: insert a user_devices row with metadata.attestation jsonb,
--    verify the view projects model + attestation_status + attestation_trusted_at
--    + the derived is_attestation_trusted boolean.
DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000039a000';
  v_user UUID := '00000000-0000-0000-0000-00000039a001';
  v_device UUID := '00000000-0000-0000-0000-00000039a002';
  v_model TEXT;
  v_status TEXT;
  v_trusted_at TIMESTAMPTZ;
  v_is_trusted BOOLEAN;
  v_revoked_at TIMESTAMPTZ;
  v_revoked_by UUID;
  v_revoked_reason TEXT;
  v_is_revoked BOOLEAN;
  v_push_token_cleared BOOLEAN;
  v_is_attestation_revoked BOOLEAN;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W39 Device Summary Org', 'w39-device-summary-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status,
    access_scope_type, access_scope_id, created_at
  )
  VALUES (
    v_user, v_org,
    'w39-device-test@example.invalid',
    'W39 Device Tester',
    'driver', 'active',
    'tenant', NULL, now()
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_devices (
    id, organization_id, user_id, device_platform,
    device_identifier_sha256, device_label, app_version, os_version,
    last_seen_at, push_token, metadata, created_at, updated_at
  )
  VALUES (
    v_device, v_org, v_user, 'android',
    'sha256_w39_device_test_001', 'Pixel 8 (W39 test)',
    '1.42.0', 'android 14',
    now(), 'push-token-before-revoke',
    jsonb_build_object(
      'model', 'Pixel 8',
      'attestation', jsonb_build_object(
        'status', 'trusted',
        'trusted_at', '2026-04-01T08:00:00Z'
      )
    ),
    now(), now()
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT model, attestation_status, attestation_trusted_at, is_attestation_trusted
    INTO v_model, v_status, v_trusted_at, v_is_trusted
    FROM public.v_user_device_summary
   WHERE id = v_device;

  PERFORM ok(
    v_model = 'Pixel 8'
      AND v_status = 'trusted'
      AND v_trusted_at = '2026-04-01T08:00:00Z'::TIMESTAMPTZ
      AND v_is_trusted = TRUE,
    'v_user_device_summary projects model + attestation_status + attestation_trusted_at + is_attestation_trusted'
  );

  UPDATE public.user_devices
     SET revoked_at = '2026-05-11T10:30:00Z'::TIMESTAMPTZ,
         revoked_by_user_id = v_user,
         revoked_reason = 'operator lost-phone test',
         push_token = NULL
   WHERE id = v_device;

  SELECT revoked_at, revoked_by_user_id, revoked_reason, is_revoked,
         push_token_cleared, is_attestation_revoked
    INTO v_revoked_at, v_revoked_by, v_revoked_reason, v_is_revoked,
         v_push_token_cleared, v_is_attestation_revoked
    FROM public.v_user_device_summary
   WHERE id = v_device;

  PERFORM ok(
    v_revoked_at = '2026-05-11T10:30:00Z'::TIMESTAMPTZ
      AND v_revoked_by = v_user
      AND v_revoked_reason = 'operator lost-phone test'
      AND v_is_revoked IS TRUE
      AND v_push_token_cleared IS TRUE
      AND v_is_attestation_revoked IS TRUE,
    'v_user_device_summary projects canonical revocation state and push-token clearance'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;

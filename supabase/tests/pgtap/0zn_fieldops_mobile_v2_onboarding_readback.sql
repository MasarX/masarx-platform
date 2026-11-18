-- Test Suite: FieldOps Mobile V2 onboarding/readiness readback
-- Validates resolve_fieldops_onboarding_readback_v1 reconciles the
-- authenticated driver's KYC, vehicle, cleaning, and pre-shift writes.

SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(27);

SELECT has_function(
  'public',
  'resolve_fieldops_onboarding_readback_v1',
  ARRAY['text','jsonb'],
  'public.resolve_fieldops_onboarding_readback_v1 exists'
);

SELECT has_function(
  'api',
  'resolve_fieldops_onboarding_readback_v1',
  ARRAY['text','jsonb'],
  'api.resolve_fieldops_onboarding_readback_v1 wrapper exists'
);

SELECT has_table(
  'public',
  'fieldops_v2_vehicle_photos',
  'public.fieldops_v2_vehicle_photos stores Mobile V2 vehicle photo evidence'
);

SELECT has_function(
  'public',
  'submit_fieldops_vehicle_photos_v1',
  ARRAY['jsonb','uuid'],
  'public.submit_fieldops_vehicle_photos_v1 exists'
);

SELECT has_function(
  'api',
  'submit_fieldops_vehicle_photos_v1',
  ARRAY['jsonb','uuid'],
  'api.submit_fieldops_vehicle_photos_v1 wrapper exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.resolve_fieldops_onboarding_readback_v1(text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.resolve_fieldops_onboarding_readback_v1(text,jsonb)', 'EXECUTE'),
  'public resolver grants authenticated and revokes anon'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.resolve_fieldops_onboarding_readback_v1(text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.resolve_fieldops_onboarding_readback_v1(text,jsonb)', 'EXECUTE'),
  'api resolver grants authenticated and revokes anon'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.submit_fieldops_vehicle_photos_v1(jsonb,uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'api.submit_fieldops_vehicle_photos_v1(jsonb,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.submit_fieldops_vehicle_photos_v1(jsonb,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.submit_fieldops_vehicle_photos_v1(jsonb,uuid)', 'EXECUTE'),
  'vehicle photo submit RPC grants authenticated and revokes anon'
);

SELECT ok(
  has_table_privilege('authenticated', 'public.fieldops_v2_vehicle_photos', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.fieldops_v2_vehicle_photos', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.fieldops_v2_vehicle_photos', 'SELECT'),
  'vehicle photo evidence table is RLS guarded and read-only to authenticated clients'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'fieldops_v2_vehicle_photos'
       AND c.relrowsecurity IS TRUE
  )
  AND EXISTS (
    SELECT 1
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'fieldops_v2_vehicle_photos'
       AND p.polname = 'fieldops_v2_vehicle_photos_select_policy'
  )
  AND EXISTS (
    SELECT 1
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'fieldops_v2_vehicle_photos'
       AND p.polname = 'fieldops_v2_vehicle_photos_insert_policy'
  ),
  'vehicle photo evidence table has RLS enabled with scoped select and insert policies'
);

CREATE TEMP TABLE pgtap_mobile_onboarding_ctx AS
SELECT
  gen_random_uuid() AS org_id,
  gen_random_uuid() AS client_id,
  gen_random_uuid() AS sender_id,
  gen_random_uuid() AS driver_id,
  gen_random_uuid() AS other_driver_id,
  gen_random_uuid() AS policy_version_id,
  gen_random_uuid() AS policy_setting_id,
  gen_random_uuid() AS doc_key,
  gen_random_uuid() AS license_key,
  gen_random_uuid() AS vehicle_key,
  gen_random_uuid() AS vehicle_photos_key,
  gen_random_uuid() AS cleaning_key,
  gen_random_uuid() AS pre_shift_key,
  gen_random_uuid() AS blocked_pre_shift_key,
  'SHIFT-PGTAP-ONBOARDING'::text AS shift_id,
  'SHIFT-PGTAP-ONBOARDING-BLOCKED'::text AS blocked_shift_id;

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{}', true);
END $$;

SELECT throws_ok(
  'SELECT public.resolve_fieldops_onboarding_readback_v1(''driver'', ''{}''::jsonb)',
  '42501'
);

DO $$
BEGIN
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
END $$;

INSERT INTO public.organizations (id, name, slug)
SELECT org_id, 'pgTAP mobile onboarding readback', 'pgt-mobile-onboard-' || substr(org_id::text, 1, 8)
FROM pgtap_mobile_onboarding_ctx
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  PERFORM set_config('app.organization_onboarding_source', '', true);
END $$;

INSERT INTO public.clients (id, organization_id, name, slug, status)
SELECT client_id, org_id, 'pgTAP mobile onboarding client', 'pgt-mobile-onboard-c-' || substr(client_id::text, 1, 8), 'active'
FROM pgtap_mobile_onboarding_ctx
ON CONFLICT DO NOTHING;

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
SELECT sender_id, client_id, 'pgTAP mobile onboarding sender', 'pgTAP mobile onboarding sender', TRUE, 'active'
FROM pgtap_mobile_onboarding_ctx
ON CONFLICT DO NOTHING;

SELECT public.bootstrap_tenant_onboarding_v1(
  org_id,
  'pgtap:fieldops-mobile-onboarding-readback-fixture-bootstrap'
)
FROM pgtap_mobile_onboarding_ctx;

INSERT INTO public.users (id, organization_id, email, full_name, status)
SELECT driver_id, org_id, 'pgt-mobile-onboard-' || substr(driver_id::text, 1, 8) || '@e.test', 'Onboarding Driver', 'active'
FROM pgtap_mobile_onboarding_ctx
UNION ALL
SELECT other_driver_id, org_id, 'pgt-mobile-onboard-' || substr(other_driver_id::text, 1, 8) || '@e.test', 'Other Driver', 'active'
FROM pgtap_mobile_onboarding_ctx
ON CONFLICT DO NOTHING;

UPDATE public.settings_versions sv
   SET effective_until = GREATEST(now(), sv.effective_from + interval '1 millisecond')
  FROM pgtap_mobile_onboarding_ctx ctx
 WHERE sv.category = 'mobile_pre_shift_gate_policy'
   AND sv.scope_type = 'tenant'
   AND sv.scope_hash = ctx.org_id
   AND sv.effective_until IS NULL;

WITH policy AS (
  SELECT
    org_id,
    policy_version_id,
    policy_setting_id,
    jsonb_build_object(
      'version', 1,
      'photo_cadence_hours', 168,
      'cleaning_cadence_hours', 24,
      'health_attestation', TRUE,
      'required_documents', jsonb_build_array(
        'national_id',
        'driving_licence',
        'vehicle_registration',
        'vehicle_photos'
      ),
      'vehicle_photo_angles', jsonb_build_array('front', 'rear', 'left', 'right'),
      'cleaning_items', jsonb_build_array(
        jsonb_build_object('id', 'cabin', 'label', 'Cabin', 'sub', 'Dashboard and seats'),
        jsonb_build_object('id', 'cargo', 'label', 'Cargo bay', 'sub', 'Sweep and sanitize'),
        jsonb_build_object('id', 'glass', 'label', 'Glass', 'sub', 'Windscreen and mirrors')
      )
    ) AS policy_value
  FROM pgtap_mobile_onboarding_ctx
), version_row AS (
  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from,
    effective_until
  )
  SELECT
    policy_version_id,
    'mobile_pre_shift_gate_policy',
    'tenant',
    org_id,
    org_id,
    1,
    policy_value,
    1,
    'pgTAP Mobile V2 onboarding readback policy',
    now(),
    now(),
    NULL
  FROM policy
  RETURNING id, scope_id, scope_hash, value
)
INSERT INTO public.settings (
  id,
  category,
  scope_type,
  scope_id,
  scope_hash,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  policy.policy_setting_id,
  'mobile_pre_shift_gate_policy',
  'tenant',
  version_row.scope_id,
  version_row.scope_hash,
  version_row.id,
  version_row.value,
  now()
FROM policy
JOIN version_row ON version_row.id = policy.policy_version_id
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

DO $$
DECLARE
  v_driver_id UUID;
BEGIN
  SELECT driver_id INTO v_driver_id FROM pgtap_mobile_onboarding_ctx;
  PERFORM set_config('request.jwt.claim.sub', v_driver_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_driver_id::text, 'role', 'authenticated')::text,
    true
  );
END $$;

SELECT ok(
  public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)->'latest_cleaning' = 'null'::jsonb
  AND public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)->'latest_pre_shift' = 'null'::jsonb
  AND (public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)#>>'{requirements,cleaning_required}')::boolean IS TRUE,
  'onboarding readback starts empty and requires cleaning'
);

SELECT throws_like(
  $$
    SELECT public.pass_fieldops_pre_shift_gate_v1('SHIFT-PGTAP-BEFORE-READY', TRUE, gen_random_uuid())
  $$,
  '%requires completed Mobile V2 onboarding and cleaning readiness%',
  'pre-shift clearance fails closed before onboarding, vehicle photos, and cleaning are complete'
);

SELECT throws_like(
  $$
    SELECT public.record_fieldops_cleaning_check_v1(ARRAY['cabin', 'cargo'], 'cleaning/partial.jpg', gen_random_uuid())
  $$,
  '%missing configured cleaning items%',
  'cleaning write rejects partial row-driven cleaning item attestations'
);

SELECT throws_like(
  $$
    SELECT public.submit_fieldops_vehicle_photos_v1(
      jsonb_build_object(
        'front', 'vehicle/front.jpg',
        'rear', 'vehicle/rear.jpg',
        'left', 'vehicle/left.jpg'
      ),
      gen_random_uuid()
    )
  $$,
  '%missing configured angle paths%',
  'vehicle photo write rejects missing row-driven angle evidence'
);

CREATE TEMP TABLE pgtap_mobile_onboarding_writes AS
SELECT
  public.submit_fieldops_kyc_doc_v1('idDoc', 'kyc/id-front.jpg', doc_key) AS doc_payload,
  public.submit_fieldops_kyc_doc_v1('licenseDoc', 'kyc/license-front.jpg', license_key) AS license_payload,
  public.submit_fieldops_kyc_vehicle_v1('ABC-123', 'VIN00000001', '2026', 'Toyota Hiace', 'kyc/istimara.jpg', vehicle_key) AS vehicle_payload,
  public.submit_fieldops_vehicle_photos_v1(
    jsonb_build_object(
      'front', 'vehicle/front.jpg',
      'rear', 'vehicle/rear.jpg',
      'left', 'vehicle/left.jpg',
      'right', 'vehicle/right.jpg'
    ),
    vehicle_photos_key
  ) AS vehicle_photos_payload,
  public.record_fieldops_cleaning_check_v1(ARRAY['cabin', 'cargo', 'glass'], 'cleaning/cargo.jpg', cleaning_key) AS cleaning_payload,
  public.pass_fieldops_pre_shift_gate_v1(shift_id, TRUE, pre_shift_key) AS pre_shift_payload
FROM pgtap_mobile_onboarding_ctx;

SELECT ok(
  (public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)->'latest_cleaning'->>'check_id') = (cleaning_payload->>'check_id')
  AND (public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)->'latest_cleaning'->>'decision_log_id') = (cleaning_payload->>'decision_log_id')
  AND (public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)->'latest_cleaning'->>'state') = 'attested'
  AND (public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)#>>'{requirements,cleaning_required}')::boolean IS FALSE,
  'public resolver returns same-driver latest cleaning readback'
)
FROM pgtap_mobile_onboarding_writes;

SELECT ok(
  (public.resolve_fieldops_onboarding_readback_v1('driver', jsonb_build_object('shift_id', shift_id))->'latest_pre_shift'->>'pass_id') = (pre_shift_payload->>'pass_id')
  AND (public.resolve_fieldops_onboarding_readback_v1('driver', jsonb_build_object('shift_id', shift_id))->'latest_pre_shift'->>'decision_log_id') = (pre_shift_payload->>'decision_log_id')
  AND (public.resolve_fieldops_onboarding_readback_v1('driver', jsonb_build_object('shift_id', shift_id))->'latest_pre_shift'->>'state') = 'cleared',
  'public resolver returns same-shift pre-shift readback'
)
FROM pgtap_mobile_onboarding_ctx, pgtap_mobile_onboarding_writes;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)->'documents') doc
     WHERE doc->>'doc_id' = (doc_payload->>'doc_id')
  )
  AND EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)->'documents') doc
     WHERE doc->>'doc_id' = (license_payload->>'doc_id')
  )
  AND (public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)->'latest_vehicle'->>'vehicle_id') = (vehicle_payload->>'vehicle_id')
  AND (public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)->'latest_vehicle_photos'->>'photo_set_id') = (vehicle_photos_payload->>'photo_set_id')
  AND (public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)#>>'{requirements,vehicle_submitted}')::boolean IS TRUE,
  'public resolver returns same-driver KYC, vehicle, and vehicle-photo readback'
)
FROM pgtap_mobile_onboarding_writes;

SELECT ok(
  (public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)#>>'{requirements,docs_complete}')::boolean IS TRUE
  AND (public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)#>>'{requirements,required_documents_count}')::int = 4
  AND (public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)#>>'{requirements,required_documents_satisfied_count}')::int = 4,
  'public resolver marks row-driven required documents complete only after docs and vehicle evidence exist'
);

SELECT ok(
  (public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)#>>'{requirements,vehicle_photos_submitted}')::boolean IS TRUE
  AND (public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)#>>'{requirements,required_vehicle_photo_count}')::int = 4
  AND public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)#>>'{latest_vehicle_photos,angle_paths,front}' = 'vehicle/front.jpg'
  AND public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)#>>'{latest_vehicle_photos,angle_paths,rear}' = 'vehicle/rear.jpg'
  AND public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)#>>'{latest_vehicle_photos,angle_paths,left}' = 'vehicle/left.jpg'
  AND public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)#>>'{latest_vehicle_photos,angle_paths,right}' = 'vehicle/right.jpg',
  'public resolver exposes policy-counted vehicle photo requirements and angle paths'
);

SELECT ok(
  (public.submit_fieldops_vehicle_photos_v1(
    jsonb_build_object(
      'front', 'vehicle/front.jpg',
      'rear', 'vehicle/rear.jpg',
      'left', 'vehicle/left.jpg',
      'right', 'vehicle/right.jpg'
    ),
    vehicle_photos_key
  )->>'decision_log_id') = (vehicle_photos_payload->>'decision_log_id')
  AND (public.submit_fieldops_vehicle_photos_v1(
    jsonb_build_object(
      'front', 'vehicle/front.jpg',
      'rear', 'vehicle/rear.jpg',
      'left', 'vehicle/left.jpg',
      'right', 'vehicle/right.jpg'
    ),
    vehicle_photos_key
  )->>'state') = 'replayed',
  'vehicle photo submit replays the existing decision for the same idempotency key'
)
FROM pgtap_mobile_onboarding_ctx, pgtap_mobile_onboarding_writes;

SELECT ok(
  (api.submit_fieldops_vehicle_photos_v1(
    jsonb_build_object(
      'front', 'vehicle/front.jpg',
      'rear', 'vehicle/rear.jpg',
      'left', 'vehicle/left.jpg',
      'right', 'vehicle/right.jpg'
    ),
    vehicle_photos_key
  )->>'decision_log_id') = (vehicle_photos_payload->>'decision_log_id')
  AND (api.submit_fieldops_vehicle_photos_v1(
    jsonb_build_object(
      'front', 'vehicle/front.jpg',
      'rear', 'vehicle/rear.jpg',
      'left', 'vehicle/left.jpg',
      'right', 'vehicle/right.jpg'
    ),
    vehicle_photos_key
  )->>'state') = 'replayed',
  'api vehicle photo wrapper executes and replays the existing decision'
)
FROM pgtap_mobile_onboarding_ctx, pgtap_mobile_onboarding_writes;

SELECT ok(
  (api.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)->'latest_cleaning'->>'decision_log_id') = (cleaning_payload->>'decision_log_id')
  AND (api.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)->'latest_pre_shift'->>'decision_log_id') = (pre_shift_payload->>'decision_log_id')
  AND (api.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)->'latest_vehicle_photos'->>'decision_log_id') = (vehicle_photos_payload->>'decision_log_id'),
  'api wrapper returns same latest onboarding readback'
)
FROM pgtap_mobile_onboarding_writes;

SELECT ok(
  api.resolve_fieldops_onboarding_readback_v1('driver', jsonb_build_object('shift_id', 'OTHER-SHIFT'))->'latest_pre_shift' = 'null'::jsonb,
  'pre-shift readback is shift-filtered when context supplies shift_id'
);

CREATE TEMP TABLE pgtap_mobile_onboarding_blocked_gate AS
SELECT
  public.pass_fieldops_pre_shift_gate_v1(blocked_shift_id, FALSE, blocked_pre_shift_key) AS blocked_payload,
  blocked_shift_id
FROM pgtap_mobile_onboarding_ctx;

SELECT ok(
  (public.resolve_fieldops_onboarding_readback_v1('driver', jsonb_build_object('shift_id', blocked_shift_id))->'latest_pre_shift'->>'decision_log_id') = (blocked_payload->>'decision_log_id')
  AND (public.resolve_fieldops_onboarding_readback_v1('driver', jsonb_build_object('shift_id', blocked_shift_id))->'latest_pre_shift'->>'state') = 'blocked_health'
  AND (public.resolve_fieldops_onboarding_readback_v1('driver', jsonb_build_object('shift_id', blocked_shift_id))#>>'{requirements,pre_shift_cleared}')::boolean IS FALSE,
  'pre-shift readback keeps health-blocked gates uncleared'
)
FROM pgtap_mobile_onboarding_blocked_gate;

UPDATE public.fieldops_v2_cleaning_checks c
   SET created_at = now() - interval '48 hours'
  FROM pgtap_mobile_onboarding_writes w
 WHERE c.id = (w.cleaning_payload->>'check_id')::uuid;

SELECT ok(
  public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)->'latest_cleaning' <> 'null'::jsonb
  AND (public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)#>>'{requirements,cleaning_attested}')::boolean IS FALSE
  AND (public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)#>>'{requirements,cleaning_required}')::boolean IS TRUE,
  'public resolver keeps stale cleaning readback visible but readiness uncleared after cadence expiry'
);

DO $$
DECLARE
  v_other_driver_id UUID;
BEGIN
  SELECT other_driver_id INTO v_other_driver_id FROM pgtap_mobile_onboarding_ctx;
  PERFORM set_config('request.jwt.claim.sub', v_other_driver_id::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_other_driver_id::text, 'role', 'authenticated')::text,
    true
  );
END $$;

SELECT ok(
  public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)->'latest_cleaning' = 'null'::jsonb
  AND public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)->'latest_vehicle' = 'null'::jsonb
  AND public.resolve_fieldops_onboarding_readback_v1('driver', '{}'::jsonb)->'latest_pre_shift' = 'null'::jsonb,
  'onboarding readback is scoped to the submitting driver'
);

SELECT * FROM finish();
ROLLBACK;

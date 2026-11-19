-- Test Suite: FieldOps Mobile V2 incident latest readback
-- Validates resolve_fieldops_latest_incident_v1 returns the authenticated
-- driver's latest submitted incident and stays scoped to that caller.

SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

SELECT has_function(
  'public',
  'resolve_fieldops_latest_incident_v1',
  ARRAY['text','jsonb'],
  'public.resolve_fieldops_latest_incident_v1 exists'
);

SELECT has_function(
  'api',
  'resolve_fieldops_latest_incident_v1',
  ARRAY['text','jsonb'],
  'api.resolve_fieldops_latest_incident_v1 wrapper exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.resolve_fieldops_latest_incident_v1(text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.resolve_fieldops_latest_incident_v1(text,jsonb)', 'EXECUTE'),
  'public resolver grants authenticated and revokes anon'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.resolve_fieldops_latest_incident_v1(text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.resolve_fieldops_latest_incident_v1(text,jsonb)', 'EXECUTE'),
  'api resolver grants authenticated and revokes anon'
);

CREATE TEMP TABLE pgtap_mobile_incident_ctx AS
SELECT
  gen_random_uuid() AS org_id,
  gen_random_uuid() AS client_id,
  gen_random_uuid() AS sender_id,
  gen_random_uuid() AS driver_id,
  gen_random_uuid() AS other_driver_id,
  gen_random_uuid() AS idempotency_key;

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{}', true);
END $$;

SELECT throws_ok(
  'SELECT public.resolve_fieldops_latest_incident_v1(''driver'', ''{}''::jsonb)',
  '42501'
);

DO $$
BEGIN
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
END $$;

INSERT INTO public.organizations (id, name, slug)
SELECT org_id, 'pgTAP mobile incident readback', 'pgt-mobile-inc-' || substr(org_id::text, 1, 8)
FROM pgtap_mobile_incident_ctx
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  PERFORM set_config('app.organization_onboarding_source', '', true);
END $$;

INSERT INTO public.clients (id, organization_id, name, slug, status)
SELECT client_id, org_id, 'pgTAP mobile incident client', 'pgt-mobile-inc-c-' || substr(client_id::text, 1, 8), 'active'
FROM pgtap_mobile_incident_ctx
ON CONFLICT DO NOTHING;

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
SELECT sender_id, client_id, 'pgTAP mobile incident sender', 'pgTAP mobile incident sender', TRUE, 'active'
FROM pgtap_mobile_incident_ctx
ON CONFLICT DO NOTHING;

SELECT public.bootstrap_tenant_onboarding_v1(
  org_id,
  'pgtap:fieldops-mobile-incident-readback-fixture-bootstrap'
)
FROM pgtap_mobile_incident_ctx;

INSERT INTO public.users (id, organization_id, email, full_name, status)
SELECT driver_id, org_id, 'pgt-mobile-inc-' || substr(driver_id::text, 1, 8) || '@e.test', 'Incident Driver', 'active'
FROM pgtap_mobile_incident_ctx
UNION ALL
SELECT other_driver_id, org_id, 'pgt-mobile-inc-' || substr(other_driver_id::text, 1, 8) || '@e.test', 'Other Driver', 'active'
FROM pgtap_mobile_incident_ctx
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  v_driver_id UUID;
BEGIN
  SELECT driver_id INTO v_driver_id FROM pgtap_mobile_incident_ctx;
  PERFORM set_config('request.jwt.claim.sub', v_driver_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_driver_id::text, 'role', 'authenticated')::text,
    true
  );
END $$;

SELECT ok(
  public.resolve_fieldops_latest_incident_v1('driver', '{}'::jsonb)->'latest_incident' = 'null'::jsonb,
  'latest incident readback is null before the driver submits'
);

CREATE TEMP TABLE pgtap_mobile_incident_write AS
SELECT public.submit_fieldops_incident_v1(
  'collision',
  NULL,
  'high',
  'Side impact at gate 4',
  NULL,
  idempotency_key
) AS payload
FROM pgtap_mobile_incident_ctx;

SELECT ok(
  (public.resolve_fieldops_latest_incident_v1('driver', '{}'::jsonb)->'latest_incident'->>'incident_id') = (payload->>'incident_id')
  AND (public.resolve_fieldops_latest_incident_v1('driver', '{}'::jsonb)->'latest_incident'->>'decision_log_id') = (payload->>'decision_log_id')
  AND (public.resolve_fieldops_latest_incident_v1('driver', '{}'::jsonb)->'latest_incident'->>'type_id') = 'collision'
  AND (public.resolve_fieldops_latest_incident_v1('driver', '{}'::jsonb)->'latest_incident'->>'severity') = 'high'
  AND (public.resolve_fieldops_latest_incident_v1('driver', '{}'::jsonb)->'latest_incident'->>'statement') = 'Side impact at gate 4',
  'public resolver returns latest incident matching the write decision'
)
FROM pgtap_mobile_incident_write;

SELECT ok(
  (api.resolve_fieldops_latest_incident_v1('driver', '{}'::jsonb)->'latest_incident'->>'incident_id') = (payload->>'incident_id')
  AND (api.resolve_fieldops_latest_incident_v1('driver', '{}'::jsonb)->'latest_incident'->>'decision_log_id') = (payload->>'decision_log_id'),
  'api wrapper returns the same latest incident readback'
)
FROM pgtap_mobile_incident_write;

DO $$
DECLARE
  v_other_driver_id UUID;
BEGIN
  SELECT other_driver_id INTO v_other_driver_id FROM pgtap_mobile_incident_ctx;
  PERFORM set_config('request.jwt.claim.sub', v_other_driver_id::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_other_driver_id::text, 'role', 'authenticated')::text,
    true
  );
END $$;

SELECT ok(
  public.resolve_fieldops_latest_incident_v1('driver', '{}'::jsonb)->'latest_incident' = 'null'::jsonb,
  'latest incident readback is scoped to the submitting driver'
);

DO $$
DECLARE
  v_driver_id UUID;
BEGIN
  SELECT driver_id INTO v_driver_id FROM pgtap_mobile_incident_ctx;
  PERFORM set_config('request.jwt.claim.sub', v_driver_id::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_driver_id::text, 'role', 'authenticated')::text,
    true
  );
END $$;

SELECT ok(
  (public.resolve_fieldops_latest_incident_v1('driver', '{}'::jsonb)->'latest_incident'->>'incident_id') = (payload->>'incident_id'),
  'submitting driver can still read the same latest incident'
)
FROM pgtap_mobile_incident_write;

SELECT * FROM finish();
ROLLBACK;

-- pgTAP: Console V2 webhook tester force-status lookup catalog.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

SELECT has_function(
  'api',
  'list_lookup_values_v1',
  ARRAY['text'],
  'api.list_lookup_values_v1(text) exists for browser lookup hydration'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions
     WHERE category = 'webhook_forced_status'
       AND owner_role = 'engineering'
       AND approval_policy = 'tier_1'
       AND is_mutable IS FALSE
  ),
  'webhook_forced_status lookup definition exists for live Console metadata hydration'
);

SELECT is(
  (
    SELECT string_agg(lv.value, ',' ORDER BY lv.sort_order)
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'webhook_forced_status'
       AND lv.status = 'active'
  ),
  'auto,200,400,422,500,503',
  'webhook_forced_status active values match the tester force-status selector'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'f5f1ce00-2100-4c21-9a54-7a7a00021001'::uuid,
  'Console V2 Webhook Forced Status Lookup Org',
  'console-v2-webhook-forced-status-lookup-org'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (
  id,
  organization_id,
  email,
  full_name,
  user_type,
  access_scope_type,
  access_scope_id,
  status
)
VALUES (
  'f5f1ce00-2100-4c21-9a54-7a7a00021002'::uuid,
  'f5f1ce00-2100-4c21-9a54-7a7a00021001'::uuid,
  'console-v2-webhook-forced-status-lookup@example.test',
  'Console V2 Webhook Forced Status Lookup Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('request.jwt.claim.sub', 'f5f1ce00-2100-4c21-9a54-7a7a00021002', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'f5f1ce00-2100-4c21-9a54-7a7a00021002',
    'role', 'authenticated',
    'email', 'console-v2-webhook-forced-status-lookup@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT is(
  (
    SELECT string_agg(row.value, ',' ORDER BY row.sort_order)
      FROM api.list_lookup_values_v1('webhook_forced_status') AS row
  ),
  'auto,200,400,422,500,503',
  'api lookup wrapper exposes webhook_forced_status to browser metadata hydration'
);

RESET ROLE;

SELECT is(
  (
    SELECT lv.metadata->>'target_status'
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'webhook_forced_status'
       AND lv.value = '200'
       AND lv.status = 'active'
  ),
  'succeeded',
  'HTTP 200 force option maps to succeeded processing_status'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'webhook_forced_status'
       AND lv.value IN ('400', '422', '500', '503')
       AND lv.metadata->>'target_status' IS DISTINCT FROM 'failed'
  ),
  'non-2xx force options map to failed processing_status'
);

SELECT is(
  (
    SELECT lv.metadata ? 'target_status'
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'webhook_forced_status'
       AND lv.value = 'auto'
       AND lv.status = 'active'
  ),
  false,
  'auto force option is a no-op sentinel without target_status metadata'
);

SELECT * FROM finish();

ROLLBACK;

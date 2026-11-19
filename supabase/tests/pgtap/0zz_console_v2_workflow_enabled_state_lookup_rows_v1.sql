-- pgTAP: Console V2 Workflows enabled-state lookup labels are API-visible.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'ec3d7b34-9154-46b9-ae2a-d0d124145f60'::uuid,
  'Console V2 Workflow Lookup Org',
  'console-v2-workflow-lookup-org'
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
  '78ca48d5-365c-4977-a18f-fe8b101afdfb'::uuid,
  'ec3d7b34-9154-46b9-ae2a-d0d124145f60'::uuid,
  'console-v2-workflow-lookups@example.test',
  'Console V2 Workflow Lookup Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('request.jwt.claim.sub', '78ca48d5-365c-4977-a18f-fe8b101afdfb', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '78ca48d5-365c-4977-a18f-fe8b101afdfb',
    'role', 'authenticated',
    'email', 'console-v2-workflow-lookups@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT is(
  (
    SELECT label
    FROM api.list_lookup_values_v1('workflow_binding_enabled_state') AS row
    WHERE value = 'enabled'
  ),
  'Enabled',
  'workflow_binding_enabled_state.enabled resolves for trigger bindings'
);

SELECT is(
  (
    SELECT label
    FROM api.list_lookup_values_v1('workflow_binding_enabled_state') AS row
    WHERE value = 'disabled'
  ),
  'Disabled',
  'workflow_binding_enabled_state.disabled resolves for trigger bindings'
);

SELECT is(
  (
    SELECT label
    FROM api.list_lookup_values_v1('workflow_schedule_enabled_state') AS row
    WHERE value = 'enabled'
  ),
  'Enabled',
  'workflow_schedule_enabled_state.enabled resolves for schedule triggers'
);

SELECT is(
  (
    SELECT label
    FROM api.list_lookup_values_v1('workflow_schedule_enabled_state') AS row
    WHERE value = 'paused'
  ),
  'Paused',
  'workflow_schedule_enabled_state.paused resolves for schedule triggers'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

INSERT INTO public.organizations (id, name, slug)
VALUES
  ('e9a51000-0000-4000-8000-00000000fac1', 'Egress Preview Tenant A', 'egress-preview-tenant-a'),
  ('e9a51000-0000-4000-8000-00000000fac2', 'Egress Preview Tenant B', 'egress-preview-tenant-b');

INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
VALUES (
  'e9a51000-0000-4000-8000-00000000fac3',
  'e9a51000-0000-4000-8000-00000000fac1',
  'egress-preview-approver@example.test',
  'Egress Preview Approver',
  'tenant_integrations_approver',
  'active',
  'tenant',
  NULL
);

SELECT set_config('request.jwt.claim.sub', 'e9a51000-0000-4000-8000-00000000fac3', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims', '{"sub":"e9a51000-0000-4000-8000-00000000fac3","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

-- Mutation: remove the tenant scope arguments from the guard.
SELECT throws_ok(
  $$ SELECT api.integration_plugin_egress_policy_preview_v1('e9a51000-0000-4000-8000-00000000fac2') $$,
  '42501',
  'Capability denied: integration_plugins.read',
  'an approver cannot preview another tenant egress policy'
);

-- Mutation: require platform scope for tenant preview.
SELECT lives_ok(
  $$ SELECT api.integration_plugin_egress_policy_preview_v1('e9a51000-0000-4000-8000-00000000fac1') $$,
  'an approver can preview their own tenant egress policy'
);

SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);

-- Mutation: remove the capability check on the org-less branch.
SELECT throws_ok(
  $$ SELECT api.integration_plugin_egress_policy_preview_v1() $$,
  '42501',
  'Capability denied: integration_plugins.read',
  'org-less preview requires plugin read capability'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SET LOCAL ROLE service_role;

-- Mutation: require a human subject for service-role preview.
SELECT lives_ok(
  $$ SELECT api.integration_plugin_egress_policy_preview_v1('e9a51000-0000-4000-8000-00000000fac2') $$,
  'service_role can preview tenant egress policy without a user subject'
);

RESET ROLE;

-- Mutation: restore the authenticated grant on the public preview implementation.
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.integration_plugin_egress_policy_preview_v1(uuid)', 'EXECUTE'),
  'authenticated cannot execute the public preview implementation directly'
);

-- Mutation: revoke authenticated execution of the API preview wrapper.
SELECT ok(
  has_function_privilege('authenticated', 'api.integration_plugin_egress_policy_preview_v1(uuid)', 'EXECUTE'),
  'authenticated can execute the API preview wrapper'
);

-- Mutation: grant runtime binding helper execution to anon or PUBLIC.
SELECT ok(
  NOT has_function_privilege('anon', 'public.integration_plugin_set_binding_runtime_enabled_v1(uuid,boolean,text,uuid)', 'EXECUTE'),
  'anon cannot execute the runtime binding helper'
);

-- Mutation: restore the direct authenticated runtime binding helper grant.
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.integration_plugin_set_binding_runtime_enabled_v1(uuid,boolean,text,uuid)', 'EXECUTE'),
  'authenticated cannot execute the runtime binding helper'
);

SELECT * FROM finish();

ROLLBACK;

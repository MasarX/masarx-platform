BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(12);

SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'ed552951-f2c5-45d2-8f9b-87eeb8d56920'::UUID,
  'Console V2 Live Registry Org',
  'console-v2-live-registry-ed552951'
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      slug = EXCLUDED.slug;

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
  '61edda8b-7164-4d1a-a803-e4ab0f5e9001'::UUID,
  'ed552951-f2c5-45d2-8f9b-87eeb8d56920'::UUID,
  'console-v2-marketing-intake@example.test',
  'Console V2 Marketing Intake Super Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      email = EXCLUDED.email,
      full_name = EXCLUDED.full_name,
      user_type = EXCLUDED.user_type,
      access_scope_type = EXCLUDED.access_scope_type,
      access_scope_id = EXCLUDED.access_scope_id,
      status = EXCLUDED.status;

CREATE TEMP TABLE tmp_console_marketing_recent_proof (
  body JSONB NOT NULL
) ON COMMIT DROP;

INSERT INTO tmp_console_marketing_recent_proof(body)
SELECT api.marketing_lead_request_create_v1(
  'console-marketing-recent-proof-202605291830@example.com',
  'Console Marketing Recent Proof',
  '10k-60k',
  'Ops',
  'Console marketing recent projection proof.',
  'en',
  'http://127.0.0.1:3333/#contact-sales',
  'http://127.0.0.1:3333/',
  'http://127.0.0.1:3333',
  jsonb_build_object('campaign', 'console-marketing-recent-proof'),
  'pgtap_marketing_recent_hash',
  TRUE
);

SELECT ok((body->>'ok') = 'true', 'marketing lead proof intake returns ok=true')
  FROM tmp_console_marketing_recent_proof;

SELECT ok(NULLIF(body->>'id', '') IS NOT NULL, 'marketing lead proof intake returns lead id')
  FROM tmp_console_marketing_recent_proof;

SELECT ok(NULLIF(body->>'task_id', '') IS NOT NULL, 'marketing lead proof intake returns follow-up task id')
  FROM tmp_console_marketing_recent_proof;

SELECT ok(NULLIF(body->>'dispatch_id', '') IS NOT NULL, 'marketing lead proof intake returns workflow dispatch id')
  FROM tmp_console_marketing_recent_proof;

GRANT SELECT ON TABLE tmp_console_marketing_recent_proof TO authenticated;

SELECT is(
  (
    SELECT r.company
      FROM public.marketing_demo_requests r
      JOIN tmp_console_marketing_recent_proof p
        ON r.id = NULLIF(p.body->>'id', '')::UUID
  ),
  'Console Marketing Recent Proof',
  'source lead row is persisted in marketing_demo_requests'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') AS item(value)
     WHERE item.value->>'key' = 'marketing_intake_recent'
       AND item.value->>'relation' = 'public.marketing_intake_recent_v1'
       AND item.value->>'capability_read' = 'webhooks.read'
  ),
  'marketing_intake_recent registry uses the Console intake read capability'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') AS item(value)
     WHERE item.value->>'key' = 'marketing_intake_metrics_24h'
       AND item.value->>'relation' = 'public.marketing_intake_metrics_24h'
       AND item.value->>'capability_read' = 'webhooks.read'
  ),
  'marketing_intake_metrics_24h registry uses the Console intake read capability'
);

SELECT set_config('request.jwt.claim.sub', '61edda8b-7164-4d1a-a803-e4ab0f5e9001', true);
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '61edda8b-7164-4d1a-a803-e4ab0f5e9001',
    'role', 'authenticated',
    'email', 'console-v2-marketing-intake@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

CREATE TEMP TABLE tmp_console_marketing_recent_listing AS
SELECT api.ui_list_resource_v1(
  'marketing_intake_recent',
  jsonb_build_object(
    'filter',
    jsonb_build_object('email', 'console-marketing-recent-proof-202605291830@example.com')
  ),
  5,
  0,
  NULL::jsonb
) AS body;

SELECT is(
  (
    SELECT row.value->>'id'
      FROM tmp_console_marketing_recent_listing l,
           LATERAL jsonb_array_elements(l.body->'items') AS row(value)
     LIMIT 1
  ),
  (
    SELECT body->>'id'
      FROM tmp_console_marketing_recent_proof
     LIMIT 1
  ),
  'Console marketing intake recent reads the marketing_demo_requests lead id'
);

SELECT is(
  (
    SELECT row.value->>'company'
      FROM tmp_console_marketing_recent_listing l,
           LATERAL jsonb_array_elements(l.body->'items') AS row(value)
     LIMIT 1
  ),
  'Console Marketing Recent Proof',
  'Console marketing intake recent exposes lead company'
);

SELECT is(
  (
    SELECT row.value->>'decision'
      FROM tmp_console_marketing_recent_listing l,
           LATERAL jsonb_array_elements(l.body->'items') AS row(value)
     LIMIT 1
  ),
  'accepted',
  'Console marketing intake recent exposes accepted decision'
);

SELECT ok(
  (
    SELECT NULLIF(row.value->>'task_id', '') IS NOT NULL
       AND NULLIF(row.value->>'dispatch_id', '') IS NOT NULL
       AND row.value ? 'workflow_run_id'
      FROM tmp_console_marketing_recent_listing l,
           LATERAL jsonb_array_elements(l.body->'items') AS row(value)
     LIMIT 1
  ),
  'Console marketing intake recent exposes task workflow and dispatch lineage'
);

SELECT ok(
  (
    SELECT (row.value->>'total')::INT >= 1
       AND (row.value->>'verified')::INT >= 1
      FROM api.ui_list_resource_v1(
        'marketing_intake_metrics_24h',
        '{}'::jsonb,
        1,
        0,
        NULL::jsonb
      ) AS metrics(body),
           LATERAL jsonb_array_elements(metrics.body->'items') AS row(value)
     LIMIT 1
  ),
  'Console marketing intake metrics derive from the lead projection'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;

-- pgTAP: Console V2 customer setup screens must use live backend projection
-- resources for client/sender/recipient context, not seed-only fallbacks.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(13);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('client_summary'),
      ('sender_summary'),
      ('recipient_directory')
    ) AS required(resource_key)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
      WHERE r.value->>'key' = required.resource_key
    )
  ),
  'platform ui_read_registry exposes customer projection resources'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'ui_read_registry'
      AND EXISTS (
        SELECT 1
        FROM (VALUES
          ('client_summary'),
          ('sender_summary'),
          ('recipient_directory')
        ) AS required(resource_key)
        WHERE NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) sr(value)
          WHERE sr.value->>'key' = required.resource_key
        )
      )
  ),
  'all scoped ui_read_registry rows expose customer projection resources'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('client_summary', 'public.v_client_summary', 'clients.read', 'organization_id'),
      ('sender_summary', 'public.v_sender_summary', 'senders.read', 'organization_id_resolved'),
      ('recipient_directory', 'public.v_recipient_directory', 'recipients.read', 'organization_id')
    ) AS expected(resource_key, relation_name, capability_read, tenant_scope_column)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
      WHERE r.value->>'key' = expected.resource_key
        AND r.value->>'relation' = expected.relation_name
        AND r.value->>'capability_read' = expected.capability_read
        AND r.value#>>'{scope_columns,tenant}' = expected.tenant_scope_column
    )
  ),
  'customer projection registry resources use canonical relations, capabilities, and tenant scope columns'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('client_summary', 'client', 'client_id'),
      ('sender_summary', 'client', 'client_id'),
      ('sender_summary', 'sender', 'sender_id'),
      ('recipient_directory', 'client', 'client_id')
    ) AS expected(resource_key, scope_type, scope_column)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
      WHERE r.value->>'key' = expected.resource_key
        AND r.value#>>ARRAY['scope_columns', expected.scope_type] = expected.scope_column
    )
  ),
  'customer projection registry resources declare non-tenant scope columns where the projection can be safely scoped'
);

SELECT throws_ok(
  $$ SELECT public.ui_read_scope_column_v1('{"scope_columns":{"tenant":"organization_id"}}'::jsonb, 'recipient_directory', 'sender', 'test_ui_read') $$,
  '42501',
  'test_ui_read resource recipient_directory missing sender scope column',
  'ui_read_scope_column_v1 fail-closes client/sender reads without a declared scope column'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('client_summary', 'organization_id', 'organization_id'),
      ('sender_summary', 'organization_id_resolved', 'organization_id_resolved'),
      ('recipient_directory', 'organization_id', 'organization_id')
    ) AS expected(resource_key, filter_key, filter_column)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.value->'filters', '[]'::jsonb)) f(value)
      WHERE r.value->>'key' = expected.resource_key
        AND f.value->>'key' = expected.filter_key
        AND f.value->>'column' = expected.filter_column
        AND f.value->>'op' = 'eq'
    )
  ),
  'customer projection registry resources declare tenant-lens filters'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('v_client_summary'),
      ('v_sender_summary'),
      ('v_recipient_directory')
    ) AS expected(view_name)
    JOIN pg_class c ON c.relname = expected.view_name
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE NOT (COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true'])
  ),
  'customer projection views enforce security_invoker for RLS-backed generic reads'
);

DO $do$
DECLARE
  v_org UUID := 'c3caa1e9-e680-4f44-89d6-5b3cd41d6f01'::uuid;
  v_other_org UUID := 'b7bfc6f7-3e6e-4fd4-a5b2-d8e5135452d1'::uuid;
  v_user UUID := '13d20795-e891-42b5-bf7f-b2dcadbbbd5f'::uuid;
  v_client UUID := 'b3d69c52-f718-46f5-a746-977bcb01282b'::uuid;
  v_sender UUID := '4b1b4bfb-a294-4fc3-ae91-ae74303cf833'::uuid;
  v_recipient UUID := 'c191f034-fc46-4014-bf2d-00c72da2491f'::uuid;
  v_client_user UUID := '7d73faf1-1e69-4f56-8f73-24a6e18a7b43'::uuid;
  v_sender_user UUID := '880a9a0a-8bd2-44ee-8d51-299fc43238f0'::uuid;
  v_body JSONB;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Console V2 Customer Projection Org', 'console-v2-customer-projection-org'),
    (v_other_org, 'Console V2 Customer Projection Other Org', 'console-v2-customer-projection-other-org')
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
    v_user,
    v_org,
    'console-v2-customer-projection-admin@example.test',
    'Console V2 Customer Projection Admin',
    'super_admin',
    'platform',
    NULL,
    'active'
  )
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      user_type = EXCLUDED.user_type,
      access_scope_type = EXCLUDED.access_scope_type,
      access_scope_id = EXCLUDED.access_scope_id,
      status = EXCLUDED.status;

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
    v_client_user,
    v_org,
    'console-v2-customer-projection-client-admin@example.test',
    'Console V2 Customer Projection Client Admin',
    'client_admin',
    'client',
    v_client,
    'active'
  )
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      user_type = EXCLUDED.user_type,
      access_scope_type = EXCLUDED.access_scope_type,
      access_scope_id = EXCLUDED.access_scope_id,
      status = EXCLUDED.status;

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
    v_sender_user,
    v_org,
    'console-v2-customer-projection-sender-user@example.test',
    'Console V2 Customer Projection Sender User',
    'sender_user',
    'sender',
    v_sender,
    'active'
  )
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      user_type = EXCLUDED.user_type,
      access_scope_type = EXCLUDED.access_scope_type,
      access_scope_id = EXCLUDED.access_scope_id,
      status = EXCLUDED.status;

  INSERT INTO public.clients (id, organization_id, name, slug, status, sla_tier)
  VALUES (v_client, v_org, 'Console V2 Projection Client', 'console-v2-projection-client', 'active', 'standard')
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      name = EXCLUDED.name,
      slug = EXCLUDED.slug,
      status = EXCLUDED.status;

  INSERT INTO public.senders (id, client_id, name, brand_name, status)
  VALUES (v_sender, v_client, 'Console V2 Projection Sender', 'Projection Brand', 'active')
  ON CONFLICT (id) DO UPDATE
  SET client_id = EXCLUDED.client_id,
      name = EXCLUDED.name,
      brand_name = EXCLUDED.brand_name,
      status = EXCLUDED.status;

  INSERT INTO public.recipients (id, organization_id, client_id, name, phone_number, email)
  VALUES (v_recipient, v_org, v_client, 'Console V2 Projection Recipient', '+15550123001', 'projection-recipient@example.test')
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      client_id = EXCLUDED.client_id,
      name = EXCLUDED.name,
      phone_number = EXCLUDED.phone_number,
      email = EXCLUDED.email;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_user::text)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_body := public.ui_list_resource_v1(
    'client_summary',
    jsonb_build_object('organization_id', v_org::text),
    50,
    0,
    '[]'::jsonb
  );
  PERFORM ok(
    v_body->'items' @> jsonb_build_array(jsonb_build_object('client_id', v_client::text, 'organization_id', v_org::text)),
    'client_summary returns the active tenant client through ui_list_resource_v1'
  );

  v_body := public.ui_list_resource_v1(
    'sender_summary',
    jsonb_build_object('organization_id_resolved', v_org::text),
    50,
    0,
    '[]'::jsonb
  );
  PERFORM ok(
    v_body->'items' @> jsonb_build_array(jsonb_build_object('sender_id', v_sender::text, 'organization_id_resolved', v_org::text)),
    'sender_summary returns the active tenant sender through ui_list_resource_v1'
  );

  v_body := public.ui_list_resource_v1(
    'recipient_directory',
    jsonb_build_object('organization_id', v_org::text),
    50,
    0,
    '[]'::jsonb
  );
  PERFORM ok(
    v_body->'items' @> jsonb_build_array(jsonb_build_object('recipient_id', v_recipient::text, 'organization_id', v_org::text)),
    'recipient_directory returns the active tenant recipient through ui_list_resource_v1'
  );

  PERFORM set_config('request.jwt.claim.sub', v_client_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_client_user::text)::text, true);

  v_body := public.ui_list_resource_v1(
    'client_summary',
    '{}'::jsonb,
    50,
    0,
    '[]'::jsonb
  );
  PERFORM is(
    (v_body->>'total')::int,
    1,
    'client-scoped client_summary returns only the caller client'
  );

  PERFORM set_config('request.jwt.claim.sub', v_sender_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_sender_user::text)::text, true);

  v_body := public.ui_list_resource_v1(
    'sender_summary',
    '{}'::jsonb,
    50,
    0,
    '[]'::jsonb
  );
  PERFORM is(
    (v_body->>'total')::int,
    1,
    'sender-scoped sender_summary returns only the caller sender'
  );

  PERFORM throws_ok(
    $$ SELECT public.ui_list_resource_v1('recipient_directory', '{}'::jsonb, 50, 0, '[]'::jsonb) $$,
    '42501',
    'ui_list_resource_v1 resource recipient_directory missing sender scope column',
    'sender-scoped recipient_directory fails closed without a sender scope column'
  );

  EXECUTE 'RESET ROLE';
END $do$;

SELECT * FROM finish();

ROLLBACK;

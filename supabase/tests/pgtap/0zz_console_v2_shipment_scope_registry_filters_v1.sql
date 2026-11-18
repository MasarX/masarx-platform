-- pgTAP: Console V2 shipment lifecycle reads must accept explicit
-- tenant/client/sender filters through the canonical registry path.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('shipments', 'organization_id', 'organization_id'),
      ('shipments', 'client_id', 'client_id'),
      ('shipments', 'sender_id', 'sender_id'),
      ('shipment_directory', 'organization_id', 'organization_id'),
      ('shipment_directory', 'client_id', 'client_id'),
      ('shipment_directory', 'sender_id', 'sender_id'),
      ('service_offering_directory', 'organization_id', 'organization_id')
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
  'shipment lifecycle registry resources declare tenant/client/sender filters'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('shipments', 'organization_id'),
      ('shipment_directory', 'organization_id'),
      ('service_offering_directory', 'organization_id')
    ) AS expected(resource_key, tenant_scope_column)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
      WHERE r.value->>'key' = expected.resource_key
        AND r.value#>>'{scope_columns,tenant}' = expected.tenant_scope_column
    )
  ),
  'shipment lifecycle registry resources declare tenant scope columns'
);

DO $do$
DECLARE
  v_org UUID := 'db7e23cc-84d9-4822-9dfb-9b7c8e8f00aa'::uuid;
  v_other_org UUID := '1fe1e91f-a18b-4545-849b-0e47fca9435d'::uuid;
  v_user UUID := 'f73366d5-cf3c-43d2-8cd6-416a1d9f0f8f'::uuid;
  v_client UUID := '2a863b2c-8295-498b-9080-91c04ff83e1c'::uuid;
  v_other_client UUID := '3efe34ac-6e98-45c5-93d7-e3ca6fbc9bd9'::uuid;
  v_sender UUID := 'be91412f-b0c9-4840-a536-b83c59891a0c'::uuid;
  v_recipient UUID := '010e9c31-d90a-46f3-813e-8dafc8f507f9'::uuid;
  v_shipment UUID := 'e249c204-b148-41ff-905b-6a37df338161'::uuid;
  v_other_shipment UUID := 'e4f9f396-c22a-4580-9ae0-8327e3b78520'::uuid;
  v_body JSONB;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Console V2 Shipment Scope Org', 'console-v2-shipment-scope-org'),
    (v_other_org, 'Console V2 Shipment Scope Other Org', 'console-v2-shipment-scope-other-org')
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
    'console-v2-shipment-scope-admin@example.test',
    'Console V2 Shipment Scope Admin',
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

  INSERT INTO public.clients (id, organization_id, name, slug, status, sla_tier)
  VALUES
    (v_client, v_org, 'Console V2 Scope Client', 'console-v2-scope-client', 'active', 'standard'),
    (v_other_client, v_other_org, 'Console V2 Other Scope Client', 'console-v2-other-scope-client', 'active', 'standard')
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      name = EXCLUDED.name,
      slug = EXCLUDED.slug,
      status = EXCLUDED.status;

  INSERT INTO public.senders (id, client_id, name, brand_name, status)
  VALUES (v_sender, v_client, 'Console V2 Scope Sender', 'Scope Brand', 'active')
  ON CONFLICT (id) DO UPDATE
  SET client_id = EXCLUDED.client_id,
      name = EXCLUDED.name,
      brand_name = EXCLUDED.brand_name,
      status = EXCLUDED.status;

  INSERT INTO public.recipients (id, organization_id, client_id, name, phone_number, email)
  VALUES (v_recipient, v_org, v_client, 'Console V2 Scope Recipient', '+15550124001', 'scope-recipient@example.test')
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      client_id = EXCLUDED.client_id,
      name = EXCLUDED.name,
      phone_number = EXCLUDED.phone_number,
      email = EXCLUDED.email;

  DELETE FROM public.shipments
   WHERE id IN (v_shipment, v_other_shipment);

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    recipient_id,
    tracking_number,
    client_reference_number,
    service_type,
    status
  )
  VALUES (
    v_shipment,
    v_org,
    v_client,
    v_sender,
    v_recipient,
    'SHP-SCOPE-001',
    'REF-SCOPE-001',
    'delivery',
    'created'
  );

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    recipient_id,
    tracking_number,
    client_reference_number,
    service_type,
    status
  )
  VALUES (
    v_other_shipment,
    v_other_org,
    v_other_client,
    v_recipient,
    'SHP-SCOPE-OTHER',
    'REF-SCOPE-OTHER',
    'delivery',
    'created'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_user::text)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_body := public.ui_list_resource_v1(
    'shipments',
    jsonb_build_object('organization_id', v_org::text, 'client_id', v_client::text, 'sender_id', v_sender::text),
    50,
    0,
    '[]'::jsonb
  );
  PERFORM ok(
    v_body->'items' @> jsonb_build_array(jsonb_build_object('id', v_shipment::text, 'organization_id', v_org::text, 'client_id', v_client::text, 'sender_id', v_sender::text))
      AND NOT (v_body->'items' @> jsonb_build_array(jsonb_build_object('id', v_other_shipment::text))),
    'shipments list honors explicit tenant/client/sender filters'
  );

  v_body := public.ui_list_resource_v1(
    'shipment_directory',
    jsonb_build_object('organization_id', v_org::text, 'client_id', v_client::text, 'sender_id', v_sender::text),
    50,
    0,
    '[]'::jsonb
  );
  PERFORM ok(
    v_body->'items' @> jsonb_build_array(jsonb_build_object('id', v_shipment::text, 'organization_id', v_org::text, 'client_id', v_client::text, 'sender_id', v_sender::text))
      AND NOT (v_body->'items' @> jsonb_build_array(jsonb_build_object('id', v_other_shipment::text))),
    'shipment_directory list honors explicit tenant/client/sender filters'
  );

  EXECUTE 'RESET ROLE';
END $do$;

SELECT * FROM finish();

ROLLBACK;

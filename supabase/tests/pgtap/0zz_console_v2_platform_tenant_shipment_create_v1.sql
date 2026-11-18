-- pgTAP: Console V2 platform operators can create shipment previews for the
-- selected tenant lens without mutating the platform user's home org.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

DO $do$
DECLARE
  v_platform_org UUID := 'd6be3e5b-c437-4cf6-b025-c25f29ecb65d'::uuid;
  v_tenant_org UUID := 'd6e1f937-6d78-495b-9bdc-28204d6ef4ea'::uuid;
  v_platform_user UUID := '424e5784-6a2d-4716-9cad-879e9de79133'::uuid;
  v_tenant_user UUID := 'a67d5a93-7b15-48fd-9358-f57d4b94f77a'::uuid;
  v_client UUID := 'e29d4397-5be7-44f3-9d5e-3f4a105c9f19'::uuid;
  v_sender UUID := 'e62a1c0f-c912-49f9-9582-f35cde0063ea'::uuid;
  v_recipient UUID := 'ec31a7ab-16d8-42df-9187-d9f1d9d7f948'::uuid;
  v_body JSONB;
  v_error TEXT;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_platform_org, 'Console V2 Platform Shipment Org', 'console-v2-platform-shipment-org'),
    (v_tenant_org, 'Console V2 Tenant Shipment Org', 'console-v2-tenant-shipment-org')
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
  VALUES
    (
      v_platform_user,
      v_platform_org,
      'console-v2-platform-shipment-admin@example.test',
      'Console V2 Platform Shipment Admin',
      'super_admin',
      'platform',
      NULL,
      'active'
    ),
    (
      v_tenant_user,
      v_platform_org,
      'console-v2-tenant-spoof-admin@example.test',
      'Console V2 Tenant Spoof Admin',
      'ops_admin',
      'tenant',
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
  VALUES (v_client, v_tenant_org, 'Console V2 Tenant Create Client', 'console-v2-tenant-create-client', 'active', 'standard')
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      name = EXCLUDED.name,
      slug = EXCLUDED.slug,
      status = EXCLUDED.status;

  INSERT INTO public.senders (id, client_id, name, brand_name, status)
  VALUES (v_sender, v_client, 'Console V2 Tenant Create Sender', 'Tenant Create Brand', 'active')
  ON CONFLICT (id) DO UPDATE
  SET client_id = EXCLUDED.client_id,
      name = EXCLUDED.name,
      brand_name = EXCLUDED.brand_name,
      status = EXCLUDED.status;

  INSERT INTO public.recipients (id, organization_id, client_id, name, phone_number, email)
  VALUES (v_recipient, v_tenant_org, v_client, 'Console V2 Tenant Create Recipient', '+15550125001', 'tenant-create-recipient@example.test')
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      client_id = EXCLUDED.client_id,
      name = EXCLUDED.name,
      phone_number = EXCLUDED.phone_number,
      email = EXCLUDED.email;

  PERFORM set_config('request.jwt.claim.sub', v_platform_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_platform_user::text)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_body := public.ui_create_shipment_v1(
    v_client,
    v_sender,
    'delivery',
    NULL,
    'CONSOLE-V2-TENANT-LENS-001',
    NULL,
    'pending',
    jsonb_build_object(
      'dry_run', TRUE,
      'organization_id', v_tenant_org::text,
      'recipient_id', v_recipient::text
    )
  );

  PERFORM is(
    v_body->>'organization_id',
    v_tenant_org::text,
    'platform shipment create preview honors active tenant organization_id metadata'
  );

  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_tenant_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_tenant_user::text)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  BEGIN
    PERFORM public.ui_create_shipment_v1(
      v_client,
      v_sender,
      'delivery',
      NULL,
      'CONSOLE-V2-TENANT-SPOOF-001',
      NULL,
      'pending',
      jsonb_build_object(
        'dry_run', TRUE,
        'organization_id', v_tenant_org::text,
        'recipient_id', v_recipient::text
      )
    );
  EXCEPTION WHEN others THEN
    v_error := SQLERRM;
  END;

  PERFORM ok(
    COALESCE(v_error, '') LIKE '%organization_id is outside the current scope%',
    'non-platform shipment create cannot spoof organization_id metadata'
  );

  EXECUTE 'RESET ROLE';
END $do$;

SELECT * FROM finish();

ROLLBACK;

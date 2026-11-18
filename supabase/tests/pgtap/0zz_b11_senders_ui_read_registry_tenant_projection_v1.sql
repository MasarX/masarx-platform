-- pgTAP: senders generic UI reads must remain tenant-isolated through the
-- canonical security-invoker sender projection.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;

SELECT plan(13);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'v_sender_summary'
      AND c.relkind = 'v'
      AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
  ),
  'v_sender_summary remains security_invoker'
);

SELECT columns_are(
  'public',
  'v_sender_summary',
  ARRAY[
    'sender_id', 'id', 'client_id', 'name', 'brand_name',
    'auto_provisioned', 'auto_recreate', 'warehouse_address_id',
    'settings_override', 'status', 'updated_at', 'client_label',
    'client_slug', 'sla_tier_inherited', 'organization_id_resolved',
    'effective_warehouse_id', 'has_warehouse', 'active_shipments',
    'total_shipments', 'last_shipment_at', 'created_at'
  ],
  'v_sender_summary preserves existing columns and appends created_at'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL (
      VALUES (sv.value), (s.cached_value)
    ) AS payload(value)
    WHERE s.category = 'ui_read_registry'
      AND (
        (SELECT COUNT(*)
           FROM jsonb_array_elements(COALESCE(payload.value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'senders') <> 1
        OR NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(payload.value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'senders'
            AND resource->>'relation' = 'public.v_sender_summary'
            AND resource->>'allow_view_relation' = 'true'
            AND resource->'select' = '["id","client_id","name","brand_name","status","auto_provisioned","created_at"]'::jsonb
            AND resource->'default_sort' = '{"column":"created_at","direction":"desc"}'::jsonb
            AND resource->'scope_columns' = '{"tenant":"organization_id_resolved","client":"client_id","sender":"id"}'::jsonb
        )
      )
  ),
  'senders registry relation, select, sort, and scope columns are exact'
);

CREATE OR REPLACE FUNCTION pg_temp.test_b11_senders_ui_read_registry_tenant_projection_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
SECURITY INVOKER
AS $test$
DECLARE
  v_org UUID := gen_random_uuid();
  v_foreign_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_foreign_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_foreign_sender UUID := gen_random_uuid();
  v_created_at TIMESTAMPTZ := '2026-07-10 12:30:00+03'::timestamptz;
  v_foreign_client_slug TEXT := 'sender-isolation-foreign-' || left(gen_random_uuid()::text, 8);
  v_detail JSONB;
  v_list JSONB;
  v_values JSONB;
  v_metrics JSONB;
  v_client_detail JSONB;
  v_client_list JSONB;
  v_client_values JSONB;
  v_client_metrics JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug, billing_status)
  VALUES
    (v_org, 'Sender Isolation Tenant', 'sender-isolation-' || left(v_org::text, 8), 'active'),
    (v_foreign_org, 'Sender Isolation Foreign Tenant', 'sender-isolation-' || left(v_foreign_org::text, 8), 'active');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES
    (v_client, v_org, 'Sender Isolation Client', 'sender-isolation-client-' || left(v_client::text, 8), 'active'),
    (v_foreign_client, v_foreign_org, 'Sender Isolation Foreign Client', v_foreign_client_slug, 'active');

  INSERT INTO public.senders (id, client_id, name, status, created_at, updated_at)
  VALUES
    (v_sender, v_client, 'Sender Isolation Visible', 'active', v_created_at, v_created_at),
    (v_foreign_sender, v_foreign_client, 'Sender Isolation Hidden', 'active', v_created_at, v_created_at);

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    status,
    access_scope_type,
    access_scope_id
  )
  VALUES (
    v_user,
    v_org,
    'sender-isolation-' || left(v_user::text, 8) || '@example.test',
    'Sender Isolation Tenant User',
    'ops_admin',
    'active',
    'tenant',
    NULL
  );

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_user);

  INSERT INTO public.rbac_user_role_assignments (
    organization_id,
    user_id,
    role_id,
    assigned_by_user_id,
    metadata
  )
  SELECT
    v_org,
    v_user,
    r.id,
    v_user,
    jsonb_build_object('source', 'pgtap', 'contract', 'senders-tenant-isolation')
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'ops_admin';

  PERFORM set_config('request.jwt.claim.sub', v_user::text, TRUE);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text,
    TRUE
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT ok(
    public.user_has_resource_capability_v1('senders', 'read')
      AND public.user_has_resource_capability_v1('clients', 'read'),
    'tenant fixture has sender and client read capabilities'
  );

  v_detail := public.ui_get_resource_v1('senders', v_sender);
  RETURN NEXT ok(
    v_detail->>'id' = v_sender::text
      AND (v_detail->>'created_at')::timestamptz = v_created_at,
    'same-tenant sender exact-ID read works and exposes created_at'
  );

  v_list := public.ui_list_resource_v1(
    'senders',
    jsonb_build_object('client_id', v_client::text),
    10,
    0,
    NULL
  );
  RETURN NEXT ok(
    (v_list->>'total')::integer >= 1
      AND v_list->'items' @> jsonb_build_array(jsonb_build_object('id', v_sender::text)),
    'same-tenant sender list read works'
  );

  v_values := public.ui_filter_distinct_values_v1(
    'senders',
    'client_id',
    v_client::text,
    10
  );
  RETURN NEXT ok(
    v_values @> jsonb_build_array(v_client::text),
    'same-tenant sender filter selector read works'
  );

  v_metrics := public.ui_resource_metrics_v1(
    'senders',
    jsonb_build_object('client_id', v_client::text),
    NULL
  );
  RETURN NEXT is(
    (v_metrics->>'total')::integer,
    (v_list->>'total')::integer,
    'same-tenant sender metrics read works'
  );

  v_detail := public.ui_get_resource_v1('senders', v_foreign_sender);
  RETURN NEXT is(
    v_detail,
    NULL::jsonb,
    'foreign sender exact-ID read is hidden'
  );

  v_list := public.ui_list_resource_v1(
    'senders',
    jsonb_build_object('client_id', v_foreign_client::text),
    10,
    0,
    NULL
  );
  RETURN NEXT ok(
    (v_list->>'total')::integer = 0
      AND jsonb_array_length(v_list->'items') = 0,
    'foreign sender list read is hidden'
  );

  v_values := public.ui_filter_distinct_values_v1(
    'senders',
    'client_id',
    v_foreign_client::text,
    10
  );
  RETURN NEXT is(
    v_values,
    '[]'::jsonb,
    'foreign sender filter selector read is hidden'
  );

  v_metrics := public.ui_resource_metrics_v1(
    'senders',
    jsonb_build_object('client_id', v_foreign_client::text),
    NULL
  );
  RETURN NEXT is(
    (v_metrics->>'total')::integer,
    0,
    'foreign sender metrics read is hidden'
  );

  v_client_detail := public.ui_get_resource_v1('clients', v_foreign_client);
  v_client_list := public.ui_list_resource_v1('clients', '{}'::jsonb, 50, 0, NULL);
  v_client_values := public.ui_filter_distinct_values_v1(
    'clients',
    'slug',
    v_foreign_client_slug,
    10
  );
  v_client_metrics := public.ui_resource_metrics_v1(
    'clients',
    jsonb_build_object('slug', v_foreign_client_slug),
    NULL
  );

  RETURN NEXT ok(
    v_client_detail IS NULL
      AND NOT (v_client_list->'items' @> jsonb_build_array(jsonb_build_object('id', v_foreign_client::text)))
      AND v_client_values = '[]'::jsonb
      AND (v_client_metrics->>'total')::integer = 0,
    'foreign clients remain hidden across exact-ID, list, selector, and metrics reads'
  );

  EXECUTE 'RESET ROLE';
END;
$test$;

SELECT * FROM pg_temp.test_b11_senders_ui_read_registry_tenant_projection_v1();
SELECT * FROM finish();

-- All organizations, clients, senders, users, and RBAC fixtures are rolled back.
ROLLBACK;

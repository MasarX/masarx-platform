-- pgTAP: Console V2 first-tenant onboarding basket policy is operational.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(14);

CREATE OR REPLACE FUNCTION test_console_v2_onboarding_basket_policy_operational_default_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := '0fb09100-0000-0000-0000-000000000001'::uuid;
  v_client UUID := '0fb09100-0000-0000-0000-000000000101'::uuid;
  v_sender UUID := '0fb09100-0000-0000-0000-000000000201'::uuid;
  v_policy JSONB;
BEGIN
  SELECT s.cached_value
    INTO v_policy
    FROM public.settings s
   WHERE s.category = 'basket_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  RETURN NEXT ok(COALESCE((v_policy->>'enabled')::boolean, FALSE), 'global basket_policy is enabled for operational onboarding');
  RETURN NEXT ok(COALESCE((v_policy->>'create_if_missing')::boolean, FALSE), 'global basket_policy can create workflow-owned baskets');
  RETURN NEXT ok(NOT COALESCE((v_policy->>'require_zone')::boolean, TRUE), 'global basket_policy does not block first shipment sorting when zone is still pending');
  RETURN NEXT is((v_policy->>'capacity_count')::int, 50, 'global basket_policy has an operational default capacity');
  RETURN NEXT ok(v_policy->'open_states' ? 'forming', 'global basket_policy opens forming baskets');

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug, billing_status)
  VALUES (v_org, 'Basket Policy Operational Tenant', 'basket-policy-operational-tenant', 'active');

  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap-basket-policy-operational-default');

  SELECT s.cached_value
    INTO v_policy
    FROM public.settings s
   WHERE s.category = 'basket_policy'
     AND s.scope_type = 'tenant'
     AND s.scope_id = v_org
   LIMIT 1;

  RETURN NEXT ok(COALESCE((v_policy->>'enabled')::boolean, FALSE), 'tenant onboarding copies enabled basket_policy');
  RETURN NEXT ok(COALESCE((v_policy->>'create_if_missing')::boolean, FALSE), 'tenant onboarding copies create_if_missing basket_policy');
  RETURN NEXT ok(NOT COALESCE((v_policy->>'require_zone')::boolean, TRUE), 'tenant onboarding copies non-blocking require_zone default');

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Basket Policy Operational Client', 'basket-policy-operational-client', 'active');

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'Basket Policy Operational Sender', 'active');

  SELECT row.value
    INTO v_policy
    FROM public.resolve_settings_row_from_context(
      'basket_policy',
      jsonb_build_object(
        'organization_id', v_org,
        'client_id', v_client,
        'sender_id', v_sender
      )
    ) AS row
   LIMIT 1;

  RETURN NEXT ok(COALESCE((v_policy->>'enabled')::boolean, FALSE), 'sender/client context resolves enabled basket_policy through onboarding defaults');
  RETURN NEXT ok(COALESCE((v_policy->>'create_if_missing')::boolean, FALSE), 'sender/client context resolves create_if_missing basket_policy');
  RETURN NEXT ok(NOT COALESCE((v_policy->>'require_zone')::boolean, TRUE), 'sender/client context resolves non-blocking require_zone basket_policy');
  RETURN NEXT is((v_policy->>'capacity_count')::int, 50, 'sender/client context resolves operational basket capacity');
  RETURN NEXT ok(v_policy->'open_states' ? 'forming', 'sender/client context resolves forming basket state');

  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
        FROM public.settings s
       WHERE s.category = 'basket_policy'
         AND s.scope_type IN ('tenant', 'client', 'sender')
         AND s.scope_id IS NOT NULL
         AND lower(COALESCE(s.cached_value->>'enabled', 'false')) <> 'true'
         AND lower(COALESCE(s.cached_value->>'require_zone', 'true')) = 'true'
         AND (
           NOT (COALESCE(s.cached_value, '{}'::jsonb) ? 'basket_type')
           OR s.cached_value->'basket_type' = 'null'::jsonb
         )
         AND (
           NOT (COALESCE(s.cached_value, '{}'::jsonb) ? 'open_states')
           OR s.cached_value->'open_states' = 'null'::jsonb
         )
         AND (
           NOT (COALESCE(s.cached_value, '{}'::jsonb) ? 'capacity_count')
           OR s.cached_value->'capacity_count' = 'null'::jsonb
         )
         AND NOT (
           COALESCE(s.cached_value, '{}'::jsonb) ?| ARRAY[
             'group_by_branch',
             'group_by_service',
             'group_by_route',
             'branch_key_paths',
             'service_key_paths',
             'route_key_paths'
           ]
         )
    ),
    'old inert basket_policy rows are backfilled across tenant, client, and sender scopes'
  );

  RETURN;
END;
$function$;

SELECT * FROM test_console_v2_onboarding_basket_policy_operational_default_v1();
SELECT * FROM finish();

ROLLBACK;

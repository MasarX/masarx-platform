-- Console V2 first-tenant operations basket policy default.
--
-- Basket membership is workflow/policy-owned. A newly approved tenant must
-- have an enabled basket_policy so shipment resort and dispatch basket
-- contexts can be proven through the canonical workflow path instead of
-- direct basket_items writes.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605080740_console_v2_onboarding_basket_policy_operational_default_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_operational_default JSONB := jsonb_build_object(
    'version', 1,
    'enabled', TRUE,
    'basket_type', NULL,
    'open_states', jsonb_build_array('forming'),
    'create_if_missing', TRUE,
    'require_zone', FALSE,
    'expires_in_minutes', NULL,
    'capacity_count', 50
  );
  v_global_value JSONB := '{}'::jsonb;
  v_row RECORD;
  v_next JSONB;
BEGIN
  SELECT COALESCE(s.cached_value, '{}'::jsonb)
    INTO v_global_value
    FROM public.settings s
   WHERE s.category = 'basket_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  v_next := public.deep_merge_jsonb(COALESCE(v_global_value, '{}'::jsonb), v_operational_default);

  PERFORM public.upsert_settings_value_v1(
    'basket_policy',
    'global',
    NULL,
    v_next,
    1,
    'Console V2 first-tenant operations default: enable workflow-owned basket assignment.'
  );

  FOR v_row IN
    SELECT s.scope_type, s.scope_id, COALESCE(s.cached_value, '{}'::jsonb) AS value
      FROM public.settings s
      LEFT JOIN public.organizations tenant_org
        ON s.scope_type = 'tenant'
       AND tenant_org.id = s.scope_id
      LEFT JOIN public.clients client_scope
        ON s.scope_type = 'client'
       AND client_scope.id = s.scope_id
      LEFT JOIN public.organizations client_org
        ON client_org.id = client_scope.organization_id
      LEFT JOIN public.senders sender_scope
        ON s.scope_type = 'sender'
       AND sender_scope.id = s.scope_id
      LEFT JOIN public.clients sender_client
        ON sender_client.id = sender_scope.client_id
      LEFT JOIN public.organizations sender_org
        ON sender_org.id = sender_client.organization_id
     WHERE s.category = 'basket_policy'
       AND s.scope_type IN ('tenant', 'client', 'sender')
       AND s.scope_id IS NOT NULL
       AND COALESCE(tenant_org.billing_status, client_org.billing_status, sender_org.billing_status, 'active') IS DISTINCT FROM 'suspended'
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
  LOOP
    v_next := public.deep_merge_jsonb(v_row.value, v_operational_default);

    PERFORM public.upsert_settings_value_v1(
      'basket_policy',
      v_row.scope_type,
      v_row.scope_id,
      v_next,
      1,
      'Console V2 first-tenant operations backfill: enable workflow-owned basket assignment.'
    );
  END LOOP;
END;
$do$;

COMMENT ON FUNCTION workflow_handlers.execute_basket_assign_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Assign shipment to a basket using enabled, row-driven basket_policy settings. Console V2 production proof must use shipment resort/workflow paths, not direct basket_items writes.';

SELECT pg_advisory_unlock(hashtext('202605080740_console_v2_onboarding_basket_policy_operational_default_v1'));
COMMIT;

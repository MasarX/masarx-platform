-- pgTAP: Console V2 Integrations Catalog plugin lifecycle lookup/readback guard.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(18);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions
     WHERE category = 'plugin_status'
  ),
  'plugin_status lookup definition exists'
);

SELECT is(
  (
    SELECT count(*)::int
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'plugin_status'
       AND lv.value IN (
         'active',
         'pending',
         'degraded',
         'rollback',
         'disabled',
         'draft',
         'rejected',
         'submitted',
         'approved',
         'archived',
         'pending_review'
       )
       AND lv.status = 'active'
  ),
  11,
  'plugin_status covers plugin and version lifecycle rows'
);

SELECT is(
  (
    SELECT lv.metadata->>'tone'
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'plugin_status'
       AND lv.value = 'draft'
  ),
  'neutral',
  'draft status has a visible tone policy'
);

SELECT ok(
  (
    SELECT lv.metadata->'next_actions' ? 'submit'
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'plugin_status'
       AND lv.value = 'draft'
  ),
  'draft status exposes submit as next action'
);

SELECT ok(
  (
    SELECT lv.metadata->'next_actions' ? 'approve'
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'plugin_status'
       AND lv.value = 'submitted'
  ),
  'submitted status exposes approve as next action'
);

SELECT ok(
  (
    SELECT lv.metadata->'next_actions' ? 'activate'
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'plugin_status'
       AND lv.value = 'approved'
  ),
  'approved status exposes activate as next action'
);

SELECT ok(
  (
    SELECT COALESCE((lv.metadata->>'is_chip_visible')::boolean, FALSE)
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'plugin_status'
       AND lv.value = 'pending_review'
  ),
  'pending_review status remains chip-visible for catalog cards'
);

SELECT ok(
  jsonb_path_exists(
    public.ui_read_registry_v1(),
    '$.resources[*] ? (@.key == "integration_plugin_bindings" && @.relation == "public.v_integration_plugin_binding_directory")'
  ),
  'integration_plugin_bindings is registry-readable through redacted runtime binding readback'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'decision_category'
       AND lv.value = 'integration_plugin.set_binding'
       AND lv.status = 'active'
  ),
  'decision_category includes integration_plugin.set_binding for runtime binding audit'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'decision_outcome'
       AND lv.value = 'binding_enabled'
       AND lv.status = 'active'
  ),
  'decision_outcome includes binding_enabled for runtime binding audit'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'decision_outcome'
       AND lv.value = 'binding_disabled'
       AND lv.status = 'active'
  ),
  'decision_outcome includes binding_disabled for runtime binding audit'
);

SELECT has_function(
  'public',
  'integration_plugin_default_workflow_binding_v1',
  ARRAY['text', 'uuid'],
  'Plugin Studio default workflow binding resolver exists'
);

SELECT is(
  public.integration_plugin_default_workflow_binding_v1('api', NULL)->>'template_name',
  'api_gateway_shipment_create_default_v1',
  'api Plugin Studio drafts resolve an API Gateway workflow binding from policy'
);

SELECT is(
  public.integration_plugin_default_workflow_binding_v1('webhook', NULL)->>'template_name',
  'webhook_shipment_create_v1',
  'webhook Plugin Studio drafts resolve a webhook shipment workflow binding from policy'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'integration_plugin_policy'
       AND s.cached_value #>> '{studio_defaults,workflow_bindings,api,mode}' = 'attach_existing'
       AND s.cached_value #>> '{studio_defaults,workflow_bindings,api,template_name}' = 'api_gateway_shipment_create_default_v1'
  ),
  'integration_plugin_policy stores row-driven Plugin Studio workflow defaults'
);

SELECT ok(
  pg_get_functiondef('public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure)
    LIKE '%v_route_policy := jsonb_set(v_route_policy, ''{workflow}''%v_route_policy := jsonb_set(v_route_policy, ''{delivery}''%',
  'API plugin activation preserves the shared workflow and delivery parent writes'
);

SELECT ok(
  pg_get_functiondef('public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure)
    LIKE '%handler_key,%handler_version,%''outbound_http'',%''v1'',%',
  'API plugin activation writes outbound operation_templates with workflow handler metadata'
);

SELECT ok(
  pg_get_functiondef('public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure)
    LIKE '%integration_plugin_default_route_policy_v1(%{workflow,intent}%'
  AND pg_get_functiondef('public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure)
    LIKE '%''base_url'', v_provider_base_url%',
  'Console V2 activation retains route defaults, workflow intent and provider base URL'
);

SELECT * FROM finish();
ROLLBACK;

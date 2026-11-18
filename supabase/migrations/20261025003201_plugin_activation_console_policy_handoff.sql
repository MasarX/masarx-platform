-- Apply Console V2 route defaults and provider metadata to the canonical activation body.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $console_policy$
DECLARE
  v_target REGPROCEDURE := 'public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure;
  v_definition TEXT := pg_get_functiondef(v_target);
  v_patch RECORD;
  v_matches INTEGER;
BEGIN
  FOR v_patch IN SELECT * FROM (VALUES
    ($before1$    v_route_policy := COALESCE(v_version.inbound_config #> '{route,policy}', '{}'::jsonb);
    v_route_policy := jsonb_set(v_route_policy, '{workflow}',
      COALESCE(v_route_policy->'workflow', '{}'::jsonb) || jsonb_build_object(
        'enabled', TRUE, 'template_name', v_workflow_template_name), TRUE);
    v_route_policy := jsonb_set(v_route_policy, '{delivery}',
      COALESCE(v_route_policy->'delivery', '{}'::jsonb) || jsonb_build_object(
        'mode', 'accepted_async', 'status_code', 202), TRUE);$before1$,
     $after1$    v_route_policy := public.jsonb_deep_merge(
      public.integration_plugin_default_route_policy_v1(
        v_plugin.plugin_kind,
        COALESCE(v_version.workflow_binding, '{}'::jsonb),
        v_plugin.organization_id
      ),
      COALESCE(v_version.inbound_config #> '{route,policy}', '{}'::jsonb)
    );
    IF jsonb_typeof(v_route_policy) <> 'object' THEN
      v_route_policy := '{}'::jsonb;
    END IF;
    v_route_policy := jsonb_set(v_route_policy, '{workflow}',
      COALESCE(v_route_policy->'workflow', '{}'::jsonb) || jsonb_build_object(
        'enabled', TRUE, 'template_name', v_workflow_template_name), TRUE);
    v_route_policy := jsonb_set(v_route_policy, '{delivery}',
      COALESCE(v_route_policy->'delivery', '{}'::jsonb) || jsonb_build_object(
        'mode', 'accepted_async', 'status_code', 202), TRUE);
    IF NULLIF(btrim(COALESCE(v_version.workflow_binding->>'intent', '')), '') IS NOT NULL THEN
      v_route_policy := jsonb_set(v_route_policy, '{workflow,intent}', to_jsonb(NULLIF(btrim(v_version.workflow_binding->>'intent'), '')), TRUE);
    END IF;$after1$,
     1),
    ($before2$      'healthy',
      jsonb_build_object(
        'managed_by', 'integration_plugin',
        'plugin_id', v_plugin.id,
        'plugin_version_id', v_version.id
      )$before2$,
     $after2$      'healthy',
      jsonb_strip_nulls(jsonb_build_object(
        'managed_by', 'integration_plugin',
        'plugin_id', v_plugin.id,
        'plugin_version_id', v_version.id,
        'base_url', v_provider_base_url
      ))$after2$,
     1),
    ($before3$        'healthy',
        jsonb_build_object(
          'managed_by', 'integration_plugin',
          'plugin_id', v_plugin.id,
          'plugin_version_id', v_version.id
        )$before3$,
     $after3$        'healthy',
        jsonb_strip_nulls(jsonb_build_object(
          'managed_by', 'integration_plugin',
          'plugin_id', v_plugin.id,
          'plugin_version_id', v_version.id,
          'base_url', v_provider_base_url
        ))$after3$,
     1)
  ) AS patches(prior, replacement, expected_count)
  LOOP
    v_matches := (length(v_definition) - length(replace(v_definition, v_patch.prior, '')))
      / length(v_patch.prior);
    IF v_matches IS DISTINCT FROM v_patch.expected_count THEN
      RAISE EXCEPTION 'Unexpected integration plugin activation definition during consolidation: %', v_target;
    END IF;
    v_definition := replace(v_definition, v_patch.prior, v_patch.replacement);
  END LOOP;
  EXECUTE v_definition;
END;
$console_policy$;
COMMIT;

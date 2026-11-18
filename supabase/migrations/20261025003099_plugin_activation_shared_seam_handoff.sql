-- Present the native route and materialization seams to the canonical migrations.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $handoff$
DECLARE
  v_target REGPROCEDURE := 'public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure;
  v_definition TEXT := pg_get_functiondef(v_target);
  v_patch RECORD;
  v_matches INTEGER;
BEGIN
  FOR v_patch IN SELECT * FROM (VALUES
    ($before1$    v_route_policy := public.jsonb_deep_merge(
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
    v_route_policy := v_route_policy || jsonb_build_object(
      'workflow', COALESCE(v_route_policy->'workflow', '{}'::jsonb),
      'delivery', COALESCE(v_route_policy->'delivery', '{}'::jsonb)
    );
    v_route_policy := jsonb_set(v_route_policy, '{workflow,enabled}', 'true'::jsonb, TRUE);
    v_route_policy := jsonb_set(v_route_policy, '{workflow,template_name}', to_jsonb(v_workflow_template_name), TRUE);
    IF NULLIF(btrim(COALESCE(v_version.workflow_binding->>'intent', '')), '') IS NOT NULL THEN
      v_route_policy := jsonb_set(v_route_policy, '{workflow,intent}', to_jsonb(NULLIF(btrim(v_version.workflow_binding->>'intent'), '')), TRUE);
    END IF;
    v_route_policy := jsonb_set(v_route_policy, '{delivery,mode}', '"accepted_async"'::jsonb, TRUE);
    v_route_policy := jsonb_set(v_route_policy, '{delivery,status_code}', '202'::jsonb, TRUE);$before1$,
     $after1$    v_route_policy := COALESCE(v_version.inbound_config #> '{route,policy}', '{}'::jsonb);
    v_route_policy := jsonb_set(v_route_policy, '{workflow,enabled}', 'true'::jsonb, TRUE);
    v_route_policy := jsonb_set(v_route_policy, '{workflow,template_name}', to_jsonb(v_workflow_template_name), TRUE);
    v_route_policy := jsonb_set(v_route_policy, '{delivery,mode}', '"accepted_async"'::jsonb, TRUE);
    v_route_policy := jsonb_set(v_route_policy, '{delivery,status_code}', '202'::jsonb, TRUE);$after1$,
     1),
    ($before2$        jsonb_strip_nulls(jsonb_build_object(
          'managed_by', 'integration_plugin',
          'plugin_id', v_plugin.id,
          'plugin_version_id', v_version.id,
          'base_url', v_provider_base_url
        ))$before2$,
     $after2$        jsonb_build_object(
          'managed_by', 'integration_plugin',
          'plugin_id', v_plugin.id,
          'plugin_version_id', v_version.id
        )$after2$,
     2),
    ($before3$
        timeout_seconds,
        call_type,
        handler_key,
        handler_version,
        metadata
      )
$before3$,
     $after3$
        timeout_seconds,
        call_type,
        metadata
      )
$after3$,
     1),
    ($before4$
        GREATEST(v_op_timeout, 1),
        'provider_api',
        'outbound_http',
        'v1',
        jsonb_build_object(
$before4$,
     $after4$
        GREATEST(v_op_timeout, 1),
        'provider_api',
        jsonb_build_object(
$after4$,
     1),
    ($before5$
        call_type = EXCLUDED.call_type,
        handler_key = EXCLUDED.handler_key,
        handler_version = EXCLUDED.handler_version,
        metadata = EXCLUDED.metadata,
$before5$,
     $after5$
        call_type = EXCLUDED.call_type,
        metadata = EXCLUDED.metadata,
$after5$,
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
$handoff$;
COMMIT;

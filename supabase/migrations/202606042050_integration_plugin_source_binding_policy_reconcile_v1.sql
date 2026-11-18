-- Reconcile Plugin Studio source-binding defaults after later policy seed
-- updates. Activation remains row-driven through integration_plugin_policy.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606042050_integration_plugin_source_binding_policy_reconcile_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $policy$
DECLARE
  v_setting RECORD;
  v_value JSONB;
  v_api_source_binding JSONB := jsonb_build_object(
    'enabled', TRUE,
    'required_for_templates', jsonb_build_array('api_gateway_shipment_create_default_v1'),
    'required_for_intents', jsonb_build_array('shipment.create', 'shipment_create', 'shipments.create'),
    'resolution_order', jsonb_build_array(
      'scope_sender',
      'scope_client_default_sender',
      'scope_client_first_active_sender',
      'tenant_default_sender',
      'tenant_first_active_sender'
    ),
    'default_sender_name_source', 'saas_onboarding_policy.client_defaults.default_sender_name',
    'fallback_to_first_active_sender', TRUE
  );
  v_webhook_source_binding JSONB := jsonb_build_object(
    'enabled', TRUE,
    'required_for_templates', jsonb_build_array('webhook_shipment_create_v1'),
    'required_for_intents', jsonb_build_array('shipment.create', 'shipment_create', 'shipments.create'),
    'resolution_order', jsonb_build_array(
      'scope_sender',
      'scope_client_default_sender',
      'scope_client_first_active_sender',
      'tenant_default_sender',
      'tenant_first_active_sender'
    ),
    'default_sender_name_source', 'saas_onboarding_policy.client_defaults.default_sender_name',
    'fallback_to_first_active_sender', TRUE
  );
  v_api_workflow_binding JSONB := jsonb_build_object(
    'mode', 'attach_existing',
    'template_name', 'api_gateway_shipment_create_default_v1',
    'intent', 'shipment.create'
  );
  v_webhook_workflow_binding JSONB := jsonb_build_object(
    'mode', 'attach_existing',
    'template_name', 'webhook_shipment_create_v1',
    'intent', 'shipment.create'
  );
  v_studio_defaults JSONB;
  v_source_binding JSONB;
  v_workflow_bindings JSONB;
  v_existing JSONB;
  v_merged JSONB;
  v_array JSONB;
BEGIN
  CREATE TEMP TABLE integration_plugin_policy_before_reconcile_v1
  ON COMMIT DROP AS
  SELECT s.scope_type, s.scope_id, s.cached_value
    FROM public.settings s
   WHERE s.category = 'integration_plugin_policy';

  IF NOT EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'integration_plugin_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  ) THEN
    PERFORM public.upsert_settings_value_v1(
      'integration_plugin_policy',
      'global',
      NULL,
      jsonb_build_object('version', 1, 'enabled', TRUE),
      1,
      'Console V2 Plugin Studio source binding policy reconcile'
    );
  END IF;

  FOR v_setting IN
    SELECT s.scope_type, s.scope_id, s.cached_value
      FROM public.settings s
     WHERE s.category = 'integration_plugin_policy'
  LOOP
    v_value := COALESCE(v_setting.cached_value, '{}'::jsonb);
    IF jsonb_typeof(v_value) IS DISTINCT FROM 'object' THEN
      v_value := '{}'::jsonb;
    END IF;

    v_studio_defaults := COALESCE(v_value->'studio_defaults', '{}'::jsonb);
    IF jsonb_typeof(v_studio_defaults) IS DISTINCT FROM 'object' THEN
      v_studio_defaults := '{}'::jsonb;
    END IF;
    v_value := jsonb_set(v_value, '{studio_defaults}', v_studio_defaults, TRUE);

    v_source_binding := COALESCE(v_value #> '{studio_defaults,source_binding}', '{}'::jsonb);
    IF jsonb_typeof(v_source_binding) IS DISTINCT FROM 'object' THEN
      v_source_binding := '{}'::jsonb;
    END IF;
    v_value := jsonb_set(v_value, '{studio_defaults,source_binding}', v_source_binding, TRUE);

    v_existing := COALESCE(v_value #> '{studio_defaults,source_binding,api}', '{}'::jsonb);
    IF jsonb_typeof(v_existing) IS DISTINCT FROM 'object' THEN
      v_existing := '{}'::jsonb;
    END IF;
    v_merged := v_api_source_binding || v_existing;
    SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY first_seen), '[]'::jsonb)
      INTO v_array
      FROM (
        SELECT item, MIN(first_seen) AS first_seen
          FROM (
            SELECT value AS item, ord::INT AS first_seen
              FROM jsonb_array_elements_text(
                CASE
                  WHEN jsonb_typeof(v_existing->'required_for_templates') = 'array'
                    THEN v_existing->'required_for_templates'
                  ELSE '[]'::jsonb
                END
              ) WITH ORDINALITY AS existing_template(value, ord)
            UNION ALL
            SELECT value AS item, (10000 + ord)::INT AS first_seen
              FROM jsonb_array_elements_text(v_api_source_binding->'required_for_templates')
                WITH ORDINALITY AS required_template(value, ord)
          ) AS template_items
         GROUP BY item
      ) AS merged_templates;
    v_merged := jsonb_set(v_merged, '{required_for_templates}', v_array, TRUE);
    SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY first_seen), '[]'::jsonb)
      INTO v_array
      FROM (
        SELECT item, MIN(first_seen) AS first_seen
          FROM (
            SELECT value AS item, ord::INT AS first_seen
              FROM jsonb_array_elements_text(
                CASE
                  WHEN jsonb_typeof(v_existing->'required_for_intents') = 'array'
                    THEN v_existing->'required_for_intents'
                  ELSE '[]'::jsonb
                END
              ) WITH ORDINALITY AS existing_intent(value, ord)
            UNION ALL
            SELECT value AS item, (10000 + ord)::INT AS first_seen
              FROM jsonb_array_elements_text(v_api_source_binding->'required_for_intents')
                WITH ORDINALITY AS required_intent(value, ord)
          ) AS intent_items
         GROUP BY item
      ) AS merged_intents;
    v_merged := jsonb_set(v_merged, '{required_for_intents}', v_array, TRUE);
    v_value := jsonb_set(
      v_value,
      '{studio_defaults,source_binding,api}',
      v_merged,
      TRUE
    );

    v_existing := COALESCE(v_value #> '{studio_defaults,source_binding,webhook}', '{}'::jsonb);
    IF jsonb_typeof(v_existing) IS DISTINCT FROM 'object' THEN
      v_existing := '{}'::jsonb;
    END IF;
    v_merged := v_webhook_source_binding || v_existing;
    SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY first_seen), '[]'::jsonb)
      INTO v_array
      FROM (
        SELECT item, MIN(first_seen) AS first_seen
          FROM (
            SELECT value AS item, ord::INT AS first_seen
              FROM jsonb_array_elements_text(
                CASE
                  WHEN jsonb_typeof(v_existing->'required_for_templates') = 'array'
                    THEN v_existing->'required_for_templates'
                  ELSE '[]'::jsonb
                END
              ) WITH ORDINALITY AS existing_template(value, ord)
            UNION ALL
            SELECT value AS item, (10000 + ord)::INT AS first_seen
              FROM jsonb_array_elements_text(v_webhook_source_binding->'required_for_templates')
                WITH ORDINALITY AS required_template(value, ord)
          ) AS template_items
         GROUP BY item
      ) AS merged_templates;
    v_merged := jsonb_set(v_merged, '{required_for_templates}', v_array, TRUE);
    SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY first_seen), '[]'::jsonb)
      INTO v_array
      FROM (
        SELECT item, MIN(first_seen) AS first_seen
          FROM (
            SELECT value AS item, ord::INT AS first_seen
              FROM jsonb_array_elements_text(
                CASE
                  WHEN jsonb_typeof(v_existing->'required_for_intents') = 'array'
                    THEN v_existing->'required_for_intents'
                  ELSE '[]'::jsonb
                END
              ) WITH ORDINALITY AS existing_intent(value, ord)
            UNION ALL
            SELECT value AS item, (10000 + ord)::INT AS first_seen
              FROM jsonb_array_elements_text(v_webhook_source_binding->'required_for_intents')
                WITH ORDINALITY AS required_intent(value, ord)
          ) AS intent_items
         GROUP BY item
      ) AS merged_intents;
    v_merged := jsonb_set(v_merged, '{required_for_intents}', v_array, TRUE);
    v_value := jsonb_set(
      v_value,
      '{studio_defaults,source_binding,webhook}',
      v_merged,
      TRUE
    );

    v_workflow_bindings := COALESCE(v_value #> '{studio_defaults,workflow_bindings}', '{}'::jsonb);
    IF jsonb_typeof(v_workflow_bindings) IS DISTINCT FROM 'object' THEN
      v_workflow_bindings := '{}'::jsonb;
    END IF;
    v_value := jsonb_set(v_value, '{studio_defaults,workflow_bindings}', v_workflow_bindings, TRUE);

    v_existing := COALESCE(v_value #> '{studio_defaults,workflow_bindings,api}', '{}'::jsonb);
    IF jsonb_typeof(v_existing) IS DISTINCT FROM 'object' THEN
      v_existing := '{}'::jsonb;
    END IF;
    v_value := jsonb_set(
      v_value,
      '{studio_defaults,workflow_bindings,api}',
      v_api_workflow_binding || v_existing,
      TRUE
    );

    v_existing := COALESCE(v_value #> '{studio_defaults,workflow_bindings,webhook}', '{}'::jsonb);
    IF jsonb_typeof(v_existing) IS DISTINCT FROM 'object' THEN
      v_existing := '{}'::jsonb;
    END IF;
    v_value := jsonb_set(
      v_value,
      '{studio_defaults,workflow_bindings,webhook}',
      v_webhook_workflow_binding || v_existing,
      TRUE
    );

    PERFORM public.upsert_settings_value_v1(
      'integration_plugin_policy',
      v_setting.scope_type,
      v_setting.scope_id,
      v_value,
      1,
      'Console V2 Plugin Studio source binding policy reconcile'
    );
  END LOOP;
END;
$policy$;

DO $assert$
BEGIN
  IF NOT COALESCE(
    (
      public.integration_plugin_resolve_policy_v1('integration_plugin_policy', NULL)
        #> '{studio_defaults,source_binding,api,required_for_templates}'
    ) ? 'api_gateway_shipment_create_default_v1',
    FALSE
  ) THEN
    RAISE EXCEPTION 'integration_plugin_policy global API source-binding default is missing';
  END IF;

  IF NOT COALESCE(
    (
      public.integration_plugin_resolve_policy_v1('integration_plugin_policy', NULL)
        #> '{studio_defaults,source_binding,webhook,required_for_templates}'
    ) ? 'webhook_shipment_create_v1',
    FALSE
  ) THEN
    RAISE EXCEPTION 'integration_plugin_policy global webhook source-binding default is missing';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'integration_plugin_policy'
       AND s.cached_value #>> '{studio_defaults,workflow_bindings,api,template_name}' = 'api_gateway_shipment_create_default_v1'
       AND NOT COALESCE(
         (s.cached_value #> '{studio_defaults,source_binding,api,required_for_templates}')
           ? 'api_gateway_shipment_create_default_v1',
         FALSE
       )
  ) THEN
    RAISE EXCEPTION 'integration_plugin_policy row has API workflow default without API source-binding default';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM integration_plugin_policy_before_reconcile_v1 b
      JOIN public.settings s
        ON s.category = 'integration_plugin_policy'
       AND s.scope_type = b.scope_type
       AND s.scope_id IS NOT DISTINCT FROM b.scope_id
     WHERE jsonb_typeof(b.cached_value #> '{studio_defaults,source_binding,api}') = 'object'
       AND NOT COALESCE(
         (s.cached_value #> '{studio_defaults,source_binding,api}')
           @> (b.cached_value #> '{studio_defaults,source_binding,api}'),
         FALSE
       )
  ) THEN
    RAISE EXCEPTION 'integration_plugin_policy API source-binding reconcile dropped existing policy values';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM integration_plugin_policy_before_reconcile_v1 b
      JOIN public.settings s
        ON s.category = 'integration_plugin_policy'
       AND s.scope_type = b.scope_type
       AND s.scope_id IS NOT DISTINCT FROM b.scope_id
     WHERE jsonb_typeof(b.cached_value #> '{studio_defaults,source_binding,webhook}') = 'object'
       AND NOT COALESCE(
         (s.cached_value #> '{studio_defaults,source_binding,webhook}')
           @> (b.cached_value #> '{studio_defaults,source_binding,webhook}'),
         FALSE
       )
  ) THEN
    RAISE EXCEPTION 'integration_plugin_policy webhook source-binding reconcile dropped existing policy values';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM integration_plugin_policy_before_reconcile_v1 b
      JOIN public.settings s
        ON s.category = 'integration_plugin_policy'
       AND s.scope_type = b.scope_type
       AND s.scope_id IS NOT DISTINCT FROM b.scope_id
     WHERE jsonb_typeof(b.cached_value #> '{studio_defaults,workflow_bindings,api}') = 'object'
       AND NOT COALESCE(
         (s.cached_value #> '{studio_defaults,workflow_bindings,api}')
           @> (b.cached_value #> '{studio_defaults,workflow_bindings,api}'),
         FALSE
       )
  ) THEN
    RAISE EXCEPTION 'integration_plugin_policy API workflow-binding reconcile dropped existing policy values';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM integration_plugin_policy_before_reconcile_v1 b
      JOIN public.settings s
        ON s.category = 'integration_plugin_policy'
       AND s.scope_type = b.scope_type
       AND s.scope_id IS NOT DISTINCT FROM b.scope_id
     WHERE jsonb_typeof(b.cached_value #> '{studio_defaults,workflow_bindings,webhook}') = 'object'
       AND NOT COALESCE(
         (s.cached_value #> '{studio_defaults,workflow_bindings,webhook}')
           @> (b.cached_value #> '{studio_defaults,workflow_bindings,webhook}'),
         FALSE
       )
  ) THEN
    RAISE EXCEPTION 'integration_plugin_policy webhook workflow-binding reconcile dropped existing policy values';
  END IF;
END;
$assert$;

SELECT pg_advisory_unlock(hashtext('202606042050_integration_plugin_source_binding_policy_reconcile_v1'));

COMMIT;

-- Append-only F823 Mapping Studio explicit source eligibility.
BEGIN;
CREATE OR REPLACE FUNCTION public.ui_upsert_mapping_artifact_v1(
  p_artifact JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := COALESCE(
    public.mapping_studio_try_uuid_v1(p_artifact->>'organization_id'),
    public.current_user_org_id()
  );
  v_artifact TEXT := lower(COALESCE(NULLIF(btrim(p_artifact->>'artifact'), ''), ''));
  v_requested_mapping_key TEXT := NULLIF(btrim(COALESCE(p_artifact->>'mapping_key', '')), '');
  v_mapping_type TEXT;
  v_mapping_key TEXT;
  v_mapping_id UUID := public.mapping_studio_try_uuid_v1(p_artifact->>'mapping_config_id');
  v_mapping_config JSONB := COALESCE(p_artifact->'mapping_config', '{}'::jsonb);
  v_mapping_notes TEXT := NULLIF(btrim(COALESCE(p_artifact->>'notes', '')), '');
  v_mapping_row public.mapping_configs%ROWTYPE;
  v_webhook_source_id UUID := public.mapping_studio_try_uuid_v1(p_artifact->>'webhook_source_id');
  v_source_sender_id UUID;
  v_source_client_id UUID;
  v_operation_template_id UUID := public.mapping_studio_try_uuid_v1(p_artifact->>'operation_template_id');
  v_api_route_id UUID := public.mapping_studio_try_uuid_v1(p_artifact->>'api_route_id');
  v_workflow_binding JSONB := COALESCE(p_artifact->'workflow_binding', '{}'::jsonb);
  v_workflow_binding_mode TEXT := lower(NULLIF(btrim(COALESCE(p_artifact->'workflow_binding'->>'mode', '')), ''));
  v_workflow_template_name TEXT := NULLIF(btrim(COALESCE(p_artifact->'workflow_binding'->>'template_name', '')), '');
  v_workflow_outcome JSONB := '{}'::jsonb;
  v_workflow_template_id UUID;
  v_policy_workflow_template_id UUID;
  v_workflow_template_status TEXT;
  v_workflow_template_scope_type TEXT;
  v_workflow_template_scope_id UUID;
  v_workflow_template_in_source_org BOOLEAN := FALSE;
  v_workflow_binding_created BOOLEAN := FALSE;
  v_supplied_workflow_template_ref TEXT := NULLIF(
    btrim(COALESCE(v_workflow_binding->>'workflow_template_id', '')),
    ''
  );
  v_webhook_event_type TEXT;
  v_webhook_policy_patch JSONB := '{}'::jsonb;
  v_webhook_settings_id UUID;
  v_response_mapping_id UUID := public.mapping_studio_try_uuid_v1(p_artifact->>'response_mapping_config_id');
  v_response_mapping_config JSONB := COALESCE(p_artifact->'response_mapping_config', '{}'::jsonb);
  v_request_config JSONB := COALESCE(p_artifact->'request_config', '{}'::jsonb);
  v_operation_row public.operation_templates%ROWTYPE;
  v_route_row public.api_routes%ROWTYPE;
  v_resource_ids JSONB := '[]'::jsonb;
  v_result JSONB := '{}'::jsonb;
BEGIN
  IF p_artifact IS NULL OR jsonb_typeof(p_artifact) <> 'object' THEN
    RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 requires artifact object';
  END IF;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 requires organization context';
  END IF;

  IF v_user_id IS NOT NULL
     AND NOT public.is_platform_user()
     AND public.current_user_org_id() IS DISTINCT FROM v_org_id THEN
    RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 cannot write another organization';
  END IF;

  IF v_artifact NOT IN ('tabular_import', 'webhook_inbound', 'api_outbound') THEN
    RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 unsupported artifact %', v_artifact;
  END IF;

  IF p_artifact ? 'test_enabled' THEN
    IF jsonb_typeof(p_artifact->'test_enabled') IS DISTINCT FROM 'boolean'
       OR v_artifact <> 'webhook_inbound' OR v_webhook_source_id IS NULL THEN
      RAISE EXCEPTION 'test_enabled requires a boolean and an exact webhook source' USING ERRCODE='22023';
    END IF;
    IF v_user_id IS NULL OR public.current_user_org_id() IS DISTINCT FROM v_org_id THEN
      RAISE EXCEPTION 'test_enabled requires the source tenant actor' USING ERRCODE='42501';
    END IF;
  END IF;

  IF v_artifact = 'tabular_import' THEN
    PERFORM public.assert_capability_v1('mappings.write', 'tenant', v_org_id);
    v_mapping_type := 'tabular_import';
    v_mapping_key := COALESCE(
      v_requested_mapping_key,
      format(
        'tabular_import::%s::%s',
        public.mapping_studio_normalize_key_v1(COALESCE(p_artifact->>'target_resource_key', 'resource')),
        v_org_id
      )
    );
  ELSIF v_artifact = 'webhook_inbound' THEN
    PERFORM public.assert_capability_v1('mappings.write', 'tenant', v_org_id);
    IF v_webhook_source_id IS NOT NULL THEN
      PERFORM public.assert_capability_v1('webhooks.write', 'tenant', v_org_id);
    END IF;
    v_mapping_type := 'webhook_inbound';
    v_mapping_key := COALESCE(
      v_requested_mapping_key,
      format(
        'webhook_inbound::%s::%s',
        COALESCE(p_artifact->>'webhook_source_id', public.mapping_studio_normalize_key_v1(COALESCE(p_artifact->>'source_identifier', 'default'))),
        v_org_id
      )
    );
  ELSE
    PERFORM public.assert_capability_v1('system.write', 'tenant', v_org_id);
    v_mapping_type := 'provider_response';
    v_mapping_key := COALESCE(
      v_requested_mapping_key,
      format(
        'api_outbound::%s::%s',
        COALESCE(
          p_artifact->>'operation_template_id',
          p_artifact->>'api_route_id',
          public.mapping_studio_normalize_key_v1(COALESCE(p_artifact->>'target_resource_key', 'default'))
        ),
        v_org_id
      )
    );
  END IF;

  IF p_artifact ? 'workflow_binding'
     AND p_artifact->'workflow_binding' IS NOT NULL
     AND jsonb_typeof(p_artifact->'workflow_binding') <> 'object' THEN
    RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 workflow_binding must be an object';
  END IF;

  IF v_workflow_binding <> '{}'::jsonb THEN
    IF v_workflow_binding_mode IS NOT NULL
       AND v_workflow_binding_mode NOT IN ('attach_existing', 'create_new') THEN
      RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 unsupported workflow binding mode %',
        v_workflow_binding_mode;
    ELSIF v_workflow_binding_mode = 'attach_existing' THEN
      IF v_supplied_workflow_template_ref IS NULL THEN
        RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 attach_existing requires workflow_template_id';
      END IF;
      IF v_workflow_template_name IS NOT NULL THEN
        RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 attach_existing contradicts template_name';
      END IF;
    ELSIF v_workflow_binding_mode = 'create_new' THEN
      IF v_workflow_template_name IS NULL THEN
        RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 create_new requires template_name';
      END IF;
      IF v_supplied_workflow_template_ref IS NOT NULL THEN
        RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 create_new contradicts workflow_template_id';
      END IF;
    ELSIF v_supplied_workflow_template_ref IS NOT NULL THEN
      IF v_workflow_template_name IS NOT NULL THEN
        RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 implicit attach contradicts template_name';
      END IF;
    ELSE
      RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 nonempty workflow_binding requires attach_existing or create_new';
    END IF;
  END IF;

  IF v_artifact = 'webhook_inbound' AND v_webhook_source_id IS NOT NULL THEN
    SELECT ws.sender_id, s.client_id
      INTO v_source_sender_id, v_source_client_id
      FROM public.webhook_sources ws
      LEFT JOIN public.senders s ON s.id = ws.sender_id
     WHERE ws.id = v_webhook_source_id
       AND ws.organization_id = v_org_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 webhook source % not found for organization %',
        v_webhook_source_id, v_org_id;
    END IF;

    IF v_source_sender_id IS NOT NULL AND v_source_client_id IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 webhook source % has unresolved sender lineage',
        v_webhook_source_id;
    END IF;
  END IF;

  v_workflow_outcome := public.mapping_studio_maybe_create_workflow_template_v1(v_workflow_binding);
  v_workflow_template_id := public.mapping_studio_try_uuid_v1(v_workflow_outcome->>'workflow_template_id');

  IF v_supplied_workflow_template_ref IS NOT NULL
     AND v_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 workflow template reference is invalid';
  END IF;

  IF v_workflow_template_id IS NOT NULL THEN
    SELECT wt.status, wt.scope_type, wt.scope_id
      INTO v_workflow_template_status, v_workflow_template_scope_type, v_workflow_template_scope_id
      FROM public.workflow_templates wt
     WHERE wt.id = v_workflow_template_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 workflow template % not found', v_workflow_template_id;
    END IF;

    v_workflow_binding_created := COALESCE((v_workflow_outcome->>'created')::BOOLEAN, FALSE);

    IF v_workflow_binding_created THEN
      IF v_workflow_template_status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 created workflow template % must remain draft', v_workflow_template_id;
      END IF;

      v_workflow_outcome := v_workflow_outcome || jsonb_build_object(
        'binding_status', 'pending_activation',
        'policy_binding_written', FALSE
      );
    ELSE
      IF v_workflow_template_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 workflow template % is not active', v_workflow_template_id;
      END IF;

      IF NOT public.workflow_template_scope_allowed(
        v_workflow_template_scope_type,
        v_workflow_template_scope_id
      ) THEN
        RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 workflow template % is outside caller scope', v_workflow_template_id;
      END IF;

      v_workflow_template_in_source_org := CASE lower(COALESCE(v_workflow_template_scope_type, ''))
        WHEN 'global' THEN v_workflow_template_scope_id IS NULL
        WHEN 'tenant' THEN v_workflow_template_scope_id = v_org_id
        WHEN 'client' THEN CASE
          WHEN v_artifact = 'webhook_inbound' AND v_webhook_source_id IS NOT NULL THEN
            v_source_client_id IS NOT NULL
            AND v_workflow_template_scope_id = v_source_client_id
          ELSE EXISTS (
            SELECT 1
              FROM public.clients c
             WHERE c.id = v_workflow_template_scope_id
               AND c.organization_id = v_org_id
          )
        END
        WHEN 'sender' THEN CASE
          WHEN v_artifact = 'webhook_inbound' AND v_webhook_source_id IS NOT NULL THEN
            v_source_sender_id IS NOT NULL
            AND v_workflow_template_scope_id = v_source_sender_id
          ELSE EXISTS (
            SELECT 1
              FROM public.senders s
              JOIN public.clients c ON c.id = s.client_id
             WHERE s.id = v_workflow_template_scope_id
               AND c.organization_id = v_org_id
          )
        END
        ELSE FALSE
      END;

      IF NOT v_workflow_template_in_source_org THEN
        RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 workflow template % is outside exact source lineage', v_workflow_template_id;
      END IF;

      v_policy_workflow_template_id := v_workflow_template_id;
    END IF;
  END IF;

  IF v_mapping_id IS NOT NULL THEN
    UPDATE public.mapping_configs
       SET mapping_config = v_mapping_config,
           mapping_version = mapping_version + 1,
           notes = COALESCE(v_mapping_notes, notes),
           updated_at = now()
     WHERE id = v_mapping_id
       AND organization_id = v_org_id
     RETURNING * INTO v_mapping_row;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 mapping config % not found for organization %',
        v_mapping_id, v_org_id;
    END IF;
  ELSE
    INSERT INTO public.mapping_configs (
      organization_id,
      mapping_type,
      mapping_key,
      mapping_config,
      mapping_version,
      notes
    )
    VALUES (
      v_org_id,
      v_mapping_type,
      v_mapping_key,
      v_mapping_config,
      1,
      COALESCE(v_mapping_notes, format('Mapping studio %s artifact', v_artifact))
    )
    ON CONFLICT (mapping_type, mapping_key) DO UPDATE
    SET mapping_config = EXCLUDED.mapping_config,
        mapping_version = public.mapping_configs.mapping_version + 1,
        notes = EXCLUDED.notes,
        updated_at = now()
    WHERE public.mapping_configs.organization_id = v_org_id
    RETURNING * INTO v_mapping_row;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 mapping key % is owned by another organization',
        v_mapping_key;
    END IF;
  END IF;

  v_mapping_id := v_mapping_row.id;
  v_resource_ids := v_resource_ids || jsonb_build_array(
    jsonb_build_object('resource_type', 'mapping_configs', 'resource_id', v_mapping_id)
  );

  IF v_artifact = 'webhook_inbound' AND v_webhook_source_id IS NOT NULL THEN
    UPDATE public.webhook_sources
       SET mapping_config_id = v_mapping_id,
           managed_metadata = CASE WHEN p_artifact ? 'test_enabled'
             THEN COALESCE(managed_metadata, '{}'::jsonb) || jsonb_build_object('test_enabled', p_artifact->'test_enabled')
             ELSE managed_metadata END,
           updated_at = now()
     WHERE id = v_webhook_source_id
       AND organization_id = v_org_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 webhook source % not found for organization %', v_webhook_source_id, v_org_id;
    END IF;

    v_resource_ids := v_resource_ids || jsonb_build_array(
      jsonb_build_object('resource_type', 'webhook_sources', 'resource_id', v_webhook_source_id)
    );

    IF v_policy_workflow_template_id IS NOT NULL THEN
      v_webhook_event_type := lower(COALESCE(
        NULLIF(btrim(COALESCE(v_workflow_binding->>'event_type', '')), ''),
        NULLIF(btrim(COALESCE(p_artifact->>'event_type', '')), ''),
        'default'
      ));

      IF v_webhook_event_type = 'default' THEN
        v_webhook_policy_patch := jsonb_build_object(
          'workflow',
          jsonb_build_object('template_id', v_policy_workflow_template_id)
        );
      ELSE
        v_webhook_event_type := lower(NULLIF(btrim(COALESCE(
          public.normalize_shipment_intent_v1(v_webhook_event_type, v_webhook_event_type),
          ''
        )), ''));

        IF v_webhook_event_type IS NULL OR v_webhook_event_type NOT IN (
          'shipment.create',
          'shipment.swap',
          'shipment.return',
          'shipment.modify',
          'shipment.delete',
          'shipment.reschedule',
          'update.status',
          'update.geocode',
          'update.address',
          'update.driver',
          'update.action',
          'update.attachment'
        ) THEN
          RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 unsupported or unresolved shipment intent %',
            COALESCE(v_workflow_binding->>'event_type', p_artifact->>'event_type');
        END IF;

        v_webhook_policy_patch := jsonb_build_object(
          'workflow',
          jsonb_build_object(
            'templates_by_intent',
            jsonb_build_object(
              v_webhook_event_type,
              jsonb_build_object('template_id', v_policy_workflow_template_id)
            )
          )
        );
      END IF;

      v_webhook_settings_id := public.upsert_webhook_ingest_policy(
        'source',
        v_webhook_source_id,
        v_webhook_policy_patch
      );
      v_workflow_outcome := COALESCE(v_workflow_outcome, '{}'::jsonb)
        || jsonb_build_object(
          'binding_kind', 'webhook_ingest_policy',
          'scope_type', 'source',
          'scope_id', v_webhook_source_id,
          'event_type', v_webhook_event_type,
          'settings_id', v_webhook_settings_id
        );
      v_resource_ids := v_resource_ids || jsonb_build_array(
        jsonb_build_object('resource_type', 'settings', 'resource_id', v_webhook_settings_id)
      );
    END IF;

    v_result := jsonb_build_object(
      'primary_resource_type', 'mapping_configs',
      'primary_resource_id', v_mapping_id,
      'mapping_config_id', v_mapping_id,
      'webhook_source_id', v_webhook_source_id,
      'workflow_template_id', v_workflow_template_id,
      'workflow_binding_outcome', COALESCE(v_workflow_outcome, '{}'::jsonb),
      'resource_ids', v_resource_ids
    );
    RETURN v_result;
  END IF;

  IF v_artifact = 'api_outbound' THEN
    IF v_response_mapping_id IS NOT NULL THEN
      UPDATE public.mapping_configs
         SET mapping_config = v_response_mapping_config,
             mapping_version = mapping_version + 1,
             notes = COALESCE(v_mapping_notes, notes),
             updated_at = now()
       WHERE id = v_response_mapping_id
         AND organization_id = v_org_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 response mapping config % not found for organization %',
          v_response_mapping_id, v_org_id;
      END IF;
    ELSIF v_response_mapping_config <> '{}'::jsonb THEN
      INSERT INTO public.mapping_configs (
        organization_id,
        mapping_type,
        mapping_key,
        mapping_config,
        mapping_version,
        notes
      )
      VALUES (
        v_org_id,
        'provider_response',
        format('provider_response::%s::%s', v_mapping_key, v_org_id),
        v_response_mapping_config,
        1,
        COALESCE(v_mapping_notes, 'Mapping studio provider response mapping')
      )
      ON CONFLICT (mapping_type, mapping_key) DO UPDATE
      SET mapping_config = EXCLUDED.mapping_config,
          mapping_version = public.mapping_configs.mapping_version + 1,
          notes = EXCLUDED.notes,
          updated_at = now()
      WHERE public.mapping_configs.organization_id = v_org_id
      RETURNING id INTO v_response_mapping_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 response mapping key is owned by another organization';
      END IF;

      v_resource_ids := v_resource_ids || jsonb_build_array(
        jsonb_build_object('resource_type', 'mapping_configs', 'resource_id', v_response_mapping_id)
      );
    END IF;

    IF v_operation_template_id IS NOT NULL THEN
      SELECT ot.*
        INTO v_operation_row
        FROM public.operation_templates ot
        JOIN public.providers p ON p.id = ot.provider_id
       WHERE ot.id = v_operation_template_id
         AND p.organization_id = v_org_id
       FOR UPDATE OF ot, p;

      IF v_operation_row.id IS NULL THEN
        RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 operation template % not found', v_operation_template_id;
      END IF;

      UPDATE public.operation_templates
         SET method = COALESCE(NULLIF(btrim(COALESCE(v_request_config->>'method', '')), ''), method),
             url_template = COALESCE(NULLIF(btrim(COALESCE(v_request_config->>'url_template', '')), ''), url_template),
             headers_template = COALESCE(v_request_config->'headers_template', headers_template),
             body_template = COALESCE(v_request_config->'body_template', body_template),
             request_mappings = COALESCE(v_request_config->'request_mappings', request_mappings),
             timeout_seconds = COALESCE(NULLIF(v_request_config->>'timeout_seconds', '')::int, timeout_seconds),
             mapping_config_id = COALESCE(v_response_mapping_id, mapping_config_id),
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'mapping_studio', jsonb_build_object(
                 'saved_at', now(),
                 'saved_by', v_user_id,
                 'artifact', v_artifact
               )
             )
       WHERE id = v_operation_template_id
         AND provider_id IN (
           SELECT id
             FROM public.providers
            WHERE organization_id = v_org_id
         );

      IF NOT FOUND THEN
        RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 operation template % changed ownership', v_operation_template_id;
      END IF;

      v_resource_ids := v_resource_ids || jsonb_build_array(
        jsonb_build_object('resource_type', 'operation_templates', 'resource_id', v_operation_template_id)
      );
    END IF;

    IF v_api_route_id IS NOT NULL THEN
      SELECT r.*
        INTO v_route_row
        FROM public.api_routes r
       WHERE r.id = v_api_route_id
         AND (
           public.is_platform_user()
           OR (
             lower(COALESCE(NULLIF(r.scope_type, ''), 'global')) <> 'global'
             AND r.scope_id IS NOT NULL
             AND public.api_route_visible_v1(r.scope_type, r.scope_id)
           )
         )
       FOR UPDATE OF r;

      IF v_route_row.id IS NULL THEN
        RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 api route % not found', v_api_route_id;
      END IF;

      UPDATE public.api_routes
         SET policy = COALESCE(policy, '{}'::jsonb) || jsonb_build_object(
           'mapping_studio', jsonb_strip_nulls(jsonb_build_object(
             'mapping_config_id', v_mapping_id,
             'response_mapping_config_id', v_response_mapping_id,
             'request_config', NULLIF(v_request_config, '{}'::jsonb),
             'workflow_template_id', v_workflow_template_id
           ))
         ),
             updated_at = now()
       WHERE id = v_api_route_id
         AND (
           public.is_platform_user()
           OR (
             lower(COALESCE(NULLIF(scope_type, ''), 'global')) <> 'global'
             AND scope_id IS NOT NULL
             AND public.api_route_visible_v1(scope_type, scope_id)
           )
         );

      IF NOT FOUND THEN
        RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 api route % changed scope', v_api_route_id;
      END IF;

      v_resource_ids := v_resource_ids || jsonb_build_array(
        jsonb_build_object('resource_type', 'api_routes', 'resource_id', v_api_route_id)
      );
    END IF;

    v_result := jsonb_build_object(
      'primary_resource_type',
      CASE
        WHEN v_operation_template_id IS NOT NULL THEN 'operation_templates'
        WHEN v_api_route_id IS NOT NULL THEN 'api_routes'
        ELSE 'mapping_configs'
      END,
      'primary_resource_id',
      COALESCE(v_operation_template_id, v_api_route_id, v_mapping_id),
      'mapping_config_id', v_mapping_id,
      'response_mapping_config_id', v_response_mapping_id,
      'operation_template_id', v_operation_template_id,
      'api_route_id', v_api_route_id,
      'workflow_template_id', v_workflow_template_id,
      'workflow_binding_outcome', COALESCE(v_workflow_outcome, '{}'::jsonb),
      'resource_ids', v_resource_ids
    );
    RETURN v_result;
  END IF;

  v_result := jsonb_build_object(
    'primary_resource_type', 'mapping_configs',
    'primary_resource_id', v_mapping_id,
    'mapping_config_id', v_mapping_id,
    'workflow_template_id', v_workflow_template_id,
    'workflow_binding_outcome', COALESCE(v_workflow_outcome, '{}'::jsonb),
    'resource_ids', v_resource_ids
  );

  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.ui_upsert_mapping_artifact_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_upsert_mapping_artifact_v1(jsonb) TO authenticated, service_role;
-- Existing API SECURITY INVOKER wrapper delegates the unchanged signature.
COMMIT;

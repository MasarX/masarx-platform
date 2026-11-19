-- Console V2 first-tenant readiness: Plugin Studio drafts must be lifecycle-ready.
-- A saved plugin draft without workflow_binding cannot pass canonical submit
-- validation. Resolve the default binding from integration_plugin_policy so the
-- Studio remains row-driven and generated drafts can proceed through
-- submit/approve/activate without operator-side JSON surgery.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605222030_plugin_studio_default_workflow_binding_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.integration_plugin_default_workflow_binding_v1(
  p_plugin_kind TEXT,
  p_organization_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_kind TEXT := lower(COALESCE(NULLIF(btrim(p_plugin_kind), ''), ''));
  v_policy JSONB := public.integration_plugin_resolve_policy_v1('integration_plugin_policy', p_organization_id);
  v_binding JSONB;
BEGIN
  IF v_kind = '' THEN
    RETURN '{}'::jsonb;
  END IF;

  v_binding := COALESCE(v_policy #> ARRAY['studio_defaults', 'workflow_bindings', v_kind], '{}'::jsonb);

  IF jsonb_typeof(v_binding) <> 'object' THEN
    RETURN '{}'::jsonb;
  END IF;

  RETURN v_binding;
END;
$function$;

COMMENT ON FUNCTION public.integration_plugin_default_workflow_binding_v1(TEXT, UUID) IS
  'Resolves Plugin Studio default workflow_binding from integration_plugin_policy.studio_defaults.workflow_bindings[plugin_kind].';

DO $policy$
DECLARE
  v_setting RECORD;
  v_defaults JSONB := jsonb_build_object(
    'api', jsonb_build_object(
      'mode', 'attach_existing',
      'template_name', 'api_gateway_shipment_create_default_v1'
    ),
    'webhook', jsonb_build_object(
      'mode', 'attach_existing',
      'template_name', 'webhook_shipment_create_v1'
    )
  );
  v_value JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.scope_type, s.scope_id, s.cached_value
      FROM public.settings s
     WHERE s.category = 'integration_plugin_policy'
  LOOP
    v_value := jsonb_set(
      COALESCE(v_setting.cached_value, '{}'::jsonb) || jsonb_build_object('studio_defaults', COALESCE(v_setting.cached_value->'studio_defaults', '{}'::jsonb)),
      '{studio_defaults,workflow_bindings}',
      v_defaults,
      TRUE
    );

    PERFORM public.upsert_settings_value_v1(
      'integration_plugin_policy',
      v_setting.scope_type,
      v_setting.scope_id,
      v_value,
      1,
      'Console V2 Plugin Studio default workflow bindings'
    );
  END LOOP;

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
      jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'studio_defaults', jsonb_build_object('workflow_bindings', v_defaults)
      ),
      1,
      'Console V2 Plugin Studio default workflow bindings'
    );
  END IF;
END;
$policy$;

CREATE OR REPLACE FUNCTION public.integration_plugin_generate_draft_v1(
  p_plugin_name TEXT,
  p_plugin_kind TEXT,
  p_source_type TEXT DEFAULT 'manual',
  p_source_payload JSONB DEFAULT '{}'::jsonb,
  p_inbound_config JSONB DEFAULT '{}'::jsonb,
  p_mapping_config JSONB DEFAULT '{}'::jsonb,
  p_workflow_binding JSONB DEFAULT '{}'::jsonb,
  p_outbound_operations JSONB DEFAULT '[]'::jsonb,
  p_plugin_id UUID DEFAULT NULL,
  p_plugin_key TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_organization_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_is_service BOOLEAN := public.request_role_is_service_v1();
  v_org_id UUID;
  v_plugin public.integration_plugins%ROWTYPE;
  v_plugin_id UUID;
  v_plugin_key TEXT;
  v_version_no INTEGER;
  v_version_id UUID;
  v_counter INT := 1;
  v_kind TEXT := lower(COALESCE(NULLIF(btrim(p_plugin_kind), ''), ''));
  v_workflow_binding JSONB := COALESCE(p_workflow_binding, '{}'::jsonb);
BEGIN
  v_org_id := COALESCE(p_organization_id, public.current_user_org_id());

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_generate_draft_v1 requires tenant organization context';
  END IF;

  IF NOT v_is_service
     AND NOT public.is_platform_user()
     AND p_organization_id IS NOT NULL
     AND p_organization_id <> public.current_user_org_id()
  THEN
    RAISE EXCEPTION 'integration_plugin_generate_draft_v1 cannot create drafts for another organization';
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.write', 'tenant', v_org_id);

  IF v_kind = '' THEN
    RAISE EXCEPTION 'integration_plugin_generate_draft_v1 requires plugin_kind';
  END IF;

  IF p_plugin_name IS NULL OR btrim(p_plugin_name) = '' THEN
    RAISE EXCEPTION 'integration_plugin_generate_draft_v1 requires plugin_name';
  END IF;

  IF jsonb_typeof(v_workflow_binding) <> 'object' OR v_workflow_binding = '{}'::jsonb THEN
    v_workflow_binding := public.integration_plugin_default_workflow_binding_v1(v_kind, v_org_id);
  END IF;

  IF p_plugin_id IS NOT NULL THEN
    SELECT *
      INTO v_plugin
      FROM public.integration_plugins p
     WHERE p.id = p_plugin_id
     LIMIT 1;

    IF v_plugin.id IS NULL THEN
      RAISE EXCEPTION 'integration_plugin_generate_draft_v1 plugin % not found', p_plugin_id;
    END IF;

    IF v_plugin.organization_id <> v_org_id THEN
      RAISE EXCEPTION 'integration_plugin_generate_draft_v1 organization mismatch for plugin %', p_plugin_id;
    END IF;

    v_plugin_id := v_plugin.id;
  ELSE
    v_plugin_key := public.integration_plugin_normalize_key_v1(COALESCE(NULLIF(btrim(p_plugin_key), ''), p_plugin_name));

    WHILE EXISTS (
      SELECT 1
      FROM public.integration_plugins p
      WHERE p.organization_id = v_org_id
        AND p.plugin_key = v_plugin_key
    ) LOOP
      v_counter := v_counter + 1;
      v_plugin_key := left(
        format('%s-%s', public.integration_plugin_normalize_key_v1(COALESCE(NULLIF(btrim(p_plugin_key), ''), p_plugin_name)), v_counter),
        80
      );
    END LOOP;

    INSERT INTO public.integration_plugins (
      organization_id,
      plugin_key,
      name,
      description,
      plugin_kind,
      status,
      managed_by,
      metadata,
      created_by,
      updated_by
    )
    VALUES (
      v_org_id,
      v_plugin_key,
      btrim(p_plugin_name),
      NULLIF(btrim(COALESCE(p_description, '')), ''),
      v_kind,
      'draft',
      'integration_plugin',
      COALESCE(p_metadata, '{}'::jsonb),
      auth.uid(),
      auth.uid()
    )
    RETURNING id INTO v_plugin_id;
  END IF;

  v_version_no := public.integration_plugin_next_version_no_v1(v_plugin_id);

  INSERT INTO public.integration_plugin_versions (
    plugin_id,
    organization_id,
    version_no,
    status,
    source_type,
    source_payload,
    normalized_contract,
    inbound_config,
    mapping_config,
    workflow_binding,
    outbound_operations,
    auth_bindings,
    metadata,
    created_by,
    updated_by
  )
  VALUES (
    v_plugin_id,
    v_org_id,
    v_version_no,
    'draft',
    lower(COALESCE(NULLIF(btrim(p_source_type), ''), 'manual')),
    COALESCE(p_source_payload, '{}'::jsonb),
    COALESCE(p_source_payload, '{}'::jsonb),
    COALESCE(p_inbound_config, '{}'::jsonb),
    COALESCE(p_mapping_config, '{}'::jsonb),
    COALESCE(v_workflow_binding, '{}'::jsonb),
    COALESCE(p_outbound_operations, '[]'::jsonb),
    '{}'::jsonb,
    jsonb_set(
      COALESCE(p_metadata, '{}'::jsonb),
      '{workflow_binding_source}',
      to_jsonb(CASE WHEN COALESCE(p_workflow_binding, '{}'::jsonb) = '{}'::jsonb THEN 'policy_default' ELSE 'request' END),
      TRUE
    ),
    auth.uid(),
    auth.uid()
  )
  RETURNING id INTO v_version_id;

  UPDATE public.integration_plugins
     SET status = 'draft',
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = v_plugin_id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'plugin_id', v_plugin_id,
    'version_id', v_version_id,
    'plugin_version_id', v_version_id,
    'version_no', v_version_no,
    'organization_id', v_org_id,
    'workflow_binding', COALESCE(v_workflow_binding, '{}'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.integration_plugin_default_workflow_binding_v1(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.integration_plugin_default_workflow_binding_v1(TEXT, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605222030_plugin_studio_default_workflow_binding_v1'));
COMMIT;

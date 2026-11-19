-- Preserve raw Plugin Studio source payloads while storing the parsed contract
-- operators previewed in `integration_plugin_versions.normalized_contract`.

CREATE OR REPLACE FUNCTION public.integration_plugin_generate_draft_v1(
  p_plugin_name text,
  p_plugin_kind text,
  p_source_type text DEFAULT 'manual'::text,
  p_source_payload jsonb DEFAULT '{}'::jsonb,
  p_inbound_config jsonb DEFAULT '{}'::jsonb,
  p_mapping_config jsonb DEFAULT '{}'::jsonb,
  p_workflow_binding jsonb DEFAULT '{}'::jsonb,
  p_outbound_operations jsonb DEFAULT '[]'::jsonb,
  p_plugin_id uuid DEFAULT NULL::uuid,
  p_plugin_key text DEFAULT NULL::text,
  p_description text DEFAULT NULL::text,
  p_organization_id uuid DEFAULT NULL::uuid,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
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
  v_metadata JSONB := COALESCE(p_metadata, '{}'::jsonb) - 'normalized_contract';
  v_normalized_contract JSONB := COALESCE(
    NULLIF(COALESCE(p_metadata, '{}'::jsonb)->'normalized_contract', 'null'::jsonb),
    COALESCE(p_source_payload, '{}'::jsonb)
  );
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
      v_metadata,
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
    v_normalized_contract,
    COALESCE(p_inbound_config, '{}'::jsonb),
    COALESCE(p_mapping_config, '{}'::jsonb),
    COALESCE(v_workflow_binding, '{}'::jsonb),
    COALESCE(p_outbound_operations, '[]'::jsonb),
    '{}'::jsonb,
    jsonb_set(
      v_metadata,
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

COMMENT ON FUNCTION public.integration_plugin_generate_draft_v1(
  text,
  text,
  text,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  uuid,
  text,
  text,
  uuid,
  jsonb
) IS 'Creates or versions an integration plugin draft. Raw source_payload is preserved; p_metadata.normalized_contract, when provided by Plugin Studio, is persisted to integration_plugin_versions.normalized_contract and removed from stored metadata.';

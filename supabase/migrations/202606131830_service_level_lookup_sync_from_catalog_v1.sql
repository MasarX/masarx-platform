-- Console-created service levels must be immediately usable by shipment
-- creation, whose shipments.service_level column is lookup-contract enforced.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606131830_service_level_lookup_sync_from_catalog_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.ensure_service_level_lookup_value_v1(p_service_level_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_lookup_definition_id uuid;
  v_lookup_value_id uuid;
  v_level record;
  v_level_metadata jsonb;
  v_org_key text;
  v_org_lineage jsonb;
  v_sort_order integer;
BEGIN
  SELECT id, organization_id, key, name, metadata, is_active
    INTO v_level
    FROM public.service_levels
   WHERE id = p_service_level_id;

  IF v_level.id IS NULL THEN
    RAISE EXCEPTION 'ensure_service_level_lookup_value_v1 service_level % not found', p_service_level_id
      USING ERRCODE = '23503';
  END IF;

  IF v_user_id IS NOT NULL THEN
    PERFORM public.assert_capability_v1('agreements.write');
    IF v_level.organization_id <> COALESCE(public.current_user_org_id(), v_level.organization_id)
       AND NOT public.is_platform_user() THEN
      RAISE EXCEPTION 'ensure_service_level_lookup_value_v1 service_level outside tenant scope'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF COALESCE(v_level.is_active, false) IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  v_level_metadata := COALESCE(v_level.metadata, '{}'::jsonb);
  v_org_key := v_level.organization_id::text;
  v_org_lineage := jsonb_build_object(
    v_org_key,
    jsonb_strip_nulls(jsonb_build_object(
      'service_level_id', v_level.id,
      'organization_id', v_level.organization_id,
      'name', v_level.name,
      'synced_at', now()
    ))
  );

  SELECT id
    INTO v_lookup_definition_id
    FROM public.lookup_definitions
   WHERE category = 'service_level';

  IF v_lookup_definition_id IS NULL THEN
    RAISE EXCEPTION 'ensure_service_level_lookup_value_v1 requires service_level lookup definition'
      USING ERRCODE = '23503';
  END IF;

  IF v_level_metadata->>'priority_rank' ~ '^[0-9]+$' THEN
    v_sort_order := (v_level_metadata->>'priority_rank')::integer;
  END IF;

  INSERT INTO public.lookup_values (
    lookup_definition_id,
    value,
    label,
    description,
    sort_order,
    is_default,
    status,
    metadata,
    organization_id,
    created_by
  ) VALUES (
    v_lookup_definition_id,
    v_level.key,
    v_level.name,
    'Catalog service level available for shipment creation.',
    v_sort_order,
    false,
    'active',
    (v_level_metadata - 'service_level_id' - 'service_level_organization_id')
      || jsonb_build_object(
      'source', 'service_levels',
      'service_levels_by_organization', v_org_lineage,
      'tone', COALESCE(v_level_metadata->>'tone', 'info')
    ),
    v_level.organization_id,
    v_user_id
  )
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
     SET status = 'active',
         retired_at = NULL,
         archived_at = NULL,
         metadata = (COALESCE(public.lookup_values.metadata, '{}'::jsonb) - 'service_level_id' - 'service_level_organization_id')
           || jsonb_build_object(
                'source', 'service_levels',
                'service_levels_by_organization',
                  (
                    CASE
                      WHEN jsonb_typeof(COALESCE(public.lookup_values.metadata, '{}'::jsonb)->'service_levels_by_organization') = 'object'
                        THEN COALESCE(public.lookup_values.metadata, '{}'::jsonb)->'service_levels_by_organization'
                      ELSE '{}'::jsonb
                    END
                  ) || v_org_lineage,
                'tone', COALESCE(public.lookup_values.metadata->>'tone', v_level_metadata->>'tone', 'info')
              ),
         updated_at = now()
  RETURNING id INTO v_lookup_value_id;

  RETURN v_lookup_value_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.service_level_create_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id TEXT := gen_random_uuid()::text;
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID;
  v_key TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'key', '')), ''));
  v_name TEXT := NULLIF(btrim(COALESCE(p_args->>'name', '')), '');
  v_description TEXT := NULLIF(btrim(COALESCE(p_args->>'description', '')), '');
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_target_org UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'service_level_create_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('agreements.write');

  IF v_key IS NULL OR v_name IS NULL THEN
    RAISE EXCEPTION 'service_level_create_v1 requires key and name'
      USING ERRCODE = '23502';
  END IF;

  v_target_org := NULLIF(p_args->>'organization_id', '')::uuid;
  IF v_target_org IS NULL THEN
    v_target_org := v_org_id;
  ELSIF v_target_org <> COALESCE(v_org_id, v_target_org) AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'service_level_create_v1 organization_id outside tenant scope'
      USING ERRCODE = '42501';
  END IF;
  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'service_level_create_v1 cannot resolve target organization'
      USING ERRCODE = '23502';
  END IF;

  INSERT INTO public.service_levels (
    organization_id, key, name, description, is_active, metadata
  ) VALUES (
    v_target_org, v_key, v_name, v_description, TRUE, v_metadata
  )
  RETURNING id INTO v_resource_id;

  PERFORM public.ensure_service_level_lookup_value_v1(v_resource_id);

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_target_org, 'service_levels.create', 'service_level', v_resource_id,
    'service_level_create_v1', 'created',
    jsonb_strip_nulls(jsonb_build_object('key', v_key, 'name', v_name)),
    'service_level_create_v1', v_correlation_id::uuid
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_target_org, 'service_level.created', 'service_level', v_resource_id,
    jsonb_build_object('key', v_key), v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'service_level_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

SELECT public.ensure_service_level_lookup_value_v1(sl.id)
  FROM public.service_levels sl
 WHERE sl.is_active IS TRUE;

REVOKE ALL ON FUNCTION public.ensure_service_level_lookup_value_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_service_level_lookup_value_v1(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.service_level_create_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.service_level_create_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.service_level_create_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.ensure_service_level_lookup_value_v1(uuid)
  IS 'Synchronizes active service_levels rows into the canonical service_level lookup_values category so lookup-enforced shipment creation accepts catalog-created service levels.';

COMMENT ON FUNCTION public.service_level_create_v1(jsonb)
  IS 'Canonical write RPC: insert service_levels row, sync service_level lookup value, decision_log, and domain_event. Capability: agreements.write.';

SELECT pg_advisory_unlock(hashtext('202606131830_service_level_lookup_sync_from_catalog_v1'));

COMMIT;

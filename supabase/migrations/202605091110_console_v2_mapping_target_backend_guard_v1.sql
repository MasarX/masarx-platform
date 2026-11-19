-- Console V2 Mapping Studio backend target guard.
--
-- Purpose:
--   Mapping target authoring is row-driven in the UI and must also be
--   enforced by the backend. Direct Console/API writes may only persist
--   active mapping_target lookup rows and compatible mapping_type values.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605091110_console_v2_mapping_target_backend_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_upsert_mapping_config_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_current_org_id uuid;
  v_requested_org_id uuid;
  v_org_id uuid;
  v_mapping_id uuid;
  v_mapping_type text;
  v_mapping_key text;
  v_mapping_config jsonb;
  v_mapping_target text;
  v_allowed_mapping_types jsonb;
  v_notes text;
  v_row public.mapping_configs%ROWTYPE;
  v_existing public.mapping_configs%ROWTYPE;
  v_action text := 'created';
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'ui_upsert_mapping_config_v1 requires argument object'
      USING ERRCODE = '23502';
  END IF;

  v_current_org_id := public.current_user_org_id();
  v_requested_org_id := public.mapping_studio_try_uuid_v1(p_args->>'organization_id');
  IF public.is_platform_user() THEN
    v_org_id := COALESCE(v_requested_org_id, v_current_org_id);
  ELSE
    v_org_id := v_current_org_id;
    IF v_requested_org_id IS NOT NULL AND v_requested_org_id IS DISTINCT FROM v_current_org_id THEN
      RAISE EXCEPTION 'ui_upsert_mapping_config_v1 cannot write a different organization'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  v_mapping_id := public.mapping_studio_try_uuid_v1(p_args->>'mapping_config_id');
  v_mapping_type := NULLIF(btrim(COALESCE(p_args->>'mapping_type', '')), '');
  v_mapping_key := NULLIF(btrim(COALESCE(p_args->>'mapping_key', '')), '');
  v_mapping_config := COALESCE(p_args->'mapping_config', '{}'::jsonb);
  v_notes := NULLIF(btrim(COALESCE(p_args->>'notes', '')), '');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_mapping_config_v1 requires organization context'
      USING ERRCODE = '23502';
  END IF;

  IF v_mapping_type IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_mapping_config_v1 requires mapping_type'
      USING ERRCODE = '23502';
  END IF;

  IF v_mapping_key IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_mapping_config_v1 requires mapping_key'
      USING ERRCODE = '23502';
  END IF;

  IF jsonb_typeof(v_mapping_config) <> 'object' THEN
    RAISE EXCEPTION 'ui_upsert_mapping_config_v1 requires mapping_config object'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.lookup_definitions d
    JOIN public.lookup_values v ON v.lookup_definition_id = d.id
    WHERE d.category = 'mapping_type'
      AND v.value = v_mapping_type
      AND v.status = 'active'
  ) THEN
    RAISE EXCEPTION 'ui_upsert_mapping_config_v1 mapping_type % is not active', v_mapping_type
      USING ERRCODE = '23503';
  END IF;

  v_mapping_target := NULLIF(btrim(COALESCE(v_mapping_config->>'target', '')), '');
  IF v_mapping_target IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_mapping_config_v1 requires mapping_config.target'
      USING ERRCODE = '23502';
  END IF;

  SELECT COALESCE(v.metadata->'allowed_mapping_types', '[]'::jsonb)
    INTO v_allowed_mapping_types
    FROM public.lookup_definitions d
    JOIN public.lookup_values v ON v.lookup_definition_id = d.id
   WHERE d.category = 'mapping_target'
     AND v.value = v_mapping_target
     AND v.status = 'active'
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_upsert_mapping_config_v1 mapping target % is not active', v_mapping_target
      USING ERRCODE = '23503';
  END IF;

  IF jsonb_typeof(v_allowed_mapping_types) = 'array'
     AND jsonb_array_length(v_allowed_mapping_types) > 0
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(v_allowed_mapping_types) AS allowed(value)
        WHERE allowed.value = v_mapping_type
     ) THEN
    RAISE EXCEPTION 'ui_upsert_mapping_config_v1 mapping target % does not allow mapping_type %',
      v_mapping_target, v_mapping_type
      USING ERRCODE = '23514';
  END IF;

  PERFORM public.assert_capability_v1('mappings.write', 'tenant', v_org_id);
  PERFORM pg_advisory_xact_lock(hashtext('mapping_config:' || v_mapping_type || ':' || v_mapping_key));

  IF v_mapping_id IS NOT NULL THEN
    SELECT *
      INTO v_existing
      FROM public.mapping_configs
     WHERE id = v_mapping_id
     FOR UPDATE;

    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_mapping_config_v1 mapping_config % not found', v_mapping_id
        USING ERRCODE = '23503';
    END IF;

    IF v_existing.organization_id IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_mapping_config_v1 mapping_config % is global/shared and service-managed', v_mapping_id
        USING ERRCODE = '42501';
    END IF;

    IF v_existing.organization_id IS DISTINCT FROM v_org_id THEN
      RAISE EXCEPTION 'ui_upsert_mapping_config_v1 mapping_config % belongs to another organization', v_mapping_id
        USING ERRCODE = '42501';
    END IF;

    UPDATE public.mapping_configs
       SET mapping_type = v_mapping_type,
           mapping_key = v_mapping_key,
           mapping_config = v_mapping_config,
           mapping_version = mapping_version + 1,
           notes = COALESCE(v_notes, notes),
           updated_at = now()
     WHERE id = v_mapping_id
       AND organization_id = v_org_id
     RETURNING * INTO v_row;
    v_action := 'updated';
  ELSE
    SELECT *
      INTO v_existing
      FROM public.mapping_configs
     WHERE mapping_type = v_mapping_type
       AND mapping_key = v_mapping_key
     FOR UPDATE;

    IF v_existing.id IS NOT NULL THEN
      IF v_existing.organization_id IS NULL THEN
        RAISE EXCEPTION 'ui_upsert_mapping_config_v1 mapping key %/% is global/shared and service-managed', v_mapping_type, v_mapping_key
          USING ERRCODE = '42501';
      END IF;

      IF v_existing.organization_id IS DISTINCT FROM v_org_id THEN
        RAISE EXCEPTION 'ui_upsert_mapping_config_v1 mapping key %/% belongs to another organization', v_mapping_type, v_mapping_key
          USING ERRCODE = '42501';
      END IF;

      UPDATE public.mapping_configs
         SET mapping_config = v_mapping_config,
             mapping_version = mapping_version + 1,
             notes = COALESCE(v_notes, notes),
             updated_at = now()
       WHERE id = v_existing.id
         AND organization_id = v_org_id
       RETURNING * INTO v_row;
      v_action := 'updated';
    ELSE
      v_action := 'created';
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
        COALESCE(v_notes, 'Console V2 mapping_config artifact')
      )
      RETURNING * INTO v_row;
    END IF;
  END IF;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_mapping_config_v1 failed to persist mapping_config'
      USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'action', v_action,
    'primary_resource_type', 'mapping_configs',
    'primary_resource_id', v_row.id,
    'mapping_config_id', v_row.id,
    'resource_ids', jsonb_build_array(
      jsonb_build_object('resource_type', 'mapping_configs', 'resource_id', v_row.id)
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_upsert_mapping_config_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_upsert_mapping_config_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_upsert_mapping_config_v1(jsonb)
  IS 'Console V2 direct mapping_config write path. Enforces mapping_type and mapping_config.target through active lookup rows.';

SELECT pg_advisory_unlock(hashtext('202605091110_console_v2_mapping_target_backend_guard_v1'));
COMMIT;

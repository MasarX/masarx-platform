-- Plan: PLAN-202603-shared-mapping-studio / Step: S04
-- Migration: Task type catalog helper falls back along the resolved scope path

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091260_task_type_catalog_scope_path_fallback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ensure_task_type_from_catalog_internal_v1(
  p_organization_id UUID,
  p_task_type_key TEXT,
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := p_organization_id;
  v_key TEXT := lower(NULLIF(btrim(COALESCE(p_task_type_key, '')), ''));
  v_ctx JSONB := COALESCE(p_context, '{}'::jsonb);
  v_existing_id UUID := NULL;
  v_row RECORD;
  v_scope_path JSONB := '[]'::jsonb;
  v_scope_entry JSONB;
  v_scope_type TEXT := NULL;
  v_scope_id UUID := NULL;
  v_catalog JSONB := '{}'::jsonb;
  v_items JSONB := '[]'::jsonb;
  v_item JSONB;
  v_item_key TEXT := NULL;
  v_name TEXT := NULL;
  v_description TEXT := NULL;
  v_default_priority INT := NULL;
  v_default_queue_key TEXT := NULL;
  v_enabled BOOLEAN := TRUE;
  v_metadata JSONB := '{}'::jsonb;
BEGIN
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ensure_task_type_from_catalog_internal_v1 requires organization_id' USING ERRCODE = '23514';
  END IF;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'ensure_task_type_from_catalog_internal_v1 requires task_type_key' USING ERRCODE = '23514';
  END IF;

  SELECT tt.id
    INTO v_existing_id
    FROM public.task_types tt
   WHERE tt.organization_id = v_org_id
     AND tt.key = v_key
   LIMIT 1;
  IF FOUND THEN
    RETURN v_existing_id;
  END IF;

  IF jsonb_typeof(v_ctx) <> 'object' THEN
    v_ctx := '{}'::jsonb;
  END IF;

  v_ctx := jsonb_strip_nulls(v_ctx || jsonb_build_object('organization_id', v_org_id));

  SELECT *
    INTO v_row
    FROM public.resolve_settings_row_from_policy_context_v1('task_type_catalog', v_ctx)
   LIMIT 1;

  v_scope_path := COALESCE(v_row.scope_path, '[]'::jsonb);
  IF jsonb_typeof(v_scope_path) <> 'array' OR jsonb_array_length(v_scope_path) = 0 THEN
    v_scope_path := jsonb_build_array(jsonb_build_object('scope_type', 'global', 'scope_id', NULL));
  END IF;

  <<scope_search>>
  FOR v_scope_entry IN
    SELECT value
      FROM jsonb_array_elements(v_scope_path)
  LOOP
    v_scope_type := lower(NULLIF(btrim(COALESCE(v_scope_entry->>'scope_type', '')), ''));
    IF v_scope_type IS NULL THEN
      CONTINUE;
    END IF;

    BEGIN
      v_scope_id := NULLIF(v_scope_entry->>'scope_id', '')::uuid;
    EXCEPTION
      WHEN others THEN
        v_scope_id := NULL;
    END;

    SELECT s.cached_value
      INTO v_catalog
      FROM public.settings s
     WHERE s.category = 'task_type_catalog'
       AND s.scope_type = v_scope_type
       AND (
         (v_scope_id IS NULL AND s.scope_id IS NULL)
         OR s.scope_id = v_scope_id
       )
     LIMIT 1;

    IF jsonb_typeof(v_catalog) <> 'object' THEN
      CONTINUE;
    END IF;

    v_items := COALESCE(v_catalog->'task_types', '[]'::jsonb);
    IF jsonb_typeof(v_items) <> 'array' THEN
      CONTINUE;
    END IF;

    FOR v_item IN
      SELECT * FROM jsonb_array_elements(v_items)
    LOOP
      v_item_key := lower(NULLIF(btrim(COALESCE(v_item->>'key', '')), ''));
      IF v_item_key = v_key THEN
        v_name := NULLIF(btrim(COALESCE(v_item->>'name', '')), '');
        v_description := NULLIF(btrim(COALESCE(v_item->>'description', '')), '');
        BEGIN v_default_priority := NULLIF(v_item->>'default_priority', '')::int; EXCEPTION WHEN others THEN v_default_priority := NULL; END;
        v_default_queue_key := NULLIF(btrim(COALESCE(v_item->>'default_queue_key', '')), '');
        BEGIN v_enabled := COALESCE(NULLIF(v_item->>'enabled', '')::boolean, TRUE); EXCEPTION WHEN others THEN v_enabled := TRUE; END;
        v_metadata := COALESCE(v_item->'metadata', '{}'::jsonb);
        EXIT scope_search;
      END IF;
    END LOOP;
  END LOOP;

  IF v_name IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_default_priority IS NULL THEN
    v_default_priority := 50;
  END IF;
  IF jsonb_typeof(v_metadata) <> 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  INSERT INTO public.task_types (
    organization_id,
    key,
    name,
    description,
    default_priority,
    default_queue_key,
    enabled,
    metadata
  ) VALUES (
    v_org_id,
    v_key,
    v_name,
    v_description,
    v_default_priority,
    v_default_queue_key,
    v_enabled,
    v_metadata
  )
  ON CONFLICT (organization_id, key) DO NOTHING
  RETURNING id INTO v_existing_id;

  IF v_existing_id IS NULL THEN
    SELECT tt.id
      INTO v_existing_id
      FROM public.task_types tt
     WHERE tt.organization_id = v_org_id
       AND tt.key = v_key
     LIMIT 1;
  END IF;

  RETURN v_existing_id;
END;
$function$;

COMMENT ON FUNCTION public.ensure_task_type_from_catalog_internal_v1(UUID, TEXT, JSONB)
  IS 'Internal row-driven helper that materializes task_types from task_type_catalog, searching the resolved scope path before falling back to lower scopes.';

REVOKE ALL ON FUNCTION public.ensure_task_type_from_catalog_internal_v1(UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_task_type_from_catalog_internal_v1(UUID, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.ensure_task_type_from_catalog_internal_v1(UUID, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_task_type_from_catalog_internal_v1(UUID, TEXT, JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202603091260_task_type_catalog_scope_path_fallback_v1'));
COMMIT;

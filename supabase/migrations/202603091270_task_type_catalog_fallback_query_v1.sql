-- Plan: PLAN-202603-shared-mapping-studio / Step: S04
-- Migration: Resolve task type catalog fallback with ordered scope-path query

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091270_task_type_catalog_fallback_query_v1'));
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

  SELECT
    NULLIF(btrim(COALESCE(item.value->>'name', '')), ''),
    NULLIF(btrim(COALESCE(item.value->>'description', '')), ''),
    CASE
      WHEN NULLIF(item.value->>'default_priority', '') IS NULL THEN NULL
      ELSE (item.value->>'default_priority')::int
    END,
    NULLIF(btrim(COALESCE(item.value->>'default_queue_key', '')), ''),
    COALESCE((item.value->>'enabled')::boolean, TRUE),
    COALESCE(item.value->'metadata', '{}'::jsonb)
    INTO
      v_name,
      v_description,
      v_default_priority,
      v_default_queue_key,
      v_enabled,
      v_metadata
  FROM jsonb_array_elements(v_scope_path) WITH ORDINALITY AS scope_item(value, ordinality)
  JOIN public.settings s
    ON s.category = 'task_type_catalog'
   AND s.scope_type = lower(NULLIF(btrim(COALESCE(scope_item.value->>'scope_type', '')), ''))
   AND (
     (
       public.mapping_studio_try_uuid_v1(scope_item.value->>'scope_id') IS NULL
       AND s.scope_id IS NULL
     )
     OR s.scope_id = public.mapping_studio_try_uuid_v1(scope_item.value->>'scope_id')
   )
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) AS item(value)
  WHERE lower(NULLIF(btrim(COALESCE(item.value->>'key', '')), '')) = v_key
  ORDER BY scope_item.ordinality
  LIMIT 1;

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
  IS 'Internal row-driven helper that materializes task_types from task_type_catalog by querying the resolved scope path in precedence order.';

REVOKE ALL ON FUNCTION public.ensure_task_type_from_catalog_internal_v1(UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_task_type_from_catalog_internal_v1(UUID, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.ensure_task_type_from_catalog_internal_v1(UUID, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_task_type_from_catalog_internal_v1(UUID, TEXT, JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202603091270_task_type_catalog_fallback_query_v1'));
COMMIT;

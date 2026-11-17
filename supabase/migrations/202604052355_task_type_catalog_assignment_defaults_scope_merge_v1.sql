-- Plan: PLAN-202604-b08-delivery-completion-core / Step: S06
-- Migration: Merge task_type_catalog assignment defaults across scope path and repair stale task_types
-- Date: 2026-04-05
--
-- Why:
--   - Older tenant-scoped task_type_catalog rows can mask newer global assignment defaults.
--   - create_task_system_v1 must inherit canonical queue/SLA/owner defaults even when a stale scoped row exists.
--   - ensure_task_type_from_catalog_internal_v1 should repair stale task_types when they are reused, not only on first insert.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604052355_task_type_catalog_assignment_defaults_scope_merge_v1'));
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
  v_scope_row RECORD;
  v_scope_path JSONB := '[]'::jsonb;
  v_match RECORD;
  v_found_match BOOLEAN := FALSE;
  v_name TEXT := NULL;
  v_description TEXT := NULL;
  v_default_priority INT := NULL;
  v_default_queue_key TEXT := NULL;
  v_enabled BOOLEAN := TRUE;
  v_metadata JSONB := '{}'::jsonb;
  v_item_metadata JSONB := '{}'::jsonb;
  v_item_assignment_defaults JSONB := '{}'::jsonb;
  v_merged_assignment_defaults JSONB := '{}'::jsonb;
  v_catalog_assignment_defaults JSONB := '{}'::jsonb;
  v_catalog_queue_key TEXT := NULL;
  v_existing_task_type public.task_types%ROWTYPE;
  v_existing_assignment_defaults JSONB := '{}'::jsonb;
  v_existing_assignment_effective JSONB := '{}'::jsonb;
  v_next_metadata JSONB := '{}'::jsonb;
  v_result_id UUID := NULL;
BEGIN
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ensure_task_type_from_catalog_internal_v1 requires organization_id' USING ERRCODE = '23514';
  END IF;

  IF v_key IS NULL THEN
    RAISE EXCEPTION 'ensure_task_type_from_catalog_internal_v1 requires task_type_key' USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(v_ctx) <> 'object' THEN
    v_ctx := '{}'::jsonb;
  END IF;

  v_ctx := jsonb_strip_nulls(v_ctx || jsonb_build_object('organization_id', v_org_id));

  SELECT *
    INTO v_scope_row
    FROM public.resolve_settings_row_from_policy_context_v1('task_type_catalog', v_ctx)
   LIMIT 1;

  v_scope_path := COALESCE(v_scope_row.scope_path, '[]'::jsonb);
  IF jsonb_typeof(v_scope_path) <> 'array' OR jsonb_array_length(v_scope_path) = 0 THEN
    v_scope_path := jsonb_build_array(jsonb_build_object('scope_type', 'global', 'scope_id', NULL));
  END IF;

  FOR v_match IN
    SELECT
      NULLIF(btrim(COALESCE(item.value->>'name', '')), '') AS name,
      NULLIF(btrim(COALESCE(item.value->>'description', '')), '') AS description,
      CASE
        WHEN NULLIF(item.value->>'default_priority', '') IS NULL THEN NULL
        ELSE (item.value->>'default_priority')::int
      END AS default_priority,
      NULLIF(btrim(COALESCE(item.value->>'default_queue_key', '')), '') AS default_queue_key,
      COALESCE((item.value->>'enabled')::boolean, TRUE) AS enabled,
      COALESCE(item.value->'metadata', '{}'::jsonb) AS metadata
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
    ORDER BY scope_item.ordinality DESC
  LOOP
    v_found_match := TRUE;

    IF v_match.name IS NOT NULL THEN
      v_name := v_match.name;
    END IF;

    IF v_match.description IS NOT NULL THEN
      v_description := v_match.description;
    END IF;

    IF v_match.default_priority IS NOT NULL THEN
      v_default_priority := v_match.default_priority;
    END IF;

    IF v_match.default_queue_key IS NOT NULL THEN
      v_default_queue_key := v_match.default_queue_key;
    END IF;

    v_enabled := COALESCE(v_match.enabled, v_enabled);

    v_item_metadata := COALESCE(v_match.metadata, '{}'::jsonb);
    IF jsonb_typeof(v_item_metadata) <> 'object' THEN
      v_item_metadata := '{}'::jsonb;
    END IF;

    v_item_assignment_defaults := COALESCE(v_item_metadata->'assignment_defaults', '{}'::jsonb);
    IF jsonb_typeof(v_item_assignment_defaults) <> 'object' THEN
      v_item_assignment_defaults := '{}'::jsonb;
    END IF;

    v_merged_assignment_defaults := COALESCE(v_metadata->'assignment_defaults', '{}'::jsonb);
    IF jsonb_typeof(v_merged_assignment_defaults) <> 'object' THEN
      v_merged_assignment_defaults := '{}'::jsonb;
    END IF;

    v_metadata := COALESCE(v_metadata, '{}'::jsonb);
    IF jsonb_typeof(v_metadata) <> 'object' THEN
      v_metadata := '{}'::jsonb;
    END IF;

    v_metadata := v_metadata || (v_item_metadata - 'assignment_defaults');
    IF v_item_assignment_defaults <> '{}'::jsonb THEN
      v_metadata := jsonb_set(
        v_metadata,
        '{assignment_defaults}',
        v_merged_assignment_defaults || v_item_assignment_defaults,
        TRUE
      );
    ELSIF v_merged_assignment_defaults <> '{}'::jsonb THEN
      v_metadata := jsonb_set(
        v_metadata,
        '{assignment_defaults}',
        v_merged_assignment_defaults,
        TRUE
      );
    END IF;
  END LOOP;

  IF NOT v_found_match OR v_name IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_default_priority IS NULL THEN
    v_default_priority := 50;
  END IF;

  IF jsonb_typeof(v_metadata) <> 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  v_catalog_assignment_defaults := COALESCE(v_metadata->'assignment_defaults', '{}'::jsonb);
  IF jsonb_typeof(v_catalog_assignment_defaults) <> 'object' THEN
    v_catalog_assignment_defaults := '{}'::jsonb;
  END IF;

  v_catalog_queue_key := NULLIF(btrim(COALESCE(v_catalog_assignment_defaults->>'queue_key', '')), '');
  IF (v_default_queue_key IS NULL OR lower(v_default_queue_key) = 'default')
     AND v_catalog_queue_key IS NOT NULL THEN
    v_default_queue_key := v_catalog_queue_key;
  END IF;

  SELECT *
    INTO v_existing_task_type
    FROM public.task_types tt
   WHERE tt.organization_id = v_org_id
     AND tt.key = v_key
   LIMIT 1;

  IF FOUND THEN
    v_next_metadata := COALESCE(v_existing_task_type.metadata, '{}'::jsonb);
    IF jsonb_typeof(v_next_metadata) <> 'object' THEN
      v_next_metadata := '{}'::jsonb;
    END IF;

    v_existing_assignment_defaults := COALESCE(v_next_metadata->'assignment_defaults', '{}'::jsonb);
    IF jsonb_typeof(v_existing_assignment_defaults) <> 'object' THEN
      v_existing_assignment_defaults := '{}'::jsonb;
    END IF;

    v_existing_assignment_effective := v_existing_assignment_defaults;
    IF jsonb_typeof(v_existing_assignment_effective) <> 'object' THEN
      v_existing_assignment_effective := '{}'::jsonb;
    END IF;

    IF NULLIF(btrim(COALESCE(v_existing_assignment_effective->>'queue_key', '')), '') IS NULL
       OR lower(COALESCE(v_existing_assignment_effective->>'queue_key', '')) = 'default' THEN
      v_existing_assignment_effective := v_existing_assignment_effective - 'queue_key';
    END IF;

    IF NULLIF(v_existing_assignment_effective->>'sla_minutes', '') IS NULL THEN
      v_existing_assignment_effective := v_existing_assignment_effective - 'sla_minutes';
    END IF;

    IF NULLIF(btrim(COALESCE(v_existing_assignment_effective->>'assigned_to_user_type', '')), '') IS NULL THEN
      v_existing_assignment_effective := v_existing_assignment_effective - 'assigned_to_user_type';
    END IF;

    IF v_catalog_assignment_defaults <> '{}'::jsonb THEN
      v_merged_assignment_defaults := v_catalog_assignment_defaults || v_existing_assignment_effective;
      IF v_merged_assignment_defaults IS DISTINCT FROM v_existing_assignment_defaults THEN
        v_next_metadata := jsonb_set(v_next_metadata, '{assignment_defaults}', v_merged_assignment_defaults, TRUE);
      END IF;
    END IF;

    IF (v_existing_task_type.default_queue_key IS NULL
        OR btrim(v_existing_task_type.default_queue_key) = ''
        OR lower(v_existing_task_type.default_queue_key) = 'default')
       AND v_default_queue_key IS NOT NULL
       AND lower(v_default_queue_key) <> 'default' THEN
      UPDATE public.task_types
         SET default_queue_key = v_default_queue_key,
             metadata = v_next_metadata,
             updated_at = now()
       WHERE id = v_existing_task_type.id;
    ELSIF v_next_metadata IS DISTINCT FROM COALESCE(v_existing_task_type.metadata, '{}'::jsonb) THEN
      UPDATE public.task_types
         SET metadata = v_next_metadata,
             updated_at = now()
       WHERE id = v_existing_task_type.id;
    END IF;

    RETURN v_existing_task_type.id;
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
  RETURNING id INTO v_result_id;

  IF v_result_id IS NULL THEN
    SELECT tt.id
      INTO v_result_id
      FROM public.task_types tt
     WHERE tt.organization_id = v_org_id
       AND tt.key = v_key
     LIMIT 1;
  END IF;

  RETURN v_result_id;
END;
$function$;

COMMENT ON FUNCTION public.ensure_task_type_from_catalog_internal_v1(UUID, TEXT, JSONB)
  IS 'Internal row-driven helper that materializes task_types from task_type_catalog, merges missing defaults across the resolved scope path, and repairs stale queue/assignment defaults on existing task_types.';

SELECT pg_advisory_unlock(hashtext('202604052355_task_type_catalog_assignment_defaults_scope_merge_v1'));
COMMIT;

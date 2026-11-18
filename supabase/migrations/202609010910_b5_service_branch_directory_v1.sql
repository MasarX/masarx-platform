-- Migration: register the service-catalog branch directory on the canonical UI read path.
BEGIN;
SELECT pg_advisory_lock(hashtext('202609010910_b5_service_branch_directory_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_current JSONB;
  v_resources JSONB;
  v_resource JSONB := jsonb_build_object(
    'key', 'service_branch_directory',
    'label', 'Service branches',
    'relation', 'public.branches',
    'id_column', 'id',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'capability_read', 'agreements.read',
    'capability_write', 'agreements.write',
    'select', jsonb_build_array(
      'id', 'organization_id', 'code', 'name', 'is_active'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'code', 'column', 'code', 'op', 'ilike'),
      jsonb_build_object('key', 'name', 'column', 'name', 'op', 'ilike'),
      jsonb_build_object('key', 'is_active', 'column', 'is_active', 'op', 'eq')
    ),
    'default_sort', jsonb_build_object('column', 'name', 'direction', 'asc')
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  SELECT COALESCE(
           jsonb_agg(
             CASE
               WHEN entry.item->>'key' = v_resource->>'key' THEN v_resource
               ELSE entry.item
             END
             ORDER BY entry.ordinality
           ),
           '[]'::jsonb
         )
    INTO v_resources
    FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb))
         WITH ORDINALITY AS entry(item, ordinality);

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_resources) item
     WHERE item->>'key' = v_resource->>'key'
  ) THEN
    v_resources := v_resources || jsonb_build_array(v_resource);
  END IF;

  v_current := jsonb_set(v_current, '{resources}', v_resources, TRUE);

  WITH current AS (
    SELECT s.settings_version_id, sv.version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ), applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Register canonical service branch directory',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202609010910_b5_service_branch_directory_v1'));
COMMIT;

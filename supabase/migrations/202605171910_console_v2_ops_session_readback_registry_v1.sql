BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_resource jsonb := jsonb_build_object(
    'key', 'ops_sessions',
    'label', 'Operational sessions',
    'relation', 'ops_sessions',
    'id_column', 'id',
    'capability_read', 'tasks.read',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
      jsonb_build_object('key', 'actor_user_id', 'column', 'actor_user_id', 'op', 'eq'),
      jsonb_build_object('key', 'session_type', 'column', 'session_type', 'op', 'eq'),
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'idempotency_key', 'column', 'idempotency_key', 'op', 'eq')
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'session_type', 'label', 'Session type', 'filterable', true),
      jsonb_build_object('key', 'status', 'label', 'Status', 'filterable', true),
      jsonb_build_object('key', 'actor_user_id', 'label', 'Actor', 'mono', true),
      jsonb_build_object('key', 'opened_at', 'label', 'Opened', 'format', 'datetime', 'sortable', true),
      jsonb_build_object('key', 'closed_at', 'label', 'Closed', 'format', 'datetime', 'sortable', true),
      jsonb_build_object('key', 'idempotency_key', 'label', 'Idempotency key', 'mono', true)
    )
  );
BEGIN
  UPDATE public.settings_versions sv
  SET value = jsonb_set(
        sv.value,
        '{resources}',
        COALESCE(
          (
            SELECT jsonb_agg(
              CASE
                WHEN item->>'key' = 'ops_sessions' THEN v_resource
                ELSE item
              END
              ORDER BY ord
            )
            FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb))
                 WITH ORDINALITY AS existing(item, ord)
          ),
          '[]'::jsonb
        ) ||
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS existing(item)
            WHERE existing.item->>'key' = 'ops_sessions'
          )
          THEN '[]'::jsonb
          ELSE jsonb_build_array(v_resource)
        END,
        true
      ),
      version = sv.version + 1,
      change_reason = 'Expose ops_sessions readback for Console V2 task completion',
      approved_at = now(),
      effective_from = now()
  WHERE sv.id IN (
    SELECT s.settings_version_id
    FROM public.settings s
    WHERE s.category = 'ui_read_registry'
  );

  UPDATE public.settings s
  SET cached_value = sv.value,
      last_updated = now()
  FROM public.settings_versions sv
  WHERE s.category = 'ui_read_registry'
    AND s.settings_version_id = sv.id;

  DELETE FROM public.settings_cache
  WHERE cache_key LIKE 'ui_read_registry:%';
END $$;

COMMIT;

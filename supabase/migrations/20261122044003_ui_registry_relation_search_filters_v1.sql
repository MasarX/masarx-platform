BEGIN;

SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('20261122044003_ui_registry_relation_search_filters_v1'));

DO $search_filters$
DECLARE
  current_registry RECORD;
  next_value JSONB;
BEGIN
  FOR current_registry IN
    SELECT s.scope_type, s.scope_id, sv.value, sv.schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
    WHERE s.category = 'ui_read_registry'
      AND jsonb_typeof(sv.value->'resources') = 'array'
    ORDER BY s.scope_type, s.scope_hash
    FOR UPDATE OF s
  LOOP
    WITH required(resource_key, filters) AS (
      VALUES
        ('clients', '[{"key":"name","column":"name","op":"ilike"}]'::jsonb),
        ('senders', '[{"key":"name","column":"name","op":"ilike"},
                      {"key":"brand_name","column":"brand_name","op":"ilike"}]'::jsonb)
    )
    SELECT jsonb_set(current_registry.value, '{resources}', COALESCE(jsonb_agg(
      CASE WHEN required.filters IS NULL THEN resource.value
      ELSE jsonb_set(resource.value, '{filters}', (
        SELECT jsonb_agg(
          COALESCE(existing.value, '{}'::jsonb) || COALESCE(wanted.value, '{}'::jsonb)
          ORDER BY existing.ordinal NULLS LAST, wanted.ordinal
        )
        FROM jsonb_array_elements(COALESCE(NULLIF(resource.value->'filters', 'null'::jsonb), '[]'::jsonb))
          WITH ORDINALITY AS existing(value, ordinal)
        FULL JOIN jsonb_array_elements(required.filters)
          WITH ORDINALITY AS wanted(value, ordinal) ON existing.value->>'key' = wanted.value->>'key'
      )) END ORDER BY resource.ordinal
    ), '[]'::jsonb))
      INTO next_value
      FROM jsonb_array_elements(current_registry.value->'resources') WITH ORDINALITY AS resource(value, ordinal)
      LEFT JOIN required ON resource.value->>'key' = required.resource_key;

    IF next_value IS DISTINCT FROM current_registry.value THEN
      PERFORM public.upsert_settings_value_v1(
        'ui_read_registry', current_registry.scope_type, current_registry.scope_id,
        next_value, current_registry.schema_version, 'Add relation name search filters'
      );
    END IF;
  END LOOP;
END;
$search_filters$;

DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';

COMMIT;

-- Migration: repair shipments UI total strategy after registry rebuilds
-- Purpose: keep high-volume shipment lists on estimated totals while filtered
-- shipment searches remain exact for operator-facing identifier lookups.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606042000_ui_read_registry_shipments_total_strategy_repair_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $registry$
DECLARE
  v_setting RECORD;
  v_current JSONB;
  v_next JSONB;
  v_resources JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.id AS setting_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_setting.value, '{"resources":[]}'::jsonb);

    SELECT COALESCE(
             jsonb_agg(
               CASE
                 WHEN resource->>'key' = 'shipments' THEN
                   resource
                   || jsonb_build_object(
                        'total_strategy', 'estimate',
                        'estimate_filtered_totals', false
                      )
                 ELSE resource
               END
               ORDER BY ordinality
             ),
             '[]'::jsonb
           )
      INTO v_resources
      FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb))
           WITH ORDINALITY AS r(resource, ordinality);

    v_next := jsonb_set(v_current, '{resources}', v_resources, TRUE);

    UPDATE public.settings_versions sv
       SET value = v_next,
           version = v_setting.version + 1,
           change_reason = 'Console V2: repair shipments UI read total strategy',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_setting.settings_version_id
       AND sv.value IS DISTINCT FROM v_next;

    UPDATE public.settings s
       SET cached_value = v_next,
           last_updated = now()
     WHERE s.id = v_setting.setting_id
       AND s.cached_value IS DISTINCT FROM v_next;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_read_registry:%'
      OR cache_key LIKE 'ui_list_resource:%shipments%';
END;
$registry$;

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'shipments'
            AND resource->>'total_strategy' = 'estimate'
            AND resource->>'estimate_filtered_totals' = 'false'
       )
  ) THEN
    RAISE EXCEPTION 'global shipments registry entry must use estimated unfiltered totals and exact filtered totals';
  END IF;
END;
$assert$;

SELECT pg_advisory_unlock(hashtext('202606042000_ui_read_registry_shipments_total_strategy_repair_v1'));

COMMIT;

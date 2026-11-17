-- Migration: keep shipment identifier/search totals exact while default lists use estimates
BEGIN;
SELECT pg_advisory_lock(hashtext('202604201530_ui_read_registry_shipments_filtered_totals_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_item JSONB;
  v_found BOOLEAN := false;
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

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) LOOP
    IF v_item->>'key' = 'shipments' THEN
      v_found := true;
      v_item := jsonb_set(v_item, '{estimate_filtered_totals}', to_jsonb(false), true);
    END IF;
    v_resources := v_resources || jsonb_build_array(v_item);
  END LOOP;

  IF v_found IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ui_read_registry missing shipments resource';
  END IF;

  v_current := jsonb_set(v_current, '{resources}', v_resources, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Use exact totals for filtered shipment UI reads',
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
END $$;

SELECT pg_advisory_unlock(hashtext('202604201530_ui_read_registry_shipments_filtered_totals_guard_v1'));
COMMIT;

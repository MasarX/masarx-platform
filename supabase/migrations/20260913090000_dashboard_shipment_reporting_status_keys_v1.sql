BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

SELECT pg_advisory_xact_lock(hashtext('20260913090000_dashboard_shipment_reporting_status_keys_v1'));

DO $reporting_status_keys$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
  v_old JSONB := '{"enabled":true,"resource":"shipments","status_filter":"status","statuses":[{"key":"delivered","label_key":"delivered"},{"key":"in_transit","label_key":"in_transit"},{"key":"out_for_delivery","label_key":"out_for_delivery"},{"key":"pending","label_key":"pending"},{"key":"exceptions","label_key":"exceptions"},{"key":"cancelled","label_key":"cancelled"},{"key":"returned","label_key":"returned"}],"active_status_keys":["in_transit","out_for_delivery"],"delivered_status_key":"delivered","pending_status_key":"pending","exception_status_key":"exceptions","app_keys":["console"]}'::jsonb;
  v_new JSONB := '{"enabled":true,"resource":"shipments","status_filter":"status","statuses":[{"key":"delivered","label_key":"delivered"},{"key":"in_transit","label_key":"in_transit"},{"key":"out_for_delivery","label_key":"out_for_delivery"},{"key":"pending","label_key":"pending"},{"key":"delivery_failed","label_key":"exceptions"},{"key":"cancelled","label_key":"cancelled"},{"key":"return_to_origin","label_key":"returned"}],"active_status_keys":["in_transit","out_for_delivery"],"delivered_status_key":"delivered","pending_status_key":"pending","exception_status_key":"delivery_failed","app_keys":["console"]}'::jsonb;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT s.id AS settings_id, s.settings_version_id, s.category, s.scope_type,
         s.scope_id, s.scope_hash, s.cached_value, sv.value, sv.version,
         sv.schema_version, sv.change_reason, sv.effective_from, sv.effective_until, sv.approved_at
    INTO v_row
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
     AND sv.scope_hash = s.scope_hash
     AND sv.category = s.category
     AND sv.scope_type = s.scope_type
     AND sv.scope_id IS NOT DISTINCT FROM s.scope_id
   WHERE s.category = 'ui_dashboard_config'
     AND s.scope_type = public.get_root_scope_type_key_v1()
     AND s.scope_id IS NULL
   FOR UPDATE OF s, sv;

  IF NOT FOUND
     OR jsonb_typeof(v_row.value) IS DISTINCT FROM 'object'
     OR v_row.cached_value IS DISTINCT FROM v_row.value
     OR v_row.effective_until IS NOT NULL
     OR v_row.effective_from > v_now
     OR v_row.approved_at IS NULL THEN
    RAISE EXCEPTION 'dashboard config settings pair is missing or inconsistent';
  END IF;

  v_current := v_row.value->'shipment_reporting';
  IF v_current IS NOT DISTINCT FROM v_new THEN
    RETURN;
  END IF;
  IF v_current IS DISTINCT FROM v_old THEN
    RETURN;
  END IF;
  IF v_row.change_reason IS DISTINCT FROM
       'Restore F808 reporting without overriding explicit dashboard policy' THEN
    RETURN;
  END IF;

  v_next := jsonb_set(v_row.value, '{shipment_reporting}', v_new, TRUE);
  WITH closed AS (
    UPDATE public.settings_versions
       SET effective_until = GREATEST(v_now, effective_from + INTERVAL '1 microsecond'),
           updated_at = v_now
     WHERE id = v_row.settings_version_id
       AND scope_hash = v_row.scope_hash
       AND effective_until IS NULL
    RETURNING id
  ), inserted AS (
    INSERT INTO public.settings_versions(
      id, category, scope_type, scope_id, scope_hash, version, value,
      schema_version, change_reason, approved_at, effective_from
    )
    SELECT gen_random_uuid(), v_row.category, v_row.scope_type, v_row.scope_id,
           v_row.scope_hash,
           (SELECT COALESCE(MAX(candidate.version), 0) + 1
              FROM public.settings_versions candidate
             WHERE candidate.category = v_row.category
               AND candidate.scope_type = v_row.scope_type
               AND candidate.scope_id IS NOT DISTINCT FROM v_row.scope_id
               AND candidate.scope_hash = v_row.scope_hash),
           v_next, v_row.schema_version,
           'Correct F808 reporting status keys to canonical shipment taxonomy',
           v_now, v_now
      FROM closed
    RETURNING id, value
  )
  UPDATE public.settings s
     SET settings_version_id = inserted.id,
         cached_value = inserted.value,
         last_updated = v_now
    FROM inserted
   WHERE s.id = v_row.settings_id
     AND s.settings_version_id = v_row.settings_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dashboard reporting status correction lost settings pointer CAS';
  END IF;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_dashboard_config:%';
END;
$reporting_status_keys$;

COMMIT;

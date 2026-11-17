-- Migration: Access control policy shipment resources
BEGIN;
SELECT pg_advisory_lock(hashtext('202601071530_access_control_policy_shipment_resources'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resource_map JSONB := '{}'::jsonb;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'access_control_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'access_control_policy global settings missing';
  END IF;

  v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);

  IF NOT (v_resource_map ? 'shipment_boxes') THEN
    v_resource_map := jsonb_set(
      v_resource_map,
      '{shipment_boxes}',
      jsonb_build_object('read','shipments.read','write','shipments.write'),
      true
    );
  END IF;

  IF NOT (v_resource_map ? 'shipment_reference_numbers') THEN
    v_resource_map := jsonb_set(
      v_resource_map,
      '{shipment_reference_numbers}',
      jsonb_build_object('read','shipments.read','write','shipments.write'),
      true
    );
  END IF;

  v_current := jsonb_set(v_current, '{resource_map}', v_resource_map, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
    SET value = v_current,
        version = current.version + 1,
        change_reason = 'Add shipment resource map entries',
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
  WHERE s.category = 'access_control_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
    AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202601071530_access_control_policy_shipment_resources'));
COMMIT;

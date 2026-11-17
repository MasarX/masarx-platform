-- Migration: Fix shipments.print_labels to start labels_print_workflow_v1 (bulk, no navigation)
BEGIN;
SELECT pg_advisory_lock(hashtext('202601191230_ui_command_registry_shipments_print_labels_fix'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_commands JSONB := '[]'::jsonb;
  v_updated JSONB := '[]'::jsonb;
  v_item JSONB;
  v_found BOOLEAN := false;
  v_replacement JSONB := jsonb_build_object(
    'key', 'shipments.print_labels',
    'label', 'Print labels',
    'description', 'Generate a printable labels bundle for selected shipments.',
    'capability', 'labels.download',
    'schema_category', 'resource:shipments',
    'workflow_key', 'labels_print_workflow_v1',
    'selection', jsonb_build_object('mode', 'multi', 'min_count', 1),
    'execution', jsonb_build_object(
      'type', 'workflow',
      'rpc', 'ui_execute_command_v1',
      'params', jsonb_build_object(
        'payload_key', 'shipments',
        'selection_id_key', 'shipment_id'
      )
    )
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_command_registry global settings missing';
  END IF;

  v_commands := COALESCE(v_current->'commands', '[]'::jsonb);

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_commands) LOOP
    IF v_item->>'key' = 'shipments.print_labels' THEN
      v_updated := v_updated || jsonb_build_array(v_replacement);
      v_found := true;
    ELSE
      v_updated := v_updated || jsonb_build_array(v_item);
    END IF;
  END LOOP;

  IF v_found IS DISTINCT FROM true THEN
    v_updated := v_updated || jsonb_build_array(v_replacement);
  END IF;

  v_current := jsonb_set(v_current, '{commands}', v_updated, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Fix shipments.print_labels workflow execution',
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
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202601191230_ui_command_registry_shipments_print_labels_fix'));
COMMIT;


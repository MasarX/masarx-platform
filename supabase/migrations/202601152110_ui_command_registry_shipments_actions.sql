-- Migration: Add shipments action commands to ui_command_registry
BEGIN;
SELECT pg_advisory_lock(hashtext('202601152110_ui_command_registry_shipments_actions'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_commands JSONB := '[]'::jsonb;
  v_candidate JSONB;
  v_new JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'shipments.edit',
      'label', 'Edit shipment',
      'description', 'Open shipment detail for editing.',
      'capability', 'shipments.write',
      'schema_category', 'resource:shipments',
      'selection', jsonb_build_object('mode', 'single', 'id_param', 'id'),
      'route_targets', jsonb_build_object(
        'console', jsonb_build_object('path', '/console/resources/shipments'),
        'portal', jsonb_build_object('path', '/portal/resources/shipments')
      )
    ),
    jsonb_build_object(
      'key', 'shipments.delete',
      'label', 'Delete shipments',
      'description', 'Delete selected shipments.',
      'capability', 'shipments.write',
      'schema_category', 'resource:shipments',
      'selection', jsonb_build_object('mode', 'multi', 'min_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_command_v1',
        'confirm', jsonb_build_object('tone', 'danger'),
        'params', jsonb_build_object('handler', 'resource_delete')
      )
    ),
    jsonb_build_object(
      'key', 'shipments.print_labels',
      'label', 'Print labels',
      'description', 'Generate printable labels for selected shipments.',
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
  FOR v_candidate IN SELECT * FROM jsonb_array_elements(v_new) LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_commands) AS item
      WHERE item->>'key' = v_candidate->>'key'
    ) THEN
      v_commands := v_commands || jsonb_build_array(v_candidate);
    END IF;
  END LOOP;

  v_current := jsonb_set(v_current, '{commands}', v_commands, true);

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
           change_reason = 'Add shipments commands',
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

SELECT pg_advisory_unlock(hashtext('202601152110_ui_command_registry_shipments_actions'));
COMMIT;

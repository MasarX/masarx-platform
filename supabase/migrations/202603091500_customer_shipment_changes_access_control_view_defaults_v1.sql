-- Plan: PLAN-202603-customer-shipment-change-review-flow / Step: S04
-- Migration: align customer shipment change review authorization and UI list defaults

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091210_customer_shipment_changes_access_control_view_defaults_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
  v_resource_map JSONB;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
    v_resource_map := jsonb_set(
      v_resource_map,
      '{customer_shipment_changes}',
      jsonb_build_object(
        'read', 'shipments.read',
        'write', 'manual_review.resolve'
      ),
      TRUE
    );
    v_next := jsonb_set(v_current, '{resource_map}', v_resource_map, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
      SET value = v_next,
          version = v_row.version + 1,
          change_reason = 'Add customer_shipment_changes access control resource map entry.',
          approved_at = workflow_now(),
          effective_from = workflow_now()
      WHERE id = v_row.settings_version_id;

      UPDATE public.settings
      SET cached_value = v_next,
          last_updated = workflow_now()
      WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  v_current JSONB;
  v_next JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_columns JSONB := jsonb_build_array(
    jsonb_build_object('key', 'tracking_number', 'label', 'Tracking number'),
    jsonb_build_object('key', 'shipment_status_snapshot', 'label', 'Shipment status'),
    jsonb_build_object('key', 'request_type_key', 'label', 'Change type'),
    jsonb_build_object('key', 'request_outcome', 'label', 'Outcome'),
    jsonb_build_object('key', 'changed_fields', 'label', 'Changed fields'),
    jsonb_build_object('key', 'requester_channel', 'label', 'Requester channel'),
    jsonb_build_object('key', 'change_summary', 'label', 'Before -> requested'),
    jsonb_build_object(
      'key',
      'created_at',
      'label',
      'Requested at',
      'render_type',
      'datetime',
      'format_options',
      jsonb_build_object('dateStyle', 'medium', 'timeStyle', 'short')
    ),
    jsonb_build_object('key', 'status_reason', 'label', 'Status reason')
  );
  v_select TEXT[] := ARRAY[
    'id',
    'tracking_number',
    'shipment_status_snapshot',
    'request_type_key',
    'request_outcome',
    'changed_fields',
    'requester_channel',
    'change_summary',
    'status',
    'status_reason',
    'priority',
    'sla_due_at',
    'created_at',
    'updated_at',
    'organization_id',
    'client_id',
    'sender_id',
    'resource_type',
    'resource_id',
    'request_source',
    'metadata'
  ];
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

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

  FOR v_resource IN SELECT * FROM jsonb_array_elements(v_resources) LOOP
    IF v_resource->>'key' = 'customer_shipment_changes' THEN
      v_resource := jsonb_set(v_resource, '{select}', to_jsonb(v_select), TRUE);
      v_resource := jsonb_set(v_resource, '{columns}', v_columns, TRUE);
      v_resource := jsonb_set(
        v_resource,
        '{column_labels}',
        jsonb_build_object(
          'tracking_number', 'Tracking number',
          'shipment_status_snapshot', 'Shipment status',
          'request_type_key', 'Change type',
          'request_outcome', 'Outcome',
          'changed_fields', 'Changed fields',
          'requester_channel', 'Requester channel',
          'change_summary', 'Before -> requested',
          'status_reason', 'Status reason',
          'created_at', 'Requested at',
          'updated_at', 'Updated at',
          'sla_due_at', 'SLA due at'
        ),
        TRUE
      );
    END IF;

    v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
  END LOOP;

  v_next := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

  WITH current AS (
    SELECT
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
    SET value = v_next,
        version = current.version + 1,
        change_reason = 'Set customer shipment changes default review columns.',
        approved_at = workflow_now(),
        effective_from = workflow_now()
    FROM current
    WHERE sv.id = current.settings_version_id
      AND v_next IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
  SET cached_value = applied.value,
      last_updated = workflow_now()
  FROM applied
  WHERE s.category = 'ui_read_registry'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
    AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202603091210_customer_shipment_changes_access_control_view_defaults_v1'));
COMMIT;

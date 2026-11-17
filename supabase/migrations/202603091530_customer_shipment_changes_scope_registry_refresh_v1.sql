-- Plan: PLAN-202603-customer-shipment-change-review-flow / Step: S04
-- Refresh scoped ui_read_registry copies for customer shipment changes so
-- tenant/client/sender scopes inherit the review-focused list/detail shape.

BEGIN;

SELECT pg_advisory_lock(hashtext('202603091240_customer_shipment_changes_scope_registry_refresh_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
  v_resources JSONB;
  v_updated_resources JSONB;
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
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    v_updated_resources := '[]'::jsonb;

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

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
      SET value = v_next,
          version = v_row.version + 1,
          change_reason = 'Refresh customer_shipment_changes scoped registry columns and select order.',
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

SELECT pg_advisory_unlock(hashtext('202603091240_customer_shipment_changes_scope_registry_refresh_v1'));
COMMIT;

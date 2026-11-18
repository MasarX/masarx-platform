-- Migration: Console V2 warehouse transfer summary view registry contract
-- Purpose:
--   - Allow the generic Console V2 read substrate to read the canonical
--     security-invoker warehouse transfer summary projection.
--   - Keep the registry fail-closed: only this explicit resource is marked
--     view-readable, and mutations still flow through warehouse RPCs.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605071445_console_v2_warehouse_transfer_summary_view_registry_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
  v_resources JSONB;
  v_next_resources JSONB;
  v_resource JSONB;
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
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    v_next_resources := '[]'::jsonb;
    FOR v_resource IN
      SELECT value
      FROM jsonb_array_elements(v_resources) AS value
    LOOP
      IF v_resource->>'key' = 'warehouse_transfer_summary' THEN
        v_resource := jsonb_set(v_resource, '{relation}', to_jsonb('v_warehouse_transfer_summary'::text), TRUE);
        v_resource := jsonb_set(v_resource, '{allow_view_relation}', 'true'::jsonb, TRUE);
      END IF;

      v_next_resources := v_next_resources || jsonb_build_array(v_resource);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_next_resources) AS item
      WHERE item->>'key' = 'warehouse_transfer_summary'
    ) THEN
      v_next_resources := v_next_resources || jsonb_build_array(
        jsonb_build_object(
          'key', 'warehouse_transfer_summary',
          'relation', 'v_warehouse_transfer_summary',
          'allow_view_relation', true,
          'id_column', 'id',
          'capability_read', 'warehouse.read',
          'columns', jsonb_build_array(
            jsonb_build_object('key', 'transfer_code', 'label', 'Transfer', 'mono', true, 'sortable', true, 'filterable', true),
            jsonb_build_object('key', 'from_branch_id', 'label', 'Origin', 'mono', true, 'sortable', true, 'filterable', true),
            jsonb_build_object('key', 'to_branch_id', 'label', 'Destination', 'mono', true, 'sortable', true, 'filterable', true),
            jsonb_build_object('key', 'item_count', 'label', 'Items', 'align', 'right', 'mono', true, 'sortable', true, 'type', 'number'),
            jsonb_build_object('key', 'received_count', 'label', 'Received', 'align', 'right', 'mono', true, 'sortable', true, 'type', 'number'),
            jsonb_build_object('key', 'variance_count', 'label', 'Variance', 'align', 'right', 'mono', true, 'sortable', true, 'type', 'number'),
            jsonb_build_object('key', 'variance_flag', 'label', 'At risk', 'sortable', true, 'filterable', true),
            jsonb_build_object('key', 'status', 'label', 'Status', 'sortable', true, 'filterable', true, 'lookup', 'warehouse_transfer_status'),
            jsonb_build_object('key', 'posted_at', 'label', 'Posted', 'format', 'datetime', 'sortable', true),
            jsonb_build_object('key', 'updated_at', 'label', 'Updated', 'format', 'datetime', 'sortable', true)
          )
        )
      );
    END IF;

    v_next := jsonb_set(v_current, '{resources}', v_next_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Allow Console V2 warehouse transfer summary to read the security-invoker projection view.',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605071445_console_v2_warehouse_transfer_summary_view_registry_v1'));
COMMIT;

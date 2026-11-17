-- Plan: PLAN-202603-customer-shipment-change-review-flow / Step: S04
-- Allow focused operator workspaces to opt into configured columns only.

BEGIN;

SELECT pg_advisory_lock(hashtext('202603091250_customer_shipment_changes_strict_columns_v1'));
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
        v_resource := jsonb_set(v_resource, '{strict_columns}', 'true'::jsonb, TRUE);
      END IF;
      v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
    END LOOP;

    v_next := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
      SET value = v_next,
          version = v_row.version + 1,
          change_reason = 'Enable strict configured columns for customer_shipment_changes.',
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

SELECT pg_advisory_unlock(hashtext('202603091250_customer_shipment_changes_strict_columns_v1'));
COMMIT;

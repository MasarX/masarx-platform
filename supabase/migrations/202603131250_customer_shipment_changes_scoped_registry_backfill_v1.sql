-- Plan: PLAN-202603-runtime-deploy-health-mainline-convergence / Step: S06
-- Backfill scoped ui_read_registry rows with the customer_shipment_changes
-- resource so scoped ResourcePage resolution can find the review workspace.

BEGIN;

SELECT pg_advisory_lock(hashtext('202603131250_customer_shipment_changes_scoped_registry_backfill_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_canonical_resource JSONB;
  v_row RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_updated_resources JSONB;
  v_resource JSONB;
  v_found BOOLEAN;
  v_next JSONB;
BEGIN
  SELECT item
    INTO v_canonical_resource
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS item
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND item->>'key' = 'customer_shipment_changes'
   LIMIT 1;

  IF v_canonical_resource IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global customer_shipment_changes resource missing';
  END IF;

  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type IN ('tenant', 'client', 'sender')
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    v_updated_resources := '[]'::jsonb;
    v_found := FALSE;

    FOR v_resource IN SELECT * FROM jsonb_array_elements(v_resources) LOOP
      IF v_resource->>'key' = 'customer_shipment_changes' THEN
        v_resource := public.deep_merge_jsonb(v_canonical_resource, v_resource);
        v_found := TRUE;
      END IF;

      v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
    END LOOP;

    IF NOT v_found THEN
      v_updated_resources := v_updated_resources || jsonb_build_array(v_canonical_resource);
    END IF;

    v_next := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Backfill customer_shipment_changes into scoped ui_read_registry rows.',
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

SELECT pg_advisory_unlock(hashtext('202603131250_customer_shipment_changes_scoped_registry_backfill_v1'));

COMMIT;

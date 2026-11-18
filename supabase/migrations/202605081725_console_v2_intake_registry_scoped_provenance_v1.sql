-- Console V2 intake provenance registry repair.
--
-- The inbound intake screen derives its shipment provenance from the visible
-- tenant-scoped webhook_inbox rows, then fetches only the linked
-- workflow/domain event rows. Keep that backend read path row-driven by
-- exposing workflow_run_id as an allowed domain_events filter and by making the
-- paired webhook/mapping directory projections explicitly tenant-scoped in
-- ui_read_registry.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605081725_console_v2_intake_registry_scoped_provenance_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $read_registry$
DECLARE
  v_scope RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_resource JSONB;
  v_filters JSONB;
BEGIN
  FOR v_scope IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_scope.value, '{"resources":[]}'::jsonb);
    v_resources := '[]'::jsonb;

    FOR v_resource IN
      SELECT value
      FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS value
    LOOP
      IF v_resource->>'key' IN ('webhook_inbox', 'webhook_inbox_directory', 'mapping_config_directory') THEN
        v_resource := jsonb_set(
          v_resource,
          '{scope_columns}',
          COALESCE(v_resource->'scope_columns', '{}'::jsonb)
            || jsonb_build_object('tenant', 'organization_id'),
          TRUE
        );

        v_filters := COALESCE(v_resource->'filters', '[]'::jsonb);
        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_filters) AS filter
          WHERE filter->>'key' = 'organization_id'
        ) THEN
          v_filters := v_filters || jsonb_build_array(
            jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq')
          );
        END IF;

        IF v_resource->>'key' = 'webhook_inbox' THEN
          IF NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(v_filters) AS filter
            WHERE filter->>'key' = 'id'
          ) THEN
            v_filters := v_filters || jsonb_build_array(
              jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq')
            );
          END IF;
          IF NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(v_filters) AS filter
            WHERE filter->>'key' = 'workflow_run_id'
          ) THEN
            v_filters := v_filters || jsonb_build_array(
              jsonb_build_object('key', 'workflow_run_id', 'column', 'workflow_run_id', 'op', 'eq')
            );
          END IF;
          IF NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(v_filters) AS filter
            WHERE filter->>'key' = 'idempotency_key'
          ) THEN
            v_filters := v_filters || jsonb_build_array(
              jsonb_build_object('key', 'idempotency_key', 'column', 'idempotency_key', 'op', 'eq')
            );
          END IF;
        END IF;

        v_resource := jsonb_set(v_resource, '{filters}', v_filters, TRUE);
      END IF;

      IF v_resource->>'key' = 'domain_events' THEN
        v_filters := COALESCE(v_resource->'filters', '[]'::jsonb);
        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_filters) AS filter
          WHERE filter->>'key' = 'workflow_run_id'
        ) THEN
          v_filters := v_filters || jsonb_build_array(
            jsonb_build_object('key', 'workflow_run_id', 'column', 'workflow_run_id', 'op', 'eq')
          );
        END IF;
        v_resource := jsonb_set(v_resource, '{filters}', v_filters, TRUE);
      END IF;

      v_resources := v_resources || jsonb_build_array(v_resource);
    END LOOP;

    v_current := jsonb_set(v_current, '{resources}', v_resources, TRUE);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = v_scope.version + 1,
           change_reason = 'Scope Console V2 intake and mapping registry reads by tenant and workflow provenance',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_scope.settings_version_id
       AND sv.value IS DISTINCT FROM v_current;

    UPDATE public.settings s
       SET cached_value = v_current,
           last_updated = now()
     WHERE s.id = v_scope.settings_id
       AND s.cached_value IS DISTINCT FROM v_current;
  END LOOP;
END;
$read_registry$;

SELECT pg_advisory_unlock(hashtext('202605081725_console_v2_intake_registry_scoped_provenance_v1'));

COMMIT;

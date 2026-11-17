-- Plan: PLAN-202603-fieldops-driver-production-readiness-v1 / Step: S04
-- Migration: ui_read_registry settlements scoped override backfill v1
-- Purpose:
-- - Reconcile all active ui_read_registry scope rows so tenant/client/sender overrides cannot mask the mobile settlements resource.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603052360_ui_read_registry_settlements_scope_backfill_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_read_registry_settlements_resource_v1()
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'key', 'settlements',
    'label', 'Settlements',
    'relation', 'public.settlement_batches',
    'id_column', 'id',
    'scope_columns', jsonb_build_object(
      'tenant', 'organization_id',
      'client', 'client_id',
      'sender', 'sender_id'
    ),
    'capability_read', 'tasks.read',
    'select', jsonb_build_array(
      'id',
      'kind',
      'scope_type',
      'branch_id',
      'client_id',
      'sender_id',
      'subject_type',
      'subject_id',
      'status',
      'status_reason',
      'window_start_at',
      'window_end_at',
      'metadata',
      'created_at',
      'updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'kind', 'column', 'kind', 'op', 'eq'),
      jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq'),
      jsonb_build_object('key', 'subject_id', 'column', 'subject_id', 'op', 'eq'),
      jsonb_build_object('key', 'subject_type', 'column', 'subject_type', 'op', 'eq')
    ),
    'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
  );
$$;

COMMENT ON FUNCTION public.ui_read_registry_settlements_resource_v1()
  IS 'Canonical settlements ui_read_registry resource payload used to reconcile scoped ui_read_registry overrides.';

DO $$
DECLARE
  v_resource JSONB := public.ui_read_registry_settlements_resource_v1();
  v_setting RECORD;
  v_resources JSONB;
  v_updated_resources JSONB;
  v_current JSONB;
  v_item JSONB;
  v_found BOOLEAN;
BEGIN
  FOR v_setting IN
    SELECT
      s.category,
      s.scope_type,
      s.scope_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
      AND sv.effective_until IS NULL
  LOOP
    v_current := COALESCE(v_setting.value, '{}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    v_updated_resources := '[]'::jsonb;
    v_found := FALSE;

    FOR v_item IN SELECT value FROM jsonb_array_elements(v_resources) AS value LOOP
      IF v_item->>'key' = 'settlements' THEN
        v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
        v_found := TRUE;
      ELSE
        v_updated_resources := v_updated_resources || jsonb_build_array(v_item);
      END IF;
    END LOOP;

    IF NOT v_found THEN
      v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
    END IF;

    v_current := jsonb_set(v_current, '{resources}', v_updated_resources, true);

    IF v_current IS DISTINCT FROM v_setting.value THEN
      UPDATE public.settings_versions
         SET value = v_current,
             version = v_setting.version + 1,
             change_reason = 'Backfill settlements resource into scoped ui_read_registry overrides',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_setting.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_current,
             last_updated = now()
       WHERE category = v_setting.category
         AND scope_type = v_setting.scope_type
         AND scope_id IS NOT DISTINCT FROM v_setting.scope_id;
    END IF;
  END LOOP;
END $$;

SELECT pg_advisory_unlock(hashtext('202603052360_ui_read_registry_settlements_scope_backfill_v1'));
COMMIT;

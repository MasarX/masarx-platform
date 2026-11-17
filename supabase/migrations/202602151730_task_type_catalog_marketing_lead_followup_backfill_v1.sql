-- Plan: PLAN-202602-fieldops-driver-go-live / Step: S99
-- Migration: task_type_catalog - backfill marketing_lead_followup (global default; additive)
-- Date: 2026-02-15
--
-- Context:
--   pgTAP marketing lead intake depends on task_type_catalog containing the
--   marketing_lead_followup task type. In some workspaces the migration history
--   indicates the original add migration ran, but the settings row does not
--   include the entry. This migration is a safe, idempotent backfill.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602151730_task_type_catalog_marketing_lead_followup_backfill_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_settings_version_id UUID;
  v_value JSONB;
  v_task_types JSONB;
  v_key TEXT := 'marketing_lead_followup';
  v_item JSONB := jsonb_build_object(
    'key', v_key,
    'name', 'Marketing Lead Follow-up',
    'description', 'Follow up on inbound Contact Sales leads from the marketing landing.',
    'default_priority', 50,
    'default_queue_key', 'default',
    'enabled', TRUE
  );
  v_changed BOOLEAN := FALSE;
BEGIN
  SELECT s.settings_version_id, s.cached_value
    INTO v_settings_version_id, v_value
    FROM public.settings s
   WHERE s.category = 'task_type_catalog'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    RAISE EXCEPTION 'task_type_catalog global settings missing'
      USING ERRCODE = '23503';
  END IF;

  v_task_types := COALESCE(v_value->'task_types', '[]'::jsonb);
  IF jsonb_typeof(v_task_types) IS DISTINCT FROM 'array' THEN
    v_task_types := '[]'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_task_types) AS t(value)
     WHERE lower(NULLIF(btrim(COALESCE(t.value->>'key', '')), '')) = v_key
  ) THEN
    v_task_types := v_task_types || jsonb_build_array(v_item);
    v_changed := TRUE;
  END IF;

  IF v_changed THEN
    v_value := jsonb_set(COALESCE(v_value, '{}'::jsonb), '{task_types}', v_task_types, TRUE);
    IF NULLIF(btrim(COALESCE(v_value->>'version', '')), '') IS NULL THEN
      v_value := jsonb_set(v_value, '{version}', to_jsonb(1), TRUE);
    END IF;

    UPDATE public.settings_versions sv
       SET value = v_value,
           approved_at = now()
     WHERE sv.id = v_settings_version_id;

    UPDATE public.settings s
       SET cached_value = v_value,
           last_updated = now()
     WHERE s.category = 'task_type_catalog'
       AND s.scope_type = 'global'
       AND s.scope_hash = v_scope_hash;
  END IF;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202602151730_task_type_catalog_marketing_lead_followup_backfill_v1'));
COMMIT;


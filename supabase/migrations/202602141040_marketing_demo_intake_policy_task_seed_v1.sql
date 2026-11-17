-- Plan: PLAN-202602-landing-contact-sales-intake / Step: S04
-- Migration: marketing_demo_intake_policy global default - seed task routing defaults (additive)
-- Date: 2026-02-14
--
-- Notes:
--   - Updates the existing global default settings row in-place (SSOT: settings_versions + settings.cached_value).
--   - Adds policy.task defaults used by marketing_lead_request_create_v1.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602141040_marketing_demo_intake_policy_task_seed_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_settings_version_id UUID;
  v_value JSONB;
BEGIN
  SELECT s.settings_version_id, s.cached_value
    INTO v_settings_version_id, v_value
    FROM public.settings s
   WHERE s.category = 'marketing_demo_intake_policy'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    RAISE EXCEPTION 'marketing_demo_intake_policy global settings missing'
      USING ERRCODE = '23503';
  END IF;

  IF jsonb_typeof(v_value) IS DISTINCT FROM 'object' THEN
    v_value := '{}'::jsonb;
  END IF;

  IF COALESCE(jsonb_typeof(v_value->'task'), 'null') IS DISTINCT FROM 'object' THEN
    v_value := jsonb_set(v_value, '{task}', '{}'::jsonb, TRUE);
  END IF;

  IF NULLIF(btrim(COALESCE(v_value#>>'{task,organization_slug}', '')), '') IS NULL THEN
    v_value := jsonb_set(v_value, '{task,organization_slug}', to_jsonb('global-root'::text), TRUE);
  END IF;

  IF NULLIF(btrim(COALESCE(v_value#>>'{task,task_type_key}', '')), '') IS NULL THEN
    v_value := jsonb_set(v_value, '{task,task_type_key}', to_jsonb('marketing_lead_followup'::text), TRUE);
  END IF;

  UPDATE public.settings_versions sv
     SET value = v_value,
         approved_at = now()
   WHERE sv.id = v_settings_version_id;

  UPDATE public.settings s
     SET cached_value = v_value,
         last_updated = now()
   WHERE s.category = 'marketing_demo_intake_policy'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202602141040_marketing_demo_intake_policy_task_seed_v1'));
COMMIT;


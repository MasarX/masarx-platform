-- Migration: label print policy async execute default
-- Purpose:
--   - Align the active label print policy with the commit-aware async execute transport.
--   - Remove the stale sync_wait default from the global row-driven policy surface.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603063340_label_print_policy_execute_async_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_settings_id uuid;
  v_version_id uuid;
  v_value jsonb;
BEGIN
  SELECT s.id, s.settings_version_id, sv.value
  INTO v_settings_id, v_version_id, v_value
  FROM public.settings s
  JOIN public.settings_versions sv
    ON sv.id = s.settings_version_id
  WHERE s.category = 'label_print_policy'
    AND s.scope_type = 'global'
    AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  ORDER BY s.last_updated DESC
  LIMIT 1;

  IF v_settings_id IS NULL OR v_version_id IS NULL THEN
    RAISE EXCEPTION 'Global label_print_policy settings missing';
  END IF;

  UPDATE public.settings_versions
  SET value = jsonb_set(
        jsonb_set(COALESCE(v_value, '{}'::jsonb), '{execute_dispatch_mode}', to_jsonb('async'::text), true),
        '{execute_initial_defer_ms}',
        to_jsonb(0),
        true
      ),
      change_reason = 'Default label print execute dispatch to async because pg_net HTTP dispatch starts after commit',
      approved_at = workflow_now(),
      effective_from = workflow_now()
  WHERE id = v_version_id;

  UPDATE public.settings
  SET cached_value = (SELECT value FROM public.settings_versions WHERE id = v_version_id),
      last_updated = workflow_now()
  WHERE id = v_settings_id;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202603063340_label_print_policy_execute_async_v1'));
COMMIT;

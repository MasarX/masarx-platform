-- Plan: PLAN-202603-customer-shipment-change-review-flow / Step: S04
-- Migration: remove legacy public-tracking reviewer task organization slug default

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091220_public_tracking_policy_reviewer_task_org_default_cleanup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'public_tracking_policy'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    v_next := v_current;

    IF v_current #>> ARRAY['notifications','task','organization_slug'] = 'global-root' THEN
      v_next := v_next #- ARRAY['notifications','task','organization_slug'];
    END IF;

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
      SET value = v_next,
          version = v_row.version + 1,
          change_reason = 'Remove legacy global-root reviewer task default from public_tracking_policy.',
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

SELECT pg_advisory_unlock(hashtext('202603091220_public_tracking_policy_reviewer_task_org_default_cleanup_v1'));
COMMIT;

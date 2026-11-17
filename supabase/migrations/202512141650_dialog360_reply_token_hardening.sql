-- Migration: Dialog360 reply webhook source token hardening
-- Purpose:
--   - Prevent production use of the historical default token (`dialog360-reply-token`).
--   - Disable the webhook source when its token hash matches the default, requiring re-provisioning.
-- Date: 2025-12-14

BEGIN;

DO $$
DECLARE
  v_source RECORD;
BEGIN
  SELECT id, organization_id, auth_token_hash, enabled
    INTO v_source
    FROM public.webhook_sources
   WHERE source_identifier = 'dialog360_reply'
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_source.id IS NULL THEN
    RETURN;
  END IF;

  IF v_source.auth_token_hash IS NULL THEN
    RETURN;
  END IF;

  -- If the stored bcrypt hash validates against the known historical default token, disable the source.
  IF crypt('dialog360-reply-token', v_source.auth_token_hash) = v_source.auth_token_hash THEN
    UPDATE public.webhook_sources
       SET enabled = FALSE,
           updated_at = now()
     WHERE id = v_source.id;

    PERFORM public.log_decision(
      p_organization_id := v_source.organization_id,
      p_decision_category := 'security',
      p_resource_type := 'webhook_source',
      p_resource_id := v_source.id,
      p_decision_point := 'disable_default_token',
      p_decision_outcome := 'disabled',
      p_performed_by_system := 'migration_dialog360_reply_token_hardening',
      p_correlation_id := NULL,
      p_decision_inputs := jsonb_build_object(
        'source_identifier', 'dialog360_reply',
        'reason', 'default_token_detected'
      ),
      p_decision_reason := 'Disabled dialog360_reply webhook source because its token matched a known default; re-provision a strong token.'
    );
  END IF;
END $$;

COMMIT;


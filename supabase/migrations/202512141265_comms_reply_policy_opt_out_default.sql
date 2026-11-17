-- Migration: Ensure comms_reply_policy includes an opt-out intent (policy-driven stop + consent)
-- Purpose:
--   - Add a standard opt_out intent when missing, so STOP/UNSUBSCRIBE is handled safely.
--   - Keep stop_workflow policy-driven: only opt_out intent requests stop_workflow=true.
-- Date: 2025-12-14

BEGIN;

DO $$
DECLARE
  v_setting RECORD;
  v_value JSONB;
  v_intents JSONB;
  v_optout_intent JSONB;
  v_next_version INT;
  v_new_version_id UUID;
BEGIN
  v_optout_intent := jsonb_build_object(
    'keywords', jsonb_build_array('stop', 'unsubscribe', 'optout', 'opt-out', 'cancel'),
    'template', 'You have been opted out. You will no longer receive WhatsApp messages from us.',
    'stop_workflow', TRUE,
    'opt_out', TRUE,
    'allow_opted_out_send', TRUE
  );

  FOR v_setting IN
    SELECT s.id,
           s.scope_type,
           s.scope_id,
           s.scope_hash,
           s.cached_value
      FROM public.settings s
     WHERE s.category = 'comms_reply_policy'
     ORDER BY s.last_updated DESC NULLS LAST
  LOOP
    v_value := COALESCE(v_setting.cached_value, '{}'::jsonb);
    v_intents := COALESCE(v_value->'intents', '{}'::jsonb);

    -- Skip if already configured.
    IF v_intents ? 'opt_out' THEN
      CONTINUE;
    END IF;

    v_intents := v_intents || jsonb_build_object('opt_out', v_optout_intent);
    v_value := v_value || jsonb_build_object('intents', v_intents);

    SELECT COALESCE(MAX(version), 0) + 1
      INTO v_next_version
      FROM public.settings_versions sv
     WHERE sv.category = 'comms_reply_policy'
       AND sv.scope_type = v_setting.scope_type
       AND (sv.scope_id IS NOT DISTINCT FROM v_setting.scope_id);

    INSERT INTO public.settings_versions (
      category,
      scope_type,
      scope_id,
      version,
      value,
      schema_version,
      change_reason,
      approved_at,
      effective_from
    )
    VALUES (
      'comms_reply_policy',
      v_setting.scope_type,
      v_setting.scope_id,
      v_next_version,
      v_value,
      1,
      'Add opt_out intent to comms_reply_policy (STOP/UNSUBSCRIBE handling)',
      now(),
      now()
    )
    RETURNING id INTO v_new_version_id;

    UPDATE public.settings
       SET settings_version_id = v_new_version_id,
           cached_value = v_value,
           last_updated = now()
     WHERE id = v_setting.id;
  END LOOP;
END $$;

COMMIT;


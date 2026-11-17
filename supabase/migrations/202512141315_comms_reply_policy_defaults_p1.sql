-- Migration: Seed comms_reply_policy defaults for disambiguation + rate limiting
-- Purpose:
--   - Ensure policy includes:
--     - reply_rate_limit (enabled/window/max)
--     - intents.<intent>.multiple_shipments templates + ttl/max options for two-way disambiguation
--   - No code fallbacks: send_comms_reply reads these settings rows.
-- Date: 2025-12-14

BEGIN;

DO $$
DECLARE
  v_setting RECORD;
  v_value JSONB;
  v_intents JSONB;
  v_rate JSONB;
  v_intent_key TEXT;
  v_intent_cfg JSONB;
  v_multi JSONB;
  v_next_version INT;
  v_new_version_id UUID;
  v_changed BOOLEAN;
BEGIN
  v_rate := jsonb_build_object(
    'enabled', TRUE,
    'window_seconds', 60,
    'max_replies', 5
  );

  FOR v_setting IN
    SELECT s.id,
           s.scope_type,
           s.scope_id,
           s.cached_value
      FROM public.settings s
     WHERE s.category = 'comms_reply_policy'
     ORDER BY s.last_updated DESC NULLS LAST
  LOOP
    v_changed := FALSE;
    v_value := COALESCE(v_setting.cached_value, '{}'::jsonb);
    v_intents := COALESCE(v_value->'intents', '{}'::jsonb);

    IF NOT (v_value ? 'reply_rate_limit') THEN
      v_value := v_value || jsonb_build_object('reply_rate_limit', v_rate);
      v_changed := TRUE;
    END IF;

    -- Add multiple_shipments config for any intent that requires_shipment=true.
    FOR v_intent_key IN
      SELECT key
      FROM jsonb_object_keys(v_intents) AS key
    LOOP
      v_intent_cfg := COALESCE(v_intents->v_intent_key, '{}'::jsonb);
      IF COALESCE(NULLIF(v_intent_cfg->>'requires_shipment', '')::BOOLEAN, (v_intent_cfg ? 'not_found_template')) THEN
        IF NOT (v_intent_cfg ? 'multiple_shipments') THEN
          v_multi := jsonb_build_object(
            'template', 'We found multiple shipments for your number. Reply with the tracking number (or a number from the list):\n{{shipment_options}}',
            'invalid_selection_template', 'Please reply with one of the tracking numbers (or a number from the list):\n{{shipment_options}}',
            'ttl_seconds', 900,
            'max_options', 5
          );
          v_intent_cfg := v_intent_cfg || jsonb_build_object('multiple_shipments', v_multi);
          v_intents := jsonb_set(v_intents, ARRAY[v_intent_key], v_intent_cfg, TRUE);
          v_changed := TRUE;
        END IF;
      END IF;
    END LOOP;

    IF v_changed THEN
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
        'Seed comms_reply_policy defaults (disambiguation + reply_rate_limit)',
        now(),
        now()
      )
      RETURNING id INTO v_new_version_id;

      UPDATE public.settings
         SET settings_version_id = v_new_version_id,
             cached_value = v_value,
             last_updated = now()
       WHERE id = v_setting.id;
    END IF;
  END LOOP;
END $$;

COMMIT;


-- Plan: PLAN-202512-comms-reply-low-latency / Step: S04
-- Migration: comms_reply_policy dispatch defaults
-- Purpose:
--   - Add dispatch configuration to comms_reply_policy settings rows (row-driven; no code fallbacks).
--   - Enable inline dispatch for dialog360_reply by default (latency-sensitive source).
-- Date: 2025-12-16

BEGIN;

DO $$
DECLARE
  v_setting RECORD;
  v_value JSONB;
  v_defaults_dispatch JSONB;
  v_existing_dispatch JSONB;
  v_new_dispatch JSONB;
  v_changed BOOLEAN;
  v_next_version INT;
  v_new_version_id UUID;
  v_dialog_source_id UUID := NULL;
BEGIN
  SELECT id
    INTO v_dialog_source_id
    FROM public.webhook_sources
   WHERE source_identifier = 'dialog360_reply'
   LIMIT 1;

  v_defaults_dispatch := jsonb_build_object(
    'mode', 'queue',
    'timeout_seconds', 10,
    'poll_max_seconds', 8,
    'poll_interval_ms', 200,
    'lease_seconds', 30,
    'pending_reschedule_seconds', 30
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

    v_existing_dispatch := v_value->'dispatch';
    IF v_existing_dispatch IS NULL OR jsonb_typeof(v_existing_dispatch) <> 'object' THEN
      v_existing_dispatch := '{}'::jsonb;
      v_changed := TRUE;
    END IF;

    v_new_dispatch := public.jsonb_deep_merge(v_defaults_dispatch, v_existing_dispatch);

    -- Default enablement: dialog360_reply is latency-sensitive.
    IF v_dialog_source_id IS NOT NULL
       AND v_setting.scope_type = 'source'
       AND v_setting.scope_id = v_dialog_source_id THEN
      v_new_dispatch := jsonb_set(v_new_dispatch, '{mode}', to_jsonb('inline'::text), TRUE);
    END IF;

    IF (v_value->'dispatch') IS DISTINCT FROM v_new_dispatch THEN
      v_value := jsonb_set(v_value, '{dispatch}', v_new_dispatch, TRUE);
      v_changed := TRUE;
    END IF;

    IF v_changed THEN
      -- Expire the current active version first to satisfy the "one current row" unique index.
      UPDATE public.settings_versions
         SET effective_until = now()
       WHERE category = 'comms_reply_policy'
         AND scope_type = v_setting.scope_type
         AND (scope_id IS NOT DISTINCT FROM v_setting.scope_id)
         AND effective_until IS NULL
         AND approved_at IS NOT NULL;

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
        'Seed comms_reply_policy dispatch defaults (inline dispatch support)',
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

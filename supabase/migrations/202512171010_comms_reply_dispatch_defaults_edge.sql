-- Plan: PLAN-202512-comms-reply-edge-dispatch-v1 / Step: S04
-- Migration: comms_reply_policy dispatch defaults (edge for dialog360_reply)
-- Purpose:
--   - Switch dialog360_reply default dispatch from inline -> edge to avoid intake RPC timeouts.
--   - Keep behavior row-driven via settings_versions (no code fallbacks).
-- Date: 2025-12-17

BEGIN;

DO $$
DECLARE
  v_setting RECORD;
  v_value JSONB;
  v_dispatch JSONB;
  v_dialog_source_id UUID := NULL;
  v_next_version INT;
  v_new_version_id UUID;
BEGIN
  SELECT id
    INTO v_dialog_source_id
    FROM public.webhook_sources
   WHERE source_identifier = 'dialog360_reply'
   LIMIT 1;

  IF v_dialog_source_id IS NULL THEN
    RAISE NOTICE 'dialog360_reply webhook source not found; skipping comms_reply_policy dispatch update';
    RETURN;
  END IF;

  FOR v_setting IN
    SELECT s.id,
           s.scope_type,
           s.scope_id,
           s.cached_value
      FROM public.settings s
     WHERE s.category = 'comms_reply_policy'
       AND s.scope_type = 'source'
       AND s.scope_id = v_dialog_source_id
     ORDER BY s.last_updated DESC NULLS LAST
  LOOP
    v_value := COALESCE(v_setting.cached_value, '{}'::jsonb);
    v_dispatch := COALESCE(v_value->'dispatch', '{}'::jsonb);
    IF jsonb_typeof(v_dispatch) <> 'object' THEN
      v_dispatch := '{}'::jsonb;
    END IF;

    v_dispatch := jsonb_set(v_dispatch, '{mode}', to_jsonb('edge'::text), TRUE);

    IF (v_value->'dispatch') IS DISTINCT FROM v_dispatch THEN
      v_value := jsonb_set(v_value, '{dispatch}', v_dispatch, TRUE);

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
        'Set dialog360_reply comms replies to edge dispatch (avoid intake RPC timeout)',
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


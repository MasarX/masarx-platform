-- Migration: Migrate comms_reply_policy from resource-scope (legacy) to source-scope (ladder-compliant)
-- Purpose:
--   - Preserve existing Dialog360 reply policies that were incorrectly stored as scope_type='resource'
--     on webhook_sources.id by copying them to scope_type='source'.
--   - Ensures the full ladder (Source->Sender->Client->Tenant->Global) is reachable for replies.
-- Date: 2025-12-14

BEGIN;

DO $$
DECLARE
  v_source RECORD;
  v_value JSONB;
  v_next_version INT;
  v_version_id UUID;
BEGIN
  FOR v_source IN
    SELECT ws.id AS webhook_source_id
    FROM public.webhook_sources ws
    WHERE EXISTS (
      SELECT 1
      FROM public.settings s
      WHERE s.category = 'comms_reply_policy'
        AND s.scope_type = 'resource'
        AND s.scope_id = ws.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.settings s
      WHERE s.category = 'comms_reply_policy'
        AND s.scope_type = 'source'
        AND s.scope_id = ws.id
    )
    ORDER BY ws.created_at ASC
  LOOP
    SELECT cached_value
      INTO v_value
      FROM public.settings
     WHERE category = 'comms_reply_policy'
       AND scope_type = 'resource'
       AND scope_id = v_source.webhook_source_id
     ORDER BY last_updated DESC NULLS LAST
     LIMIT 1;

    IF v_value IS NULL THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(MAX(version), 0) + 1
      INTO v_next_version
      FROM public.settings_versions
     WHERE category = 'comms_reply_policy'
       AND scope_type = 'source'
       AND scope_id = v_source.webhook_source_id;

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
      'source',
      v_source.webhook_source_id,
      v_next_version,
      v_value,
      1,
      'Migrate legacy comms_reply_policy from resource scope to source scope for webhook_sources',
      now(),
      now()
    )
    RETURNING id INTO v_version_id;

    INSERT INTO public.settings (
      category,
      scope_type,
      scope_id,
      settings_version_id,
      cached_value,
      last_updated
    )
    VALUES (
      'comms_reply_policy',
      'source',
      v_source.webhook_source_id,
      v_version_id,
      v_value,
      now()
    )
    ON CONFLICT (category, scope_type, scope_hash)
    DO UPDATE SET
      settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;
  END LOOP;
END $$;

COMMIT;


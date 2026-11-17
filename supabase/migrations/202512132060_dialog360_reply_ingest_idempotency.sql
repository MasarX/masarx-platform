-- Migration: Dialog360 reply ingest idempotency
-- Purpose: Prevent duplicate processing/replies by adding an idempotency key derived from the inbound message id.
-- Date: 2025-12-13

BEGIN;

DO $$
DECLARE
  v_source_id UUID;
  v_now TIMESTAMPTZ := now();
  v_current JSONB;
  v_next_version INT;
  v_new_version_id UUID;
BEGIN
  SELECT id
    INTO v_source_id
    FROM webhook_sources
   WHERE source_identifier = 'dialog360_reply'
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_source_id IS NULL THEN
    RETURN;
  END IF;

  SELECT cached_value
    INTO v_current
    FROM settings
   WHERE category = 'webhook_ingest_policy'
     AND scope_type = 'resource'
     AND scope_id = v_source_id
   ORDER BY last_updated DESC NULLS LAST
   LIMIT 1;

  v_current := COALESCE(v_current, '{}'::jsonb);

  IF v_current#>>'{validation,idempotency,body_path}' = 'entry.0.changes.0.value.messages.0.id' THEN
    RETURN;
  END IF;

  -- Ensure validation.idempotency.body_path points at the inbound message id.
  v_current := jsonb_set(
    v_current,
    '{validation,idempotency,body_path}',
    to_jsonb('entry.0.changes.0.value.messages.0.id'::text),
    TRUE
  );

  SELECT COALESCE(MAX(version), 0) + 1
    INTO v_next_version
    FROM settings_versions
   WHERE category = 'webhook_ingest_policy'
     AND scope_type = 'resource'
     AND scope_id = v_source_id;

  UPDATE settings_versions
     SET effective_until = v_now
   WHERE category = 'webhook_ingest_policy'
     AND scope_type = 'resource'
     AND scope_id = v_source_id
     AND effective_until IS NULL;

  INSERT INTO settings_versions (
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
    'webhook_ingest_policy',
    'resource',
    v_source_id,
    v_next_version,
    v_current,
    1,
    'Enable idempotency for dialog360_reply ingest (dedupe by message id)',
    v_now,
    v_now
  )
  RETURNING id INTO v_new_version_id;

  INSERT INTO settings (
    category,
    scope_type,
    scope_id,
    settings_version_id,
    cached_value,
    last_updated
  )
  VALUES (
    'webhook_ingest_policy',
    'resource',
    v_source_id,
    v_new_version_id,
    v_current,
    v_now
  )
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;
END $$;

COMMIT;

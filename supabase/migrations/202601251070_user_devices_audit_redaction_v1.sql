-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Audit redaction defaults for user_devices (push_token, device identifiers)
-- Date: 2026-01-25
--
-- Purpose:
--   - user_devices is audit-enabled and contains token-like fields (push_token).
--   - Ensure audit_table_changes snapshots redact sensitive columns (row-driven).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601251070_user_devices_audit_redaction_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.audit_redaction_rules (table_schema, table_name, mode, columns, redaction_token)
VALUES (
  'public',
  'user_devices',
  'denylist',
  ARRAY['push_token', 'device_identifier_sha256'],
  '[REDACTED]'
)
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  mode = EXCLUDED.mode,
  columns = EXCLUDED.columns,
  redaction_token = EXCLUDED.redaction_token,
  updated_at = now();

SELECT pg_advisory_unlock(hashtext('202601251070_user_devices_audit_redaction_v1'));
COMMIT;


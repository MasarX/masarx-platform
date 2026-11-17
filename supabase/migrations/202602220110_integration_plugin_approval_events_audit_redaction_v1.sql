-- Plan: PLAN-202602-integration-plugin-studio-v1 / Step: S99
-- Migration: integration plugin approval events audit redaction v1
-- Purpose:
--   - Keep integration_plugin_approval_events audit-enabled while redacting payload snapshots.
--   - Satisfy pgTAP sensitive-column audit redaction coverage.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602220110_integration_plugin_approval_events_audit_redaction_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.audit_redaction_rules (table_schema, table_name, mode, columns, redaction_token)
VALUES (
  'public',
  'integration_plugin_approval_events',
  'denylist',
  ARRAY['payload']::text[],
  '[REDACTED]'
)
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  mode = EXCLUDED.mode,
  columns = EXCLUDED.columns,
  redaction_token = EXCLUDED.redaction_token,
  updated_at = now();

SELECT pg_advisory_unlock(hashtext('202602220110_integration_plugin_approval_events_audit_redaction_v1'));
COMMIT;

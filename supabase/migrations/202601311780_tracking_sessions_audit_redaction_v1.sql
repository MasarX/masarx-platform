-- Migration: tracking_sessions audit redaction v1
-- Purpose:
--   - pgTAP requires audit_redaction_rules coverage for audited tables with sensitive column names
--     (e.g., token/token_hash) (073_audit_redaction_seed_sensitive.sql).
--   - Keep audit_enabled=TRUE for tracking_sessions while ensuring token material is never stored
--     in audit_table_changes snapshots.

BEGIN;

SELECT pg_advisory_lock(hashtext('202601311780_tracking_sessions_audit_redaction_v1'));

INSERT INTO public.audit_redaction_rules (table_schema, table_name, mode, columns, redaction_token)
VALUES ('public', 'tracking_sessions', 'denylist', ARRAY['token', 'token_hash', 'token_hint']::text[], '[REDACTED]')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  mode = EXCLUDED.mode,
  columns = EXCLUDED.columns,
  redaction_token = EXCLUDED.redaction_token,
  updated_at = now();

SELECT pg_advisory_unlock(hashtext('202601311780_tracking_sessions_audit_redaction_v1'));

COMMIT;


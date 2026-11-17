-- Migration: route_stop_reassignment_events audit redaction v1
-- Purpose:
--   - Keep route_stop_reassignment_events audit-enabled while redacting payload snapshots.
--   - Satisfy pgTAP sensitive-column audit redaction coverage for UC079.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604102020_route_stop_reassignment_events_audit_redaction_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.audit_redaction_rules (table_schema, table_name, mode, columns, redaction_token)
VALUES (
  'public',
  'route_stop_reassignment_events',
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

SELECT pg_advisory_unlock(hashtext('202604102020_route_stop_reassignment_events_audit_redaction_v1'));
COMMIT;

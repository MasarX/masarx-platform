-- Migration: table_contracts route assignment + zone override fixup v1
-- Purpose:
--   - Register newly introduced operational tables in table_contracts.
--   - Keep timestamp/audit compatibility gates green on rebased heads.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604061730_table_contracts_route_assignment_zone_override_fixup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  updated_at_required,
  audit_enabled,
  notes
)
VALUES
  (
    'public',
    'route_run_assignments',
    TRUE,
    TRUE,
    TRUE,
    'Authoritative route-run assignment projection for internal-driver and partner-fleet ownership.'
  ),
  (
    'public',
    'route_run_assignment_events',
    TRUE,
    FALSE,
    TRUE,
    'Append-only route-run assignment lifecycle event ledger.'
  ),
  (
    'public',
    'zone_override_requests',
    TRUE,
    TRUE,
    TRUE,
    'Manual zone-override approval requests for wrong-zone shipment exceptions.'
  )
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202604061730_table_contracts_route_assignment_zone_override_fixup_v1'));
COMMIT;

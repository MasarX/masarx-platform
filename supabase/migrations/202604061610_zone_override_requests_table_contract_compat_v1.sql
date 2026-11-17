-- Migration: zone_override_requests table contract compat v1
-- Purpose:
--   - Register public.zone_override_requests in public.table_contracts after the
--     B04 UC062 ledger landed without the canonical contract row.
--   - Reconcile updated_at + audit trigger enforcement so table contract pgTap
--     remains truthful after the zone override approval slice.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604061610_zone_override_requests_table_contract_compat_v1'));

INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  updated_at_required,
  audit_enabled,
  notes
)
VALUES (
  'public',
  'zone_override_requests',
  TRUE,
  TRUE,
  TRUE,
  'Zone override approval ledger contract reconcile (timestamp + audit).'
)
ON CONFLICT (table_schema, table_name) DO UPDATE
SET created_at_required = EXCLUDED.created_at_required,
    updated_at_required = EXCLUDED.updated_at_required,
    audit_enabled = EXCLUDED.audit_enabled,
    notes = EXCLUDED.notes;

SELECT * FROM public.apply_table_contracts('public');
SELECT public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202604061610_zone_override_requests_table_contract_compat_v1'));

COMMIT;

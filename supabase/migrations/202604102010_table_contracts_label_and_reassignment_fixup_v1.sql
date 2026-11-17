-- Migration: register label and route-stop reassignment tables in table_contracts
-- Purpose:
--   - Keep new public base tables covered by the canonical timestamp/audit registry.
--   - Reconcile timestamp triggers and audit triggers from the registry after registration.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604102010_table_contracts_label_and_reassignment_fixup_v1'));

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
        'label_artifacts',
        TRUE,
        TRUE,
        TRUE,
        'Canonical persistence for target-neutral non-shipment label outputs.'
    ),
    (
        'public',
        'label_versions',
        TRUE,
        TRUE,
        TRUE,
        'Stable active/superseded label lineage for generation and reprint governance.'
    ),
    (
        'public',
        'route_stop_reassignment_events',
        TRUE,
        FALSE,
        TRUE,
        'Append-only route-stop reassignment lifecycle event ledger.'
    )
ON CONFLICT (table_schema, table_name) DO UPDATE
SET created_at_required = EXCLUDED.created_at_required,
    updated_at_required = EXCLUDED.updated_at_required,
    audit_enabled = EXCLUDED.audit_enabled,
    notes = EXCLUDED.notes;

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202604102010_table_contracts_label_and_reassignment_fixup_v1'));
COMMIT;
-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Register marketplace foundation tables in table_contracts and reconcile audit/timestamp coverage

BEGIN;

SELECT pg_advisory_lock(hashtext('202603091121_marketplace_table_contracts_reconcile_v1'));

INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  updated_at_required,
  audit_enabled,
  notes
)
VALUES
  ('public', 'marketplace_registry_entries', TRUE, TRUE, TRUE, 'Marketplace registry entries contract coverage'),
  ('public', 'marketplace_request_kinds', TRUE, TRUE, TRUE, 'Marketplace request kinds contract coverage'),
  ('public', 'marketplace_participant_profiles', TRUE, TRUE, TRUE, 'Marketplace participant profile contract coverage'),
  ('public', 'marketplace_participant_memberships', TRUE, TRUE, TRUE, 'Marketplace participant membership contract coverage'),
  ('public', 'marketplace_participant_requests', TRUE, TRUE, TRUE, 'Marketplace participant request contract coverage'),
  ('public', 'marketplace_participant_capabilities', TRUE, TRUE, TRUE, 'Marketplace participant capability contract coverage'),
  ('public', 'marketplace_verification_records', TRUE, TRUE, TRUE, 'Marketplace verification record contract coverage'),
  ('public', 'marketplace_availability_windows', TRUE, TRUE, TRUE, 'Marketplace availability window contract coverage'),
  ('public', 'marketplace_requests', TRUE, TRUE, TRUE, 'Marketplace request lifecycle contract coverage'),
  ('public', 'marketplace_request_items', TRUE, TRUE, TRUE, 'Marketplace request item contract coverage'),
  ('public', 'marketplace_offers', TRUE, TRUE, TRUE, 'Marketplace offer contract coverage'),
  ('public', 'marketplace_awards', TRUE, TRUE, TRUE, 'Marketplace award contract coverage'),
  ('public', 'marketplace_contracts', TRUE, TRUE, TRUE, 'Marketplace contract contract coverage'),
  ('public', 'marketplace_work_packages', TRUE, TRUE, TRUE, 'Marketplace work package contract coverage'),
  ('public', 'marketplace_disputes', TRUE, TRUE, TRUE, 'Marketplace dispute contract coverage'),
  ('public', 'marketplace_reputation_events', TRUE, TRUE, FALSE, 'Marketplace reputation event ledger contract coverage'),
  ('public', 'marketplace_reputation_snapshots', TRUE, TRUE, TRUE, 'Marketplace reputation snapshot contract coverage'),
  ('public', 'marketplace_events', TRUE, FALSE, FALSE, 'Marketplace immutable event ledger contract coverage')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes;

SELECT * FROM public.apply_table_contracts('public');
SELECT public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202603091121_marketplace_table_contracts_reconcile_v1'));

COMMIT;

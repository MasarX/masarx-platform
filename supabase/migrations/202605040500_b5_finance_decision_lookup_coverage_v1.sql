-- Complete Phase B5 finance decision-log lookup coverage for canonical
-- billing, settlement, bank reconciliation, dispute, and subscription RPCs.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031550_b5_finance_decision_lookup_coverage_v1'));
SET search_path TO public, extensions, pg_temp;

WITH categories(value, label, sort_order) AS (
  VALUES
    ('bank_recon.match', 'Bank Reconciliation Match', 1700),
    ('bank_recon.unmatch', 'Bank Reconciliation Unmatch', 1710),
    ('billing_invoice.create', 'Billing Invoice Create', 1720),
    ('billing_invoice.refund', 'Billing Invoice Refund', 1730),
    ('billing_invoice.send', 'Billing Invoice Send', 1740),
    ('billing_invoice.update', 'Billing Invoice Update', 1750),
    ('billing_invoice.void', 'Billing Invoice Void', 1760),
    ('dispute.acknowledge', 'Dispute Acknowledge', 1770),
    ('dispute.escalate', 'Dispute Escalate', 1780),
    ('dispute.reject', 'Dispute Reject', 1790),
    ('dispute.resolve', 'Dispute Resolve', 1800),
    ('settlement_batch.apply', 'Settlement Batch Apply', 1810),
    ('settlement_batch.reject', 'Settlement Batch Reject', 1820),
    ('subscription.cancel', 'Subscription Cancel', 1830)
),
definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_category'
   LIMIT 1
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  d.id,
  c.value,
  c.label,
  'Decision category emitted by canonical Phase B5 finance RPCs.',
  c.sort_order,
  FALSE,
  'active',
  jsonb_build_object('source', 'b5_finance_decision_lookup_coverage_v1')
FROM definition d
CROSS JOIN categories c
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

WITH outcomes(value, label, sort_order) AS (
  VALUES
    ('approved', 'Approved', 1700),
    ('canceled', 'Canceled', 1710),
    ('escalated', 'Escalated', 1720),
    ('issued', 'Issued', 1730),
    ('refunded', 'Refunded', 1740),
    ('rejected', 'Rejected', 1750),
    ('unmatched', 'Unmatched', 1760),
    ('voided', 'Voided', 1770)
),
definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_outcome'
   LIMIT 1
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  d.id,
  o.value,
  o.label,
  'Decision outcome emitted by canonical Phase B5 finance RPCs.',
  o.sort_order,
  FALSE,
  'active',
  jsonb_build_object('source', 'b5_finance_decision_lookup_coverage_v1')
FROM definition d
CROSS JOIN outcomes o
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

SELECT pg_advisory_unlock(hashtext('202605031550_b5_finance_decision_lookup_coverage_v1'));
COMMIT;

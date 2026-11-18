-- Migration: Billing invoice status lifecycle metadata for Console V2
-- Date: 2026-05-17
--
-- Align live lookup rows with the Console V2 billing lifecycle gates. The
-- frontend already consumes invoice_status metadata for send/refund/void
-- buttons; shared DB lanes must carry the same row-driven contract so live
-- readiness does not depend on seed-only lookup metadata.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605171115_billing_invoice_status_lifecycle_metadata_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('invoice_status', 'Console billing invoice lifecycle status', 'finance', 'tier_1', TRUE),
  ('billing_invoice_status', 'Billing invoice status (projection)', 'finance', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

WITH status_rows(value, label, sort_order, is_default, metadata) AS (
  VALUES
    (
      'draft',
      'Draft',
      10,
      TRUE,
      '{"tone":"neutral","lifecycle":"working","is_terminal":false,"allows_send":true,"allows_mark_paid":false,"allows_refund":false,"allows_void":true,"allows_reissue":false,"is_overdue":false,"is_overdue_when_past_due":false,"is_draft":true,"is_issued":false}'::jsonb
    ),
    (
      'issued',
      'Issued',
      20,
      FALSE,
      '{"tone":"info","lifecycle":"working","is_terminal":false,"allows_send":true,"allows_mark_paid":true,"allows_refund":false,"allows_void":false,"allows_reissue":true,"is_overdue":false,"is_overdue_when_past_due":true,"is_draft":false,"is_issued":true}'::jsonb
    ),
    (
      'sent',
      'Sent',
      21,
      FALSE,
      '{"tone":"info","lifecycle":"working","is_terminal":false,"allows_send":true,"allows_mark_paid":true,"allows_refund":false,"allows_void":false,"allows_reissue":true,"is_overdue":false,"is_overdue_when_past_due":true,"is_draft":false,"is_issued":true}'::jsonb
    ),
    (
      'paid',
      'Paid',
      30,
      FALSE,
      '{"tone":"good","lifecycle":"paid","is_terminal":true,"allows_send":false,"allows_mark_paid":false,"allows_refund":true,"allows_void":false,"allows_reissue":true,"is_overdue":false,"is_overdue_when_past_due":false,"is_draft":false,"is_issued":false,"is_final":true}'::jsonb
    ),
    (
      'overdue',
      'Overdue',
      40,
      FALSE,
      '{"tone":"danger","lifecycle":"working","is_terminal":false,"allows_send":true,"allows_mark_paid":true,"allows_refund":false,"allows_void":false,"allows_reissue":true,"is_overdue":true,"is_overdue_when_past_due":false,"is_draft":false,"is_issued":false}'::jsonb
    ),
    (
      'void',
      'Void',
      50,
      FALSE,
      '{"tone":"neutral","lifecycle":"void","is_terminal":true,"allows_send":false,"allows_mark_paid":false,"allows_refund":false,"allows_void":false,"allows_reissue":false,"is_overdue":false,"is_overdue_when_past_due":false,"is_draft":false,"is_issued":false,"is_final":true}'::jsonb
    ),
    (
      'voided',
      'Voided',
      51,
      FALSE,
      '{"tone":"neutral","lifecycle":"void","is_terminal":true,"allows_send":false,"allows_mark_paid":false,"allows_refund":false,"allows_void":false,"allows_reissue":false,"is_overdue":false,"is_overdue_when_past_due":false,"is_draft":false,"is_issued":false,"is_final":true}'::jsonb
    ),
    (
      'refunded',
      'Refunded',
      60,
      FALSE,
      '{"tone":"warn","lifecycle":"paid","is_terminal":true,"allows_send":false,"allows_mark_paid":false,"allows_refund":false,"allows_void":false,"allows_reissue":true,"is_overdue":false,"is_overdue_when_past_due":false,"is_draft":false,"is_issued":false,"is_final":true}'::jsonb
    )
)
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, sr.value, sr.label, sr.sort_order, sr.is_default, sr.metadata
FROM public.lookup_definitions ld
CROSS JOIN status_rows sr
WHERE ld.category IN ('invoice_status', 'billing_invoice_status')
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    metadata = EXCLUDED.metadata,
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605171115_billing_invoice_status_lifecycle_metadata_v1'));
COMMIT;

-- pgTAP: Console V2 driver application review lookup/timeline contract.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions
     WHERE category = 'marketplace_participant_review_reason'
       AND scope_type = 'global'
  ),
  'marketplace_participant_review_reason lookup definition exists globally'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v ON v.lookup_definition_id = d.id
     WHERE d.category = 'marketplace_participant_review_reason'
       AND v.value = 'background_check_clear'
       AND v.is_default IS TRUE
       AND v.metadata->>'decision' = 'approve'
       AND v.metadata->>'tone' = 'good'
       AND v.status = 'active'
  ),
  'approve review reason has active default row-driven metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v ON v.lookup_definition_id = d.id
     WHERE d.category = 'marketplace_participant_review_reason'
       AND v.value = 'capacity_available'
       AND v.metadata->>'decision' = 'approve'
       AND v.status = 'active'
  ),
  'secondary approve review reason is active'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v ON v.lookup_definition_id = d.id
     WHERE d.category = 'marketplace_participant_review_reason'
       AND v.value = 'qualification_gap'
       AND v.is_default IS TRUE
       AND v.metadata->>'decision' = 'reject'
       AND v.metadata->>'tone' = 'danger'
       AND v.status = 'active'
  ),
  'reject review reason has active default row-driven metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v ON v.lookup_definition_id = d.id
     WHERE d.category = 'marketplace_participant_review_reason'
       AND v.value = 'compliance_gap'
       AND v.metadata->>'decision' = 'reject'
       AND v.status = 'active'
  ),
  'secondary reject review reason is active'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v ON v.lookup_definition_id = d.id
     WHERE d.category = 'marketplace_participant_review_reason'
       AND v.value = 'duplicate_identity'
       AND v.metadata->>'decision' = 'reject'
       AND v.metadata->>'edge_case' = 'duplicate_identity'
       AND v.status = 'active'
  ),
  'duplicate identity rejection reason is active and row-driven'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v ON v.lookup_definition_id = d.id
     WHERE d.category = 'marketplace_participant_review_reason'
       AND v.value = 'compliance_document_mismatch'
       AND v.metadata->>'decision' = 'reject'
       AND v.metadata->>'edge_case' = 'compliance_denied'
       AND v.status = 'active'
  ),
  'compliance denied rejection reason is active and row-driven'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v ON v.lookup_definition_id = d.id
     WHERE d.category = 'marketplace_participant_review_reason'
       AND v.value = 'other'
       AND v.metadata ? 'tone'
       AND NOT (v.metadata ? 'decision')
       AND v.status = 'active'
  ),
  'neutral review reason remains available to both decisions'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v ON v.lookup_definition_id = d.id
     WHERE d.category = 'marketplace_participant_request_status'
       AND v.value = 'pending'
       AND (v.metadata->'allowed_actions') ? 'approve'
       AND (v.metadata->'allowed_actions') ? 'reject'
       AND v.status = 'active'
  ),
  'pending participant status exposes row-driven approve/reject actions'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v ON v.lookup_definition_id = d.id
     WHERE d.category = 'marketplace_participant_request_status'
       AND v.value = 'approved'
       AND v.metadata->>'decision_event_type' = 'application.approved'
       AND v.metadata->>'review_summary_template' LIKE 'Application approved%'
  ),
  'approved participant status carries decision timeline metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v ON v.lookup_definition_id = d.id
     WHERE d.category = 'marketplace_participant_request_status'
       AND v.value = 'rejected'
       AND v.metadata->>'decision_event_type' = 'application.rejected'
       AND v.metadata->>'review_summary_template' LIKE 'Application rejected%'
  ),
  'rejected participant status carries decision timeline metadata'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.lookup_definitions d
      JOIN public.lookup_values v ON v.lookup_definition_id = d.id
     WHERE d.category = 'marketplace_participant_review_reason'
       AND v.status = 'active'
       AND v.value IN (
         'documents_verified',
         'reviewer_attested',
         'capabilities_match',
         'license_expired_at_submission',
         'national_id_invalid',
         'documents_incomplete',
         'duplicate_profile',
         'compliance_risk'
       )
  ),
  'legacy seed-only driver application review reasons are not active'
);

SELECT * FROM finish();
ROLLBACK;

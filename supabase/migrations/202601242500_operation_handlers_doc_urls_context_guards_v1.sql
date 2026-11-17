-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Ensure doc_url coverage for new workflow handlers (context guards)
-- Date: 2026-01-24
--
-- Why:
--   - pgTAP enforces doc_url coverage for every active operation handler.
--   - context_set_defaults/context_require were registered without doc_url.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601242500_operation_handlers_doc_urls_context_guards_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

UPDATE public.operation_handlers
SET doc_url = 'docs/ops/runbooks/workflow_engine_runbook.md',
    updated_at = now()
WHERE handler_key IN ('context_set_defaults', 'context_require')
  AND is_active
  AND (doc_url IS NULL OR length(btrim(doc_url)) = 0);

SELECT pg_advisory_unlock(hashtext('202601242500_operation_handlers_doc_urls_context_guards_v1'));
COMMIT;


-- Migration: Backfill doc_url for active operation handlers
-- Purpose: Ensure pgTAP doc_url coverage without hardcoding per-handler logic
-- Approach: Assign default runbook URLs by handler_key family when missing

BEGIN;

UPDATE operation_handlers
SET doc_url = CASE
  WHEN handler_key LIKE 'label_%' OR handler_key = 'label_job'
    THEN 'docs/ops/runbooks/label_renderer_runbook.md'
  ELSE 'docs/ops/runbooks/workflow_engine_runbook.md'
END,
    updated_at = now()
WHERE is_active
  AND (doc_url IS NULL OR length(trim(doc_url)) = 0);

COMMIT;


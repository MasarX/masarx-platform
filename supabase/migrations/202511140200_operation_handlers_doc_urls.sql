-- Migration: Add doc_url anchors to operation_handlers
-- Purpose: Link registry entries to Integration Handbook for faster Ops navigation

BEGIN;

ALTER TABLE operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

-- General handler registry reference
UPDATE operation_handlers
SET doc_url = 'docs/ops/guides/integration-handbook.md#5-handler-registry-plug-in-system'
WHERE handler_key IN (
  'geocode_cache','geo_coordinate','geo_normalize','geo_decision','geocode_manual_review_enqueue'
) AND (doc_url IS NULL OR doc_url = '');

-- Provider dispatch -> operation templates
UPDATE operation_handlers
SET doc_url = 'docs/ops/guides/integration-handbook.md#4-outbound-operation-templates'
WHERE handler_key IN ('provider_dispatch')
  AND (doc_url IS NULL OR doc_url = '');

-- workflow follow-up wrapper handlers
UPDATE operation_handlers
SET doc_url = 'docs/ops/guides/integration-handbook.md#6-workflow follow-up-action-arguments-reference'
WHERE handler_key IN ('outbound_http','workflow_followup_notification','start_workflow','call_supplier_api','enqueue_notification','geocode_enrich')
  AND (doc_url IS NULL OR doc_url = '');

ALTER TABLE operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

COMMIT;

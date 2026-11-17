-- Migration: Retire legacy orchestrate_webhook_processing entrypoint
-- Purpose: Remove legacy orchestrator now that workflow_intake_webhook owns intake pipeline.
-- Date: 2025-11-20

BEGIN;

DROP FUNCTION IF EXISTS orchestrate_webhook_processing(UUID);

COMMIT;

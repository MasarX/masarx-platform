-- Migration: Pin search_path for security definer helpers to meet secdef lint
-- Date: 2025-12-01

BEGIN;

-- Worker reply handler should use deterministic search_path.
ALTER FUNCTION public.worker_action_mark_communication_reply(UUID, JSONB, JSONB)
    SET search_path = public, workflow_handlers, extensions, pg_temp;

-- Resolve webhook intake defaults helper should include extensions/workflow_handlers.
ALTER FUNCTION public.resolve_webhook_intake_defaults(UUID)
    SET search_path = public, workflow_handlers, extensions, pg_temp;

-- record_webhook_ack already updated via latest migration; pin again defensively.
ALTER FUNCTION public.record_webhook_ack(
    UUID, UUID, TEXT, INT, JSONB, JSONB, TEXT, TEXT, JSONB, TIMESTAMPTZ, TEXT, UUID, TEXT, UUID, INT, UUID
)
    SET search_path = public, workflow_handlers, extensions, pg_temp;

COMMIT;

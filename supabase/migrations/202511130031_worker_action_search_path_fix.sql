-- Migration: Worker action search_path fix
-- Purpose: Ensure workflow follow-up worker actions resolve public schema objects.

BEGIN;

ALTER FUNCTION public.worker_action_start_workflow(
    UUID,
    JSONB,
    JSONB
)
    SET search_path TO public, workflow_handlers, extensions, pg_temp;

ALTER FUNCTION public.worker_action_call_supplier_api(
    UUID,
    JSONB,
    JSONB
)
    SET search_path TO public, workflow_handlers, extensions, pg_temp;

ALTER FUNCTION public.worker_action_enqueue_notification(
    UUID,
    JSONB,
    JSONB
)
    SET search_path TO public, workflow_handlers, extensions, pg_temp;

ALTER FUNCTION public.worker_action_geocode_enrich(
    UUID,
    JSONB,
    JSONB
)
    SET search_path TO public, workflow_handlers, extensions, pg_temp;

ALTER FUNCTION public.worker_action_mark_communication_reply(
    UUID,
    JSONB,
    JSONB
)
    SET search_path TO public, workflow_handlers, extensions, pg_temp;

COMMIT;


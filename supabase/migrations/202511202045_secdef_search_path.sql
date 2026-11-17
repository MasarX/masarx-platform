-- Migration: Apply explicit search_path to remaining security definer helpers
-- Date: 2025-11-20 20:45 UTC

BEGIN;

ALTER FUNCTION public.call_api(TEXT, TEXT, JSONB, JSONB, INT)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.claim_pending_edge_jobs(INT)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.cleanup_expired_geocodes(INT)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.escalate_geocoding_manual_review(INT)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.invoke_label_renderer(INT)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.log_api_call_event(UUID, JSONB, JSONB, INT, INT, TEXT)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.mark_outbound_call_failure(UUID, INT, JSONB, JSONB, TEXT)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.mark_outbound_call_in_progress(UUID)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.mark_outbound_call_success(UUID, INT, JSONB, JSONB, INT)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.reclaim_stale_label_jobs(INT, INT)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.request_label_generation(UUID, TEXT, UUID, TEXT, UUID, TEXT)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.requeue_expired_edge_jobs(INT)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.requeue_stuck_geocoding_steps(INT, INT)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.resolve_webhook_ingest_policy(UUID)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.get_webhook_source_by_token(TEXT)
    SET search_path TO public, pg_temp;

COMMIT;

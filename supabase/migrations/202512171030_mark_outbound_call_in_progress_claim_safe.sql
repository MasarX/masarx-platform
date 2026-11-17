-- Plan: PLAN-202512-comms-reply-edge-dispatch-v1 / Step: S04
-- Migration: Harden mark_outbound_call_in_progress (claim-safe)
-- Purpose:
--   - Prevent duplicate sends by making job_id dispatch claim-only (no resurrecting completed jobs).
--   - Keep api-caller behavior deterministic under retries (409 when job cannot be claimed).
-- Date: 2025-12-17

BEGIN;

CREATE OR REPLACE FUNCTION public.mark_outbound_call_in_progress(p_job_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
BEGIN
  IF to_regclass('public.outbound_calls') IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.outbound_calls oc
     SET status = 'in_progress_edge',
         lease_expires_at = now() + interval '5 minutes'
   WHERE oc.id = p_job_id
     AND oc.status IN ('pending_edge', 'failed')
     AND oc.scheduled_at <= now()
     AND (oc.lease_expires_at IS NULL OR oc.lease_expires_at < now())
     AND (oc.status <> 'failed' OR oc.retry_count < oc.max_retries);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'outbound_call_not_claimable: %', p_job_id;
  END IF;
END;
$$;

COMMIT;


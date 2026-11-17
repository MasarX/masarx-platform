-- Plan: PLAN-202512-ops-maintenance-universal / Step: S04
-- Migration: Retry state columns for webhook_inbox + domain_events
-- Purpose: Enable policy-driven retries without hardcoding per-table logic.
-- Date: 2025-12-27

BEGIN;

ALTER TABLE public.webhook_inbox
  ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;
ALTER TABLE public.webhook_inbox
  ADD COLUMN IF NOT EXISTS max_retries INT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'webhook_inbox_retry_count_check'
      AND conrelid = 'public.webhook_inbox'::regclass
  ) THEN
    ALTER TABLE public.webhook_inbox
      ADD CONSTRAINT webhook_inbox_retry_count_check CHECK (retry_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'webhook_inbox_max_retries_check'
      AND conrelid = 'public.webhook_inbox'::regclass
  ) THEN
    ALTER TABLE public.webhook_inbox
      ADD CONSTRAINT webhook_inbox_max_retries_check CHECK (max_retries IS NULL OR max_retries >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.webhook_inbox.retry_count
  IS 'Retry attempts already scheduled by maintenance (policy-driven).';
COMMENT ON COLUMN public.webhook_inbox.max_retries
  IS 'Optional per-row max retries override (NULL = use policy default).';

ALTER TABLE public.domain_events
  ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;
ALTER TABLE public.domain_events
  ADD COLUMN IF NOT EXISTS max_retries INT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'domain_events_retry_count_check'
      AND conrelid = 'public.domain_events'::regclass
  ) THEN
    ALTER TABLE public.domain_events
      ADD CONSTRAINT domain_events_retry_count_check CHECK (retry_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'domain_events_max_retries_check'
      AND conrelid = 'public.domain_events'::regclass
  ) THEN
    ALTER TABLE public.domain_events
      ADD CONSTRAINT domain_events_max_retries_check CHECK (max_retries IS NULL OR max_retries >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.domain_events.retry_count
  IS 'Retry attempts already scheduled by maintenance (policy-driven).';
COMMENT ON COLUMN public.domain_events.max_retries
  IS 'Optional per-row max retries override (NULL = use policy default).';

COMMIT;

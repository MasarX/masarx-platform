-- Migration: Restore webhook ack columns + make ack history view insertable + ensure address coordinates
-- Purpose:
--   - Keep webhook ack persistence compatible with record_webhook_ack and workflow intake functions.
--   - Make webhook_ack_history (compatibility view) insertable via an INSTEAD OF trigger that delegates to record_webhook_ack.
--   - Ensure public.addresses exposes coordinates for geocoding provider dispatch templates.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO-HARDCODING
-- Date: 2025-12-16

BEGIN;

SET search_path TO public, pg_temp;

-- ---------------------------------------------------------------------------
-- webhook_inbox: restore ack persistence columns (some environments dropped these)
-- ---------------------------------------------------------------------------

ALTER TABLE public.webhook_inbox
  ADD COLUMN IF NOT EXISTS ack_mode TEXT,
  ADD COLUMN IF NOT EXISTS ack_status_code INT,
  ADD COLUMN IF NOT EXISTS ack_headers JSONB,
  ADD COLUMN IF NOT EXISTS ack_body JSONB,
  ADD COLUMN IF NOT EXISTS ack_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ack_outcome TEXT,
  ADD COLUMN IF NOT EXISTS ack_reason TEXT,
  ADD COLUMN IF NOT EXISTS ack_validation JSONB;

ALTER TABLE public.webhook_inbox
  ALTER COLUMN ack_headers SET DEFAULT '{}'::jsonb,
  ALTER COLUMN ack_validation SET DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.webhook_inbox.ack_mode IS 'Policy-driven acknowledgement mode (synchronous_success, accepted_async, policy_error, etc.).';
COMMENT ON COLUMN public.webhook_inbox.ack_status_code IS 'HTTP status code returned in the acknowledgement response.';
COMMENT ON COLUMN public.webhook_inbox.ack_headers IS 'HTTP headers returned in the acknowledgement response.';
COMMENT ON COLUMN public.webhook_inbox.ack_body IS 'HTTP body returned in the acknowledgement response.';
COMMENT ON COLUMN public.webhook_inbox.ack_sent_at IS 'Timestamp when the acknowledgement response was emitted.';
COMMENT ON COLUMN public.webhook_inbox.ack_outcome IS 'Outcome classification for acknowledgement (ack_sent, ack_failed, etc.).';
COMMENT ON COLUMN public.webhook_inbox.ack_reason IS 'Reason/details for acknowledgement outcome.';
COMMENT ON COLUMN public.webhook_inbox.ack_validation IS 'Validation results captured during acknowledgement computation.';

-- ---------------------------------------------------------------------------
-- addresses: ensure coordinates exist for geocoding templates (reverse + dispatch)
-- ---------------------------------------------------------------------------

ALTER TABLE public.addresses
  ADD COLUMN IF NOT EXISTS coordinates geography(POINT, 4326);

COMMENT ON COLUMN public.addresses.coordinates IS 'PostGIS point (lon/lat) used for reverse geocoding and provider dispatch templates.';

-- ---------------------------------------------------------------------------
-- webhook_ack_history: make compatibility view insertable (delegates to record_webhook_ack)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.webhook_ack_history_insert_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  -- Delegate legacy INSERTs into the compatibility view to the canonical persistence function.
  PERFORM public.record_webhook_ack(
    p_webhook_inbox_id := NEW.webhook_inbox_id,
    p_webhook_source_id := NEW.webhook_source_id,
    p_ack_mode := NEW.ack_mode,
    p_ack_status_code := NEW.ack_status_code,
    p_ack_headers := COALESCE(NEW.ack_headers, '{}'::jsonb),
    p_ack_body := NEW.ack_body,
    p_ack_outcome := NEW.ack_outcome,
    p_ack_reason := NEW.ack_reason,
    p_validation_results := COALESCE(NEW.validation_results, '{}'::jsonb),
    p_ack_sent_at := NEW.ack_sent_at,
    p_idempotency_key := NEW.idempotency_key,
    p_policy_settings_id := NEW.policy_settings_id,
    p_policy_scope_type := NEW.policy_scope_type,
    p_policy_scope_id := NEW.policy_scope_id,
    p_policy_version := NEW.policy_version,
    p_workflow_run_id := NULLIF(NEW.workflow_run_ref, '')::UUID
  );

  RETURN NEW;
END;
$function$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'webhook_ack_history'
      AND c.relkind = 'v'
  ) THEN
    EXECUTE 'DROP TRIGGER IF EXISTS webhook_ack_history_insert ON public.webhook_ack_history';
    EXECUTE 'CREATE TRIGGER webhook_ack_history_insert INSTEAD OF INSERT ON public.webhook_ack_history FOR EACH ROW EXECUTE FUNCTION public.webhook_ack_history_insert_trg()';
  END IF;
END $$;

COMMIT;


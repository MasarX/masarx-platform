-- Plan: PLAN-202512-logging-audit-trace-context-v2 / Step: S01
-- Migration: Audit trace context propagation
-- Purpose:
--   1) Make audit_table_changes correlation_id derive from request headers when request.correlation_id is not set.
--   2) Ensure webhook intake sets request.correlation_id early so downstream row changes (even on tables without
--      correlation_id columns) are traceable in audit_table_changes.

BEGIN;

-------------------------------------------------------------------------------
-- 1) Correlation resolution: request.correlation_id OR request.headers[x-correlation-id]
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.current_correlation_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_raw TEXT;
  v_headers JSONB;
BEGIN
  -- Preferred: explicit request-local correlation_id (set via set_config)
  BEGIN
    v_raw := current_setting('request.correlation_id', true);
  EXCEPTION WHEN others THEN
    v_raw := NULL;
  END;

  IF v_raw IS NOT NULL AND btrim(v_raw) <> '' THEN
    BEGIN
      RETURN v_raw::UUID;
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END;
  END IF;

  -- Fallback: PostgREST/Supabase request headers (x-correlation-id)
  BEGIN
    v_headers := current_setting('request.headers', true)::jsonb;
    v_raw := NULLIF(btrim(v_headers->>'x-correlation-id'), '');
  EXCEPTION WHEN others THEN
    v_raw := NULL;
  END;

  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    RETURN v_raw::UUID;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
END;
$$;

COMMENT ON FUNCTION public.current_correlation_id()
  IS 'Returns correlation/trace id from request context (request.correlation_id) or request headers (x-correlation-id).';

-------------------------------------------------------------------------------
-- 2) Webhook intake: set request.correlation_id during insert_webhook_inbox_record
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.insert_webhook_inbox_record(
    p_id UUID,
    p_webhook_source_id UUID,
    p_provider_type TEXT,
    p_raw_payload JSONB,
    p_headers JSONB,
    p_processing_status TEXT,
    p_correlation_id UUID,
    p_idempotency_key TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_id UUID := COALESCE(p_id, gen_random_uuid());
BEGIN
    -- Set trace context early so any downstream changes within the same transaction
    -- are captured by audit_table_changes even for tables without correlation_id columns.
    IF p_correlation_id IS NOT NULL THEN
      PERFORM set_config('request.correlation_id', p_correlation_id::text, true);
    END IF;

    INSERT INTO webhook_inbox (
        id,
        webhook_source_id,
        provider_type,
        raw_payload,
        headers,
        processing_status,
        correlation_id,
        idempotency_key
    )
    VALUES (
        v_id,
        p_webhook_source_id,
        p_provider_type,
        COALESCE(p_raw_payload, '{}'::jsonb),
        COALESCE(p_headers, '{}'::jsonb),
        COALESCE(p_processing_status, 'pending'),
        p_correlation_id,
        p_idempotency_key
    );

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.insert_webhook_inbox_record(UUID, UUID, TEXT, JSONB, JSONB, TEXT, UUID, TEXT)
    IS 'Security definer helper to insert webhook inbox records bypassing RLS (also seeds request.correlation_id for audit traceability).';

COMMIT;


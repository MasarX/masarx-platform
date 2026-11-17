-- Migration: Geocoding maintenance helpers hardening
-- Purpose: Pin search_path for existing helper functions without changing behaviour.

BEGIN;

DO $check$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname = 'requeue_stuck_geocoding_steps'
          AND proargtypes = ARRAY['integer'::regtype, 'integer'::regtype]::oidvector
    ) THEN
        RAISE EXCEPTION 'Expected public.requeue_stuck_geocoding_steps(int,int) to exist before applying 202511130013.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname = 'escalate_geocoding_manual_review'
          AND proargtypes = ARRAY['integer'::regtype]::oidvector
    ) THEN
        RAISE EXCEPTION 'Expected public.escalate_geocoding_manual_review(int) to exist before applying 202511130013.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname = 'cleanup_expired_geocodes'
          AND proargtypes = ARRAY['integer'::regtype]::oidvector
    ) THEN
        RAISE EXCEPTION 'Expected public.cleanup_expired_geocodes(int) to exist before applying 202511130013.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname = 'auto_learn_geography'
          AND proargtypes = ARRAY[
              'uuid'::regtype,
              'uuid'::regtype,
              'uuid'::regtype,
              'uuid'::regtype,
              'jsonb'::regtype,
              'jsonb'::regtype,
              'numeric'::regtype,
              'text'::regtype
          ]::oidvector
    ) THEN
        RAISE EXCEPTION 'Expected public.auto_learn_geography(uuid,uuid,uuid,uuid,jsonb,jsonb,numeric,text) to exist before applying 202511130013.';
    END IF;
END;
$check$;

ALTER FUNCTION public.requeue_stuck_geocoding_steps(INTEGER, INTEGER)
    SET search_path TO public, extensions, pg_temp;

ALTER FUNCTION public.escalate_geocoding_manual_review(INTEGER)
    SET search_path TO public, extensions, pg_temp;

ALTER FUNCTION public.cleanup_expired_geocodes(INTEGER)
    SET search_path TO public, extensions, pg_temp;

ALTER FUNCTION public.auto_learn_geography(
    UUID, UUID, UUID, UUID, JSONB, JSONB, NUMERIC, TEXT
)
    SET search_path TO public, extensions, pg_temp;

COMMIT;

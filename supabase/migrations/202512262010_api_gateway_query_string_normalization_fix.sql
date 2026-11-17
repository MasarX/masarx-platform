-- Plan: PLAN-202512-api-gateway-logestechs-v2-mirror / Step: S04
-- Migration: Fix API gateway query string normalization
-- Purpose:
--   - `workflow_intake_api_gateway_v1` currently strips the first character of query strings even when they do not start with `?`
--     due to an over-escaped regex (`'^\\?'` matches optional backslash at start).
--   - Patch the function to only strip a leading `?` using a simple prefix check.
-- Date: 2025-12-26

BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_def TEXT;
  v_before TEXT := 'IF v_query ~ ''^\\?'' THEN';
  v_after TEXT := 'IF v_query IS NOT NULL AND left(v_query, 1) = ''?'' THEN';
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 definition not found';
  END IF;

  IF position(v_before IN v_def) = 0 THEN
    RAISE EXCEPTION 'Expected query normalization pattern not found in workflow_intake_api_gateway_v1';
  END IF;

  v_def := replace(v_def, v_before, v_after);

  IF position(v_before IN v_def) <> 0 THEN
    RAISE EXCEPTION 'Failed to patch workflow_intake_api_gateway_v1 query normalization';
  END IF;

  EXECUTE v_def;
END;
$$;

COMMIT;

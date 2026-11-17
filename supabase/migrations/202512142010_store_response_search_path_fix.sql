-- Migration: Fix store_response search_path quoting
-- Purpose: Ensure store_response resolves public tables correctly by setting a proper multi-schema search_path.
-- Date: 2025-12-14

BEGIN;

ALTER FUNCTION public.store_response(uuid, jsonb, integer)
  SET search_path TO public, pg_temp;

COMMIT;


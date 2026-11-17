-- Migration: pgcrypto crypt public wrapper
-- Purpose:
--   - Ensure crypt() resolves when search_path excludes extensions schema.
--   - Keep bootstrap deterministic for fresh Supabase projects.
-- Date: 2025-12-14

BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_extension
    WHERE extname = 'pgcrypto'
  ) THEN
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'extensions'
      AND p.proname = 'crypt'
      AND pg_get_function_identity_arguments(p.oid) = 'text, text'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'crypt'
      AND pg_get_function_identity_arguments(p.oid) = 'text, text'
  ) THEN
    EXECUTE $sql$
      CREATE OR REPLACE FUNCTION public.crypt(text, text)
      RETURNS text
      LANGUAGE sql
      AS $crypt$SELECT extensions.crypt($1, $2);$crypt$;
    $sql$;
  END IF;
END $$;

COMMIT;

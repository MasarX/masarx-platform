-- Plan: PLAN-202601-schema-audit-improvements / Step: S95
-- Migration: Pin SECURITY DEFINER search_path for resolve_label_template
-- Purpose:
--   - SECURITY DEFINER functions must pin search_path to avoid search_path hijacking.
--   - Recent CREATE OR REPLACE reset proconfig; restore enterprise-safe defaults.
-- Date: 2026-01-21

BEGIN;

ALTER FUNCTION public.resolve_label_template(UUID, UUID, UUID, TEXT)
  SET search_path TO public, extensions, pg_temp;

COMMIT;


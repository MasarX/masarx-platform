-- Migration: SECURITY DEFINER search_path hardening
-- Purpose:
--   - Normalize search_path for core SECURITY DEFINER functions so they
--     conform to the guard tested in 045_secdef_search_path.sql:
--       public [+ workflow_handlers] [+ extensions] + pg_temp.

BEGIN;

ALTER FUNCTION public.create_ops_alert_for_webhook(
  UUID,
  UUID,
  TEXT,
  JSONB,
  TEXT
)
  SET search_path = public, extensions, pg_temp;

ALTER FUNCTION public.request_label_reprint(
  UUID,
  UUID,
  TEXT
)
  SET search_path = public, extensions, pg_temp;

ALTER FUNCTION public.deep_merge_jsonb(
  JSONB,
  JSONB
)
  SET search_path = public, extensions, pg_temp;

ALTER FUNCTION public.resolve_settings_merged(
  TEXT,
  TEXT,
  UUID
)
  SET search_path = public, extensions, pg_temp;

ALTER FUNCTION public.log_settings_resolution(
  UUID,
  TEXT,
  TEXT,
  UUID,
  UUID,
  UUID,
  INT,
  JSONB,
  JSONB,
  JSONB
)
  SET search_path = public, extensions, pg_temp;

ALTER FUNCTION public.decision_log_settings_provenance_trg()
  SET search_path = public, extensions, pg_temp;

COMMIT;


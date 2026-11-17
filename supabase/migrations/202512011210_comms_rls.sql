-- Migration: Communications RLS hardening
-- Purpose: Enforce service_role-only access on communications configuration tables.
-- Tables: message_templates, recipient_preferences, provider_usage_tracking

BEGIN;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'public.message_templates',
    'public.recipient_preferences',
    'public.provider_usage_tracking'
  ]
  LOOP
    EXECUTE format('ALTER TABLE IF EXISTS %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', t);
    EXECUTE format('REVOKE ALL ON %s FROM anon', t);
    EXECUTE format('REVOKE ALL ON %s FROM authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_service_policy ON %s', split_part(t, '.', 2), t);
    EXECUTE format(
      'CREATE POLICY %I_service_policy ON %s FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE)',
      split_part(t, '.', 2),
      t
    );
  END LOOP;
END$$;

COMMIT;

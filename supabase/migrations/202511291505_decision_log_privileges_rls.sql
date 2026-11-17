-- Migration: decision_log privileges and RLS hardening
-- Purpose:
--   - Enforce least-privilege access on decision_log.
--   - Ensure authenticated/anon roles cannot read audit trails directly.
--   - Keep service_role access for engine and observability flows.

BEGIN;

-- Enable RLS on decision_log (audit trail).
ALTER TABLE public.decision_log ENABLE ROW LEVEL SECURITY;

-- Remove broad table privileges from anon/authenticated; access must go through
-- service_role or security-definer functions.
REVOKE ALL ON public.decision_log FROM anon;
REVOKE ALL ON public.decision_log FROM authenticated;

-- Ensure service_role retains full access.
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.decision_log
  TO service_role;

-- Explicit policy for service_role to keep behavior clear under RLS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'decision_log'
       AND policyname = 'decision_log_service_policy'
  ) THEN
    CREATE POLICY decision_log_service_policy
      ON public.decision_log
      AS PERMISSIVE
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END;
$$;

COMMIT;


-- Migration: RLS for archiving_history (service_role only)
-- Purpose: Enforce least-privilege access to retention audit ledger
-- Date: 2025-11-25 10:30

BEGIN;

-- Enable RLS on archiving_history
ALTER TABLE public.archiving_history ENABLE ROW LEVEL SECURITY;

-- Lock down public/anon/authenticated
REVOKE ALL ON TABLE public.archiving_history FROM PUBLIC;
REVOKE ALL ON TABLE public.archiving_history FROM anon;
REVOKE ALL ON TABLE public.archiving_history FROM authenticated;

-- Service role full access (audit writer/reader)
DROP POLICY IF EXISTS archiving_history_service_policy ON public.archiving_history;
CREATE POLICY archiving_history_service_policy
  ON public.archiving_history
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

COMMENT ON POLICY archiving_history_service_policy ON public.archiving_history IS
  'Service-role only access to retention audit ledger (read/write).';

COMMIT;


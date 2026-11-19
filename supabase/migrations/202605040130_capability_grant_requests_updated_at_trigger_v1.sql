-- Migration: capability_grant_requests updated_at trigger repair
-- Date: 2026-05-03

BEGIN;

DROP TRIGGER IF EXISTS trg_capability_grant_requests_set_updated_at
  ON public.capability_grant_requests;

CREATE TRIGGER trg_capability_grant_requests_set_updated_at
  BEFORE UPDATE ON public.capability_grant_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMIT;

-- Migration: zone_override_requests updated_at trigger compat v1
-- Purpose:
--   - Restore the canonical updated_at trigger contract for public.zone_override_requests
--     so timestamp compatibility gates stay green after the zone override approval slice.

BEGIN;

DROP TRIGGER IF EXISTS trg_zone_override_requests_set_updated_at ON public.zone_override_requests;
CREATE TRIGGER trg_zone_override_requests_set_updated_at
  BEFORE UPDATE ON public.zone_override_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMIT;

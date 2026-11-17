-- Migration: zone_override_requests updated_at trigger repair v1
-- Purpose:
--   - Restore the canonical updated_at trigger contract for zone_override_requests.
--   - Keep the timestamp compatibility pgTap suite green on rebased heads that include UC062.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604061700_zone_override_requests_updated_at_trigger_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP TRIGGER IF EXISTS trg_zone_override_requests_set_updated_at ON public.zone_override_requests;
CREATE TRIGGER trg_zone_override_requests_set_updated_at
  BEFORE UPDATE ON public.zone_override_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

SELECT pg_advisory_unlock(hashtext('202604061700_zone_override_requests_updated_at_trigger_v1'));
COMMIT;

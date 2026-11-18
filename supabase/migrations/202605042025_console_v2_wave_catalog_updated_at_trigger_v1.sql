-- Console V2 route-planning support tables must obey the canonical timestamp
-- contract: every physical updated_at column has the standard trigger.

BEGIN;

DROP TRIGGER IF EXISTS trg_wave_catalog_set_updated_at ON public.wave_catalog;

CREATE TRIGGER trg_wave_catalog_set_updated_at
  BEFORE UPDATE ON public.wave_catalog
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMIT;

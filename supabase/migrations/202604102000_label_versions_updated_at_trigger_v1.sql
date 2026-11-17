-- Migration: restore canonical updated_at trigger coverage for label_versions

BEGIN;

SET search_path TO public, extensions, pg_temp;

DROP TRIGGER IF EXISTS trg_label_versions_set_updated_at ON public.label_versions;
CREATE TRIGGER trg_label_versions_set_updated_at
BEFORE UPDATE ON public.label_versions
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

COMMIT;

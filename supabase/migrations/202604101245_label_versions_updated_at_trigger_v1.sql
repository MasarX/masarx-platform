-- Migration: label_versions updated_at trigger
-- Purpose:
--   - Keep label_versions aligned with the canonical timestamp contract.
--   - Ensure physical updated_at is maintained by the standard trigger.

BEGIN;

DROP TRIGGER IF EXISTS trg_label_versions_set_updated_at ON public.label_versions;

CREATE TRIGGER trg_label_versions_set_updated_at
BEFORE UPDATE ON public.label_versions
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

COMMIT;

-- Migration: Drop redundant FK-support indexes after route/label contract convergence
-- Goal:
--   - Remove exact duplicate btree indexes that became redundant after newer canonical
--     FK-support index migrations landed on dev.

BEGIN;

DROP INDEX IF EXISTS public.idx_label_versions_supersedes;
DROP INDEX IF EXISTS public.idx_route_plans__published_by_user_id__fk;

COMMIT;

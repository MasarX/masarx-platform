-- Migration: security_rls_user_facing view (dynamic inventory)
-- Purpose: SSOT list of user-facing tables derived from effective grants to anon/authenticated.
-- Notes: Used by pgTAP to enforce RLS + least-privilege coverage for the exposed surface area.

BEGIN;

SET search_path TO public, pg_temp;

CREATE OR REPLACE VIEW public.security_rls_user_facing AS
SELECT (c.relname::text COLLATE "default") AS tablename
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
  AND c.relispartition = FALSE
  AND c.relname <> 'spatial_ref_sys'
  AND (
    has_table_privilege('authenticated', c.oid, 'select')
    OR has_table_privilege('authenticated', c.oid, 'insert')
    OR has_table_privilege('authenticated', c.oid, 'update')
    OR has_table_privilege('authenticated', c.oid, 'delete')
    OR has_table_privilege('anon', c.oid, 'select')
    OR has_table_privilege('anon', c.oid, 'insert')
    OR has_table_privilege('anon', c.oid, 'update')
    OR has_table_privilege('anon', c.oid, 'delete')
  )
ORDER BY (c.relname::text COLLATE "default");

COMMENT ON VIEW public.security_rls_user_facing IS
  'SSOT list of tables directly accessible to anon/authenticated (derived from effective table grants). Used by pgTAP to enforce RLS + least-privilege coverage.';

REVOKE ALL ON public.security_rls_user_facing FROM PUBLIC;
REVOKE ALL ON public.security_rls_user_facing FROM anon;
REVOKE ALL ON public.security_rls_user_facing FROM authenticated;
GRANT SELECT ON public.security_rls_user_facing TO service_role;

COMMIT;

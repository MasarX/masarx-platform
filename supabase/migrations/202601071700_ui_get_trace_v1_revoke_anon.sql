BEGIN;
SET search_path TO public, extensions, pg_temp;

REVOKE ALL ON FUNCTION public.ui_get_trace_v1(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_get_trace_v1(UUID) TO authenticated, service_role;

COMMIT;

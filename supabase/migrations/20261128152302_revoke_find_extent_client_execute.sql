BEGIN;

REVOKE EXECUTE ON FUNCTION public.find_extent(regclass, text) FROM anon, authenticated;

COMMIT;

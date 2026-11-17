REVOKE ALL ON FUNCTION public.ui_me_v1() FROM anon;
REVOKE ALL ON FUNCTION public.ui_me_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_me_v1() TO authenticated, service_role;

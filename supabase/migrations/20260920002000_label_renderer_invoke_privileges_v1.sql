-- Restrict label-renderer invocation to the service and optional Edge worker roles.

REVOKE ALL ON FUNCTION public.invoke_label_renderer(INT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_label_renderer(INT, JSONB) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.invoke_label_renderer(INT, JSONB)
      TO edge_label_renderer_role;
  END IF;
END;
$$;

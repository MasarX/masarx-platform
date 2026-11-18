BEGIN;
-- PUBLIC revocation does not remove explicit role grants.
-- Keep existing service/Edge grants and definer-owned internal callers intact.
REVOKE EXECUTE ON FUNCTION public.resolve_label_renderer_invoke_config_v1(uuid)
FROM PUBLIC, anon, authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;

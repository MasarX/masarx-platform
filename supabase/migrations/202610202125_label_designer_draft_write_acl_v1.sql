-- PUBLIC revocation alone does not remove a direct anonymous function grant.
BEGIN;
SET LOCAL lock_timeout = '30s';

REVOKE EXECUTE ON FUNCTION public.label_designer_update_draft(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION api.label_designer_update_draft(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.label_designer_publish_label_design_draft(UUID, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION api.label_designer_publish_label_design_draft(UUID, TEXT) FROM PUBLIC, anon;

COMMIT;

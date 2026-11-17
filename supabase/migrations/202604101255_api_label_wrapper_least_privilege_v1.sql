-- Migration: api label wrapper least privilege
-- Purpose:
--   - Remove implicit PUBLIC EXECUTE from api label wrapper functions.
--   - Keep wrapper privileges aligned with the underlying label renderer/service roles.

BEGIN;

REVOKE ALL ON FUNCTION api.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION api.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION api.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) TO edge_label_renderer_role;

REVOKE ALL ON FUNCTION api.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION api.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION api.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) TO edge_label_renderer_role;

REVOKE ALL ON FUNCTION api.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION api.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION api.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) TO edge_label_renderer_role;

REVOKE ALL ON FUNCTION api.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION api.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION api.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) TO edge_label_renderer_role;

COMMIT;

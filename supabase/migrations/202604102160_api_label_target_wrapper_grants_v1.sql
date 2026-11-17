-- Migration: harden api label target wrapper grants
-- Purpose:
--   - Remove default PUBLIC/anon/authenticated execute inheritance from service-only
--     api label target and bundle helper wrappers.
--   - Align grants with the existing service_role + edge_label_renderer_role pattern.

BEGIN;

SET search_path TO public, extensions, pg_temp;

REVOKE ALL ON FUNCTION api.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) FROM PUBLIC;

REVOKE ALL ON FUNCTION api.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION api.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION api.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION api.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) FROM anon;

REVOKE ALL ON FUNCTION api.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION api.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION api.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) FROM authenticated;
REVOKE ALL ON FUNCTION api.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) FROM authenticated;

GRANT EXECUTE ON FUNCTION api.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION api.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION api.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION api.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT USAGE ON SCHEMA api TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION api.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION api.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION api.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION api.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) TO edge_label_renderer_role;
  END IF;
END;
$$;

COMMIT;

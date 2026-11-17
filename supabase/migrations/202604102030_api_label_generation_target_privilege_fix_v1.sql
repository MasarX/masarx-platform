-- Migration: api label-generation wrapper privilege fix v1
-- Purpose:
--   - Remove accidental anon/authenticated EXECUTE leakage on label-generation api wrappers.
--   - Preserve service_role and edge_label_renderer_role access only.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604102030_api_label_generation_target_privilege_fix_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE ALL ON FUNCTION api.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION api.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) TO service_role;

REVOKE ALL ON FUNCTION api.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION api.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) TO service_role;

REVOKE ALL ON FUNCTION api.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION api.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION api.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION api.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT USAGE ON SCHEMA api TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION api.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT)
      TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION api.request_label_generation_target_for_step_v1(UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT)
      TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION api.resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID)
      TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION api.resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID)
      TO edge_label_renderer_role;
  END IF;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202604102030_api_label_generation_target_privilege_fix_v1'));
COMMIT;

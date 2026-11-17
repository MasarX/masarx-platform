-- Recovered from supabase_migrations.schema_migrations on 2025-10-21T09:46:34Z
-- Version: 202510200002
-- Name: label_generation_security

-- Migration 202510200002: Label renderer security, storage provisioning, and role grants
-- Purpose: Harden label generation infrastructure with dedicated role, storage bucket, and function privileges.

SET search_path = public;

BEGIN;

-- =============================================================================
-- SECTION 1: Storage bucket (labels)
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'Skipping labels bucket provisioning: storage.buckets missing (Storage disabled?)';
    RETURN;
  END IF;

  BEGIN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'labels',
      'labels',
      FALSE,
      52428800,
      ARRAY['application/pdf', 'image/png', 'image/jpeg']
    )
    ON CONFLICT (id) DO NOTHING;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'Skipping storage.buckets insert for labels (insufficient privilege/RLS). Bucket provisioning is handled via Storage API (ensure:storage-buckets).';
  END;
END $$;

-- =============================================================================
-- SECTION 2: Dedicated label renderer role
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'label_renderer_role'
    ) THEN
        CREATE ROLE label_renderer_role INHERIT;
    END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO label_renderer_role;

GRANT USAGE ON SCHEMA storage TO label_renderer_role;

GRANT SELECT, UPDATE ON TABLE label_jobs TO label_renderer_role;

GRANT SELECT ON TABLE label_template_specs TO label_renderer_role;

GRANT SELECT ON TABLE shipment_label_payload_v TO label_renderer_role;

GRANT EXECUTE ON FUNCTION request_label_generation(UUID, TEXT, UUID, TEXT, UUID, TEXT) TO label_renderer_role;

GRANT EXECUTE ON FUNCTION lease_label_job(UUID, INTEGER, UUID) TO label_renderer_role;

GRANT EXECUTE ON FUNCTION compose_label_payload(UUID) TO label_renderer_role;

GRANT EXECUTE ON FUNCTION complete_label_job(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT) TO label_renderer_role;

GRANT label_renderer_role TO service_role;

COMMIT;

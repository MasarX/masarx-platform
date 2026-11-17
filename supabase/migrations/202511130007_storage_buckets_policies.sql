-- Migration: Storage buckets and policies for label renderer
-- Purpose: Ensure private buckets and service_role-only object access for labels and label-render-assets
-- Date: 2025-11-13

BEGIN;

-- Create buckets if they don't exist (private)
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'Skipping storage bucket provisioning: storage.buckets missing (Storage disabled?)';
    RETURN;
  END IF;

  BEGIN
    INSERT INTO storage.buckets (id, name, public)
    VALUES ('labels', 'labels', FALSE)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO storage.buckets (id, name, public)
    VALUES ('label-render-assets', 'label-render-assets', FALSE)
    ON CONFLICT (id) DO NOTHING;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'Skipping storage.buckets inserts for label buckets (insufficient privilege/RLS). Bucket provisioning is handled via Storage API (ensure:storage-buckets).';
  END;
END $$;

-- RLS is enabled by default on storage.objects; add service_role-only policy for our buckets
DROP POLICY IF EXISTS labels_service_role_rw ON storage.objects;
CREATE POLICY labels_service_role_rw
  ON storage.objects
  FOR ALL
  TO service_role
  USING (bucket_id IN ('labels','label-render-assets'))
  WITH CHECK (bucket_id IN ('labels','label-render-assets'));

COMMIT;

-- Migration: Label render assets bucket
-- Purpose: Provision private storage for renderer assets (fonts/logos) with
--          idempotent guards so replays never duplicate configuration.
-- Alignment: SIMPLE * DYNAMIC * ZERO-HARD-CODING * PERMANENT

BEGIN;

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'Skipping label-render-assets bucket provisioning: storage.buckets missing (Storage disabled?)';
    RETURN;
  END IF;

  BEGIN
    INSERT INTO storage.buckets (
      id,
      name,
      public,
      file_size_limit,
      allowed_mime_types
    )
    VALUES (
      'label-render-assets',
      'label-render-assets',
      FALSE,
      10485760, -- 10 MB per object (fonts/images)
      ARRAY[
        'image/png',
        'image/jpeg',
        'image/svg+xml',
        'application/pdf',
        'font/ttf',
        'font/otf',
        'font/woff',
        'font/woff2'
      ]
    )
    ON CONFLICT (id) DO UPDATE
    SET
      public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'Skipping storage.buckets upsert for label-render-assets (insufficient privilege/RLS). Bucket provisioning is handled via Storage API (ensure:storage-buckets).';
  END;
END $$;

-- Ensure renderer role can enumerate bucket metadata (service role already bypasses RLS).
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'label_renderer_role') THEN
    RETURN;
  END IF;
  BEGIN
    GRANT SELECT ON storage.buckets TO label_renderer_role;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'Skipping GRANT SELECT ON storage.buckets TO label_renderer_role (insufficient privilege).';
  END;
END $$;

COMMIT;

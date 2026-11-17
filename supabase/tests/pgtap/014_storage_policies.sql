-- Test Suite: Storage bucket policies for labels

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

-- Buckets exist and are private
SELECT ok(
  EXISTS (SELECT 1 FROM storage.buckets WHERE id='labels' AND public = false),
  'labels bucket exists and is private'
);

SELECT ok(
  EXISTS (SELECT 1 FROM storage.buckets WHERE id='label-render-assets' AND public = false),
  'label-render-assets bucket exists and is private'
);

-- Policy exists for service_role on these buckets
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname='storage'
      AND tablename='objects'
      AND policyname='labels_service_role_rw'
  ),
  'Service role policy exists on storage.objects for label buckets'
);

SELECT finish();

ROLLBACK;

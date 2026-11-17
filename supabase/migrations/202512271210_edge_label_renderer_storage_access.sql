-- Plan: PLAN-202512-ops-maintenance-universal / Step: S04
-- Purpose: Grant edge_label_renderer_role least-privilege access to storage buckets/objects

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    RETURN;
  END IF;

  IF to_regnamespace('storage') IS NULL THEN
    RAISE EXCEPTION 'storage schema missing; enable Supabase Storage before granting edge_label_renderer_role access';
  END IF;

  GRANT USAGE ON SCHEMA storage TO edge_label_renderer_role;
  GRANT SELECT ON storage.buckets TO edge_label_renderer_role;
  GRANT SELECT, INSERT, UPDATE ON storage.objects TO edge_label_renderer_role;

  DROP POLICY IF EXISTS edge_label_renderer_buckets_read ON storage.buckets;
  CREATE POLICY edge_label_renderer_buckets_read
    ON storage.buckets
    FOR SELECT
    TO edge_label_renderer_role
    USING (id IN ('labels', 'label-render-assets'));

  DROP POLICY IF EXISTS edge_label_renderer_labels_select ON storage.objects;
  CREATE POLICY edge_label_renderer_labels_select
    ON storage.objects
    FOR SELECT
    TO edge_label_renderer_role
    USING (bucket_id = 'labels');

  DROP POLICY IF EXISTS edge_label_renderer_labels_insert ON storage.objects;
  CREATE POLICY edge_label_renderer_labels_insert
    ON storage.objects
    FOR INSERT
    TO edge_label_renderer_role
    WITH CHECK (bucket_id = 'labels');

  DROP POLICY IF EXISTS edge_label_renderer_labels_update ON storage.objects;
  CREATE POLICY edge_label_renderer_labels_update
    ON storage.objects
    FOR UPDATE
    TO edge_label_renderer_role
    USING (bucket_id = 'labels')
    WITH CHECK (bucket_id = 'labels');

  DROP POLICY IF EXISTS edge_label_renderer_assets_read ON storage.objects;
  CREATE POLICY edge_label_renderer_assets_read
    ON storage.objects
    FOR SELECT
    TO edge_label_renderer_role
    USING (bucket_id = 'label-render-assets');
END;
$$;

COMMIT;

-- Plan: PLAN-202512-label-designer-browser-v1 / Step: S95
-- Migration: Fixup label designer storage asset policies (idempotent)
-- Purpose:
--   - Ensure expected storage.objects policies exist for authenticated label designer asset uploads.
-- Notes:
--   - Append-only: required when earlier migrations executed under a role that skipped policy creation.
BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
BEGIN
  IF to_regnamespace('storage') IS NULL THEN
    RAISE EXCEPTION 'storage schema missing; enable Supabase Storage before applying label designer asset policies';
  END IF;
END;
$$;

DROP POLICY IF EXISTS objects_authenticated_restrict_labels ON storage.objects;
CREATE POLICY objects_authenticated_restrict_labels
  ON storage.objects
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (
    bucket_id NOT IN ('labels','label-render-assets')
    OR (
      bucket_id = 'label-render-assets'
      AND (
        name LIKE (public.current_user_org_id()::text || '/designer/%')
        OR name LIKE 'fonts/%'
        OR name LIKE 'global/%'
      )
    )
  );

DROP POLICY IF EXISTS label_designer_assets_insert ON storage.objects;
CREATE POLICY label_designer_assets_insert
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'label-render-assets'
    AND owner = auth.uid()
    AND name LIKE (public.current_user_org_id()::text || '/designer/%')
  );

DROP POLICY IF EXISTS label_designer_assets_update ON storage.objects;
CREATE POLICY label_designer_assets_update
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'label-render-assets'
    AND owner = auth.uid()
    AND name LIKE (public.current_user_org_id()::text || '/designer/%')
  )
  WITH CHECK (
    bucket_id = 'label-render-assets'
    AND owner = auth.uid()
    AND name LIKE (public.current_user_org_id()::text || '/designer/%')
  );

DROP POLICY IF EXISTS label_designer_assets_delete ON storage.objects;
CREATE POLICY label_designer_assets_delete
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'label-render-assets'
    AND owner = auth.uid()
    AND name LIKE (public.current_user_org_id()::text || '/designer/%')
  );

COMMIT;

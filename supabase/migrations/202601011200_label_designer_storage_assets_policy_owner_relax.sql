-- Plan: PLAN-202601-label-designer-hardening / Step: S01
-- Migration: Relax label designer storage asset owner checks
-- Purpose:
--   - Fix browser asset uploads failing due to storage.objects owner behavior.
--   - Keep least privilege: authenticated users can only manage assets under
--     `label-render-assets/<org>/designer/*` (org-scoped via current_user_org_id()).
BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
BEGIN
  IF to_regnamespace('storage') IS NULL THEN
    RAISE EXCEPTION 'storage schema missing; enable Supabase Storage before applying label designer asset policies';
  END IF;
END;
$$;

-- NOTE: We intentionally avoid `owner = auth.uid()` checks here.
-- Designer assets are org-scoped and may be shared across multiple users within
-- the same organization; the org prefix remains the single enforcement surface.

DROP POLICY IF EXISTS label_designer_assets_insert ON storage.objects;
CREATE POLICY label_designer_assets_insert
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'label-render-assets'
    AND name LIKE (public.current_user_org_id()::text || '/designer/%')
  );

DROP POLICY IF EXISTS label_designer_assets_update ON storage.objects;
CREATE POLICY label_designer_assets_update
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'label-render-assets'
    AND name LIKE (public.current_user_org_id()::text || '/designer/%')
  )
  WITH CHECK (
    bucket_id = 'label-render-assets'
    AND name LIKE (public.current_user_org_id()::text || '/designer/%')
  );

DROP POLICY IF EXISTS label_designer_assets_delete ON storage.objects;
CREATE POLICY label_designer_assets_delete
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'label-render-assets'
    AND name LIKE (public.current_user_org_id()::text || '/designer/%')
  );

COMMIT;


-- Plan: PLAN-202512-label-designer-browser-v1 / Step: S03
-- Migration: Allow authenticated access to org-scoped designer assets (label-render-assets)
-- Purpose:
--   - Enable browser label designer to upload/read logo images without exposing system labels.
--   - Keep least privilege: authenticated users can only access `label-render-assets/<org>/designer/*`.
-- Notes:
--   - `labels` bucket remains service/edge-only.
--   - This extends an existing RESTRICTIVE SELECT policy to allow a safe exception.
BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
BEGIN
  IF to_regnamespace('storage') IS NULL THEN
    RAISE EXCEPTION 'storage schema missing; enable Supabase Storage before applying label designer asset policies';
  END IF;
END;
$$;

-- Update the restrictive read policy to allow org-scoped designer assets + shared assets.
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

-- Explicit write policies for designer assets (org + owner scoped).
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

-- Plan: PLAN-202603-fieldops-mobile-ux-connectivity-feature-completion-v1 / Step: S04
-- Migration: FieldOps evidence storage bucket + authenticated org-scoped policies
-- Date: 2026-03-04

BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
BEGIN
  IF to_regnamespace('storage') IS NULL THEN
    RAISE EXCEPTION 'storage schema missing; enable Supabase Storage before applying FieldOps evidence bucket policies';
  END IF;
END;
$$;

-- Restrictive read policy: if bucket is fieldops-evidence, user can only read own-org prefix.
DROP POLICY IF EXISTS fieldops_evidence_authenticated_read_restrictive ON storage.objects;
CREATE POLICY fieldops_evidence_authenticated_read_restrictive
  ON storage.objects
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (
    bucket_id <> 'fieldops-evidence'
    OR name LIKE (public.current_user_org_id()::text || '/%')
  );

DROP POLICY IF EXISTS fieldops_evidence_insert ON storage.objects;
CREATE POLICY fieldops_evidence_insert
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'fieldops-evidence'
    AND owner = auth.uid()
    AND name LIKE (public.current_user_org_id()::text || '/%')
  );

DROP POLICY IF EXISTS fieldops_evidence_update ON storage.objects;
CREATE POLICY fieldops_evidence_update
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'fieldops-evidence'
    AND owner = auth.uid()
    AND name LIKE (public.current_user_org_id()::text || '/%')
  )
  WITH CHECK (
    bucket_id = 'fieldops-evidence'
    AND owner = auth.uid()
    AND name LIKE (public.current_user_org_id()::text || '/%')
  );

DROP POLICY IF EXISTS fieldops_evidence_delete ON storage.objects;
CREATE POLICY fieldops_evidence_delete
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'fieldops-evidence'
    AND owner = auth.uid()
    AND name LIKE (public.current_user_org_id()::text || '/%')
  );

COMMIT;

-- Migration: Ensure get_label_jobs_status exists in public schema
-- Purpose: Restore status RPC required by label renderer scope tests.
BEGIN;

CREATE OR REPLACE FUNCTION public.get_label_jobs_status(
  p_job_ids UUID[]
)
RETURNS TABLE (
  job_id UUID,
  organization_id UUID,
  status TEXT,
  output_file_url TEXT,
  label_id UUID,
  shipment_id UUID,
  shipment_box_id UUID,
  updated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
  SELECT
    lj.id AS job_id,
    lj.organization_id,
    lj.status,
    lj.output_file_url,
    lj.label_id,
    lj.shipment_id,
    lj.shipment_box_id,
    lj.updated_at,
    lj.completed_at
  FROM public.label_jobs lj
  WHERE p_job_ids IS NOT NULL
    AND array_length(p_job_ids, 1) IS NOT NULL
    AND lj.id = ANY (p_job_ids);
$$;

COMMENT ON FUNCTION public.get_label_jobs_status(UUID[])
  IS 'Return status and output_file_url for an explicit list of label_jobs ids.';

REVOKE EXECUTE ON FUNCTION public.get_label_jobs_status(UUID[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_label_jobs_status(UUID[]) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_label_jobs_status(UUID[]) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.get_label_jobs_status(UUID[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_label_jobs_status(UUID[]) TO label_renderer_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.get_label_jobs_status(UUID[]) TO edge_label_renderer_role;
  END IF;
END;
$$;

COMMIT;

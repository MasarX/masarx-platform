-- F774: project generic outputs without changing shipment reprint authority.
BEGIN;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.label_versions
  ADD COLUMN label_artifact_id uuid,
  ADD COLUMN target_type text,
  ADD COLUMN target_id uuid,
  ADD COLUMN target_box_id uuid,
  ALTER COLUMN shipment_id DROP NOT NULL,
  ALTER COLUMN client_id DROP NOT NULL;

ALTER TABLE public.label_versions
  ADD CONSTRAINT label_versions_artifact_fk
  FOREIGN KEY (label_artifact_id, organization_id)
  REFERENCES public.label_artifacts(id, organization_id)
  ON DELETE SET NULL (label_artifact_id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT label_versions_lineage_kind_chk CHECK (
    (shipment_id IS NOT NULL AND client_id IS NOT NULL
      AND label_artifact_id IS NULL AND target_type IS NULL
      AND target_id IS NULL AND target_box_id IS NULL)
    OR
    (shipment_id IS NULL AND label_id IS NULL
      AND NULLIF(btrim(target_type), '') IS NOT NULL AND target_id IS NOT NULL)
  );

CREATE UNIQUE INDEX label_versions_artifact_number_unique
  ON public.label_versions(organization_id, label_artifact_id, version_number)
  WHERE label_artifact_id IS NOT NULL;
CREATE UNIQUE INDEX label_versions_artifact_active_unique
  ON public.label_versions(organization_id, label_artifact_id)
  WHERE label_artifact_id IS NOT NULL AND version_status = 'active';

CREATE FUNCTION public.project_label_artifact_version_v1(p_artifact public.label_artifacts)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_job public.label_jobs%ROWTYPE;
  v_existing public.label_versions%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.label_jobs
  WHERE id = p_artifact.source_label_job_id
    AND organization_id = p_artifact.organization_id FOR KEY SHARE;
  IF NOT FOUND OR v_job.shipment_id IS NOT NULL
    OR v_job.client_id IS DISTINCT FROM p_artifact.client_id
    OR v_job.target_type IS DISTINCT FROM p_artifact.target_type
    OR v_job.target_id IS DISTINCT FROM p_artifact.target_id
    OR v_job.target_box_id IS DISTINCT FROM p_artifact.target_box_id
    OR v_job.template_id IS DISTINCT FROM p_artifact.layout_template_id
    OR v_job.label_type IS DISTINCT FROM p_artifact.label_type THEN
    RAISE EXCEPTION 'label_artifact_version_job_mismatch' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_existing FROM public.label_versions
  WHERE label_job_id = p_artifact.source_label_job_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.organization_id IS DISTINCT FROM p_artifact.organization_id
      OR v_existing.label_artifact_id IS DISTINCT FROM p_artifact.id
      OR v_existing.shipment_id IS NOT NULL OR v_existing.label_id IS NOT NULL
      OR v_existing.target_type IS DISTINCT FROM p_artifact.target_type
      OR v_existing.target_id IS DISTINCT FROM p_artifact.target_id
      OR v_existing.target_box_id IS DISTINCT FROM p_artifact.target_box_id
      OR v_existing.file_url IS DISTINCT FROM p_artifact.file_url
      OR v_existing.renderer_metadata IS DISTINCT FROM p_artifact.renderer_metadata THEN
      RAISE EXCEPTION 'label_artifact_version_conflict' USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.label_versions (
    label_id, shipment_id, organization_id, client_id, label_job_id,
    label_artifact_id, target_type, target_id, target_box_id,
    version_number, version_status, job_purpose, requested_source, reprint_reason,
    label_type, barcode, barcode_format, layout_template_id, file_url,
    file_size_bytes, generated_by, generated_at, print_count, last_printed_at,
    metadata, renderer_metadata, created_at, updated_at
  ) VALUES (
    NULL, NULL, p_artifact.organization_id, p_artifact.client_id, v_job.id,
    p_artifact.id, p_artifact.target_type, p_artifact.target_id, p_artifact.target_box_id,
    1, 'active', v_job.job_purpose, v_job.requested_source, NULLIF(btrim(v_job.reprint_reason), ''),
    p_artifact.label_type, p_artifact.barcode, p_artifact.barcode_format,
    p_artifact.layout_template_id, p_artifact.file_url, p_artifact.file_size_bytes,
    p_artifact.generated_by, p_artifact.generated_at, p_artifact.print_count,
    p_artifact.last_printed_at, p_artifact.metadata, p_artifact.renderer_metadata,
    p_artifact.created_at, p_artifact.updated_at
  );
END;
$fn$;
REVOKE ALL ON FUNCTION public.project_label_artifact_version_v1(public.label_artifacts)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.sync_label_artifact_version_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  -- Successful job completion is already idempotent. No new rewrite lifecycle.
  IF TG_OP = 'UPDATE' AND
    (to_jsonb(NEW) - ARRAY['print_count','last_printed_at','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['print_count','last_printed_at','updated_at']) THEN
    RAISE EXCEPTION 'label_artifact_render_is_immutable' USING ERRCODE = '23514';
  END IF;
  PERFORM public.project_label_artifact_version_v1(NEW);
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.sync_label_artifact_version_v1()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_label_artifacts_version
AFTER INSERT OR UPDATE ON public.label_artifacts
FOR EACH ROW EXECUTE FUNCTION public.sync_label_artifact_version_v1();

-- One authentic observed snapshot only, not invented historical rerenders.
DO $backfill$
DECLARE v_artifact public.label_artifacts%ROWTYPE;
BEGIN
  FOR v_artifact IN SELECT * FROM public.label_artifacts
    ORDER BY organization_id, id FOR UPDATE
  LOOP
    PERFORM public.project_label_artifact_version_v1(v_artifact);
  END LOOP;
END;
$backfill$;

COMMENT ON COLUMN public.label_versions.label_artifact_id IS
  'Generic artifact FK; target snapshot survives supported artifact deletion.';
COMMENT ON FUNCTION public.sync_label_artifact_version_v1() IS
  'Projects one immutable render snapshot per generic label job; shipment reprints remain unchanged.';
COMMIT;

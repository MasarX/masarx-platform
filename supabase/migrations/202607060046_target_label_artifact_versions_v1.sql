-- Migration: target-neutral label artifact versions
-- Purpose:
--   - Keep non-shipment label outputs on public.label_artifacts while creating
--     public.label_versions lineage for route/container/transfer labels.
--   - Backfill existing target-neutral artifacts without fabricating targets.

BEGIN;

SET search_path TO public, extensions, pg_temp;

ALTER TABLE public.label_versions
  ADD COLUMN IF NOT EXISTS label_artifact_id UUID,
  ADD COLUMN IF NOT EXISTS target_type TEXT,
  ADD COLUMN IF NOT EXISTS target_id UUID,
  ADD COLUMN IF NOT EXISTS target_box_id UUID;

ALTER TABLE public.label_versions
  ALTER COLUMN shipment_id DROP NOT NULL,
  ALTER COLUMN client_id DROP NOT NULL;

ALTER TABLE public.label_versions
  DROP CONSTRAINT IF EXISTS label_versions_label_artifact_fk;

ALTER TABLE public.label_versions
  ADD CONSTRAINT label_versions_label_artifact_fk
  FOREIGN KEY (label_artifact_id, organization_id)
  REFERENCES public.label_artifacts(id, organization_id)
  ON DELETE SET NULL (label_artifact_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.label_versions
  DROP CONSTRAINT IF EXISTS label_versions_target_lineage_chk;

ALTER TABLE public.label_versions
  ADD CONSTRAINT label_versions_target_lineage_chk
  CHECK (
    shipment_id IS NOT NULL
    OR (
      label_artifact_id IS NOT NULL
      AND target_type IS NOT NULL
      AND target_id IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS idx_label_versions__label_artifact_id__fk
  ON public.label_versions (label_artifact_id);

CREATE INDEX IF NOT EXISTS idx_label_versions_target_lineage
  ON public.label_versions (target_type, target_id, target_box_id)
  WHERE target_type IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_label_versions_artifact_active_unique
  ON public.label_versions (label_artifact_id)
  WHERE label_artifact_id IS NOT NULL
    AND version_status = 'active';

CREATE OR REPLACE FUNCTION public.sync_label_artifact_version_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_job public.label_jobs%ROWTYPE;
  v_version_id UUID;
  v_version_number INTEGER;
  v_metadata JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW.id IS NULL OR NEW.target_type IS NULL OR NEW.target_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.source_label_job_id IS NOT NULL THEN
    SELECT *
      INTO v_job
      FROM public.label_jobs
     WHERE id = NEW.source_label_job_id
     LIMIT 1;
  END IF;

  SELECT id, version_number
    INTO v_version_id, v_version_number
    FROM public.label_versions
   WHERE label_artifact_id = NEW.id
      OR (
        NEW.source_label_job_id IS NOT NULL
        AND label_job_id = NEW.source_label_job_id
      )
   ORDER BY created_at
   LIMIT 1
   FOR UPDATE;

  v_metadata := jsonb_strip_nulls(
    COALESCE(NEW.metadata, '{}'::jsonb)
    || jsonb_build_object(
      'label_artifact_id', NEW.id,
      'label_job_id', NEW.source_label_job_id,
      'target', jsonb_build_object(
        'target_type', NEW.target_type,
        'target_id', NEW.target_id,
        'target_box_id', NEW.target_box_id
      )
    )
  );

  IF v_version_id IS NOT NULL THEN
    UPDATE public.label_versions
       SET label_id = NEW.id,
           label_artifact_id = NEW.id,
           shipment_id = NULL,
           organization_id = NEW.organization_id,
           client_id = NEW.client_id,
           label_job_id = COALESCE(NEW.source_label_job_id, label_job_id),
           version_status = COALESCE(version_status, 'active'),
           job_purpose = COALESCE(NULLIF(v_job.job_purpose, ''), job_purpose, 'primary'),
           requested_source = COALESCE(v_job.requested_source, requested_source),
           reprint_reason = COALESCE(NULLIF(v_job.reprint_reason, ''), reprint_reason),
           label_type = NEW.label_type,
           barcode = NEW.barcode,
           barcode_format = NEW.barcode_format,
           layout_template_id = NEW.layout_template_id,
           file_url = NEW.file_url,
           file_size_bytes = COALESCE(NEW.file_size_bytes, 0),
           generated_by = NEW.generated_by,
           generated_at = NEW.generated_at,
           print_count = COALESCE(NEW.print_count, 0),
           last_printed_at = NEW.last_printed_at,
           metadata = v_metadata,
           renderer_metadata = COALESCE(NEW.renderer_metadata, '{}'::jsonb),
           target_type = NEW.target_type,
           target_id = NEW.target_id,
           target_box_id = NEW.target_box_id,
           updated_at = now()
     WHERE id = v_version_id;

    RETURN NEW;
  END IF;

  SELECT COALESCE(MAX(version_number), 0) + 1
    INTO v_version_number
    FROM public.label_versions
   WHERE label_id = NEW.id;

  INSERT INTO public.label_versions (
    id,
    label_id,
    label_artifact_id,
    shipment_id,
    organization_id,
    client_id,
    label_job_id,
    version_number,
    version_status,
    job_purpose,
    requested_source,
    reprint_reason,
    label_type,
    barcode,
    barcode_format,
    layout_template_id,
    file_url,
    file_size_bytes,
    generated_by,
    generated_at,
    print_count,
    last_printed_at,
    metadata,
    renderer_metadata,
    target_type,
    target_id,
    target_box_id,
    created_at,
    updated_at
  )
  VALUES (
    gen_random_uuid(),
    NEW.id,
    NEW.id,
    NULL,
    NEW.organization_id,
    NEW.client_id,
    NEW.source_label_job_id,
    v_version_number,
    'active',
    COALESCE(NULLIF(v_job.job_purpose, ''), 'primary'),
    v_job.requested_source,
    NULLIF(v_job.reprint_reason, ''),
    NEW.label_type,
    NEW.barcode,
    NEW.barcode_format,
    NEW.layout_template_id,
    NEW.file_url,
    COALESCE(NEW.file_size_bytes, 0),
    NEW.generated_by,
    NEW.generated_at,
    COALESCE(NEW.print_count, 0),
    NEW.last_printed_at,
    v_metadata,
    COALESCE(NEW.renderer_metadata, '{}'::jsonb),
    NEW.target_type,
    NEW.target_id,
    NEW.target_box_id,
    now(),
    now()
  );

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.sync_label_artifact_version_v1()
  IS 'Maintains public.label_versions lineage for target-neutral public.label_artifacts outputs.';

DROP TRIGGER IF EXISTS trg_label_artifacts_sync_version ON public.label_artifacts;

CREATE TRIGGER trg_label_artifacts_sync_version
AFTER INSERT OR UPDATE OF
  source_label_job_id,
  target_type,
  target_id,
  target_box_id,
  label_type,
  barcode,
  barcode_format,
  layout_template_id,
  file_url,
  file_size_bytes,
  generated_by,
  generated_at,
  print_count,
  last_printed_at,
  metadata,
  renderer_metadata
ON public.label_artifacts
FOR EACH ROW
EXECUTE FUNCTION public.sync_label_artifact_version_v1();

INSERT INTO public.label_versions (
  id,
  label_id,
  label_artifact_id,
  shipment_id,
  organization_id,
  client_id,
  label_job_id,
  version_number,
  version_status,
  job_purpose,
  requested_source,
  reprint_reason,
  label_type,
  barcode,
  barcode_format,
  layout_template_id,
  file_url,
  file_size_bytes,
  generated_by,
  generated_at,
  print_count,
  last_printed_at,
  metadata,
  renderer_metadata,
  target_type,
  target_id,
  target_box_id,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  la.id,
  la.id,
  NULL,
  la.organization_id,
  la.client_id,
  la.source_label_job_id,
  1,
  'active',
  COALESCE(NULLIF(lj.job_purpose, ''), 'primary'),
  lj.requested_source,
  NULLIF(lj.reprint_reason, ''),
  la.label_type,
  la.barcode,
  la.barcode_format,
  la.layout_template_id,
  la.file_url,
  COALESCE(la.file_size_bytes, 0),
  la.generated_by,
  la.generated_at,
  COALESCE(la.print_count, 0),
  la.last_printed_at,
  jsonb_strip_nulls(
    COALESCE(la.metadata, '{}'::jsonb)
    || jsonb_build_object(
      'label_artifact_id', la.id,
      'label_job_id', la.source_label_job_id,
      'target', jsonb_build_object(
        'target_type', la.target_type,
        'target_id', la.target_id,
        'target_box_id', la.target_box_id
      )
    )
  ),
  COALESCE(la.renderer_metadata, '{}'::jsonb),
  la.target_type,
  la.target_id,
  la.target_box_id,
  now(),
  now()
FROM public.label_artifacts la
LEFT JOIN public.label_jobs lj
  ON lj.id = la.source_label_job_id
WHERE la.target_type IS NOT NULL
  AND la.target_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM public.label_versions lv
     WHERE lv.label_artifact_id = la.id
        OR (
          la.source_label_job_id IS NOT NULL
          AND lv.label_job_id = la.source_label_job_id
        )
  );

COMMENT ON COLUMN public.label_versions.label_artifact_id
  IS 'Target-neutral label_artifacts identity for non-shipment route/container/transfer label versions.';
COMMENT ON COLUMN public.label_versions.target_type
  IS 'Target type copied from target-neutral label_artifacts for non-shipment version readback.';
COMMENT ON COLUMN public.label_versions.target_id
  IS 'Target id copied from target-neutral label_artifacts for non-shipment version readback.';
COMMENT ON COLUMN public.label_versions.target_box_id
  IS 'Optional target box id copied from target-neutral label_artifacts for container-level versions.';

COMMIT;

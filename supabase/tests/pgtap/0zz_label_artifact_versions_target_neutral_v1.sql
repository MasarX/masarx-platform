-- pgTAP: target-neutral label artifacts create label_versions lineage.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET search_path TO public, extensions, pgtap, pg_temp;

SELECT plan(8);

DO $$
DECLARE
  v_org UUID := '90a59bac-2b91-4ad4-ae9e-b1a445a20b36'::uuid;
  v_from_branch UUID := '99000000-0000-4000-8000-00000000b102'::uuid;
  v_to_branch UUID := '99000000-0000-4000-8000-00000000b103'::uuid;
  v_transfer UUID := '99000000-0000-4000-8000-00000000b104'::uuid;
  v_template UUID := '99000000-0000-4000-8000-00000000b105'::uuid;
  v_job UUID := '99000000-0000-4000-8000-00000000b106'::uuid;
  v_artifact UUID;
  v_version UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = v_org) THEN
    RAISE EXCEPTION 'Seeded Demo Organization % is required for this labels-only test', v_org;
  END IF;

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES
    (v_from_branch, v_org, 'pgtap-lv-from', 'pgTAP LV From', 'UTC', TRUE),
    (v_to_branch, v_org, 'pgtap-lv-to', 'pgTAP LV To', 'UTC', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.warehouse_transfers (
    id,
    organization_id,
    from_branch_id,
    to_branch_id,
    status,
    transfer_code,
    metadata
  )
  VALUES (
    v_transfer,
    v_org,
    v_from_branch,
    v_to_branch,
    'draft',
    'PGTAP-LABEL-VERSION-TX',
    jsonb_build_object('source', 'pgtap-target-neutral-label-version')
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.label_template_specs (
    id,
    organization_id,
    template_key,
    version,
    template_scope_type,
    template_scope_id,
    renderer_config,
    asset_refs
  )
  VALUES (
    v_template,
    v_org,
    'pgtap_transfer_target_version',
    1,
    'tenant',
    v_org,
    jsonb_build_object(
      'page', jsonb_build_object('width_inch', 4, 'height_inch', 6, 'dpi', 203),
      'barcode', jsonb_build_object('type', 'CODE128'),
      'label_config', jsonb_build_object('barcode_format', 'CODE128', 'fallback_barcode', 'PGTAP-LABEL-VERSION-TX')
    ),
    '[]'::jsonb
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.label_jobs (
    id,
    organization_id,
    shipment_id,
    shipment_box_id,
    target_type,
    target_id,
    target_box_id,
    target_metadata,
    label_type,
    template_id,
    template_version,
    template_snapshot,
    status,
    attempts,
    max_attempts,
    scheduled_at,
    job_purpose,
    idempotency_key,
    requested_source,
    retry_state
  )
  VALUES (
    v_job,
    v_org,
    NULL,
    NULL,
    'warehouse_transfer',
    v_transfer,
    NULL,
    jsonb_build_object(
      'target', jsonb_build_object(
        'target_type', 'warehouse_transfer',
        'target_id', v_transfer,
        'barcode', 'PGTAP-LABEL-VERSION-TX'
      )
    ),
    'transfer',
    v_template,
    1,
    jsonb_build_object(
      'template_id', v_template,
      'template_version', 1,
      'label_config', jsonb_build_object('barcode_format', 'CODE128', 'fallback_barcode', 'PGTAP-LABEL-VERSION-TX'),
      'renderer_config', jsonb_build_object('barcode', jsonb_build_object('type', 'CODE128'))
    ),
    'pending',
    0,
    5,
    now(),
    'primary',
    'pgtap-target-neutral-label-version',
    'pgtap-target-neutral-label-version',
    '[]'::jsonb
  )
  ON CONFLICT (id, organization_id) DO NOTHING;

  PERFORM public.complete_label_job(
    v_job,
    'succeeded',
    'labels/pgtap-target-neutral-label-version.pdf',
    512,
    jsonb_build_object(
      'barcode', 'PGTAP-LABEL-VERSION-TX',
      'renderer', 'pgtap',
      'timings', jsonb_build_object('total_ms', 7)
    ),
    NULL
  );

  SELECT id
    INTO v_artifact
    FROM public.label_artifacts
   WHERE source_label_job_id = v_job
     AND organization_id = v_org;

  SELECT id
    INTO v_version
    FROM public.label_versions
   WHERE label_job_id = v_job
     AND organization_id = v_org;

  PERFORM ok(v_artifact IS NOT NULL, 'complete_label_job creates target-neutral label_artifacts row');
  PERFORM ok(v_version IS NOT NULL, 'complete_label_job creates target-neutral label_versions row');

  PERFORM ok(
    EXISTS (
      SELECT 1
      FROM public.label_jobs
      WHERE id = v_job
        AND status = 'succeeded'
        AND shipment_id IS NULL
        AND target_type = 'warehouse_transfer'
        AND target_id = v_transfer
        AND label_id = v_artifact
    ),
    'label_jobs readback keeps target lineage and saved artifact identity'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
      FROM public.label_artifacts
      WHERE id = v_artifact
        AND source_label_job_id = v_job
        AND target_type = 'warehouse_transfer'
        AND target_id = v_transfer
        AND label_type = 'transfer'
        AND file_url = 'labels/pgtap-target-neutral-label-version.pdf'
    ),
    'label_artifacts readback keeps transfer target lineage'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
      FROM public.label_versions
      WHERE id = v_version
        AND label_id = v_artifact
        AND label_artifact_id = v_artifact
        AND shipment_id IS NULL
        AND target_type = 'warehouse_transfer'
        AND target_id = v_transfer
        AND label_job_id = v_job
        AND version_number = 1
        AND version_status = 'active'
    ),
    'label_versions readback keeps artifact and transfer lineage'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
      FROM public.label_versions
      WHERE id = v_version
        AND metadata->>'label_artifact_id' = v_artifact::text
        AND metadata->>'label_job_id' = v_job::text
        AND metadata#>>'{target,target_type}' = 'warehouse_transfer'
        AND metadata#>>'{target,target_id}' = v_transfer::text
    ),
    'label_versions metadata records target-neutral artifact lineage'
  );
END $$;

SELECT has_column(
  'public',
  'label_versions',
  'label_artifact_id',
  'label_versions exposes label_artifact_id for target-neutral versions'
);

SELECT has_column(
  'public',
  'label_versions',
  'target_type',
  'label_versions exposes target_type for target-neutral versions'
);

SELECT * FROM finish();
ROLLBACK;

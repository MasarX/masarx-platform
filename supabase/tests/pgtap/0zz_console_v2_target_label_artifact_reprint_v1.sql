-- pgTAP: Console V2 target-neutral label_artifact reprint lifecycle.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET search_path TO public, extensions, pgtap, pg_temp;

SELECT plan(10);

CREATE FUNCTION pg_temp.check_target_label_artifact_reprint()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_org UUID := '98000000-0000-4000-8000-00000000aa01'::uuid;
  v_branch UUID := '98000000-0000-4000-8000-00000000aa02'::uuid;
  v_route UUID := '98000000-0000-4000-8000-00000000aa03'::uuid;
  v_template UUID := '98000000-0000-4000-8000-00000000aa04'::uuid;
  v_source_job UUID := '98000000-0000-4000-8000-00000000aa05'::uuid;
  v_artifact UUID := '98000000-0000-4000-8000-00000000aa06'::uuid;
  v_reprint_job UUID;
  v_completed_artifact UUID;
  v_reason TEXT := 'operator_request';
BEGIN
  INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
  VALUES (v_org, 'pgTAP target artifact reprint org', 'pgtap-target-artifact-reprint-org', 'UTC', 'en-US', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'pgtap-lar', 'pgTAP label artifact branch', 'UTC', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO route_runs (id, organization_id, branch_id, status, planned_date, metadata)
  VALUES (v_route, v_org, v_branch, 'planned', CURRENT_DATE, jsonb_build_object('source', 'pgtap-target-artifact-reprint'))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO label_template_specs (
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
    'pgtap_route_reprint',
    1,
    'tenant',
    v_org,
    jsonb_build_object(
      'page', jsonb_build_object('width_inch', 4, 'height_inch', 6, 'dpi', 203),
      'label_config', jsonb_build_object('barcode_format', 'CODE128', 'fallback_barcode', 'RTE-REPRINT')
    ),
    '[]'::jsonb
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO label_jobs (
    id,
    organization_id,
    target_type,
    target_id,
    label_type,
    template_id,
    template_version,
    template_snapshot,
    status,
    attempts,
    max_attempts,
    scheduled_at,
    completed_at,
    job_purpose,
    idempotency_key,
    requested_source,
    retry_state,
    output_file_url
  )
  VALUES (
    v_source_job,
    v_org,
    'route_run',
    v_route,
    'route',
    v_template,
    1,
    jsonb_build_object(
      'template_id', v_template,
      'template_version', 1,
      'label_config', jsonb_build_object('barcode_format', 'CODE128', 'fallback_barcode', 'RTE-REPRINT')
    ),
    'succeeded',
    1,
    5,
    now() - interval '1 hour',
    now() - interval '55 minutes',
    'primary',
    'pgtap-target-artifact-source',
    'pgtap',
    '[]'::jsonb,
    'labels/route-original.pdf'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO label_artifacts (
    id,
    organization_id,
    target_type,
    target_id,
    label_type,
    barcode,
    barcode_format,
    layout_template_id,
    file_url,
    file_size_bytes,
    generated_at,
    print_count,
    last_printed_at,
    source_label_job_id,
    metadata,
    renderer_metadata
  )
  VALUES (
    v_artifact,
    v_org,
    'route_run',
    v_route,
    'route',
    'RTE-REPRINT',
    'CODE128',
    v_template,
    'labels/route-original.pdf',
    128,
    now() - interval '55 minutes',
    1,
    now() - interval '55 minutes',
    v_source_job,
    jsonb_build_object('target', jsonb_build_object('target_type', 'route_run', 'target_id', v_route)),
    '{}'::jsonb
  )
  ON CONFLICT DO NOTHING;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  RETURN NEXT throws_ok(
    format('SELECT api.request_label_reprint(%L::uuid, %L)', v_artifact, v_reason),
    'P0001',
    format('Access denied for label %s', v_artifact),
    'artifact reprint rejects an unscoped JWT even with a service-role scalar claim'
  );
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '{}', true);

  SELECT request_label_reprint(v_artifact, v_reason, NULL, 'console-v2')
  INTO v_reprint_job;

  RETURN NEXT ok(v_reprint_job IS NOT NULL, 'request_label_reprint returns a job id for label_artifacts');

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM label_jobs
      WHERE id = v_reprint_job
        AND organization_id = v_org
        AND shipment_id IS NULL
        AND label_id IS NULL
        AND target_type = 'route_run'
        AND target_id = v_route
        AND label_type = 'route'
        AND job_purpose = 'reprint'
        AND reprint_reason = v_reason
        AND target_metadata->>'source_label_artifact_id' = v_artifact::text
        AND target_metadata->>'source_label_job_id' = v_source_job::text
        AND workflow_run_step_id IS NOT NULL
    ),
    'target artifact reprint job stores target, reason, source artifact/job, and workflow lineage'
  );

  PERFORM complete_label_job(
    v_reprint_job,
    'succeeded',
    'labels/route-reprint.pdf',
    256,
    jsonb_build_object('barcode', 'RTE-REPRINT', 'renderer', 'pgtap'),
    NULL
  );

  SELECT id
  INTO v_completed_artifact
  FROM label_artifacts
  WHERE source_label_job_id = v_reprint_job
    AND organization_id = v_org;

  RETURN NEXT ok(v_completed_artifact IS NOT NULL, 'complete_label_job persists reprint output as a new label_artifact');

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM label_artifacts
      WHERE id = v_completed_artifact
        AND target_type = 'route_run'
        AND target_id = v_route
        AND file_url = 'labels/route-reprint.pdf'
        AND metadata->>'reprint_reason' = v_reason
    ),
    'reprinted artifact keeps target lineage and reason metadata'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM label_jobs
      WHERE id = v_reprint_job
        AND status = 'succeeded'
        AND label_id = v_completed_artifact
        AND output_file_url = 'labels/route-reprint.pdf'
    ),
    'reprint job readback points to the completed target-neutral artifact'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM decision_log
      WHERE resource_type = 'label_job'
        AND resource_id = v_reprint_job
        AND decision_point = 'request_label_reprint'
        AND decision_reason = v_reason
    ),
    'request decision log captures target artifact reprint reason'
  );
END $$;

SELECT * FROM pg_temp.check_target_label_artifact_reprint();

SELECT has_function(
  'api',
  'request_label_reprint',
  ARRAY['uuid', 'text', 'uuid', 'text'],
  'api.request_label_reprint wrapper remains available'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.request_label_reprint(uuid,text,uuid,text)', 'EXECUTE'),
  'authenticated can execute api.request_label_reprint'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.request_label_artifact_reprint_v1(uuid,text,uuid,text,boolean)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.request_label_artifact_reprint_v1(uuid,text,uuid,text,boolean)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.request_label_artifact_reprint_v1(uuid,text,uuid,text,boolean)', 'EXECUTE'),
  'artifact reprint helper can only receive authority from the canonical entry point'
);

SELECT * FROM finish();
ROLLBACK;

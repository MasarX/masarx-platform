-- Test Suite: Target-neutral label generation contract

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SET search_path TO extensions, public, pg_temp;

SELECT plan(13);

SELECT has_column(
  'public',
  'label_jobs',
  'target_type',
  'label_jobs exposes target_type for route/container/transfer label jobs'
);

SELECT has_column(
  'public',
  'label_jobs',
  'target_id',
  'label_jobs exposes target_id for generic label targets'
);

SELECT has_column(
  'public',
  'label_jobs',
  'target_box_id',
  'label_jobs exposes target_box_id for target-scoped labels'
);

SELECT has_column(
  'public',
  'label_jobs',
  'target_metadata',
  'label_jobs exposes target_metadata for target-neutral lineage'
);

SELECT has_table(
  'public',
  'label_artifacts',
  'label_artifacts table exists for non-shipment label outputs'
);

SELECT has_function(
  'public',
  'request_label_generation_target_v1',
  ARRAY['text', 'uuid', 'text', 'uuid', 'text', 'uuid', 'text'],
  'request_label_generation_target_v1 exists'
);

SELECT has_function(
  'public',
  'request_label_generation_target_for_step_v1',
  ARRAY['uuid', 'text', 'uuid', 'text', 'uuid', 'text', 'uuid', 'text'],
  'request_label_generation_target_for_step_v1 exists'
);

SELECT has_function(
  'public',
  'resolve_label_files_for_bundle',
  ARRAY['uuid', 'uuid[]', 'uuid[]', 'uuid', 'uuid'],
  'resolve_label_files_for_bundle accepts target-neutral bundle inputs'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld
      ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'label_type'
      AND lv.value = 'route'
      AND lv.status = 'active'
  ),
  'label_type lookup includes route'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld
      ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'label_type'
      AND lv.value = 'container'
      AND lv.status = 'active'
  ),
  'label_type lookup includes container'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld
      ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'label_type'
      AND lv.value = 'transfer'
      AND lv.status = 'active'
  ),
  'label_type lookup includes transfer'
);

INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
VALUES ('91000000-0000-4000-8000-00000000aa01', 'pgTAP target org', 'pgtap-target-org', 'UTC', 'en-US', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO branches (id, organization_id, code, name, timezone, is_active)
VALUES ('91000000-0000-4000-8000-00000000aa02', '91000000-0000-4000-8000-00000000aa01', 'pgtaptr1', 'pgTAP target branch', 'UTC', TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO route_runs (id, organization_id, branch_id, status, planned_date, metadata)
VALUES ('91000000-0000-4000-8000-00000000aa03', '91000000-0000-4000-8000-00000000aa01', '91000000-0000-4000-8000-00000000aa02', 'planned', CURRENT_DATE, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

SET LOCAL ROLE edge_label_renderer_role;
SELECT set_config('request.jwt.claim.role', 'edge_label_renderer_role', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', 'edge-function', 'role', 'edge_label_renderer_role', 'aud', 'authenticated')::text,
  true
);

SELECT public.request_label_generation_target_v1(
  'route',
  '91000000-0000-4000-8000-00000000aa03'::uuid,
  'shipping',
  NULL,
  'pgtap_target_contract',
  NULL,
  'primary'
);

RESET ROLE;

SELECT lives_ok(
  $admin$
  DO $body$
  DECLARE
    v_prior_role TEXT := current_setting('request.jwt.claim.role', true);
    v_prior_claims TEXT := current_setting('request.jwt.claims', true);
    v_job_id UUID;
  BEGIN
    IF session_user NOT IN ('postgres', 'supabase_admin') OR current_user <> session_user THEN
      RAISE EXCEPTION 'Expected a reset postgres/supabase_admin session';
    END IF;
    -- RESET ROLE leaves the renderer JWT settings above intact.
    PERFORM set_config('request.jwt.claim.role', '', true);
    PERFORM set_config('request.jwt.claims', '{}', true);

    v_job_id := public.request_label_generation_target_v1(
      'route',
      '91000000-0000-4000-8000-00000000aa03'::uuid,
      'shipping',
      NULL,
      'pgtap_target_contract_admin',
      NULL,
      'reprint'
    );
    IF NOT EXISTS (
      SELECT 1 FROM public.label_jobs
      WHERE id = v_job_id
        AND organization_id = '91000000-0000-4000-8000-00000000aa01'::uuid
        AND target_type = 'route_run'
        AND target_id = '91000000-0000-4000-8000-00000000aa03'::uuid
        AND requested_source = 'pgtap_target_contract_admin'
        AND job_purpose = 'reprint'
        AND status = 'pending'
    ) THEN
      RAISE EXCEPTION 'Admin request did not enqueue the exact target-neutral fixture job';
    END IF;

    PERFORM set_config('request.jwt.claim.role', COALESCE(v_prior_role, ''), true);
    PERFORM set_config('request.jwt.claims', COALESCE(v_prior_claims, ''), true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('request.jwt.claim.role', COALESCE(v_prior_role, ''), true);
    PERFORM set_config('request.jwt.claims', COALESCE(v_prior_claims, ''), true);
    RAISE;
  END;
  $body$;
  $admin$,
  format('admin session enqueues target-neutral label jobs after RESET ROLE without JWT claims (%s)', session_user)
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.label_jobs
    WHERE organization_id = '91000000-0000-4000-8000-00000000aa01'::uuid
      AND target_type = 'route_run'
      AND target_id = '91000000-0000-4000-8000-00000000aa03'::uuid
      AND requested_source = 'pgtap_target_contract'
  ),
  'edge label renderer role can enqueue target-neutral label jobs without uuid claim casts'
);

SELECT finish();

ROLLBACK;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

-- Guard: finalize_domain_event_from_run() must never block workflow_runs updates when
-- domain_event_id is missing/invalid/mismatched (trigger should not raise).

-- Case 1: valid UUID that does not exist in domain_events.
SELECT lives_ok($$
  DO $do$
  DECLARE
    v_template_id UUID := gen_random_uuid();
    v_run_id UUID := gen_random_uuid();
    v_missing_domain_event UUID := gen_random_uuid();
  BEGIN
    INSERT INTO public.workflow_templates (
      id, name, description, version, status, scope_type, scope_id, created_at, updated_at
    ) VALUES (
      v_template_id, 'pgtap_domain_event_guard', 'temp', 1, 'active', 'global', NULL, now(), now()
    ) ON CONFLICT (id) DO NOTHING;

    PERFORM set_config('app.workflow_run_id', v_run_id::text, true);

    INSERT INTO public.workflow_runs (
      id, workflow_template_id, workflow_template_version, workflow_status, context, entry_point
    ) VALUES (
      v_run_id,
      v_template_id,
      1,
      'pending',
      jsonb_build_object('domain_event_id', v_missing_domain_event::text, 'correlation_id', gen_random_uuid()::text),
      'test'
    ) ON CONFLICT (id) DO NOTHING;

    UPDATE public.workflow_runs
       SET workflow_status = 'completed'
     WHERE id = v_run_id;
  END
  $do$;
$$, 'workflow_runs completion does not raise when domain_event row is missing');

-- Case 2: invalid UUID string in context (must not raise).
SELECT lives_ok($$
  DO $do$
  DECLARE
    v_template_id UUID := gen_random_uuid();
    v_run_id UUID := gen_random_uuid();
  BEGIN
    INSERT INTO public.workflow_templates (
      id, name, description, version, status, scope_type, scope_id, created_at, updated_at
    ) VALUES (
      v_template_id, 'pgtap_domain_event_guard_invalid', 'temp', 1, 'active', 'global', NULL, now(), now()
    ) ON CONFLICT (id) DO NOTHING;

    PERFORM set_config('app.workflow_run_id', v_run_id::text, true);

    INSERT INTO public.workflow_runs (
      id, workflow_template_id, workflow_template_version, workflow_status, context, entry_point
    ) VALUES (
      v_run_id,
      v_template_id,
      1,
      'pending',
      jsonb_build_object('domain_event_id', 'not-a-uuid', 'correlation_id', gen_random_uuid()::text),
      'test'
    ) ON CONFLICT (id) DO NOTHING;

    UPDATE public.workflow_runs
       SET workflow_status = 'failed'
     WHERE id = v_run_id;
  END
  $do$;
$$, 'workflow_runs completion does not raise when domain_event_id is invalid');

SELECT finish();

ROLLBACK;

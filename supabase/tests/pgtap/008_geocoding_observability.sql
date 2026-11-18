-- pgTAP: Geocoding observability, automation, and auto-learning checks

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(12);

SELECT has_view(
    'public',
    'geocoding_queue_status_v',
    'geocoding_queue_status_v view exists'
);

SELECT has_column(
    'public',
    'geocoding_queue_status_v',
    'pending_steps',
    'geocoding_queue_status_v exposes pending_steps'
);

SELECT has_view(
    'public',
    'geocoding_cache_metrics_v',
    'geocoding_cache_metrics_v view exists'
);

SELECT has_view(
    'public',
    'geocoding_provider_spend_v',
    'geocoding_provider_spend_v view exists'
);

SELECT has_function(
    'public',
    'requeue_stuck_geocoding_steps',
    ARRAY['integer','integer'],
    'requeue_stuck_geocoding_steps helper installed'
);

SELECT has_function(
    'public',
    'escalate_geocoding_manual_review',
    ARRAY['integer'],
    'escalate_geocoding_manual_review helper installed'
);

SELECT has_function(
    'public',
    'cleanup_expired_geocodes',
    ARRAY['integer'],
    'cleanup_expired_geocodes helper installed'
);

SELECT has_function(
    'public',
    'auto_learn_geography',
    ARRAY['uuid','uuid','uuid','uuid','jsonb','jsonb','numeric','text'],
    'auto_learn_geography helper installed'
);

CREATE FUNCTION pg_temp.test_geocoding_maintenance_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $test$
DECLARE
    v_org UUID := gen_random_uuid();
    v_client UUID := gen_random_uuid();
    v_due UUID := gen_random_uuid();
    v_pending UUID := gen_random_uuid();
    v_template UUID := gen_random_uuid();
    v_template_step UUID := gen_random_uuid();
    v_run UUID := gen_random_uuid();
    v_step UUID := gen_random_uuid();
BEGIN
    INSERT INTO public.organizations (id, name, slug)
    VALUES (v_org, 'Synthetic Geocoding Maintenance', 'geo-maint-' || v_org::text);
    INSERT INTO public.clients (id, organization_id, name, slug, status)
    VALUES (v_client, v_org, 'Synthetic Geocoding Client', 'geo-client-' || v_client::text, 'active');
    INSERT INTO public.manual_review_tasks (id, organization_id, client_id, task_type, reason, status, sla_due_at)
    VALUES
        (v_due, v_org, v_client, 'geocoding', 'confidence_below_threshold', 'pending', now() - interval '1 minute'),
        (v_pending, v_org, v_client, 'geocoding', 'confidence_below_threshold', 'pending', now() + interval '1 hour');

    PERFORM public.escalate_geocoding_manual_review(200);
    RETURN NEXT ok(EXISTS (
        SELECT 1 FROM public.manual_review_tasks
        WHERE id = v_due AND status = 'escalated' AND metadata ? 'escalated_at'
    ), 'SLA sweep escalates the due review');
    RETURN NEXT is((SELECT status FROM public.manual_review_tasks WHERE id = v_pending),
        'pending', 'SLA sweep leaves the fresh review pending');

    INSERT INTO public.workflow_templates (id, name, version, status, scope_type, scope_id)
    VALUES (v_template, 'workflow_geocoding_maintenance_' || v_template::text, 1, 'active', 'tenant', v_org);
    INSERT INTO public.workflow_template_steps (id, workflow_template_id, sequence_order, operation_name, transition_condition, handler_key, handler_version, enabled)
    VALUES (v_template_step, v_template, 1, 'dispatch_provider', 'always', 'provider_dispatch', 'v1', true);
    INSERT INTO public.workflow_runs (id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context)
    VALUES (v_run, v_template, 1, 'pgtap', 'in_progress', jsonb_build_object('organization_id', v_org, 'client_id', v_client));
    INSERT INTO public.workflow_run_steps (id, workflow_run_id, workflow_template_step_id, sequence_order, step_status, operation_name, handler_key, handler_version, max_retries, retry_attempt, operation_started_at)
    VALUES (v_step, v_run, v_template_step, 1, 'in_progress', 'dispatch_provider', 'provider_dispatch', 'v1', 3, 0, now() - interval '2 days');

    PERFORM public.requeue_stuck_geocoding_steps(50, 86400);
    RETURN NEXT ok(EXISTS (
        SELECT 1 FROM public.workflow_run_steps
        WHERE id = v_step AND step_status = 'pending' AND retry_attempt = 1
          AND operation_started_at IS NULL AND operation_completed_at IS NULL
          AND last_error = 'reclaimed_by_geocoding_cron'
    ), 'maintenance returns the stale dispatch step to the retry queue');
    RETURN NEXT is((SELECT workflow_status FROM public.workflow_runs WHERE id = v_run),
        'in_progress', 'maintenance keeps the reclaimed workflow active');
END;
$test$;

SELECT * FROM pg_temp.test_geocoding_maintenance_v1();

SELECT finish();

ROLLBACK;

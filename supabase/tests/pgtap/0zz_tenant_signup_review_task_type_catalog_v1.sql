-- pgTAP: tenant signup review task type catalog wiring.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

CREATE OR REPLACE FUNCTION pg_temp.test_tenant_signup_review_task_type_catalog_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org_id uuid := gen_random_uuid();
  v_task_type_id uuid;
  v_created record;
  v_create jsonb;
  v_review jsonb;
  v_req_id uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (
    v_org_id,
    'Tenant Signup Review Task Catalog PGTAP',
    'tenant-signup-review-task-catalog-' || left(replace(v_org_id::text, '-', ''), 12)
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.settings s
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) AS item(value)
       WHERE s.category = 'task_type_catalog'
         AND s.scope_type = 'global'
         AND lower(item.value->>'key') = 'tenant_signup_review'
         AND COALESCE((item.value->>'enabled')::boolean, false)
    ),
    'global task_type_catalog includes enabled tenant_signup_review'
  );

  RETURN NEXT is(
    (
      SELECT item.value->>'default_queue_key'
        FROM public.settings s
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) AS item(value)
       WHERE s.category = 'task_type_catalog'
         AND s.scope_type = 'global'
         AND lower(item.value->>'key') = 'tenant_signup_review'
       LIMIT 1
    ),
    'tenant_signup',
    'tenant_signup_review resolves to tenant_signup queue'
  );

  RETURN NEXT is(
    (
      SELECT item.value->'default_actions'
        FROM public.settings s
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) AS item(value)
       WHERE s.category = 'task_type_catalog'
         AND s.scope_type = 'global'
         AND lower(item.value->>'key') = 'tenant_signup_review'
       LIMIT 1
    ),
    jsonb_build_array('approve', 'request_info', 'reject'),
    'tenant_signup_review exposes row-driven review actions'
  );

  v_task_type_id := public.ensure_task_type_from_catalog_v1(
    v_org_id,
    'tenant_signup_review',
    jsonb_build_object('organization_id', v_org_id)
  );

  RETURN NEXT ok(
    v_task_type_id IS NOT NULL,
    'ensure_task_type_from_catalog_v1 materializes tenant_signup_review'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.task_types tt
       WHERE tt.id = v_task_type_id
         AND tt.organization_id = v_org_id
         AND tt.key = 'tenant_signup_review'
         AND tt.default_queue_key = 'tenant_signup'
         AND COALESCE((tt.metadata #>> '{assignment_defaults,sla_minutes}')::int, 0) = 60
    ),
    'materialized task_type inherits queue and SLA defaults'
  );

  SELECT *
    INTO v_created
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'tenant_signup_review',
        'context', jsonb_build_object('organization_id', v_org_id),
        'resource_type', 'tenant_signup_request',
        'resource_id', gen_random_uuid(),
        'idempotency_key', 'pgtap:tenant-signup-review:' || replace(v_org_id::text, '-', ''),
        'metadata', jsonb_build_object('subject', 'Tenant signup review pgTAP')
      )
    )
   LIMIT 1;

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.tasks t
        JOIN public.task_types tt ON tt.id = t.task_type_id
       WHERE t.id = v_created.task_id
         AND tt.key = 'tenant_signup_review'
         AND t.queue_key = 'tenant_signup'
    ),
    'create_task_system_v1 can enqueue tenant_signup_review without workflow failure'
  );

  v_create := public.tenant_signup_request_create_v1(
    p_email := format('tenant-signup-task-closeout-%s@example.com', left(replace(gen_random_uuid()::text, '-', ''), 12)),
    p_full_name := 'Tenant Signup Task Closeout User',
    p_organization_name := 'Tenant Signup Task Closeout Org',
    p_organization_slug := NULL,
    p_website_url := NULL,
    p_phone := NULL,
    p_notes := 'pgtap task closeout',
    p_locale := 'en',
    p_page_url := 'https://example.com/signup',
    p_referrer := NULL,
    p_origin := 'https://example.com',
    p_marketing := '{}'::jsonb,
    p_ip_hash := format('pgtap-task-closeout-%s', left(replace(gen_random_uuid()::text, '-', ''), 12)),
    p_turnstile_verified := TRUE
  );

  v_req_id := NULLIF(v_create->>'id', '')::uuid;

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.tasks t
        JOIN public.task_types tt ON tt.id = t.task_type_id
       WHERE t.resource_type = 'tenant_signup_request'
         AND t.resource_id = v_req_id
         AND tt.key = 'tenant_signup_review'
         AND t.status = 'open'
    ),
    'tenant signup intake enqueues an open tenant_signup_review task'
  );

  v_review := public.tenant_signup_review_apply_v1(
    p_request_id := v_req_id,
    p_decision := 'rejected',
    p_reviewer_user_id := NULL,
    p_decision_reason := 'pgtap task closeout rejection',
    p_invited_auth_user_id := NULL,
    p_invite_email_sent := FALSE,
    p_invite_redirect_to := NULL,
    p_decision_metadata := '{}'::jsonb
  );

  RETURN NEXT ok(
    COALESCE((v_review->>'ok')::boolean, FALSE),
    'tenant_signup_review_apply_v1 rejection succeeds with task closeout'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.tasks t
        JOIN public.task_types tt ON tt.id = t.task_type_id
       WHERE t.resource_type = 'tenant_signup_request'
         AND t.resource_id = v_req_id
         AND tt.key = 'tenant_signup_review'
         AND t.status = 'completed'
         AND t.completed_at IS NOT NULL
    ),
    'tenant_signup_review task is completed when review decision is applied'
  );

  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
        FROM public.workflow_runs wr
       WHERE wr.context::text LIKE '%' || v_req_id::text || '%'
         AND wr.workflow_status = 'failed'
    ),
    'tenant signup review workflow has no failed run after task closeout'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_tenant_signup_review_task_type_catalog_v1();

SELECT * FROM finish();

ROLLBACK;

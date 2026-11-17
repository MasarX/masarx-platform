BEGIN;

SELECT plan(19);

SELECT ok(
    NOT has_function_privilege('authenticated', 'public.invoke_label_renderer(integer)', 'EXECUTE'),
    'authenticated cannot EXECUTE invoke_label_renderer(int)'
);

SELECT ok(
    has_function_privilege('service_role', 'public.invoke_label_renderer(integer)', 'EXECUTE'),
    'service_role can EXECUTE invoke_label_renderer(int)'
);

SELECT ok(
    has_function_privilege('edge_label_renderer_role', 'public.lease_label_jobs(uuid, integer, integer)', 'EXECUTE'),
    'edge_label_renderer_role can EXECUTE lease_label_jobs(uuid,int,int)'
);

SELECT ok(
    has_function_privilege('edge_label_renderer_role', 'public.lease_label_jobs_by_ids(uuid[], integer, integer)', 'EXECUTE'),
    'edge_label_renderer_role can EXECUTE lease_label_jobs_by_ids(uuid[],int,int)'
);

SELECT ok(
    has_function_privilege('edge_label_renderer_role', 'public.lease_label_jobs_by_ids_compact(uuid[], integer, integer)', 'EXECUTE'),
    'edge_label_renderer_role can EXECUTE lease_label_jobs_by_ids_compact(uuid[],int,int)'
);

SELECT ok(
    has_function_privilege('edge_label_renderer_role', 'public.get_label_jobs_status(uuid[])', 'EXECUTE'),
    'edge_label_renderer_role can EXECUTE get_label_jobs_status(uuid[])'   
);

SELECT ok(
    has_function_privilege('edge_label_renderer_role', 'public.compose_label_payloads(uuid[])', 'EXECUTE'),
    'edge_label_renderer_role can EXECUTE compose_label_payloads(uuid[])'
);

SELECT ok(
    has_function_privilege('edge_label_renderer_role', 'public.complete_label_jobs(jsonb)', 'EXECUTE'),
    'edge_label_renderer_role can EXECUTE complete_label_jobs(jsonb)'
);

SELECT ok(
    has_function_privilege(
      'edge_label_renderer_role',
      'public.log_decision(uuid, text, text, uuid, text, text, text, uuid, jsonb, text, uuid)',
      'EXECUTE'
    ),
    'edge_label_renderer_role can EXECUTE log_decision(uuid,text,text,uuid,text,text,text,uuid,jsonb,text,uuid)'
);

SELECT ok(
    NOT EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'log_decision'
        AND oidvectortypes(p.proargtypes) = 'uuid, text, text, uuid, text, text, text, uuid, jsonb, text'
    )
    OR has_function_privilege(
      'edge_label_renderer_role',
      'public.log_decision(uuid, text, text, uuid, text, text, text, uuid, jsonb, text)',
      'EXECUTE'
    ),
    'edge_label_renderer_role can EXECUTE legacy log_decision(uuid,text,text,uuid,text,text,text,uuid,jsonb,text) when present'
);

SELECT ok(
    NOT has_function_privilege('authenticated', 'public.lease_label_jobs_by_ids(uuid[], integer, integer)', 'EXECUTE'),
    'authenticated cannot EXECUTE lease_label_jobs_by_ids(uuid[],int,int)'
);

SELECT ok(
    NOT has_function_privilege('authenticated', 'public.lease_label_jobs_by_ids_compact(uuid[], integer, integer)', 'EXECUTE'),
    'authenticated cannot EXECUTE lease_label_jobs_by_ids_compact(uuid[],int,int)'
);

SELECT ok(
    NOT has_function_privilege('authenticated', 'public.get_label_jobs_status(uuid[])', 'EXECUTE'),
    'authenticated cannot EXECUTE get_label_jobs_status(uuid[])'
);

SELECT ok(
    NOT has_function_privilege('authenticated', 'public.compose_label_payloads(uuid[])', 'EXECUTE'),
    'authenticated cannot EXECUTE compose_label_payloads(uuid[])'
);

SELECT ok(
    NOT has_function_privilege('authenticated', 'public.complete_label_jobs(jsonb)', 'EXECUTE'),
    'authenticated cannot EXECUTE complete_label_jobs(jsonb)'
);

SELECT ok(
    has_function_privilege('service_role', 'public.request_label_generation_batch(uuid, text, uuid, text, uuid[], text)', 'EXECUTE'),
    'service_role can EXECUTE request_label_generation_batch(uuid,text,uuid,text,uuid[],text)'
);

SELECT ok(
    has_function_privilege('service_role', 'public.compose_label_payloads(uuid[])', 'EXECUTE'),
    'service_role can EXECUTE compose_label_payloads(uuid[])'
);

SELECT ok(
    has_function_privilege('service_role', 'public.complete_label_jobs(jsonb)', 'EXECUTE'),
    'service_role can EXECUTE complete_label_jobs(jsonb)'
);

SELECT results_eq(
    $$SELECT count(*)::int FROM public.resolve_label_files_for_bundle(gen_random_uuid(), NULL, NULL, NULL, NULL)$$,
    ARRAY[0],
    'resolve_label_files_for_bundle accepts client/sender filters and returns empty when none match'
);

SELECT * FROM finish();

ROLLBACK;

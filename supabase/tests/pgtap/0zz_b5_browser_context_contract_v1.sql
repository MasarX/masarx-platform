BEGIN;
SELECT plan(17);

SELECT has_function(
  'public', 'public_tracking_config_v1', ARRAY[]::text[],
  'public tracking config facade exists'
);
SELECT has_function(
  'api', 'public_tracking_config_v1', ARRAY[]::text[],
  'api public tracking config wrapper exists'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.public_tracking_config_v1()', 'EXECUTE'),
  'anon cannot bypass the api public tracking wrapper'
);
SELECT ok(
  has_function_privilege('anon', 'api.public_tracking_config_v1()', 'EXECUTE'),
  'anon can execute the api public tracking config wrapper'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.ui_tracking_registry_v1()', 'EXECUTE'),
  'anon cannot execute the scoped UI tracking registry'
);
SELECT ok(
  (
    SELECT p.prosecdef
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'api'
       AND p.proname = 'public_tracking_config_v1'
  ),
  'api public tracking wrapper is security definer'
);
SELECT ok(
  public.public_tracking_config_v1()
    ?& ARRAY['resource_key', 'param_key', 'form'],
  'public tracking config retains the required public presentation keys'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM jsonb_object_keys(public.public_tracking_config_v1()) key
     WHERE key <> ALL (ARRAY[
       'resource_key', 'filter_key', 'param_key', 'title', 'title_ar', 'description', 'description_ar',
       'results_description', 'results_description_ar', 'empty', 'empty_ar', 'form'
     ])
  ),
  'public tracking config exposes no unwhitelisted top-level keys'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL (
        VALUES (sv.value), (s.cached_value)
      ) AS payload(value)
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(payload.value->'resources', '[]'::jsonb)
      ) AS resource
     WHERE s.category = 'ui_read_registry'
       AND resource->>'key' = 'service_branch_directory'
       AND resource->>'relation' = 'api.service_branch_directory'
       AND resource->>'allow_view_relation' = 'true'
       AND resource->'select' =
         '["id","organization_id","code","name","is_active"]'::jsonb
       AND resource->>'capability_read' = 'agreements.read'
       AND resource->>'capability_write' = 'agreements.write'
       AND resource->>'allow_view_relation' = 'true'
       AND resource->>'strict_columns' = 'true'
  )
  AND NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL (
        VALUES (sv.value), (s.cached_value)
      ) AS payload(value)
     WHERE s.category = 'ui_read_registry'
       AND (
         (
           SELECT COUNT(*)
             FROM jsonb_array_elements(
               COALESCE(payload.value->'resources', '[]'::jsonb)
             ) AS resource
            WHERE resource->>'key' = 'service_branch_directory'
         ) > 1
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(
               COALESCE(payload.value->'resources', '[]'::jsonb)
             ) AS resource
            WHERE resource->>'key' = 'service_branch_directory'
              AND (
                resource->>'relation' IS DISTINCT FROM 'api.service_branch_directory'
                OR resource->>'allow_view_relation' IS DISTINCT FROM 'true'
                OR resource->'select' IS DISTINCT FROM
                  '["id","organization_id","code","name","is_active"]'::jsonb
                OR resource->>'capability_read' IS DISTINCT FROM 'agreements.read'
                OR resource->>'capability_write' IS DISTINCT FROM 'agreements.write'
                OR resource->>'allow_view_relation' IS DISTINCT FROM 'true'
                OR resource->>'strict_columns' IS DISTINCT FROM 'true'
              )
         )
       )
  ),
  'every service branch directory registry copy uses the exact API view contract'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'api'
       AND c.relname = 'service_branch_directory'
       AND c.relkind = 'v'
       AND COALESCE(c.reloptions, ARRAY[]::TEXT[]) @> ARRAY['security_invoker=true']
  ),
  'api service branch directory is a security-invoker view'
);
SELECT is(
  (
    SELECT array_agg(column_name::TEXT ORDER BY ordinal_position)
      FROM information_schema.columns
     WHERE table_schema = 'api'
       AND table_name = 'service_branch_directory'
  ),
  ARRAY['id', 'organization_id', 'code', 'name', 'is_active']::TEXT[],
  'api service branch directory exposes only the required fields'
);
SELECT ok(
  NOT has_table_privilege('anon', 'api.service_branch_directory', 'SELECT'),
  'anon cannot read the service branch directory'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'api.service_branch_directory', 'SELECT'),
  'authenticated cannot bypass the governed resource readers'
);
SELECT ok(
  has_table_privilege('service_role', 'api.service_branch_directory', 'SELECT'),
  'service role can read the service branch directory'
);



SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_versions sv
     WHERE sv.category = 'ui_read_registry'
       AND sv.change_reason = 'Route service branch reads through the governed API projection'
       AND sv.effective_until IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) resource
          WHERE resource->>'key' = 'service_branch_directory'
            AND resource->>'relation' = 'api.service_branch_directory'
       )
  ),
  '041010 ui read registry version is retained as closed service branch history'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) resource
          WHERE resource->>'key' = 'service_branch_directory'
            AND resource->>'relation' = 'api.service_branch_directory'
       )
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) resource
          WHERE resource->>'key' = 'service_branch_directory'
            AND resource->>'relation' = 'api.service_branch_directory'
       )
  )
  AND NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND (
         s.cached_value IS DISTINCT FROM sv.value
         OR sv.effective_until IS NOT NULL
         OR sv.version <> (
           SELECT MAX(candidate.version)
             FROM public.settings_versions candidate
            WHERE candidate.category = sv.category
              AND candidate.scope_type = sv.scope_type
              AND candidate.scope_hash = sv.scope_hash
         )
         OR NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) resource
            WHERE resource->>'key' = 'service_branch_directory'
              AND resource->>'relation' = 'api.service_branch_directory'
         )
         OR NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) resource
            WHERE resource->>'key' = 'service_branch_directory'
              AND resource->>'relation' = 'api.service_branch_directory'
         )
       )
  ),
  'latest ui read registry pointer/cache/MAX parity retains the service branch entry'
);
WITH promotion_history AS (
 SELECT * FROM public.settings_versions
  WHERE category='access_control_policy'
    AND change_reason='Align service directory access with agreements capabilities'
), current_heads AS (
 SELECT sv.*,s.cached_value FROM public.settings s
  JOIN public.settings_versions sv ON sv.id=s.settings_version_id
    AND sv.category=s.category AND sv.scope_type=s.scope_type AND sv.scope_hash=s.scope_hash
  WHERE s.category='access_control_policy' AND EXISTS(
   SELECT 1 FROM promotion_history history WHERE history.category=sv.category
     AND history.scope_type=sv.scope_type AND history.scope_hash=sv.scope_hash)
)
SELECT ok(
 EXISTS(SELECT 1 FROM promotion_history)
 AND NOT EXISTS(
  SELECT 1 FROM promotion_history history WHERE NOT EXISTS(
   SELECT 1 FROM current_heads head WHERE head.category=history.category
     AND head.scope_type=history.scope_type AND head.scope_hash=history.scope_hash
     AND head.version>=history.version
     AND (head.id=history.id OR history.effective_until IS NOT NULL)))
 AND NOT EXISTS(
  SELECT 1 FROM current_heads head WHERE head.cached_value IS DISTINCT FROM head.value
   OR head.effective_until IS NOT NULL OR head.version<>(
    SELECT MAX(candidate.version) FROM public.settings_versions candidate
     WHERE candidate.category=head.category AND candidate.scope_type=head.scope_type
       AND candidate.scope_hash=head.scope_hash)
   OR NOT EXISTS(
    SELECT 1 FROM public.settings_versions prior WHERE prior.category=head.category
      AND prior.scope_type=head.scope_type AND prior.scope_hash=head.scope_hash
      AND prior.version<head.version AND prior.effective_until IS NOT NULL
      AND prior.schema_version=head.schema_version))
 AND NOT EXISTS(
  SELECT 1 FROM promotion_history history WHERE NOT EXISTS(
   SELECT 1 FROM public.settings_versions prior WHERE prior.category=history.category
     AND prior.scope_type=history.scope_type AND prior.scope_hash=history.scope_hash
     AND prior.version<history.version AND prior.effective_until IS NOT NULL
     AND prior.schema_version=history.schema_version)),
  'access control promotion retains a closed predecessor and current pointer/cache/version parity'
);

SELECT * FROM finish();
ROLLBACK;

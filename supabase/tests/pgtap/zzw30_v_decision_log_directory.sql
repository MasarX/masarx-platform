-- pgTAP: public.v_decision_log_directory projection contract
-- Spec-Issue: W30 (paired projection views - INSIGHTS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

-- 1) View exists
SELECT has_view(
  'public', 'v_decision_log_directory',
  'public.v_decision_log_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_decision_log_directory',
  ARRAY[
    'id', 'organization_id', 'timestamp',
    'decision_category', 'decision_point', 'decision_outcome',
    'decision_inputs', 'decision_reason',
    'resource_type', 'resource_id',
    'correlation_id', 'settings_resolution_id', 'performed_by_system',
    'resolved_from', 'scope_path', 'scope_category',
    'winning_settings_id', 'winning_settings_version_id', 'winning_version',
    'scope_resolved_at',
    'age_seconds', 'has_correlation', 'has_resolution'
  ],
  'v_decision_log_directory exposes canonical + derived FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_decision_log_directory', 'SELECT'),
  'service_role has SELECT on v_decision_log_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_decision_log_directory', 'SELECT'),
  'anon has no SELECT on v_decision_log_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_decision_log_directory', 'SELECT'),
  'authenticated has SELECT on v_decision_log_directory'
);

-- 6) Underlying base tables remain SSOT.
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('decision_log', 'settings_resolution_log')
       AND c.relkind IN ('r', 'p')
    HAVING COUNT(*) = 2
  ),
  'public.decision_log + settings_resolution_log remain base tables (SSOT preserved)'
);

-- 7) Projection: insert a settings resolution + decision_log rows.
DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-00000030b001';
  v_corr     UUID := '00000000-0000-0000-0000-00000030b002';
  v_res_id   UUID := '00000000-0000-0000-0000-00000030b003';
  v_dec_a    UUID := '00000000-0000-0000-0000-00000030b004';
  v_dec_b    UUID := '00000000-0000-0000-0000-00000030b005';
  v_resource UUID := '00000000-0000-0000-0000-00000030b006';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W30 Decision Org', 'w30-d-main')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.settings_resolution_log (
    id, organization_id, category, scope_path,
    winning_scope_type, winning_scope_id,
    winning_settings_id, winning_settings_version_id,
    winning_version, resolved_at, created_at
  )
  VALUES (
    v_res_id, v_org, 'route_assignment_policy',
    jsonb_build_array(
      jsonb_build_object('rank', 0, 'scope_type', 'global', 'has_value', TRUE, 'version', 1),
      jsonb_build_object('rank', 1, 'scope_type', 'tenant', 'has_value', TRUE, 'version', 2)
    ),
    'tenant', v_org,
    NULL, NULL, 2,
    now() - INTERVAL '5 minutes', now() - INTERVAL '5 minutes'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs,
    correlation_id, settings_resolution_id, timestamp
  )
  VALUES (
    v_dec_a, v_org, 'settings_resolution', 'route_run', v_resource,
    'pre_dispatch', 'approved', '{"capacity": 22}'::jsonb,
    v_corr, v_res_id, now() - INTERVAL '5 minutes'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, timestamp
  )
  VALUES (
    v_dec_b, v_org, 'geocoding', 'address', v_resource,
    'fallback', 'use_fallback',
    now() - INTERVAL '10 minutes'
  )
  ON CONFLICT DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_decision_log_directory with_res
    JOIN public.v_decision_log_directory no_res
      ON no_res.id = '00000000-0000-0000-0000-00000030b005'::UUID
    WHERE with_res.id = '00000000-0000-0000-0000-00000030b004'::UUID
      AND with_res.resolved_from = 'tenant'
      AND with_res.age_seconds IS NOT NULL
      AND with_res.age_seconds >= 0
      AND with_res.has_correlation = TRUE
      AND with_res.has_resolution = TRUE
      AND no_res.resolved_from IS NULL
      AND no_res.has_resolution = FALSE
  ),
  'v_decision_log_directory joins resolved_from from settings_resolution_log + derives age_seconds/has_correlation/has_resolution; rows without resolution project resolved_from=NULL has_resolution=FALSE'
);

SELECT * FROM finish();
ROLLBACK;

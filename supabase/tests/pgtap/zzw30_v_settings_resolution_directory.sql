-- pgTAP: public.v_settings_resolution_directory projection contract
-- Spec-Issue: W30 (paired projection views — INSIGHTS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

-- 1) View exists
SELECT has_view(
  'public', 'v_settings_resolution_directory',
  'public.v_settings_resolution_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_settings_resolution_directory',
  ARRAY[
    'id', 'organization_id', 'resolved_at', 'created_at', 'category',
    'scope_path', 'winning_scope_type', 'winning_scope_id',
    'winning_settings_id', 'winning_settings_version_id',
    'winning_version', 'merge_notes', 'inputs',
    'ladder_levels_visited', 'override_count', 'age_seconds',
    'is_global_winner', 'is_tenant_winner',
    'is_client_winner', 'is_sender_winner'
  ],
  'v_settings_resolution_directory exposes canonical + derived FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_settings_resolution_directory', 'SELECT'),
  'service_role has SELECT on v_settings_resolution_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_settings_resolution_directory', 'SELECT'),
  'anon has no SELECT on v_settings_resolution_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_settings_resolution_directory', 'SELECT'),
  'authenticated has SELECT on v_settings_resolution_directory'
);

-- 6) Underlying base table remains SSOT (settings_resolution_log is partitioned)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'settings_resolution_log'
       AND c.relkind IN ('r', 'p')
  ),
  'public.settings_resolution_log remains a base/partitioned table (SSOT preserved)'
);

-- 7) Projection: insert two resolution rows (one tenant winner with 1 override
--    in scope_path, one global winner with 0 overrides) and verify
--    ladder_levels_visited / override_count / lifecycle booleans.
DO $$
DECLARE
  v_org    UUID := '00000000-0000-0000-0000-00000030c001';
  v_res_t  UUID := '00000000-0000-0000-0000-00000030c002';
  v_res_g  UUID := '00000000-0000-0000-0000-00000030c003';
  v_levels_t INT;
  v_overrides_t INT;
  v_age_t  BIGINT;
  v_is_global_t BOOLEAN;
  v_is_tenant_t BOOLEAN;
  v_levels_g INT;
  v_overrides_g INT;
  v_is_global_g BOOLEAN;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W30 Resolution Org', 'w30-r-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  -- Resolution T: 2-level ladder (global has_value=true, tenant has_value=true winner)
  --   ladder_levels_visited = 2 ; override_count = 1 (tenant entry overrides global)
  INSERT INTO public.settings_resolution_log (
    id, organization_id, category, scope_path,
    winning_scope_type, winning_scope_id, winning_version,
    resolved_at, created_at
  )
  VALUES (
    v_res_t, v_org, 'route_assignment_policy',
    jsonb_build_array(
      jsonb_build_object('rank', 0, 'scope_type', 'global', 'has_value', TRUE, 'version', 1),
      jsonb_build_object('rank', 1, 'scope_type', 'tenant', 'has_value', TRUE, 'version', 2)
    ),
    'tenant', v_org, 2,
    now() - INTERVAL '3 minutes', now() - INTERVAL '3 minutes'
  )
  ON CONFLICT DO NOTHING;

  -- Resolution G: 3-level ladder (global has_value=true winner; tenant + client
  --   have_value=false fall-throughs).  ladder_levels_visited = 3 ;
  --   override_count = 0 (no non-global has_value=true entries).
  INSERT INTO public.settings_resolution_log (
    id, organization_id, category, scope_path,
    winning_scope_type, winning_scope_id, winning_version,
    resolved_at, created_at
  )
  VALUES (
    v_res_g, v_org, 'communication_policy',
    jsonb_build_array(
      jsonb_build_object('rank', 0, 'scope_type', 'global', 'has_value', TRUE, 'version', 1),
      jsonb_build_object('rank', 1, 'scope_type', 'tenant', 'has_value', FALSE),
      jsonb_build_object('rank', 2, 'scope_type', 'client', 'has_value', FALSE)
    ),
    'global', NULL, 1,
    now() - INTERVAL '4 minutes', now() - INTERVAL '4 minutes'
  )
  ON CONFLICT DO NOTHING;

  SELECT ladder_levels_visited, override_count, age_seconds,
         is_global_winner, is_tenant_winner
    INTO v_levels_t, v_overrides_t, v_age_t,
         v_is_global_t, v_is_tenant_t
    FROM public.v_settings_resolution_directory
   WHERE id = v_res_t;

  SELECT ladder_levels_visited, override_count, is_global_winner
    INTO v_levels_g, v_overrides_g, v_is_global_g
    FROM public.v_settings_resolution_directory
   WHERE id = v_res_g;

  PERFORM ok(
    v_levels_t = 2
      AND v_overrides_t = 1
      AND v_age_t IS NOT NULL
      AND v_age_t >= 0
      AND v_is_global_t = FALSE
      AND v_is_tenant_t = TRUE
      AND v_levels_g = 3
      AND v_overrides_g = 0
      AND v_is_global_g = TRUE,
    'v_settings_resolution_directory derives ladder_levels_visited/override_count/age_seconds + winner-bucket booleans from canonical scope_path JSONB'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;

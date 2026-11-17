-- Test Suite: Scope ladder is registry-driven (SSOT)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(13);

SELECT ok(
  to_regclass('public.scope_type_registry') IS NOT NULL,
  'scope_type_registry exists'
);

SELECT ok(
  to_regclass('public.scope_type_aliases') IS NOT NULL,
  'scope_type_aliases exists'
);

SELECT ok(
  to_regclass('public.scope_ladder_edges') IS NOT NULL,
  'scope_ladder_edges exists'
);

SELECT is(
  (SELECT count(*) FROM public.scope_type_registry WHERE scope_type IN ('global','tenant','client','sender','source','resource')),
  6::bigint,
  'scope_type_registry has core keys'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.scope_type_registry WHERE scope_type = 'global' AND entity_table IS NULL),
  'root scope_type is global'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.scope_type_registry WHERE scope_type = 'tenant' AND entity_table = 'organizations'::regclass),
  'tenant scope_type is tenant'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.scope_ladder_edges
    WHERE child_scope_type = 'sender'
      AND parent_scope_type = 'client'
      AND child_parent_column = 'client_id'
      AND child_table = 'senders'::regclass
  ),
  'edge sender -> client'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.scope_ladder_edges
    WHERE child_scope_type = 'client'
      AND parent_scope_type = 'tenant'
      AND child_parent_column = 'organization_id'
      AND child_table = 'clients'::regclass
  ),
  'edge client -> tenant'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.scope_ladder_edges
    WHERE child_scope_type = 'resource'
      AND parent_scope_type = 'tenant'
      AND child_parent_column = 'organization_id'
      AND child_table = 'providers'::regclass
  ),
  'edge resource -> tenant'
);

DO $$
DECLARE
  v_def TEXT;
BEGIN
  v_def := pg_get_functiondef('public.resolve_settings_row(text,text,uuid)'::regprocedure);
  PERFORM ok(v_def LIKE '%resolve_scope_path_v1%', 'resolve_settings_row delegates to resolve_scope_path_v1');
  PERFORM ok(v_def NOT LIKE '%p_scope_type = ''source''%', 'resolve_settings_row has no hardcoded source branch');
END $$;

DO $$
DECLARE
  v_def TEXT;
BEGIN
  v_def := pg_get_functiondef('public.resolve_webhook_ingest_policy(uuid)'::regprocedure);
  PERFORM ok(v_def LIKE '%resolve_settings_row%', 'resolve_webhook_ingest_policy delegates to resolve_settings_row');
  PERFORM ok(v_def NOT LIKE '%UNION ALL%', 'resolve_webhook_ingest_policy has no hardcoded UNION priorities');
END $$;

SELECT finish();

ROLLBACK;

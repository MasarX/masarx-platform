-- pgTAP: Console V2 release proof governance read surface
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_category_registry
     WHERE category = 'release_deploy_proof_governance'
       AND requires_global_default
       AND safe_missing_behavior = 'hard_fail'
  ),
  'release_deploy_proof_governance category is registered as fail-closed'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.schema_registry
     WHERE category = 'release_deploy_proof_governance'
       AND version = 1
       AND is_active
  ),
  'release_deploy_proof_governance schema v1 is active'
);

SELECT has_view(
  'public',
  'release_deploy_proof_governance_v1',
  'public.release_deploy_proof_governance_v1 view exists'
);

SELECT columns_are(
  'public',
  'release_deploy_proof_governance_v1',
  ARRAY[
    'id',
    'proof_scope',
    'surface_id',
    'surface_label',
    'stage',
    'deploy_environment',
    'stage_workflow_file',
    'evidence_workflow_file',
    'workflow_name',
    'artifact_name',
    'json_entry_suffix',
    'evidence_status',
    'evidence_required',
    'proof_guard',
    'source_paths',
    'doc_paths',
    'notes'
  ],
  'release_deploy_proof_governance_v1 exposes the Console V2 proof columns'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'release_deploy_proof_governance_v1'
       AND c.relkind = 'v'
       AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
  ),
  'release_deploy_proof_governance_v1 is a security_invoker view'
);

SELECT ok(
  has_table_privilege('service_role', 'public.release_deploy_proof_governance_v1', 'SELECT'),
  'service_role has SELECT on release_deploy_proof_governance_v1'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.release_deploy_proof_governance_v1', 'SELECT'),
  'anon has no SELECT on release_deploy_proof_governance_v1'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.release_deploy_proof_governance_v1
     WHERE id = 'db-stg'
       AND evidence_status = 'configured'
       AND evidence_workflow_file = 'deploy-stg-promote.yml'
       AND artifact_name = 'stg-deploy-evidence'
  ),
  'db stg same-SHA deploy evidence row is configured'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.release_deploy_proof_governance_v1
     WHERE id = 'console-stg'
       AND surface_id = 'console'
       AND stage_workflow_file = 'deploy-console.yml'
       AND evidence_workflow_file = 'deploy-console.yml'
       AND evidence_status = 'configured'
       AND artifact_name = 'console-stg-deploy-evidence'
       AND json_entry_suffix = 'console-deploy-evidence-manifest.json'
       AND evidence_required
  ),
  'console stg same-SHA deploy evidence row is configured'
);

SELECT ok(
  (
    SELECT source_paths @> '["config/ci/deploy-evidence-contract.json", ".github/workflows/deploy-vercel-surface.yml"]'::jsonb
      FROM public.release_deploy_proof_governance_v1
     WHERE id = 'console-stg'
  ),
  'console evidence row is linked to deploy-evidence-contract and reusable deploy workflow evidence'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL::uuid)->'resources') AS resource
     WHERE resource->>'key' = 'release_deploy_proof_governance'
       AND resource->>'relation' = 'public.release_deploy_proof_governance_v1'
       AND COALESCE((resource->>'allow_view_relation')::boolean, false)
       AND resource->>'capability_read' = 'settings.read'
  ),
  'ui_read_registry exposes release_deploy_proof_governance through settings.read'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        COALESCE(
          public.resolve_settings_merged('ui_navigation', 'global', NULL::uuid)#>'{apps,console,sections}',
          '[]'::jsonb
        )
      ) AS section
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
     WHERE item->>'route' = '/platform/release-proof'
       AND item->>'resource' = 'release_deploy_proof_governance'
       AND item->>'capability' = 'settings.read'
  ),
  'ui_navigation links Console V2 release proof governance'
);

SELECT * FROM finish();
ROLLBACK;

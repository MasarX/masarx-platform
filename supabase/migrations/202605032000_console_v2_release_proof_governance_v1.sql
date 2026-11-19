-- Migration: Console V2 release proof governance read surface
-- Purpose: Expose same-SHA deploy evidence governance through a settings-backed
-- security_invoker view and the canonical UI read registry.
BEGIN;
SELECT pg_advisory_lock(hashtext('202605032000_console_v2_release_proof_governance_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES (
  'release_deploy_proof_governance',
  'Release and same-SHA deploy proof governance rows for Console V2.',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes,
    updated_at = now();

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'release_deploy_proof_governance',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'required', jsonb_build_array('version', 'rows'),
    'additionalProperties', true,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer'),
      'rows', jsonb_build_object(
        'type', 'array',
        'items', jsonb_build_object(
          'type', 'object',
          'required', jsonb_build_array(
            'id',
            'proof_scope',
            'surface_id',
            'stage',
            'deploy_environment',
            'evidence_status',
            'evidence_required',
            'source_paths',
            'doc_paths'
          ),
          'additionalProperties', true
        )
      )
    )
  ),
  'Release and same-SHA deploy proof governance rows.',
  jsonb_build_array(jsonb_build_object('version', 1, 'rows', jsonb_build_array())),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE,
    deprecated_at = NULL;

DO $$
DECLARE
  v_payload JSONB := $json$
{
  "version": 1,
  "source_paths": [
    "config/ci/deploy-evidence-contract.json",
    "config/ci/deploy-surfaces.json"
  ],
  "doc_paths": [
    "docs/ops/runbooks/DEPLOYMENTS.md"
  ],
  "rows": [
    {
      "id": "db-dev",
      "proof_scope": "same_sha_deploy_evidence",
      "surface_id": "db",
      "surface_label": "Backend (DB + Edge)",
      "stage": "dev",
      "deploy_environment": "db-dev",
      "stage_workflow_file": "deploy-dev.yml",
      "evidence_workflow_file": "deploy-dev.yml",
      "workflow_name": "Deploy (Dev)",
      "artifact_name": "dev-deploy-evidence",
      "json_entry_suffix": "deploy-dev-evidence-manifest.json",
      "evidence_status": "configured",
      "evidence_required": true,
      "proof_guard": "workflow-first same-SHA artifact",
      "source_paths": ["config/ci/deploy-evidence-contract.json", "config/ci/deploy-surfaces.json"],
      "doc_paths": ["docs/ops/runbooks/DEPLOYMENTS.md"],
      "notes": "Workflow evidence contract declares the same-SHA artifact and manifest for this surface."
    },
    {
      "id": "db-stg",
      "proof_scope": "same_sha_deploy_evidence",
      "surface_id": "db",
      "surface_label": "Backend (DB + Edge)",
      "stage": "stg",
      "deploy_environment": "db-stg",
      "stage_workflow_file": "deploy-stg-promote.yml",
      "evidence_workflow_file": "deploy-stg-promote.yml",
      "workflow_name": "Deploy (Stg)",
      "artifact_name": "stg-deploy-evidence",
      "json_entry_suffix": "deploy-stg-evidence-manifest.json",
      "evidence_status": "configured",
      "evidence_required": true,
      "proof_guard": "workflow-first same-SHA artifact",
      "source_paths": ["config/ci/deploy-evidence-contract.json", "config/ci/deploy-surfaces.json"],
      "doc_paths": ["docs/ops/runbooks/DEPLOYMENTS.md"],
      "notes": "Workflow evidence contract declares the same-SHA artifact and manifest for this surface."
    },
    {
      "id": "db-prod",
      "proof_scope": "same_sha_deploy_evidence",
      "surface_id": "db",
      "surface_label": "Backend (DB + Edge)",
      "stage": "prod",
      "deploy_environment": "db-prod",
      "stage_workflow_file": "deploy-prod.yml",
      "evidence_workflow_file": "deploy-prod.yml",
      "workflow_name": "Deploy (Prod)",
      "artifact_name": "prod-deploy-evidence",
      "json_entry_suffix": "deploy-prod-evidence-manifest.json",
      "evidence_status": "configured",
      "evidence_required": true,
      "proof_guard": "workflow-first same-SHA artifact",
      "source_paths": ["config/ci/deploy-evidence-contract.json", "config/ci/deploy-surfaces.json"],
      "doc_paths": ["docs/ops/runbooks/DEPLOYMENTS.md"],
      "notes": "Workflow evidence contract declares the same-SHA artifact and manifest for this surface."
    },
    {
      "id": "landing-dev",
      "proof_scope": "same_sha_deploy_evidence",
      "surface_id": "landing",
      "surface_label": "Landing (Cloudflare Pages)",
      "stage": "dev",
      "deploy_environment": "landing-dev",
      "stage_workflow_file": "deploy-landing-dev.yml",
      "evidence_workflow_file": "deploy-landing-dev.yml",
      "workflow_name": "Deploy Landing (Dev)",
      "artifact_name": "landing-dev-deploy-evidence",
      "json_entry_suffix": "landing-deploy-evidence-manifest.json",
      "evidence_status": "configured",
      "evidence_required": true,
      "proof_guard": "workflow-first same-SHA artifact",
      "source_paths": ["config/ci/deploy-evidence-contract.json", "config/ci/deploy-surfaces.json"],
      "doc_paths": ["docs/ops/runbooks/DEPLOYMENTS.md"],
      "notes": "Workflow evidence contract declares the same-SHA artifact and manifest for this surface."
    },
    {
      "id": "landing-stg",
      "proof_scope": "same_sha_deploy_evidence",
      "surface_id": "landing",
      "surface_label": "Landing (Cloudflare Pages)",
      "stage": "stg",
      "deploy_environment": "landing-stg",
      "stage_workflow_file": "deploy-landing-stg.yml",
      "evidence_workflow_file": "deploy-landing-stg.yml",
      "workflow_name": "Deploy Landing (Stg)",
      "artifact_name": "landing-stg-deploy-evidence",
      "json_entry_suffix": "landing-deploy-evidence-manifest.json",
      "evidence_status": "configured",
      "evidence_required": true,
      "proof_guard": "workflow-first same-SHA artifact",
      "source_paths": ["config/ci/deploy-evidence-contract.json", "config/ci/deploy-surfaces.json"],
      "doc_paths": ["docs/ops/runbooks/DEPLOYMENTS.md"],
      "notes": "Workflow evidence contract declares the same-SHA artifact and manifest for this surface."
    },
    {
      "id": "landing-prod",
      "proof_scope": "same_sha_deploy_evidence",
      "surface_id": "landing",
      "surface_label": "Landing (Cloudflare Pages)",
      "stage": "prod",
      "deploy_environment": "landing-prod",
      "stage_workflow_file": "deploy-landing-prod.yml",
      "evidence_workflow_file": "deploy-landing-prod.yml",
      "workflow_name": "Deploy Landing (Prod)",
      "artifact_name": "landing-prod-deploy-evidence",
      "json_entry_suffix": "landing-deploy-evidence-manifest.json",
      "evidence_status": "configured",
      "evidence_required": true,
      "proof_guard": "workflow-first same-SHA artifact",
      "source_paths": ["config/ci/deploy-evidence-contract.json", "config/ci/deploy-surfaces.json"],
      "doc_paths": ["docs/ops/runbooks/DEPLOYMENTS.md"],
      "notes": "Workflow evidence contract declares the same-SHA artifact and manifest for this surface."
    },
    {
      "id": "api-ingress",
      "proof_scope": "same_sha_deploy_evidence",
      "surface_id": "api_ingress",
      "surface_label": "API Ingress (Cloudflare Worker)",
      "stage": "any",
      "deploy_environment": "api-ingress-*",
      "stage_workflow_file": "deploy-api-ingress-worker.yml",
      "evidence_workflow_file": "deploy-api-ingress-worker.yml",
      "workflow_name": "Deploy API Ingress Worker (Cloudflare)",
      "artifact_name": "api-ingress-deploy-evidence",
      "json_entry_suffix": "api-ingress-deploy-evidence-manifest.json",
      "evidence_status": "configured",
      "evidence_required": true,
      "proof_guard": "workflow-first same-SHA artifact",
      "source_paths": ["config/ci/deploy-evidence-contract.json", "config/ci/deploy-surfaces.json"],
      "doc_paths": ["docs/ops/runbooks/DEPLOYMENTS.md"],
      "notes": "Workflow evidence contract declares the same-SHA artifact and manifest for this surface."
    },
    {
      "id": "mobile-fieldops",
      "proof_scope": "same_sha_deploy_evidence",
      "surface_id": "mobile_fieldops",
      "surface_label": "Mobile FieldOps (Expo/EAS)",
      "stage": "any",
      "deploy_environment": "mobile-*",
      "stage_workflow_file": "deploy-mobile-fieldops.yml",
      "evidence_workflow_file": "deploy-mobile-fieldops.yml",
      "workflow_name": "Deploy Mobile FieldOps (Manual)",
      "artifact_name": "mobile-fieldops-evidence",
      "json_entry_suffix": "mobile-fieldops-evidence-manifest.json",
      "evidence_status": "configured",
      "evidence_required": true,
      "proof_guard": "workflow-first same-SHA artifact",
      "source_paths": ["config/ci/deploy-evidence-contract.json", "config/ci/deploy-surfaces.json"],
      "doc_paths": ["docs/ops/runbooks/DEPLOYMENTS.md"],
      "notes": "Workflow evidence contract declares the same-SHA artifact and manifest for this surface."
    },
    {
      "id": "ui-stg",
      "proof_scope": "same_sha_deploy_evidence",
      "surface_id": "ui",
      "surface_label": "Shared UI verify",
      "stage": "stg",
      "deploy_environment": "db-stg",
      "stage_workflow_file": "verify-ui.yml",
      "evidence_workflow_file": "verify-ui.yml",
      "workflow_name": "Verify UI (Stg)",
      "artifact_name": "stg-ui-verify-logs",
      "json_entry_suffix": "verify-ui-evidence-manifest.json",
      "evidence_status": "configured",
      "evidence_required": true,
      "proof_guard": "workflow-first same-SHA artifact",
      "source_paths": ["config/ci/deploy-evidence-contract.json", "config/ci/deploy-surfaces.json"],
      "doc_paths": ["docs/ops/runbooks/DEPLOYMENTS.md"],
      "notes": "Workflow evidence contract declares the same-SHA artifact and manifest for this surface."
    },
    {
      "id": "db-verify-stg",
      "proof_scope": "same_sha_deploy_evidence",
      "surface_id": "db_verify",
      "surface_label": "DB verify",
      "stage": "stg",
      "deploy_environment": "db-stg",
      "stage_workflow_file": "verify.yml",
      "evidence_workflow_file": "verify.yml",
      "workflow_name": "Verify (DB + Tests)",
      "artifact_name": "verify-core-logs",
      "json_entry_suffix": "verify-core-evidence-manifest.json",
      "evidence_status": "configured",
      "evidence_required": true,
      "proof_guard": "workflow-first same-SHA artifact",
      "source_paths": ["config/ci/deploy-evidence-contract.json", "config/ci/deploy-surfaces.json"],
      "doc_paths": ["docs/ops/runbooks/DEPLOYMENTS.md"],
      "notes": "Workflow evidence contract declares the same-SHA artifact and manifest for this surface."
    },
    {
      "id": "load-day1-profile-a",
      "proof_scope": "same_sha_deploy_evidence",
      "surface_id": "load_day1_profile_a",
      "surface_label": "Load profile A",
      "stage": "stg",
      "deploy_environment": "db-stg",
      "stage_workflow_file": "load.yml",
      "evidence_workflow_file": "load.yml",
      "workflow_name": "Weekly Load Test",
      "artifact_name": "load-summary",
      "json_entry_suffix": "load-evidence-manifest.json",
      "evidence_status": "configured",
      "evidence_required": true,
      "proof_guard": "workflow-first same-SHA artifact",
      "source_paths": ["config/ci/deploy-evidence-contract.json", "config/ci/deploy-surfaces.json"],
      "doc_paths": ["docs/ops/runbooks/DEPLOYMENTS.md"],
      "notes": "Workflow evidence contract declares the same-SHA artifact and manifest for this surface."
    },
    {
      "id": "load-day1-profile-b",
      "proof_scope": "same_sha_deploy_evidence",
      "surface_id": "load_day1_profile_b",
      "surface_label": "Load profile B",
      "stage": "stg",
      "deploy_environment": "db-stg",
      "stage_workflow_file": "load.yml",
      "evidence_workflow_file": "load.yml",
      "workflow_name": "Weekly Load Test",
      "artifact_name": "load-summary",
      "json_entry_suffix": "load-evidence-manifest.json",
      "evidence_status": "configured",
      "evidence_required": true,
      "proof_guard": "workflow-first same-SHA artifact",
      "source_paths": ["config/ci/deploy-evidence-contract.json", "config/ci/deploy-surfaces.json"],
      "doc_paths": ["docs/ops/runbooks/DEPLOYMENTS.md"],
      "notes": "Workflow evidence contract declares the same-SHA artifact and manifest for this surface."
    },
    {
      "id": "console-dev",
      "proof_scope": "same_sha_deploy_evidence",
      "surface_id": "console",
      "surface_label": "Console V2 (Vercel)",
      "stage": "dev",
      "deploy_environment": "console-dev",
      "stage_workflow_file": "deploy-console.yml",
      "evidence_workflow_file": "deploy-console.yml",
      "workflow_name": "Deploy Console",
      "artifact_name": "console-dev-deploy-evidence",
      "json_entry_suffix": "console-deploy-evidence-manifest.json",
      "evidence_status": "configured",
      "evidence_required": true,
      "proof_guard": "workflow-first same-SHA artifact",
      "source_paths": ["config/ci/deploy-evidence-contract.json", "config/ci/deploy-surfaces.json", ".github/workflows/deploy-console.yml", ".github/workflows/deploy-vercel-surface.yml"],
      "doc_paths": ["docs/ops/runbooks/DEPLOYMENTS.md"],
      "notes": "Console V2 deploy workflow emits the canonical same-SHA deploy evidence manifest for this stage."
    },
    {
      "id": "console-stg",
      "proof_scope": "same_sha_deploy_evidence",
      "surface_id": "console",
      "surface_label": "Console V2 (Vercel)",
      "stage": "stg",
      "deploy_environment": "console-stg",
      "stage_workflow_file": "deploy-console.yml",
      "evidence_workflow_file": "deploy-console.yml",
      "workflow_name": "Deploy Console",
      "artifact_name": "console-stg-deploy-evidence",
      "json_entry_suffix": "console-deploy-evidence-manifest.json",
      "evidence_status": "configured",
      "evidence_required": true,
      "proof_guard": "workflow-first same-SHA artifact",
      "source_paths": ["config/ci/deploy-evidence-contract.json", "config/ci/deploy-surfaces.json", ".github/workflows/deploy-console.yml", ".github/workflows/deploy-vercel-surface.yml"],
      "doc_paths": ["docs/ops/runbooks/DEPLOYMENTS.md"],
      "notes": "Console V2 deploy workflow emits the canonical same-SHA deploy evidence manifest for this stage."
    },
    {
      "id": "console-prod",
      "proof_scope": "same_sha_deploy_evidence",
      "surface_id": "console",
      "surface_label": "Console V2 (Vercel)",
      "stage": "prod",
      "deploy_environment": "console-prod",
      "stage_workflow_file": "deploy-console.yml",
      "evidence_workflow_file": "deploy-console.yml",
      "workflow_name": "Deploy Console",
      "artifact_name": "console-prod-deploy-evidence",
      "json_entry_suffix": "console-deploy-evidence-manifest.json",
      "evidence_status": "configured",
      "evidence_required": true,
      "proof_guard": "workflow-first same-SHA artifact",
      "source_paths": ["config/ci/deploy-evidence-contract.json", "config/ci/deploy-surfaces.json", ".github/workflows/deploy-console.yml", ".github/workflows/deploy-vercel-surface.yml"],
      "doc_paths": ["docs/ops/runbooks/DEPLOYMENTS.md"],
      "notes": "Console V2 deploy workflow emits the canonical same-SHA deploy evidence manifest for this stage."
    }
  ]
}
$json$::jsonb;
  v_settings_version_id UUID;
  v_existing_version INTEGER;
  v_existing_value JSONB;
BEGIN
  SELECT s.settings_version_id, sv.version, sv.value
    INTO v_settings_version_id, v_existing_version, v_existing_value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'release_deploy_proof_governance'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    INSERT INTO public.settings_versions (
      category,
      scope_type,
      scope_id,
      version,
      value,
      schema_version,
      change_reason,
      approved_at,
      effective_from
    )
    VALUES (
      'release_deploy_proof_governance',
      'global',
      NULL,
      1,
      v_payload,
      1,
      'Seed Console V2 release proof governance',
      now(),
      now()
    )
    RETURNING id INTO v_settings_version_id;

    INSERT INTO public.settings (
      category,
      scope_type,
      scope_id,
      settings_version_id,
      cached_value,
      last_updated
    )
    VALUES (
      'release_deploy_proof_governance',
      'global',
      NULL,
      v_settings_version_id,
      v_payload,
      now()
    );
  ELSIF v_payload IS DISTINCT FROM v_existing_value THEN
    UPDATE public.settings_versions
       SET value = v_payload,
           version = COALESCE(v_existing_version, 0) + 1,
           schema_version = 1,
           change_reason = 'Refresh Console V2 release proof governance',
           approved_at = now(),
           effective_from = now()
     WHERE id = v_settings_version_id;

    UPDATE public.settings
       SET cached_value = v_payload,
           last_updated = now()
     WHERE category = 'release_deploy_proof_governance'
       AND scope_type = 'global'
       AND scope_id IS NULL;
  END IF;
END $$;

CREATE OR REPLACE VIEW public.release_deploy_proof_governance_v1
WITH (security_invoker = true) AS
SELECT
  row_value->>'id' AS id,
  row_value->>'proof_scope' AS proof_scope,
  row_value->>'surface_id' AS surface_id,
  row_value->>'surface_label' AS surface_label,
  row_value->>'stage' AS stage,
  row_value->>'deploy_environment' AS deploy_environment,
  row_value->>'stage_workflow_file' AS stage_workflow_file,
  row_value->>'evidence_workflow_file' AS evidence_workflow_file,
  row_value->>'workflow_name' AS workflow_name,
  row_value->>'artifact_name' AS artifact_name,
  row_value->>'json_entry_suffix' AS json_entry_suffix,
  row_value->>'evidence_status' AS evidence_status,
  COALESCE((row_value->>'evidence_required')::boolean, FALSE) AS evidence_required,
  row_value->>'proof_guard' AS proof_guard,
  COALESCE(row_value->'source_paths', '[]'::jsonb) AS source_paths,
  COALESCE(row_value->'doc_paths', '[]'::jsonb) AS doc_paths,
  row_value->>'notes' AS notes
FROM jsonb_array_elements(
  COALESCE(
    public.resolve_settings_merged(
      'release_deploy_proof_governance',
      'global',
      NULL::uuid
    )->'rows',
    '[]'::jsonb
  )
) AS row_value;

COMMENT ON VIEW public.release_deploy_proof_governance_v1
  IS 'Read-only release / same-SHA deploy proof governance rows sourced from release_deploy_proof_governance settings.';

REVOKE ALL ON public.release_deploy_proof_governance_v1 FROM PUBLIC;
REVOKE ALL ON public.release_deploy_proof_governance_v1 FROM anon;
REVOKE ALL ON public.release_deploy_proof_governance_v1 FROM authenticated;
GRANT SELECT ON public.release_deploy_proof_governance_v1 TO service_role;

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB;
  v_resource JSONB := jsonb_build_object(
    'key', 'release_deploy_proof_governance',
    'label', 'Release proof governance',
    'relation', 'public.release_deploy_proof_governance_v1',
    'id_column', 'id',
    'allow_view_relation', TRUE,
    'capability_read', 'settings.read',
    'select', jsonb_build_array(
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
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'surface_id', 'column', 'surface_id', 'op', 'eq'),
      jsonb_build_object('key', 'stage', 'column', 'stage', 'op', 'eq'),
      jsonb_build_object('key', 'evidence_status', 'column', 'evidence_status', 'op', 'eq')
    ),
    'default_sort', jsonb_build_object('column', 'surface_id', 'direction', 'asc')
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
    INTO v_resources
    FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS item
   WHERE item->>'key' <> 'release_deploy_proof_governance';

  v_current := jsonb_set(
    v_current,
    '{resources}',
    COALESCE(v_resources, '[]'::jsonb) || jsonb_build_array(v_resource),
    true
  );

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Add release proof governance to ui_read_registry',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
     RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

DO $$
DECLARE
  v_current JSONB;
  v_base JSONB;
  v_sections JSONB := '[]'::jsonb;
  v_section JSONB;
  v_items JSONB;
  v_has_platform BOOLEAN := FALSE;
  v_new_item JSONB := jsonb_build_object(
    'id', 'platform-release-proof',
    'key', 'release-proof',
    'label', 'Release proof',
    'href', '/platform/release-proof',
    'route', '/platform/release-proof',
    'resource', 'release_deploy_proof_governance',
    'capability', 'settings.read'
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_navigation global settings missing';
  END IF;

  v_base := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);

  FOR v_section IN SELECT * FROM jsonb_array_elements(v_base) LOOP
    IF v_section->>'id' = 'platform' THEN
      v_has_platform := TRUE;
      SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
        INTO v_items
        FROM jsonb_array_elements(COALESCE(v_section->'items', '[]'::jsonb)) AS item
       WHERE COALESCE(item->>'id', item->>'key') NOT IN ('platform-release-proof', 'release-proof');
      v_section := jsonb_set(
        v_section,
        '{items}',
        COALESCE(v_items, '[]'::jsonb) || jsonb_build_array(v_new_item),
        true
      );
    END IF;
    v_sections := v_sections || jsonb_build_array(v_section);
  END LOOP;

  IF NOT v_has_platform THEN
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'platform',
        'label', 'Platform',
        'items', jsonb_build_array(v_new_item)
      )
    );
  END IF;

  v_current := jsonb_set(v_current, '{apps,console,sections}', v_sections, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Add release proof governance to ui_navigation',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
     RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202605032000_console_v2_release_proof_governance_v1'));
COMMIT;

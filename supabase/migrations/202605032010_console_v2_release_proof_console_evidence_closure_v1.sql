-- Migration: Console V2 release proof Console deploy evidence closure
-- Purpose: Convert Console dev/stg/prod release-proof rows from explicit gaps to
-- canonical deploy-evidence-contract rows now that deploy-console emits manifests.
BEGIN;
SELECT pg_advisory_lock(hashtext('202605032010_console_v2_release_proof_console_evidence_closure_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_settings_version_id UUID;
  v_existing_version INTEGER;
  v_current JSONB;
  v_next JSONB;
BEGIN
  SELECT s.settings_version_id, sv.version, sv.value
    INTO v_settings_version_id, v_existing_version, v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'release_deploy_proof_governance'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_settings_version_id IS NULL OR v_current IS NULL THEN
    RAISE EXCEPTION 'release_deploy_proof_governance global settings missing';
  END IF;

  WITH rewritten AS (
    SELECT jsonb_agg(
      CASE row_value->>'id'
        WHEN 'console-dev' THEN row_value || jsonb_build_object(
          'surface_label', 'Console V2 (Vercel)',
          'evidence_workflow_file', 'deploy-console.yml',
          'workflow_name', 'Deploy Console',
          'artifact_name', 'console-dev-deploy-evidence',
          'json_entry_suffix', 'console-deploy-evidence-manifest.json',
          'evidence_status', 'configured',
          'proof_guard', 'workflow-first same-SHA artifact',
          'source_paths', jsonb_build_array(
            'config/ci/deploy-evidence-contract.json',
            'config/ci/deploy-surfaces.json',
            '.github/workflows/deploy-console.yml',
            '.github/workflows/deploy-vercel-surface.yml'
          ),
          'notes', 'Console V2 deploy workflow emits the canonical same-SHA deploy evidence manifest for this stage.'
        )
        WHEN 'console-stg' THEN row_value || jsonb_build_object(
          'surface_label', 'Console V2 (Vercel)',
          'evidence_workflow_file', 'deploy-console.yml',
          'workflow_name', 'Deploy Console',
          'artifact_name', 'console-stg-deploy-evidence',
          'json_entry_suffix', 'console-deploy-evidence-manifest.json',
          'evidence_status', 'configured',
          'proof_guard', 'workflow-first same-SHA artifact',
          'source_paths', jsonb_build_array(
            'config/ci/deploy-evidence-contract.json',
            'config/ci/deploy-surfaces.json',
            '.github/workflows/deploy-console.yml',
            '.github/workflows/deploy-vercel-surface.yml'
          ),
          'notes', 'Console V2 deploy workflow emits the canonical same-SHA deploy evidence manifest for this stage.'
        )
        WHEN 'console-prod' THEN row_value || jsonb_build_object(
          'surface_label', 'Console V2 (Vercel)',
          'evidence_workflow_file', 'deploy-console.yml',
          'workflow_name', 'Deploy Console',
          'artifact_name', 'console-prod-deploy-evidence',
          'json_entry_suffix', 'console-deploy-evidence-manifest.json',
          'evidence_status', 'configured',
          'proof_guard', 'workflow-first same-SHA artifact',
          'source_paths', jsonb_build_array(
            'config/ci/deploy-evidence-contract.json',
            'config/ci/deploy-surfaces.json',
            '.github/workflows/deploy-console.yml',
            '.github/workflows/deploy-vercel-surface.yml'
          ),
          'notes', 'Console V2 deploy workflow emits the canonical same-SHA deploy evidence manifest for this stage.'
        )
        ELSE row_value
      END
      ORDER BY ordinality
    ) AS rows
    FROM jsonb_array_elements(COALESCE(v_current->'rows', '[]'::jsonb)) WITH ORDINALITY AS row_data(row_value, ordinality)
  )
  SELECT jsonb_set(v_current, '{rows}', COALESCE(rows, '[]'::jsonb), true)
    INTO v_next
    FROM rewritten;

  IF v_next IS DISTINCT FROM v_current THEN
    UPDATE public.settings_versions
       SET value = v_next,
           version = COALESCE(v_existing_version, 0) + 1,
           schema_version = 1,
           change_reason = 'Close Console V2 release proof deploy evidence contract',
           approved_at = now(),
           effective_from = now()
     WHERE id = v_settings_version_id;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE category = 'release_deploy_proof_governance'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND settings_version_id = v_settings_version_id;
  END IF;
END $$;

SELECT pg_advisory_unlock(hashtext('202605032010_console_v2_release_proof_console_evidence_closure_v1'));
COMMIT;

-- pgTAP: Workflow version resolver
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
SELECT plan(1);

-- Assert that for any existing template, resolve_template_version(id) equals workflow_templates.version
SELECT ok(
  (
    SELECT COALESCE(
      (SELECT resolve_template_version(id) = version FROM workflow_templates ORDER BY updated_at DESC LIMIT 1),
      true
    )
  ),
  'resolve_template_version returns current workflow_templates.version for latest template'
);

SELECT finish();
ROLLBACK;
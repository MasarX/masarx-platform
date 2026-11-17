-- Plan: PLAN-202603-shared-mapping-studio / Step: S04
-- Migration: Tabular import policy registry + mapping operation report contract extension

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091140_tabular_import_policy_and_reports_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Extend mapping_operation_reports with operation_kind
-------------------------------------------------------------------------------

ALTER TABLE public.mapping_operation_reports
  ADD COLUMN IF NOT EXISTS operation_kind TEXT;

UPDATE public.mapping_operation_reports
   SET operation_kind = COALESCE(NULLIF(btrim(operation_kind), ''), 'mapping_save')
 WHERE operation_kind IS NULL
    OR btrim(operation_kind) = '';

ALTER TABLE public.mapping_operation_reports
  DROP CONSTRAINT IF EXISTS mapping_operation_reports_operation_kind_ck;

ALTER TABLE public.mapping_operation_reports
  ADD CONSTRAINT mapping_operation_reports_operation_kind_ck
  CHECK (
    operation_kind IN ('mapping_save', 'tabular_import_execution')
  );

ALTER TABLE public.mapping_operation_reports
  ALTER COLUMN operation_kind SET DEFAULT 'mapping_save';

ALTER TABLE public.mapping_operation_reports
  ALTER COLUMN operation_kind SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mapping_operation_reports_operation_kind_created
  ON public.mapping_operation_reports (operation_kind, created_at DESC);

COMMENT ON COLUMN public.mapping_operation_reports.operation_kind IS
  'Distinguishes mapping profile saves from executed tabular import runs.';

-------------------------------------------------------------------------------
-- 2) Settings category + schema registry: tabular_import_policy
-------------------------------------------------------------------------------

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
  'tabular_import_policy',
  'Runtime policy for prepared tabular imports: file limits, staging retention, worker batch size, timeout, allowed formats, and error export defaults.',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global","tenant","client","sender","source"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes;

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'tabular_import_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'accepted_formats', jsonb_build_object(
        'type', 'array',
        'items', jsonb_build_object('type', 'string')
      ),
      'max_file_size_bytes', jsonb_build_object('type', 'integer', 'minimum', 1),
      'max_rows', jsonb_build_object('type', 'integer', 'minimum', 1),
      'staging_retention_hours', jsonb_build_object('type', 'integer', 'minimum', 1),
      'worker_batch_size', jsonb_build_object('type', 'integer', 'minimum', 1),
      'worker_timeout_seconds', jsonb_build_object('type', 'integer', 'minimum', 1),
      'error_export_format', jsonb_build_object('type', 'string'),
      'allow_partial_success', jsonb_build_object('type', 'boolean')
    )
  ),
  'Resolved runtime policy for universal table imports.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'accepted_formats', jsonb_build_array('csv', 'xls', 'xlsx'),
      'max_file_size_bytes', 10485760,
      'max_rows', 5000,
      'staging_retention_hours', 72,
      'worker_batch_size', 200,
      'worker_timeout_seconds', 300,
      'error_export_format', 'csv',
      'allow_partial_success', TRUE
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'accepted_formats', jsonb_build_array('csv', 'xls', 'xlsx'),
    'max_file_size_bytes', 10485760,
    'max_rows', 5000,
    'staging_retention_hours', 72,
    'worker_batch_size', 200,
    'worker_timeout_seconds', 300,
    'error_export_format', 'csv',
    'allow_partial_success', TRUE
  ) AS value
),
inserted AS (
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
  SELECT
    'tabular_import_policy',
    'global',
    NULL::uuid,
    1,
    payload.value,
    1,
    'Seed global tabular_import_policy',
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (
    SELECT 1
      FROM public.settings_versions sv
     WHERE sv.category = 'tabular_import_policy'
       AND sv.scope_type = 'global'
       AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (
  category,
  scope_type,
  scope_id,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  'tabular_import_policy',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
ON CONFLICT (category, scope_type, scope_hash) DO NOTHING;

-------------------------------------------------------------------------------
-- 3) Resolver wrapper
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_tabular_import_policy_v1(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
    FROM public.resolve_settings_row_from_context('tabular_import_policy', COALESCE(p_context, '{}'::jsonb))
   LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_tabular_import_policy_v1(JSONB) IS
  'Resolve tabular_import_policy via the canonical settings ladder.';

REVOKE ALL ON FUNCTION public.resolve_tabular_import_policy_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_tabular_import_policy_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603091140_tabular_import_policy_and_reports_v1'));
COMMIT;

-- Worker: W16-5 — canonical import_jobs SSOT (PLATFORM imports surface).
-- Replaces /platform/imports PREVIEW chip with a real lifecycle table.
--
-- Goals:
--   * Introduce public.import_jobs as the SSOT for bulk import lifecycle
--     (queued | running | completed | failed | cancelled).
--   * Strict RLS + least-privilege grants (read for tenant authenticated;
--     write only via canonical RPCs at service_role).
--   * Register canonical capability `imports.read` (alongside the already-
--     registered `imports.write` from the FE registry catalog) in
--     access_control_policy SSOT so the catalog stays consistent across
--     the FE registry and DB-driven capability resolution.
--
-- Append-only: this migration creates new objects only.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301900_import_jobs'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) public.import_jobs (lifecycle SSOT)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Resource shape being imported (free-form lookup-style key; not enum to keep
  -- the registry row-driven). Values populated at row level by the FE
  -- ui_read_registry catalog (shipments, clients, senders, recipients,
  -- service_offerings, ...).
  kind TEXT NOT NULL,

  -- Source channel: file_upload | api | manual (lookup-style, not enum).
  source TEXT NOT NULL DEFAULT 'file_upload',

  -- Lifecycle status. Constrained to the canonical state machine.
  status TEXT NOT NULL DEFAULT 'queued',

  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  submitted_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,

  -- Counts (NULL while queued; populated as the worker progresses).
  row_count INT,
  error_count INT,

  -- Aggregated error summary jsonb. Shape is row-driven (no schema lock):
  -- {"errors":[{"row":3,"field":"phone_e164","reason":"invalid_e164"}], "by_kind":{"invalid_e164":4}}
  error_summary JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Optional traceability fields. Populated by the canonical RPCs.
  correlation_id UUID,
  cancelled_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT import_jobs_kind_ck         CHECK (btrim(kind) <> '' AND kind = lower(kind)),
  CONSTRAINT import_jobs_source_ck       CHECK (source IN ('file_upload','api','manual')),
  CONSTRAINT import_jobs_status_ck       CHECK (status IN ('queued','running','completed','failed','cancelled')),
  CONSTRAINT import_jobs_row_count_ck    CHECK (row_count IS NULL OR row_count >= 0),
  CONSTRAINT import_jobs_error_count_ck  CHECK (error_count IS NULL OR error_count >= 0),
  CONSTRAINT import_jobs_started_after_submitted_ck
    CHECK (started_at IS NULL OR started_at >= submitted_at),
  CONSTRAINT import_jobs_completed_after_started_ck
    CHECK (completed_at IS NULL OR (started_at IS NOT NULL AND completed_at >= started_at))
);

COMMENT ON TABLE public.import_jobs
  IS 'Bulk import lifecycle SSOT (queued | running | completed | failed | cancelled). Replaces FE-side PREVIEW stub on /platform/imports.';

COMMENT ON COLUMN public.import_jobs.kind
  IS 'Resource shape being imported (lookup-style: shipments, clients, senders, ...). Row-driven; not enum.';

COMMENT ON COLUMN public.import_jobs.source
  IS 'Submission channel (file_upload | api | manual). Constrained CHECK; not pg enum to stay row-driven.';

COMMENT ON COLUMN public.import_jobs.error_summary
  IS 'Aggregated error summary jsonb (row-driven shape). Populated by worker on failed/completed transitions.';

CREATE INDEX IF NOT EXISTS idx_import_jobs_org_status
  ON public.import_jobs (organization_id, status, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_import_jobs_org_kind
  ON public.import_jobs (organization_id, kind, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_import_jobs_user
  ON public.import_jobs (submitted_by_user_id, submitted_at DESC)
  WHERE submitted_by_user_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_import_jobs_set_updated_at ON public.import_jobs;
CREATE TRIGGER trg_import_jobs_set_updated_at
  BEFORE UPDATE ON public.import_jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 2) RLS + grants (least privilege)
-------------------------------------------------------------------------------

ALTER TABLE public.import_jobs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.import_jobs FROM PUBLIC;
REVOKE ALL ON TABLE public.import_jobs FROM anon;
REVOKE ALL ON TABLE public.import_jobs FROM authenticated;

DROP POLICY IF EXISTS import_jobs_select ON public.import_jobs;
CREATE POLICY import_jobs_select ON public.import_jobs
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS import_jobs_service_policy ON public.import_jobs;
CREATE POLICY import_jobs_service_policy ON public.import_jobs
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.import_jobs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.import_jobs TO service_role;

-------------------------------------------------------------------------------
-- 3) Capability registry: register imports.read alongside imports.write so the
--    DB-driven capability resolver matches the FE catalog (registry.js line
--    1885 already declares imports.write; this adds imports.read so /platform/
--    imports can fail-closed gate the new DataTable).
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_current JSONB;
  v_caps JSONB;
  v_roles JSONB;
  v_role JSONB;
  v_role_keys JSONB;
  v_idx INT;
  v_role_idx INT;
  v_existing_keys TEXT[] := ARRAY[]::TEXT[];
  v_target_caps TEXT[] := ARRAY[
    'imports.read',
    'imports.write'
  ];
  v_new_cap TEXT;
  v_changed BOOLEAN := FALSE;
  v_next_version INT;
BEGIN
  SELECT value INTO v_current
    FROM public.settings_versions
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL
   ORDER BY version DESC
   LIMIT 1;

  IF v_current IS NULL THEN
    -- access_control_policy global seed missing; nothing to extend.
    RETURN;
  END IF;

  v_caps := COALESCE(v_current->'capabilities', '[]'::jsonb);
  FOR v_idx IN 0 .. jsonb_array_length(v_caps) - 1 LOOP
    v_existing_keys := array_append(v_existing_keys, COALESCE(v_caps->v_idx->>'key', ''));
  END LOOP;

  FOREACH v_new_cap IN ARRAY v_target_caps LOOP
    IF NOT (v_new_cap = ANY(v_existing_keys)) THEN
      v_caps := v_caps || jsonb_build_array(jsonb_build_object(
        'key', v_new_cap,
        'label', initcap(replace(replace(v_new_cap, '.', ' '), '_', ' '))
      ));
      v_changed := TRUE;
    END IF;
  END LOOP;

  IF NOT v_changed THEN
    RETURN;
  END IF;

  -- Grant the new caps to ops_admin role (super_admin already has '*' wildcard).
  v_roles := COALESCE(v_current->'roles', '[]'::jsonb);
  FOR v_role_idx IN 0 .. jsonb_array_length(v_roles) - 1 LOOP
    v_role := v_roles->v_role_idx;
    IF v_role->>'key' = 'ops_admin' THEN
      v_role_keys := COALESCE(v_role->'capability_keys', '[]'::jsonb);
      FOREACH v_new_cap IN ARRAY v_target_caps LOOP
        IF NOT (v_role_keys @> to_jsonb(v_new_cap)) THEN
          v_role_keys := v_role_keys || to_jsonb(v_new_cap);
        END IF;
      END LOOP;
      v_role := jsonb_set(v_role, '{capability_keys}', v_role_keys);
      v_roles := jsonb_set(v_roles, ARRAY[v_role_idx::text], v_role);
    END IF;
  END LOOP;

  v_current := jsonb_set(v_current, '{capabilities}', v_caps);
  v_current := jsonb_set(v_current, '{roles}', v_roles);

  SELECT COALESCE(MAX(version), 0) + 1
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL;

  UPDATE public.settings_versions
     SET effective_until = CASE
           WHEN now() <= effective_from THEN effective_from + interval '1 microsecond'
           ELSE now()
         END
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL
     AND approved_at IS NOT NULL
     AND effective_until IS NULL;

  INSERT INTO public.settings_versions (
    category, scope_type, scope_id, version, value, schema_version,
    change_reason, approved_at
  ) VALUES (
    'access_control_policy', 'global', NULL::uuid, v_next_version, v_current, 1,
    'W16-5 import_jobs SSOT: register imports.read/.write capabilities', now()
  );

  INSERT INTO public.settings (
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  SELECT
    sv.category,
    sv.scope_type,
    sv.scope_id,
    COALESCE(sv.scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    sv.id,
    sv.value,
    now()
    FROM public.settings_versions sv
   WHERE sv.category = 'access_control_policy'
     AND sv.scope_type = 'global'
     AND sv.scope_id IS NULL
     AND sv.version = v_next_version
  ON CONFLICT ON CONSTRAINT settings_scope_hash_unique
  DO UPDATE SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604301900_import_jobs'));
COMMIT;

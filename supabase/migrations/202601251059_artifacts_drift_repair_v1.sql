-- Plan: PLAN-202602-frontend-workflow-prod-ready-finalize / Step: S04
-- Migration: Drift repair for public.artifacts + public.artifact_links (env.cloud)
-- Date: 2026-01-25
--
-- Problem:
--   - Downstream migrations expect public.artifacts to exist (e.g. scan_events_v1),
--     but env.cloud schema drift can leave the table missing while schema_migrations
--     indicates the canonical migration has already been applied.
--
-- Approach:
--   - Idempotently (re)create the canonical objects if missing.
--   - Keep SSOT + RLS + grants aligned to the canonical baseline.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601251059_artifacts_drift_repair_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Evidence artifacts: public.artifacts + public.artifact_links
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  storage_bucket TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  sha256 TEXT,
  created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  source_system TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT artifacts_bucket_nonempty CHECK (btrim(storage_bucket) <> ''),
  CONSTRAINT artifacts_key_nonempty CHECK (btrim(storage_key) <> ''),
  CONSTRAINT artifacts_size_bytes_ck CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CONSTRAINT artifacts_unique_storage UNIQUE (organization_id, storage_bucket, storage_key)
);

COMMENT ON TABLE public.artifacts IS
  'Canonical artifact registry (SSOT) for evidence file references (storage bucket/key) and metadata.';

CREATE INDEX IF NOT EXISTS idx_artifacts_org_created_at
  ON public.artifacts (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_org_storage
  ON public.artifacts (organization_id, storage_bucket, storage_key);

ALTER TABLE public.artifacts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.artifacts FROM PUBLIC;
REVOKE ALL ON TABLE public.artifacts FROM anon;
REVOKE ALL ON TABLE public.artifacts FROM authenticated;

DROP POLICY IF EXISTS artifacts_select ON public.artifacts;
CREATE POLICY artifacts_select ON public.artifacts
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR organization_id = public.current_user_org_id()
  );

DROP POLICY IF EXISTS artifacts_service_policy ON public.artifacts;
CREATE POLICY artifacts_service_policy ON public.artifacts
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.artifacts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.artifacts TO service_role;

DROP TRIGGER IF EXISTS trg_artifacts_set_updated_at ON public.artifacts;
CREATE TRIGGER trg_artifacts_set_updated_at
  BEFORE UPDATE ON public.artifacts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.artifact_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  artifact_id UUID NOT NULL REFERENCES public.artifacts(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  resource_id UUID NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'evidence',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT artifact_links_resource_type_ck CHECK (
    btrim(resource_type) <> '' AND resource_type = lower(resource_type)
  ),
  CONSTRAINT artifact_links_relation_type_ck CHECK (
    btrim(relation_type) <> '' AND relation_type = lower(relation_type)
  ),
  CONSTRAINT artifact_links_unique UNIQUE (
    organization_id, artifact_id, resource_type, resource_id, relation_type
  )
);

COMMENT ON TABLE public.artifact_links IS
  'Generic artifact link model: attach artifacts to domain resources (shipments, tasks, settlement batches, shipment_actions, etc.).';

CREATE INDEX IF NOT EXISTS idx_artifact_links_org_resource
  ON public.artifact_links (organization_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_artifact_links_org_artifact
  ON public.artifact_links (organization_id, artifact_id, relation_type);

ALTER TABLE public.artifact_links ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.artifact_links FROM PUBLIC;
REVOKE ALL ON TABLE public.artifact_links FROM anon;
REVOKE ALL ON TABLE public.artifact_links FROM authenticated;

DROP POLICY IF EXISTS artifact_links_select ON public.artifact_links;
CREATE POLICY artifact_links_select ON public.artifact_links
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR organization_id = public.current_user_org_id()
  );

DROP POLICY IF EXISTS artifact_links_service_policy ON public.artifact_links;
CREATE POLICY artifact_links_service_policy ON public.artifact_links
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.artifact_links TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.artifact_links TO service_role;

DROP TRIGGER IF EXISTS trg_artifact_links_set_updated_at ON public.artifact_links;
CREATE TRIGGER trg_artifact_links_set_updated_at
  BEFORE UPDATE ON public.artifact_links
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 2) Service-only RPC: public.register_artifact_v1(jsonb)
--    Idempotent by (organization_id, storage_bucket, storage_key)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.register_artifact_v1(
  p_artifact JSONB
)
RETURNS TABLE (
  artifact_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_a JSONB := COALESCE(p_artifact, '{}'::jsonb);
  v_id UUID := gen_random_uuid();
  v_created BOOLEAN := TRUE;

  v_org UUID := NULL;
  v_bucket TEXT := NULL;
  v_key TEXT := NULL;
  v_mime TEXT := NULL;
  v_sha TEXT := NULL;
  v_size BIGINT := NULL;
  v_user UUID := NULL;
  v_source TEXT := NULL;
  v_meta JSONB := '{}'::jsonb;
BEGIN
  IF jsonb_typeof(v_a) <> 'object' THEN
    RAISE EXCEPTION 'register_artifact_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_org := NULLIF(v_a->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org := NULL; END;
  v_bucket := NULLIF(btrim(COALESCE(v_a->>'storage_bucket', '')), '');
  v_key := NULLIF(btrim(COALESCE(v_a->>'storage_key', '')), '');
  v_mime := NULLIF(btrim(COALESCE(v_a->>'mime_type', '')), '');
  v_sha := NULLIF(btrim(COALESCE(v_a->>'sha256', '')), '');
  BEGIN v_size := NULLIF(v_a->>'size_bytes', '')::bigint; EXCEPTION WHEN others THEN v_size := NULL; END;
  BEGIN v_user := NULLIF(v_a->>'created_by_user_id', '')::uuid; EXCEPTION WHEN others THEN v_user := NULL; END;
  v_source := NULLIF(btrim(COALESCE(v_a->>'source_system', '')), '');

  v_meta := COALESCE(v_a->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_meta) <> 'object' THEN
    v_meta := '{}'::jsonb;
  END IF;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'register_artifact_v1 missing organization_id' USING ERRCODE = '23514';
  END IF;
  IF v_bucket IS NULL THEN
    RAISE EXCEPTION 'register_artifact_v1 missing storage_bucket' USING ERRCODE = '23514';
  END IF;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'register_artifact_v1 missing storage_key' USING ERRCODE = '23514';
  END IF;
  IF v_size IS NOT NULL AND v_size < 0 THEN
    RAISE EXCEPTION 'register_artifact_v1 invalid size_bytes' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.artifacts(
    id, organization_id,
    storage_bucket, storage_key,
    mime_type, size_bytes, sha256,
    created_by_user_id, source_system, metadata,
    created_at, updated_at
  ) VALUES (
    v_id, v_org,
    v_bucket, v_key,
    v_mime, v_size, v_sha,
    v_user, v_source, v_meta,
    now(), now()
  )
  ON CONFLICT (organization_id, storage_bucket, storage_key) DO NOTHING;

  IF FOUND THEN
    RETURN QUERY SELECT v_id, TRUE;
    RETURN;
  END IF;

  UPDATE public.artifacts a
     SET mime_type = COALESCE(v_mime, a.mime_type),
         size_bytes = COALESCE(v_size, a.size_bytes),
         sha256 = COALESCE(v_sha, a.sha256),
         created_by_user_id = COALESCE(v_user, a.created_by_user_id),
         source_system = COALESCE(v_source, a.source_system),
         metadata = a.metadata || v_meta,
         updated_at = now()
   WHERE a.organization_id = v_org
     AND a.storage_bucket = v_bucket
     AND a.storage_key = v_key
  RETURNING a.id INTO v_id;

  v_created := FALSE;
  RETURN QUERY SELECT v_id, v_created;
END;
$function$;

COMMENT ON FUNCTION public.register_artifact_v1(JSONB) IS
  'Service write-path: register/update an artifact record (idempotent by organization_id + storage_bucket + storage_key).';

REVOKE ALL ON FUNCTION public.register_artifact_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_artifact_v1(JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202601251059_artifacts_drift_repair_v1'));
COMMIT;

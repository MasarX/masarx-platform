-- Plan: Console V2 fleet vehicle live-path closure
-- Step: vehicle create, vehicle document upload, and telemetry projection.
--
-- Scope:
--   - Add a canonical vehicle_documents registry with artifact linkage.
--   - Add create_vehicle_v1 and upload_vehicle_document_v1 write RPCs.
--   - Expose matching api-schema wrappers for Console V2 browser clients.
--   - Extend v_vehicle_directory with telemetry fields consumed by Console V2.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605041630_console_v2_vehicle_live_paths_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('vehicle_document_kind', 'Vehicle document taxonomy for registration, insurance, inspection, permits, and related fleet evidence.', 'fleet', 'tier_1', TRUE),
  ('vehicle_document_status', 'Vehicle document review lifecycle for submitted, verified, rejected, and expired rows.', 'fleet', 'tier_1', TRUE)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    updated_at = now();

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('registration', 'Registration', 10, TRUE,  '{"tone":"info"}'),
  ('insurance',    'Insurance',    20, FALSE, '{"tone":"good"}'),
  ('inspection',   'Inspection',   30, FALSE, '{"tone":"warn"}'),
  ('permit',       'Permit',       40, FALSE, '{"tone":"neutral"}'),
  ('other',        'Other',        50, FALSE, '{"tone":"neutral"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'vehicle_document_kind'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    metadata = EXCLUDED.metadata,
    updated_at = now();

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('submitted', 'Submitted', 10, TRUE,  '{"tone":"info"}'),
  ('verified',  'Verified',  20, FALSE, '{"tone":"good"}'),
  ('rejected',  'Rejected',  30, FALSE, '{"tone":"danger"}'),
  ('expired',   'Expired',   40, FALSE, '{"tone":"warn"}')
) AS v(value, label, sort_order, is_default, metadata)
WHERE ld.category = 'vehicle_document_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    metadata = EXCLUDED.metadata,
    updated_at = now();

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  FALSE,
  'active',
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  (
    'fleet.vehicle_created',
    'Fleet Vehicle Created',
    'Vehicle asset creation decisions',
    790,
    '{"domain":"fleet","resource_type":"vehicle","operation":"create"}'
  ),
  (
    'fleet.vehicle_document_uploaded',
    'Fleet Vehicle Document Uploaded',
    'Vehicle document upload decisions',
    800,
    '{"domain":"fleet","resource_type":"vehicle_document","operation":"upload"}'
  )
) AS v(value, label, description, sort_order, metadata)
WHERE ld.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    retired_at = NULL,
    metadata = EXCLUDED.metadata,
    updated_at = now();

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  FALSE,
  'active',
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  (
    'created',
    'Created',
    'Resource created',
    670,
    '{"domain":"fleet"}'
  ),
  (
    'submitted',
    'Submitted',
    'Resource submitted',
    680,
    '{"domain":"fleet"}'
  )
) AS v(value, label, description, sort_order, metadata)
WHERE ld.category = 'decision_outcome'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    retired_at = NULL,
    metadata = EXCLUDED.metadata,
    updated_at = now();

CREATE TABLE IF NOT EXISTS public.vehicle_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vehicle_id UUID NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,

  doc_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  issuer TEXT,
  document_ref_hash TEXT,
  issued_at DATE,
  expires_at DATE,

  artifact_id UUID REFERENCES public.artifacts(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  verified_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT vehicle_documents_doc_type_ck CHECK (btrim(doc_type) <> '' AND doc_type = lower(doc_type)),
  CONSTRAINT vehicle_documents_status_ck CHECK (btrim(status) <> '' AND status = lower(status)),
  CONSTRAINT vehicle_documents_issuer_ck CHECK (issuer IS NULL OR btrim(issuer) <> ''),
  CONSTRAINT vehicle_documents_ref_hash_ck CHECK (document_ref_hash IS NULL OR btrim(document_ref_hash) <> ''),
  CONSTRAINT vehicle_documents_expires_after_issued_ck CHECK (issued_at IS NULL OR expires_at IS NULL OR expires_at >= issued_at)
);

COMMENT ON TABLE public.vehicle_documents
  IS 'Vehicle document registry with evidence via artifacts. Fleet write paths use upload_vehicle_document_v1; reads are registry-scoped through ui_read_registry.';

CREATE INDEX IF NOT EXISTS idx_vehicle_documents_org_vehicle_type
  ON public.vehicle_documents (organization_id, vehicle_id, doc_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vehicle_documents_org_status_created
  ON public.vehicle_documents (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vehicle_documents_org_expires
  ON public.vehicle_documents (organization_id, expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vehicle_documents_artifact_id
  ON public.vehicle_documents (artifact_id)
  WHERE artifact_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_vehicle_documents_set_updated_at ON public.vehicle_documents;
CREATE TRIGGER trg_vehicle_documents_set_updated_at
  BEFORE UPDATE ON public.vehicle_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.vehicle_documents_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_vehicle_org UUID;
  v_artifact_org UUID;
  v_verified_org UUID;
BEGIN
  SELECT v.organization_id
    INTO v_vehicle_org
    FROM public.vehicles v
   WHERE v.id = NEW.vehicle_id;

  IF v_vehicle_org IS NULL THEN
    RAISE EXCEPTION 'vehicle_documents: vehicle % not found', NEW.vehicle_id
      USING ERRCODE = '23503';
  END IF;

  IF v_vehicle_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'vehicle_documents: organization mismatch (doc org %, vehicle org %)', NEW.organization_id, v_vehicle_org
      USING ERRCODE = '23514';
  END IF;

  IF NEW.artifact_id IS NOT NULL THEN
    SELECT a.organization_id
      INTO v_artifact_org
      FROM public.artifacts a
     WHERE a.id = NEW.artifact_id;

    IF v_artifact_org IS NULL THEN
      RAISE EXCEPTION 'vehicle_documents: artifact % not found', NEW.artifact_id
        USING ERRCODE = '23503';
    END IF;

    IF v_artifact_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'vehicle_documents: organization mismatch (doc org %, artifact org %)', NEW.organization_id, v_artifact_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.verified_by_user_id IS NOT NULL THEN
    SELECT u.organization_id
      INTO v_verified_org
      FROM public.users u
     WHERE u.id = NEW.verified_by_user_id;

    IF v_verified_org IS NULL THEN
      RAISE EXCEPTION 'vehicle_documents: verified_by_user % not found', NEW.verified_by_user_id
        USING ERRCODE = '23503';
    END IF;

    IF v_verified_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'vehicle_documents: organization mismatch (doc org %, verified_by org %)', NEW.organization_id, v_verified_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_vehicle_documents_enforce_org_match ON public.vehicle_documents;
CREATE TRIGGER trg_vehicle_documents_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.vehicle_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.vehicle_documents_enforce_org_match_v1();

ALTER TABLE public.vehicle_documents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vehicle_documents FROM PUBLIC;
REVOKE ALL ON TABLE public.vehicle_documents FROM anon;
REVOKE ALL ON TABLE public.vehicle_documents FROM authenticated;

DROP POLICY IF EXISTS vehicle_documents_service_policy ON public.vehicle_documents;
CREATE POLICY vehicle_documents_service_policy ON public.vehicle_documents
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS vehicle_documents_select_policy ON public.vehicle_documents;
CREATE POLICY vehicle_documents_select_policy ON public.vehicle_documents
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
      AND public.user_has_permission_v1('fleet.read', organization_id)
    )
  );

DROP POLICY IF EXISTS vehicle_documents_write_policy ON public.vehicle_documents;
CREATE POLICY vehicle_documents_write_policy ON public.vehicle_documents
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_permission_v1('fleet.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_permission_v1('fleet.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.vehicle_documents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vehicle_documents TO service_role;

INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  created_at_source_column,
  updated_at_required,
  updated_at_source_column,
  audit_enabled,
  notes
)
VALUES (
  'public',
  'vehicle_documents',
  TRUE,
  NULL,
  TRUE,
  NULL,
  TRUE,
  'Vehicle document registry with artifact-backed evidence.'
)
ON CONFLICT (table_schema, table_name) DO UPDATE
SET created_at_required = EXCLUDED.created_at_required,
    created_at_source_column = EXCLUDED.created_at_source_column,
    updated_at_required = EXCLUDED.updated_at_required,
    updated_at_source_column = EXCLUDED.updated_at_source_column,
    audit_enabled = EXCLUDED.audit_enabled,
    notes = EXCLUDED.notes,
    updated_at = now();

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

CREATE OR REPLACE FUNCTION public.create_vehicle_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();
  v_payload_org_id UUID;

  v_plate_number TEXT;
  v_vehicle_type_id UUID;
  v_branch_id UUID;
  v_status TEXT;
  v_vin TEXT;
  v_make TEXT;
  v_model TEXT;
  v_model_year INT;
  v_color TEXT;
  v_acquired_at TIMESTAMPTZ;
  v_metadata JSONB;

  v_vehicle_type public.vehicle_types%ROWTYPE;
  v_branch public.branches%ROWTYPE;
  v_vehicle_id UUID;
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'create_vehicle_v1: p_args must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'create_vehicle_v1: authenticated tenant user required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  v_payload_org_id := NULLIF(btrim(COALESCE(p_args->>'organization_id', '')), '')::UUID;
  v_plate_number := NULLIF(btrim(COALESCE(p_args->>'plate_number', p_args->>'plate', '')), '');
  v_vehicle_type_id := NULLIF(btrim(COALESCE(p_args->>'vehicle_type_id', p_args->>'type_id', '')), '')::UUID;
  v_branch_id := NULLIF(btrim(COALESCE(p_args->>'branch_id', p_args->>'current_branch_id', '')), '')::UUID;
  v_status := lower(NULLIF(btrim(COALESCE(p_args->>'status', '')), ''));
  v_vin := NULLIF(btrim(COALESCE(p_args->>'vin', '')), '');
  v_make := NULLIF(btrim(COALESCE(p_args->>'make', '')), '');
  v_model := NULLIF(btrim(COALESCE(p_args->>'model', '')), '');
  v_color := NULLIF(btrim(COALESCE(p_args->>'color', '')), '');
  v_acquired_at := NULLIF(btrim(COALESCE(p_args->>'acquired_at', '')), '')::TIMESTAMPTZ;
  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);

  BEGIN
    v_model_year := NULLIF(btrim(COALESCE(p_args->>'model_year', '')), '')::INT;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'create_vehicle_v1: model_year must be an integer when provided' USING ERRCODE = '22023';
  END;

  IF v_payload_org_id IS NOT NULL AND v_payload_org_id <> v_org_id THEN
    RAISE EXCEPTION 'create_vehicle_v1: organization_id belongs to another organization' USING ERRCODE = '42501';
  END IF;
  IF v_plate_number IS NULL THEN
    RAISE EXCEPTION 'create_vehicle_v1: plate_number is required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_metadata) <> 'object' THEN
    RAISE EXCEPTION 'create_vehicle_v1: metadata must be a JSON object' USING ERRCODE = '22023';
  END IF;

  IF v_status IS NULL THEN
    SELECT lv.value
      INTO v_status
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'vehicle_status'
       AND lv.is_default IS TRUE
     ORDER BY lv.sort_order, lv.value
     LIMIT 1;
  END IF;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'create_vehicle_v1: no default vehicle_status lookup row is configured' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'vehicle_status'
       AND lv.value = v_status
  ) THEN
    RAISE EXCEPTION 'create_vehicle_v1: status % not in lookup vehicle_status', v_status USING ERRCODE = '22023';
  END IF;

  IF v_vehicle_type_id IS NOT NULL THEN
    SELECT *
      INTO v_vehicle_type
      FROM public.vehicle_types
     WHERE id = v_vehicle_type_id
     LIMIT 1;
    IF v_vehicle_type.id IS NULL THEN
      RAISE EXCEPTION 'create_vehicle_v1: vehicle_type % not found', v_vehicle_type_id USING ERRCODE = 'P0002';
    END IF;
    IF v_vehicle_type.organization_id <> v_org_id THEN
      RAISE EXCEPTION 'create_vehicle_v1: vehicle_type % belongs to another organization', v_vehicle_type_id USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_branch_id IS NOT NULL THEN
    SELECT *
      INTO v_branch
      FROM public.branches
     WHERE id = v_branch_id
     LIMIT 1;
    IF v_branch.id IS NULL THEN
      RAISE EXCEPTION 'create_vehicle_v1: branch % not found', v_branch_id USING ERRCODE = 'P0002';
    END IF;
    IF v_branch.organization_id <> v_org_id THEN
      RAISE EXCEPTION 'create_vehicle_v1: branch % belongs to another organization', v_branch_id USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO public.vehicles (
    organization_id,
    branch_id,
    vehicle_type_id,
    status,
    plate_number,
    vin,
    make,
    model,
    model_year,
    color,
    acquired_at,
    metadata
  )
  VALUES (
    v_org_id,
    v_branch_id,
    v_vehicle_type_id,
    v_status,
    v_plate_number,
    v_vin,
    v_make,
    v_model,
    v_model_year,
    v_color,
    v_acquired_at,
    v_metadata || jsonb_build_object(
      'created_by', 'create_vehicle_v1',
      'created_correlation_id', v_correlation_id
    )
  )
  RETURNING id INTO v_vehicle_id;

  PERFORM public.enqueue_domain_event(
    v_org_id,
    'fleet.vehicle_created',
    'vehicle',
    v_vehicle_id,
    jsonb_build_object(
      'plate_number', v_plate_number,
      'vehicle_type_id', v_vehicle_type_id,
      'branch_id', v_branch_id,
      'status', v_status,
      'requested_by', auth.uid()
    ),
    v_correlation_id
  );

  PERFORM public.log_decision(
    v_org_id,
    'fleet.vehicle_created',
    'vehicle',
    v_vehicle_id,
    'rpc_dispatch',
    'created',
    'create_vehicle_v1',
    v_correlation_id,
    jsonb_build_object(
      'plate_number', v_plate_number,
      'vehicle_type_id', v_vehicle_type_id,
      'branch_id', v_branch_id,
      'vehicle_status_source', 'lookup_values.vehicle_status'
    ),
    NULL
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'vehicle_id', v_vehicle_id,
    'organization_id', v_org_id,
    'plate_number', v_plate_number,
    'status', v_status,
    'correlation_id', v_correlation_id,
    'resolved_from', 'vehicle_status/lookup'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.upload_vehicle_document_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();

  v_vehicle_id UUID;
  v_doc_type TEXT;
  v_status TEXT;
  v_issuer TEXT;
  v_document_ref_hash TEXT;
  v_issued_at DATE;
  v_expires_at DATE;
  v_artifact_id UUID;
  v_storage_bucket TEXT;
  v_storage_key TEXT;
  v_mime_type TEXT;
  v_size_bytes BIGINT;
  v_metadata JSONB;

  v_vehicle public.vehicles%ROWTYPE;
  v_artifact public.artifacts%ROWTYPE;
  v_vehicle_document_id UUID := gen_random_uuid();
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'upload_vehicle_document_v1: p_args must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'upload_vehicle_document_v1: authenticated tenant user required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  v_vehicle_id := NULLIF(btrim(COALESCE(p_args->>'vehicle_id', '')), '')::UUID;
  v_doc_type := lower(NULLIF(btrim(COALESCE(p_args->>'doc_type', p_args->>'document_type', p_args->>'kind', '')), ''));
  v_issuer := NULLIF(btrim(COALESCE(p_args->>'issuer', '')), '');
  v_document_ref_hash := NULLIF(btrim(COALESCE(p_args->>'document_ref_hash', p_args->>'sha256', '')), '');
  v_issued_at := NULLIF(btrim(COALESCE(p_args->>'issued_at', '')), '')::DATE;
  v_expires_at := NULLIF(btrim(COALESCE(p_args->>'expires_at', '')), '')::DATE;
  v_artifact_id := NULLIF(btrim(COALESCE(p_args->>'artifact_id', '')), '')::UUID;
  v_storage_bucket := NULLIF(btrim(COALESCE(p_args->>'storage_bucket', '')), '');
  v_storage_key := NULLIF(btrim(COALESCE(p_args->>'storage_key', '')), '');
  v_mime_type := NULLIF(btrim(COALESCE(p_args->>'mime_type', '')), '');
  BEGIN
    v_size_bytes := NULLIF(btrim(COALESCE(p_args->>'size_bytes', '')), '')::BIGINT;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'upload_vehicle_document_v1: size_bytes must be a positive integer when provided'
      USING ERRCODE = '22023';
  END;
  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);

  IF v_vehicle_id IS NULL THEN
    RAISE EXCEPTION 'upload_vehicle_document_v1: vehicle_id is required' USING ERRCODE = '22023';
  END IF;
  IF v_doc_type IS NULL THEN
    RAISE EXCEPTION 'upload_vehicle_document_v1: doc_type is required' USING ERRCODE = '22023';
  END IF;
  IF v_artifact_id IS NULL AND (v_storage_bucket IS NULL OR v_storage_key IS NULL) THEN
    RAISE EXCEPTION 'upload_vehicle_document_v1: artifact_id or storage_bucket + storage_key is required'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_metadata) <> 'object' THEN
    RAISE EXCEPTION 'upload_vehicle_document_v1: metadata must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF v_size_bytes IS NOT NULL AND v_size_bytes < 0 THEN
    RAISE EXCEPTION 'upload_vehicle_document_v1: size_bytes must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF v_issued_at IS NOT NULL AND v_expires_at IS NOT NULL AND v_expires_at < v_issued_at THEN
    RAISE EXCEPTION 'upload_vehicle_document_v1: expires_at must be >= issued_at' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'vehicle_document_kind'
       AND lv.value = v_doc_type
  ) THEN
    RAISE EXCEPTION 'upload_vehicle_document_v1: doc_type % not in lookup vehicle_document_kind', v_doc_type
      USING ERRCODE = '22023';
  END IF;

  SELECT lv.value
    INTO v_status
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'vehicle_document_status'
     AND lv.is_default IS TRUE
   ORDER BY lv.sort_order, lv.value
   LIMIT 1;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'upload_vehicle_document_v1: no default vehicle_document_status lookup row is configured' USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_vehicle
    FROM public.vehicles
   WHERE id = v_vehicle_id
   LIMIT 1;
  IF v_vehicle.id IS NULL THEN
    RAISE EXCEPTION 'upload_vehicle_document_v1: vehicle % not found', v_vehicle_id USING ERRCODE = 'P0002';
  END IF;
  IF v_vehicle.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'upload_vehicle_document_v1: vehicle % belongs to another organization', v_vehicle_id USING ERRCODE = '42501';
  END IF;

  IF v_artifact_id IS NULL THEN
    SELECT ra.artifact_id
      INTO v_artifact_id
      FROM public.register_artifact_v1(jsonb_build_object(
        'organization_id', v_org_id,
        'storage_bucket', v_storage_bucket,
        'storage_key', v_storage_key,
        'mime_type', v_mime_type,
        'size_bytes', v_size_bytes,
        'sha256', v_document_ref_hash,
        'created_by_user_id', auth.uid(),
        'source_system', 'console_v2_vehicle_documents',
        'metadata', jsonb_build_object(
          'vehicle_id', v_vehicle_id,
          'doc_type', v_doc_type,
          'correlation_id', v_correlation_id
        )
      )) AS ra;
    IF v_artifact_id IS NULL THEN
      RAISE EXCEPTION 'upload_vehicle_document_v1: artifact registration did not return artifact_id'
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  SELECT *
    INTO v_artifact
    FROM public.artifacts
   WHERE id = v_artifact_id;
  IF v_artifact.id IS NULL THEN
    RAISE EXCEPTION 'upload_vehicle_document_v1: artifact % not found', v_artifact_id USING ERRCODE = 'P0002';
  END IF;
  IF v_artifact.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'upload_vehicle_document_v1: artifact % belongs to another organization', v_artifact_id USING ERRCODE = '42501';
  END IF;

  v_document_ref_hash := COALESCE(v_document_ref_hash, NULLIF(btrim(COALESCE(v_artifact.sha256, '')), ''));

  INSERT INTO public.vehicle_documents (
    id,
    organization_id,
    vehicle_id,
    doc_type,
    status,
    issuer,
    document_ref_hash,
    issued_at,
    expires_at,
    artifact_id,
    metadata
  )
  VALUES (
    v_vehicle_document_id,
    v_org_id,
    v_vehicle_id,
    v_doc_type,
    v_status,
    v_issuer,
    v_document_ref_hash,
    v_issued_at,
    v_expires_at,
    v_artifact_id,
    v_metadata || jsonb_build_object(
      'uploaded_by', 'upload_vehicle_document_v1',
      'uploaded_correlation_id', v_correlation_id
    )
  );

  INSERT INTO public.artifact_links (
    organization_id,
    artifact_id,
    resource_type,
    resource_id,
    relation_type,
    metadata
  )
  VALUES (
    v_org_id,
    v_artifact_id,
    'vehicle_document',
    v_vehicle_document_id,
    'source_document',
    jsonb_build_object(
      'vehicle_id', v_vehicle_id,
      'doc_type', v_doc_type,
      'correlation_id', v_correlation_id
    )
  )
  ON CONFLICT (organization_id, artifact_id, resource_type, resource_id, relation_type) DO NOTHING;

  PERFORM public.enqueue_domain_event(
    v_org_id,
    'fleet.vehicle_document_uploaded',
    'vehicle_document',
    v_vehicle_document_id,
    jsonb_build_object(
      'vehicle_id', v_vehicle_id,
      'artifact_id', v_artifact_id,
      'doc_type', v_doc_type,
      'requested_by', auth.uid()
    ),
    v_correlation_id
  );

  PERFORM public.log_decision(
    v_org_id,
    'fleet.vehicle_document_uploaded',
    'vehicle_document',
    v_vehicle_document_id,
    'rpc_dispatch',
    'submitted',
    'upload_vehicle_document_v1',
    v_correlation_id,
    jsonb_build_object(
      'vehicle_id', v_vehicle_id,
      'artifact_id', v_artifact_id,
      'doc_type', v_doc_type,
      'vehicle_document_status_source', 'lookup_values.vehicle_document_status'
    ),
    NULL
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'vehicle_document_id', v_vehicle_document_id,
    'vehicle_id', v_vehicle_id,
    'artifact_id', v_artifact_id,
    'doc_type', v_doc_type,
    'status', v_status,
    'correlation_id', v_correlation_id,
    'resolved_from', 'vehicle_document_kind/lookup'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION api.create_vehicle_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.create_vehicle_v1(COALESCE($1, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.upload_vehicle_document_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.upload_vehicle_document_v1(COALESCE($1, '{}'::jsonb));
$function$;

REVOKE ALL ON FUNCTION public.vehicle_documents_enforce_org_match_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.vehicle_documents_enforce_org_match_v1() FROM anon;

REVOKE ALL ON FUNCTION public.create_vehicle_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_vehicle_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_vehicle_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.upload_vehicle_document_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upload_vehicle_document_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.upload_vehicle_document_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.create_vehicle_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.create_vehicle_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.create_vehicle_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.upload_vehicle_document_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.upload_vehicle_document_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.upload_vehicle_document_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE VIEW public.v_vehicle_directory
  WITH (security_invoker = true)
  AS
WITH event_agg AS (
  SELECT
    ve.vehicle_id,
    MAX(ve.occurred_at)                                                   AS last_event_at,
    MAX(ve.occurred_at) FILTER (
      WHERE ve.odometer_km IS NOT NULL OR ve.fuel_liters IS NOT NULL
    )                                                                     AS last_telemetry_at,
    COUNT(*) FILTER (WHERE ve.occurred_at >= now() - INTERVAL '24 hours') AS event_count_24h
  FROM public.vehicle_events ve
  GROUP BY ve.vehicle_id
),
latest_odometer AS (
  SELECT DISTINCT ON (ve.vehicle_id)
    ve.vehicle_id,
    ve.odometer_km
  FROM public.vehicle_events ve
  WHERE ve.odometer_km IS NOT NULL
  ORDER BY ve.vehicle_id, ve.occurred_at DESC, ve.created_at DESC, ve.id DESC
),
latest_fuel AS (
  SELECT DISTINCT ON (ve.vehicle_id)
    ve.vehicle_id,
    CASE
      WHEN COALESCE(ve.metadata->>'fuel_fraction', '') ~ '^[0-9]+(\.[0-9]+)?$'
        THEN LEAST(1, GREATEST(0, (ve.metadata->>'fuel_fraction')::NUMERIC))
      ELSE NULL
    END AS fuel_fraction,
    ve.fuel_liters,
    ve.occurred_at AS last_fuel_event_at
  FROM public.vehicle_events ve
  WHERE ve.fuel_liters IS NOT NULL
     OR COALESCE(ve.metadata->>'fuel_fraction', '') ~ '^[0-9]+(\.[0-9]+)?$'
  ORDER BY ve.vehicle_id, ve.occurred_at DESC, ve.created_at DESC, ve.id DESC
),
maint_agg AS (
  SELECT
    vmw.vehicle_id,
    COUNT(*)                                                              AS maintenance_window_count,
    COUNT(*) FILTER (
      WHERE vmw.status = 'scheduled'
        AND vmw.window_start_at <= now()
        AND vmw.window_end_at >= now()
    )                                                                     AS active_maintenance_count,
    BOOL_OR(
      vmw.status = 'scheduled'
      AND (
        (vmw.window_start_at <= now() AND vmw.window_end_at >= now())
        OR (vmw.window_start_at <= now() + INTERVAL '7 days' AND vmw.window_start_at >= now())
      )
    )                                                                     AS maintenance_due
  FROM public.vehicle_maintenance_windows vmw
  GROUP BY vmw.vehicle_id
),
active_assignment AS (
  SELECT DISTINCT ON (va.vehicle_id)
    va.vehicle_id,
    va.assigned_to_user_id,
    va.started_at,
    va.branch_id
  FROM public.vehicle_assignments va
  WHERE va.status = 'active'
    AND va.ended_at IS NULL
  ORDER BY va.vehicle_id, va.started_at DESC
)
SELECT
  v.id,
  v.organization_id,
  v.branch_id,
  v.vehicle_type_id,
  v.status,
  v.plate_number,
  v.plate_number_upper,
  v.vin,
  v.make,
  v.model,
  v.model_year,
  v.color,
  v.is_active,
  v.acquired_at,
  v.retired_at,
  v.metadata,
  v.created_at,
  v.updated_at,
  CASE
    WHEN b.code IS NOT NULL AND b.name IS NOT NULL THEN b.code || ' - ' || b.name
    WHEN b.name IS NOT NULL THEN b.name
    WHEN b.code IS NOT NULL THEN b.code
    ELSE NULL
  END                                                            AS branch_label,
  vt.name                                                        AS vehicle_type_label,
  vt.key                                                         AS vehicle_type_key,
  aa.assigned_to_user_id                                         AS current_driver_user_id,
  u.full_name                                                    AS current_driver_label,
  v.branch_id                                                    AS current_branch_id,
  aa.branch_id                                                   AS active_assignment_branch_id,
  aa.started_at                                                  AS active_assignment_started_at,
  CASE
    WHEN aa.started_at IS NULL THEN NULL
    ELSE EXTRACT(EPOCH FROM (now() - aa.started_at))::BIGINT
  END                                                            AS assignment_age_seconds,
  ea.last_event_at,
  COALESCE(ea.event_count_24h, 0)::INT                           AS event_count_24h,
  COALESCE(ma.maintenance_window_count, 0)::INT                  AS maintenance_window_count,
  COALESCE(ma.active_maintenance_count, 0)::INT                  AS active_maintenance_count,
  COALESCE(ma.maintenance_due, FALSE)                            AS maintenance_due,
  (v.status = 'oos')                                             AS is_oos,
  (
    v.status = 'in_maintenance'
    OR COALESCE(ma.active_maintenance_count, 0) > 0
  )                                                              AS is_in_maintenance,
  ea.last_telemetry_at,
  lo.odometer_km,
  COALESCE(
    lf.fuel_fraction,
    CASE
      WHEN lf.fuel_liters IS NOT NULL
        AND COALESCE(vt.metadata->>'fuel_capacity_liters', '') ~ '^[0-9]+(\.[0-9]+)?$'
        AND (vt.metadata->>'fuel_capacity_liters')::NUMERIC > 0
        THEN LEAST(1, GREATEST(0, lf.fuel_liters / (vt.metadata->>'fuel_capacity_liters')::NUMERIC))
      ELSE NULL
    END,
    0
  )                                                              AS fuel_level,
  lf.last_fuel_event_at
FROM public.vehicles v
LEFT JOIN public.branches b ON b.id = v.branch_id
LEFT JOIN public.vehicle_types vt ON vt.id = v.vehicle_type_id
LEFT JOIN active_assignment aa ON aa.vehicle_id = v.id
LEFT JOIN public.users u ON u.id = aa.assigned_to_user_id
LEFT JOIN event_agg ea ON ea.vehicle_id = v.id
LEFT JOIN latest_odometer lo ON lo.vehicle_id = v.id
LEFT JOIN latest_fuel lf ON lf.vehicle_id = v.id
LEFT JOIN maint_agg ma ON ma.vehicle_id = v.id;

COMMENT ON VIEW public.v_vehicle_directory IS
  'FE-friendly projection of vehicles with branch/type labels, active assignment resolution, event/maintenance counters, status booleans, and telemetry fields (last_telemetry_at, odometer_km, fuel_level, last_fuel_event_at). SSOT remains vehicles plus vehicle_events; mutations route through fleet RPCs including create_vehicle_v1 and record_vehicle_event_v1.';

REVOKE ALL ON public.v_vehicle_directory FROM PUBLIC;
REVOKE ALL ON public.v_vehicle_directory FROM anon;
GRANT SELECT ON public.v_vehicle_directory TO authenticated;
GRANT SELECT ON public.v_vehicle_directory TO service_role;

DO $do$
DECLARE
  v_settings_version_id UUID;
  v_current JSONB;
  v_resource JSONB := '{"key":"vehicle_documents","relation":"public.vehicle_documents","id_column":"id","capability_read":"fleet.read","capability_write":"fleet.write","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"expires_at","direction":"asc"},"filters":[{"key":"vehicle_id","column":"vehicle_id","op":"eq"},{"key":"status","column":"status","op":"eq"},{"key":"doc_type","column":"doc_type","op":"eq"}]}'::jsonb;
  v_filtered JSONB;
BEGIN
  SELECT s.settings_version_id, s.cached_value
    INTO v_settings_version_id, v_current
    FROM public.settings s
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_settings_version_id IS NOT NULL THEN
    v_current := COALESCE(v_current, '{"resources":[]}'::jsonb);
    SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS value
     WHERE value->>'key' <> v_resource->>'key';

    v_current := jsonb_set(v_current, '{resources}', v_filtered || jsonb_build_array(v_resource), TRUE);

    UPDATE public.settings_versions
       SET value = v_current,
           updated_at = now()
     WHERE id = v_settings_version_id;

    UPDATE public.settings
       SET cached_value = v_current,
           last_updated = now()
     WHERE settings_version_id = v_settings_version_id;
  END IF;
END;
$do$;

COMMENT ON FUNCTION public.create_vehicle_v1(JSONB)
  IS 'Canonical fleet RPC: create a vehicle asset for the current tenant. Capability: fleet.write. Defaults status from vehicle_status lookup.';
COMMENT ON FUNCTION public.upload_vehicle_document_v1(JSONB)
  IS 'Canonical fleet RPC: attach a registered artifact, or register a storage object then attach it, as a submitted vehicle_documents row and link it through artifact_links. Capability: fleet.write.';
COMMENT ON FUNCTION api.create_vehicle_v1(JSONB)
  IS 'Console V2 api-schema wrapper delegating to canonical public.create_vehicle_v1(jsonb).';
COMMENT ON FUNCTION api.upload_vehicle_document_v1(JSONB)
  IS 'Console V2 api-schema wrapper delegating to canonical public.upload_vehicle_document_v1(jsonb).';

SELECT pg_advisory_unlock(hashtext('202605041630_console_v2_vehicle_live_paths_v1'));

COMMIT;

-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: Enterprise ops v1 (warehouse locations + driver compliance + vehicle events)
-- Date: 2026-01-31
--
-- Goals:
--   - Add missing enterprise structure primitives for warehouse + fleet/driver operations.
--   - Keep behavior row-driven (lookup enums + settings ladder categories; no hardcoding).
--   - Enforce least-privilege: RLS everywhere; RBAC-gated writes for authenticated; service_role authoritative.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601311230_enterprise_ops_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Settings categories (row-driven policies; minimal v1 schemas + global defaults)
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
VALUES
  (
    'warehouse_policy',
    'Warehouse/branch ops policy (scan + location handling). Resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'return_null',
    '["global","tenant","client","sender","source","resource"]'::jsonb
  ),
  (
    'driver_compliance_policy',
    'Driver compliance policy (required docs + renewal windows). Resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb
  ),
  (
    'fleet_policy',
    'Fleet policy (inspection cadence + required events/docs). Resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'return_null',
    '["global","tenant","client","sender","source","resource"]'::jsonb
  )
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes;

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES
  (
    'warehouse_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'scan_requires_location', jsonb_build_object('type', 'boolean'),
        'allowed_location_types', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string'))
      )
    ),
    'Warehouse policy: minimal v1 schema for scan/location handling (row-driven; ladder-resolved).',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'scan_requires_location', FALSE
      )
    ),
    TRUE
  ),
  (
    'driver_compliance_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'required_document_types', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
        'renewal_grace_days', jsonb_build_object('type', 'integer', 'minimum', 0)
      )
    ),
    'Driver compliance policy: required docs + renewal windows (row-driven; ladder-resolved).',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'required_document_types', jsonb_build_array('driver_license', 'national_id'),
        'renewal_grace_days', 7
      )
    ),
    TRUE
  ),
  (
    'fleet_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'inspection_cadence_days', jsonb_build_object('type', 'integer', 'minimum', 0),
        'required_vehicle_event_types', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string'))
      )
    ),
    'Fleet policy: minimal v1 schema for required events/inspections (row-driven; ladder-resolved).',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'inspection_cadence_days', 0
      )
    ),
    TRUE
  )
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

-- Global defaults (no hardcoding in code paths)
WITH p AS (
  SELECT jsonb_build_object('version', 1, 'scan_requires_location', FALSE) AS warehouse,
         jsonb_build_object('version', 1, 'required_document_types', jsonb_build_array('driver_license', 'national_id'), 'renewal_grace_days', 7) AS driver,
         jsonb_build_object('version', 1, 'inspection_cadence_days', 0) AS fleet
),
sv AS (
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
  SELECT 'warehouse_policy', 'global', NULL::uuid, 1, p.warehouse, 1, 'Seed global warehouse_policy', now(), now() FROM p
  WHERE NOT EXISTS (
    SELECT 1 FROM public.settings_versions WHERE category='warehouse_policy' AND scope_type='global' AND scope_id IS NULL
  )
  UNION ALL
  SELECT 'driver_compliance_policy', 'global', NULL::uuid, 1, p.driver, 1, 'Seed global driver_compliance_policy', now(), now() FROM p
  WHERE NOT EXISTS (
    SELECT 1 FROM public.settings_versions WHERE category='driver_compliance_policy' AND scope_type='global' AND scope_id IS NULL
  )
  UNION ALL
  SELECT 'fleet_policy', 'global', NULL::uuid, 1, p.fleet, 1, 'Seed global fleet_policy', now(), now() FROM p
  WHERE NOT EXISTS (
    SELECT 1 FROM public.settings_versions WHERE category='fleet_policy' AND scope_type='global' AND scope_id IS NULL
  )
  RETURNING id, category, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT sv.category, 'global', NULL::uuid, sv.id, sv.value, now()
FROM sv
ON CONFLICT (category, scope_type, scope_hash) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Lookup seeds (dynamic enums; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('warehouse_location_type', 'Warehouse location types (bin/rack/stage/returns_qc/etc.)', 'ops', 'tier_1', TRUE),
  ('driver_status', 'Driver profile status (active/inactive/suspended)', 'ops', 'tier_1', TRUE),
  ('driver_document_type', 'Driver document types (license/id/etc.)', 'ops', 'tier_1', TRUE),
  ('driver_document_status', 'Driver document status (submitted/verified/rejected/expired)', 'ops', 'tier_1', TRUE),
  ('vehicle_event_type', 'Vehicle event types (odometer/fuel/maintenance/incident)', 'fleet', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

-- Warehouse location types (seed, extendable)
INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('bin', 'Bin', 'Bin/shelf/bin location', 10, FALSE, '{}' ),
  ('rack', 'Rack', 'Rack location', 20, FALSE, '{}' ),
  ('stage', 'Stage', 'Staging area', 30, TRUE, '{}' ),
  ('returns_qc', 'Returns QC', 'Returns quality control area', 40, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'warehouse_location_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- Driver status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('active', 'Active', 'Driver is active', 10, TRUE, '{}' ),
  ('inactive', 'Inactive', 'Driver is inactive', 20, FALSE, '{}' ),
  ('suspended', 'Suspended', 'Driver is suspended', 30, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'driver_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- Driver document types (seed, extendable)
INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('driver_license', 'Driver License', 'Driver license document', 10, TRUE, '{}' ),
  ('national_id', 'National ID', 'National ID/iqama document', 20, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'driver_document_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- Driver document status
INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('submitted', 'Submitted', 'Submitted and pending review', 10, TRUE, '{}' ),
  ('verified', 'Verified', 'Verified/approved', 20, FALSE, '{}' ),
  ('rejected', 'Rejected', 'Rejected', 30, FALSE, '{}' ),
  ('expired', 'Expired', 'Expired', 40, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'driver_document_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- Vehicle event types
INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('odometer', 'Odometer', 'Odometer reading snapshot', 10, TRUE, '{}' ),
  ('fuel', 'Fuel', 'Fuel fill event', 20, FALSE, '{}' ),
  ('maintenance', 'Maintenance', 'Maintenance/service event', 30, FALSE, '{}' ),
  ('incident', 'Incident', 'Incident/accident report', 40, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'vehicle_event_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 3) Tables: warehouse locations
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.warehouse_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,

  code TEXT NOT NULL,
  name TEXT NOT NULL,
  location_type TEXT,
  parent_location_id UUID REFERENCES public.warehouse_locations(id) ON DELETE SET NULL,

  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT warehouse_locations_code_ck CHECK (btrim(code) <> '' AND code = lower(code)),
  CONSTRAINT warehouse_locations_name_ck CHECK (btrim(name) <> ''),
  CONSTRAINT warehouse_locations_location_type_ck CHECK (location_type IS NULL OR (btrim(location_type) <> '' AND location_type = lower(location_type))),
  CONSTRAINT warehouse_locations_unique_branch_code UNIQUE (branch_id, code)
);

COMMENT ON TABLE public.warehouse_locations
  IS 'Warehouse/branch locations (bins/racks/staging). Row-driven; used by warehouse app + scan/task workflows.';

CREATE INDEX IF NOT EXISTS idx_warehouse_locations_org_branch_active
  ON public.warehouse_locations (organization_id, branch_id, is_active, code);

CREATE INDEX IF NOT EXISTS idx_warehouse_locations_parent
  ON public.warehouse_locations (parent_location_id)
  WHERE parent_location_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_warehouse_locations_set_updated_at ON public.warehouse_locations;
CREATE TRIGGER trg_warehouse_locations_set_updated_at
  BEFORE UPDATE ON public.warehouse_locations
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.warehouse_locations_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_branch_org UUID;
BEGIN
  SELECT b.organization_id
    INTO v_branch_org
    FROM public.branches b
   WHERE b.id = NEW.branch_id;

  IF v_branch_org IS NULL THEN
    RAISE EXCEPTION 'warehouse_locations: branch % not found', NEW.branch_id
      USING ERRCODE = '23503';
  END IF;

  IF v_branch_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'warehouse_locations: organization mismatch (location org %, branch org %)', NEW.organization_id, v_branch_org
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_warehouse_locations_enforce_org_match ON public.warehouse_locations;
CREATE TRIGGER trg_warehouse_locations_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.warehouse_locations
  FOR EACH ROW
  EXECUTE FUNCTION public.warehouse_locations_enforce_org_match_v1();

-------------------------------------------------------------------------------
-- 4) Tables: driver profiles + documents + compliance ledger
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.driver_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  driver_code TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- lookup driver_status
  hired_at TIMESTAMPTZ,
  terminated_at TIMESTAMPTZ,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT driver_profiles_driver_code_ck CHECK (driver_code IS NULL OR btrim(driver_code) <> ''),
  CONSTRAINT driver_profiles_status_ck CHECK (btrim(status) <> '' AND status = lower(status)),
  CONSTRAINT driver_profiles_terminated_after_hired_ck CHECK (hired_at IS NULL OR terminated_at IS NULL OR terminated_at >= hired_at),
  CONSTRAINT driver_profiles_unique_org_user UNIQUE (organization_id, user_id)
);

COMMENT ON TABLE public.driver_profiles
  IS 'Driver profile projection (1:1 to users). Used to gate assignments and attach compliance state.';

CREATE INDEX IF NOT EXISTS idx_driver_profiles_org_status
  ON public.driver_profiles (organization_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_profiles_org_code
  ON public.driver_profiles (organization_id, driver_code)
  WHERE driver_code IS NOT NULL AND btrim(driver_code) <> '';

DROP TRIGGER IF EXISTS trg_driver_profiles_set_updated_at ON public.driver_profiles;
CREATE TRIGGER trg_driver_profiles_set_updated_at
  BEFORE UPDATE ON public.driver_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.driver_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  doc_type TEXT NOT NULL, -- lookup driver_document_type
  status TEXT NOT NULL DEFAULT 'submitted', -- lookup driver_document_status
  issuer TEXT,
  document_ref_hash TEXT,
  issued_at DATE,
  expires_at DATE,

  verified_at TIMESTAMPTZ,
  verified_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,

  artifact_id UUID REFERENCES public.artifacts(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT driver_documents_doc_type_ck CHECK (btrim(doc_type) <> '' AND doc_type = lower(doc_type)),
  CONSTRAINT driver_documents_status_ck CHECK (btrim(status) <> '' AND status = lower(status)),
  CONSTRAINT driver_documents_issuer_ck CHECK (issuer IS NULL OR btrim(issuer) <> ''),
  CONSTRAINT driver_documents_ref_hash_ck CHECK (document_ref_hash IS NULL OR btrim(document_ref_hash) <> ''),
  CONSTRAINT driver_documents_expires_after_issued_ck CHECK (issued_at IS NULL OR expires_at IS NULL OR expires_at >= issued_at)
);

COMMENT ON TABLE public.driver_documents
  IS 'Driver document registry (licenses/IDs) with evidence via artifacts. PII should be stored in artifacts; only hashes/metadata in-row.';

CREATE INDEX IF NOT EXISTS idx_driver_documents_org_user_type
  ON public.driver_documents (organization_id, user_id, doc_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_driver_documents_org_expires
  ON public.driver_documents (organization_id, expires_at)
  WHERE expires_at IS NOT NULL;

DROP TRIGGER IF EXISTS trg_driver_documents_set_updated_at ON public.driver_documents;
CREATE TRIGGER trg_driver_documents_set_updated_at
  BEFORE UPDATE ON public.driver_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.driver_compliance_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL,
  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_system TEXT,

  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision_log_id UUID,
  settings_resolution_id UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT driver_compliance_events_event_type_ck CHECK (btrim(event_type) <> '' AND event_type = lower(event_type))
);

COMMENT ON TABLE public.driver_compliance_events
  IS 'Immutable driver compliance event ledger (SSOT). Used for auditing compliance decisions and renewals.';

CREATE INDEX IF NOT EXISTS idx_driver_compliance_events_user_created
  ON public.driver_compliance_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_driver_compliance_events_org_created
  ON public.driver_compliance_events (organization_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.driver_profiles_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_org UUID;
BEGIN
  SELECT u.organization_id
    INTO v_user_org
    FROM public.users u
   WHERE u.id = NEW.user_id;

  IF v_user_org IS NULL THEN
    RAISE EXCEPTION 'driver_profiles: user % not found', NEW.user_id
      USING ERRCODE = '23503';
  END IF;

  IF v_user_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'driver_profiles: organization mismatch (profile org %, user org %)', NEW.organization_id, v_user_org
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_driver_profiles_enforce_org_match ON public.driver_profiles;
CREATE TRIGGER trg_driver_profiles_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.driver_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.driver_profiles_enforce_org_match_v1();

CREATE OR REPLACE FUNCTION public.driver_documents_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_org UUID;
  v_verified_org UUID;
BEGIN
  SELECT u.organization_id
    INTO v_user_org
    FROM public.users u
   WHERE u.id = NEW.user_id;

  IF v_user_org IS NULL THEN
    RAISE EXCEPTION 'driver_documents: user % not found', NEW.user_id
      USING ERRCODE = '23503';
  END IF;

  IF v_user_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'driver_documents: organization mismatch (doc org %, user org %)', NEW.organization_id, v_user_org
      USING ERRCODE = '23514';
  END IF;

  IF NEW.verified_by_user_id IS NOT NULL THEN
    SELECT u.organization_id
      INTO v_verified_org
      FROM public.users u
     WHERE u.id = NEW.verified_by_user_id;

    IF v_verified_org IS NULL THEN
      RAISE EXCEPTION 'driver_documents: verified_by_user % not found', NEW.verified_by_user_id
        USING ERRCODE = '23503';
    END IF;

    IF v_verified_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'driver_documents: organization mismatch (doc org %, verified_by org %)', NEW.organization_id, v_verified_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_driver_documents_enforce_org_match ON public.driver_documents;
CREATE TRIGGER trg_driver_documents_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.driver_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.driver_documents_enforce_org_match_v1();

-------------------------------------------------------------------------------
-- 5) Table: vehicle_events (fleet execution ledger)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.vehicle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vehicle_id UUID NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL, -- lookup vehicle_event_type
  occurred_at TIMESTAMPTZ NOT NULL,

  odometer_km INT,
  fuel_liters NUMERIC,
  cost_amount NUMERIC,
  cost_currency TEXT,

  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_system TEXT,

  notes TEXT,
  artifact_id UUID REFERENCES public.artifacts(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT vehicle_events_event_type_ck CHECK (btrim(event_type) <> '' AND event_type = lower(event_type)),
  CONSTRAINT vehicle_events_odometer_ck CHECK (odometer_km IS NULL OR odometer_km >= 0),
  CONSTRAINT vehicle_events_fuel_ck CHECK (fuel_liters IS NULL OR fuel_liters >= 0),
  CONSTRAINT vehicle_events_cost_ck CHECK (cost_amount IS NULL OR cost_amount >= 0),
  CONSTRAINT vehicle_events_currency_ck CHECK (cost_currency IS NULL OR btrim(cost_currency) <> '')
);

COMMENT ON TABLE public.vehicle_events
  IS 'Vehicle execution event ledger (fuel/odometer/maintenance/incident). Complements maintenance windows; feeds analytics and compliance.';

CREATE INDEX IF NOT EXISTS idx_vehicle_events_vehicle_time
  ON public.vehicle_events (vehicle_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_vehicle_events_org_time
  ON public.vehicle_events (organization_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION public.vehicle_events_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_vehicle_org UUID;
  v_actor_org UUID;
BEGIN
  SELECT v.organization_id
    INTO v_vehicle_org
    FROM public.vehicles v
   WHERE v.id = NEW.vehicle_id;

  IF v_vehicle_org IS NULL THEN
    RAISE EXCEPTION 'vehicle_events: vehicle % not found', NEW.vehicle_id
      USING ERRCODE = '23503';
  END IF;

  IF v_vehicle_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'vehicle_events: organization mismatch (event org %, vehicle org %)', NEW.organization_id, v_vehicle_org
      USING ERRCODE = '23514';
  END IF;

  IF NEW.actor_user_id IS NOT NULL THEN
    SELECT u.organization_id
      INTO v_actor_org
      FROM public.users u
     WHERE u.id = NEW.actor_user_id;

    IF v_actor_org IS NULL THEN
      RAISE EXCEPTION 'vehicle_events: actor_user % not found', NEW.actor_user_id
        USING ERRCODE = '23503';
    END IF;

    IF v_actor_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'vehicle_events: organization mismatch (event org %, actor org %)', NEW.organization_id, v_actor_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_vehicle_events_enforce_org_match ON public.vehicle_events;
CREATE TRIGGER trg_vehicle_events_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.vehicle_events
  FOR EACH ROW
  EXECUTE FUNCTION public.vehicle_events_enforce_org_match_v1();

-------------------------------------------------------------------------------
-- 6) RLS + least-privilege grants (user-facing tables)
-------------------------------------------------------------------------------

ALTER TABLE public.warehouse_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_compliance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.warehouse_locations FROM PUBLIC;
REVOKE ALL ON TABLE public.warehouse_locations FROM anon;
REVOKE ALL ON TABLE public.warehouse_locations FROM authenticated;

REVOKE ALL ON TABLE public.driver_profiles FROM PUBLIC;
REVOKE ALL ON TABLE public.driver_profiles FROM anon;
REVOKE ALL ON TABLE public.driver_profiles FROM authenticated;

REVOKE ALL ON TABLE public.driver_documents FROM PUBLIC;
REVOKE ALL ON TABLE public.driver_documents FROM anon;
REVOKE ALL ON TABLE public.driver_documents FROM authenticated;

REVOKE ALL ON TABLE public.driver_compliance_events FROM PUBLIC;
REVOKE ALL ON TABLE public.driver_compliance_events FROM anon;
REVOKE ALL ON TABLE public.driver_compliance_events FROM authenticated;

REVOKE ALL ON TABLE public.vehicle_events FROM PUBLIC;
REVOKE ALL ON TABLE public.vehicle_events FROM anon;
REVOKE ALL ON TABLE public.vehicle_events FROM authenticated;

-- Warehouse locations: tenant-scoped reads; RBAC-gated writes (agreements.write).
DROP POLICY IF EXISTS warehouse_locations_service_policy ON public.warehouse_locations;
CREATE POLICY warehouse_locations_service_policy ON public.warehouse_locations
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS warehouse_locations_select_policy ON public.warehouse_locations;
CREATE POLICY warehouse_locations_select_policy ON public.warehouse_locations
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS warehouse_locations_write_policy ON public.warehouse_locations;
CREATE POLICY warehouse_locations_write_policy ON public.warehouse_locations
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.warehouse_locations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.warehouse_locations TO service_role;

-- Driver profiles/documents: tenant-scoped reads require fleet.read, except self reads.
DROP POLICY IF EXISTS driver_profiles_service_policy ON public.driver_profiles;
CREATE POLICY driver_profiles_service_policy ON public.driver_profiles
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS driver_profiles_select_policy ON public.driver_profiles;
CREATE POLICY driver_profiles_select_policy ON public.driver_profiles
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      organization_id = public.current_user_org_id()
      AND user_id = auth.uid()
    )
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
      AND public.user_has_permission_v1('fleet.read', organization_id)
    )
  );

DROP POLICY IF EXISTS driver_profiles_write_policy ON public.driver_profiles;
CREATE POLICY driver_profiles_write_policy ON public.driver_profiles
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_profiles TO service_role;

DROP POLICY IF EXISTS driver_documents_service_policy ON public.driver_documents;
CREATE POLICY driver_documents_service_policy ON public.driver_documents
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS driver_documents_select_policy ON public.driver_documents;
CREATE POLICY driver_documents_select_policy ON public.driver_documents
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      organization_id = public.current_user_org_id()
      AND user_id = auth.uid()
    )
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
      AND public.user_has_permission_v1('fleet.read', organization_id)
    )
  );

DROP POLICY IF EXISTS driver_documents_write_policy ON public.driver_documents;
CREATE POLICY driver_documents_write_policy ON public.driver_documents
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_documents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_documents TO service_role;

-- Driver compliance events: readable; service-only writes (SSOT ledger).
DROP POLICY IF EXISTS driver_compliance_events_select_policy ON public.driver_compliance_events;
CREATE POLICY driver_compliance_events_select_policy ON public.driver_compliance_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      organization_id = public.current_user_org_id()
      AND user_id = auth.uid()
    )
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
      AND public.user_has_permission_v1('fleet.read', organization_id)
    )
  );

DROP POLICY IF EXISTS driver_compliance_events_service_policy ON public.driver_compliance_events;
CREATE POLICY driver_compliance_events_service_policy ON public.driver_compliance_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.driver_compliance_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_compliance_events TO service_role;

-- Vehicle events: tenant-scoped reads; RBAC-gated writes (fleet.write).
DROP POLICY IF EXISTS vehicle_events_select_policy ON public.vehicle_events;
CREATE POLICY vehicle_events_select_policy ON public.vehicle_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS vehicle_events_service_policy ON public.vehicle_events;
CREATE POLICY vehicle_events_service_policy ON public.vehicle_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS vehicle_events_write_policy ON public.vehicle_events;
CREATE POLICY vehicle_events_write_policy ON public.vehicle_events
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.vehicle_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vehicle_events TO service_role;

-------------------------------------------------------------------------------
-- 7) Table contracts (timestamps + audit posture)
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'warehouse_locations', TRUE, TRUE, TRUE, 'Warehouse locations catalog (user-facing; row-driven).'),
  ('public', 'driver_profiles', TRUE, TRUE, TRUE, 'Driver profile projection (user-facing; sensitive).'),
  ('public', 'driver_documents', TRUE, TRUE, TRUE, 'Driver documents registry (user-facing; sensitive).'),
  ('public', 'driver_compliance_events', TRUE, FALSE, FALSE, 'Driver compliance SSOT ledger (immutable).'),
  ('public', 'vehicle_events', TRUE, FALSE, FALSE, 'Vehicle events SSOT ledger (immutable).')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

-------------------------------------------------------------------------------
-- 8) Refresh api contract views for newly user-facing tables (security_invoker)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.refresh_api_contract_views_v1()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  r RECORD;
  v_public_ref TEXT;
  v_auth_select BOOLEAN;
  v_auth_insert BOOLEAN;
  v_auth_update BOOLEAN;
  v_auth_delete BOOLEAN;
  v_anon_select BOOLEAN;
  v_anon_insert BOOLEAN;
  v_anon_update BOOLEAN;
  v_anon_delete BOOLEAN;
  v_any_anon BOOLEAN := FALSE;
BEGIN
  EXECUTE 'CREATE SCHEMA IF NOT EXISTS api';
  EXECUTE 'REVOKE ALL ON SCHEMA api FROM PUBLIC';

  EXECUTE 'GRANT USAGE ON SCHEMA api TO authenticated';
  EXECUTE 'GRANT USAGE ON SCHEMA api TO service_role';

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA api TO edge_label_renderer_role';
  END IF;

  FOR r IN
    SELECT tablename
    FROM public.security_rls_user_facing
    ORDER BY tablename
  LOOP
    EXECUTE format(
      'CREATE OR REPLACE VIEW api.%I WITH (security_invoker = true) AS SELECT * FROM public.%I',
      r.tablename,
      r.tablename
    );

    EXECUTE format('REVOKE ALL ON api.%I FROM PUBLIC', r.tablename);
    EXECUTE format('REVOKE ALL ON api.%I FROM anon', r.tablename);
    EXECUTE format('REVOKE ALL ON api.%I FROM authenticated', r.tablename);

    v_public_ref := format('public.%I', r.tablename);

    v_auth_select := has_table_privilege('authenticated', v_public_ref, 'select');
    v_auth_insert := has_table_privilege('authenticated', v_public_ref, 'insert');
    v_auth_update := has_table_privilege('authenticated', v_public_ref, 'update');
    v_auth_delete := has_table_privilege('authenticated', v_public_ref, 'delete');

    v_anon_select := has_table_privilege('anon', v_public_ref, 'select');
    v_anon_insert := has_table_privilege('anon', v_public_ref, 'insert');
    v_anon_update := has_table_privilege('anon', v_public_ref, 'update');
    v_anon_delete := has_table_privilege('anon', v_public_ref, 'delete');

    IF v_auth_select THEN EXECUTE format('GRANT SELECT ON api.%I TO authenticated', r.tablename); END IF;
    IF v_auth_insert THEN EXECUTE format('GRANT INSERT ON api.%I TO authenticated', r.tablename); END IF;
    IF v_auth_update THEN EXECUTE format('GRANT UPDATE ON api.%I TO authenticated', r.tablename); END IF;
    IF v_auth_delete THEN EXECUTE format('GRANT DELETE ON api.%I TO authenticated', r.tablename); END IF;

    IF v_anon_select THEN EXECUTE format('GRANT SELECT ON api.%I TO anon', r.tablename); v_any_anon := TRUE; END IF;
    IF v_anon_insert THEN EXECUTE format('GRANT INSERT ON api.%I TO anon', r.tablename); v_any_anon := TRUE; END IF;
    IF v_anon_update THEN EXECUTE format('GRANT UPDATE ON api.%I TO anon', r.tablename); v_any_anon := TRUE; END IF;
    IF v_anon_delete THEN EXECUTE format('GRANT DELETE ON api.%I TO anon', r.tablename); v_any_anon := TRUE; END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON api.%I TO service_role', r.tablename);
  END LOOP;

  IF v_any_anon THEN
    EXECUTE 'GRANT USAGE ON SCHEMA api TO anon';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_api_contract_views_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_api_contract_views_v1() FROM anon;
REVOKE ALL ON FUNCTION public.refresh_api_contract_views_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_api_contract_views_v1() TO service_role;

COMMENT ON FUNCTION public.refresh_api_contract_views_v1()
  IS 'Service-only: Rebuild api.<table> contract views for the current user-facing public surface (derived from effective grants).';

SELECT public.refresh_api_contract_views_v1();

SELECT pg_advisory_unlock(hashtext('202601311230_enterprise_ops_v1'));
COMMIT;

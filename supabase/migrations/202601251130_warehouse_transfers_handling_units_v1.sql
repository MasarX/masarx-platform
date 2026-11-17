-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Warehouse transfers + handling units foundation v1
-- Date: 2026-01-25
--
-- Goals:
--   - Introduce enterprise-grade warehouse chain-of-custody primitives:
--       - handling_units: physical containers (bag/tote/cage/pallet) used in branches/warehouses and linehaul.
--       - warehouse_transfers + warehouse_transfer_items: inter-branch transfer manifests (who moved what, when).
--   - Keep execution state in tasks/workflows; these tables are planning/SSOT records (no bespoke state machines).
--   - Enforce least-privilege RLS: tenant-only access; clients/senders cannot access warehouse ops tables.
--   - Enforce org consistency via triggers (no cross-tenant links).
--
-- Notes:
--   - Evidence (POD, transfer slips, seals) must link via artifacts/artifact_links (SSOT), not bespoke columns.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601251130_warehouse_transfers_handling_units_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookup seeds (dynamic enums; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('handling_unit_type', 'Physical handling unit types (bag/tote/cage/pallet)', 'warehouse', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('bag', 'Bag', 'Bag handling unit (soft container)', 10, TRUE, '{}' ),
  ('tote', 'Tote', 'Tote handling unit (plastic box)', 20, FALSE, '{}' ),
  ('cage', 'Cage', 'Cage / roll container', 30, FALSE, '{}' ),
  ('pallet', 'Pallet', 'Pallet (wood/metal)', 40, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'handling_unit_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('handling_unit_status', 'Handling unit lifecycle/status', 'warehouse', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('open', 'Open', 'Open/available for packing', 10, TRUE, '{}' ),
  ('sealed', 'Sealed', 'Sealed/closed and ready for movement', 20, FALSE, '{}' ),
  ('in_transit', 'In Transit', 'In transit between branches', 30, FALSE, '{}' ),
  ('received', 'Received', 'Received at destination branch', 40, FALSE, '{}' ),
  ('retired', 'Retired', 'No longer in service', 50, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'handling_unit_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('warehouse_transfer_status', 'Warehouse transfer manifest status', 'warehouse', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('draft', 'Draft', 'Draft transfer manifest', 10, TRUE, '{}' ),
  ('in_transit', 'In Transit', 'Transfer dispatched and in transit', 20, FALSE, '{}' ),
  ('received', 'Received', 'Transfer received at destination', 30, FALSE, '{}' ),
  ('canceled', 'Canceled', 'Transfer canceled', 40, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'warehouse_transfer_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Handling units (physical containers)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.handling_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,

  unit_type TEXT NOT NULL DEFAULT 'bag', -- lookup handling_unit_type
  status TEXT NOT NULL DEFAULT 'open', -- lookup handling_unit_status
  code TEXT NOT NULL, -- printed barcode/QR; unique per org

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT handling_units_unit_type_ck CHECK (btrim(unit_type) <> '' AND unit_type = lower(unit_type)),
  CONSTRAINT handling_units_status_ck CHECK (btrim(status) <> '' AND status = lower(status)),
  CONSTRAINT handling_units_code_ck CHECK (btrim(code) <> '')
);

COMMENT ON TABLE public.handling_units
  IS 'Physical handling units (bags/totes/cages/pallets) for warehouse/branch operations. Execution/scan evidence links via artifacts + scan_events.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_handling_units_org_code
  ON public.handling_units (organization_id, code);

CREATE INDEX IF NOT EXISTS idx_handling_units_org_branch_status
  ON public.handling_units (organization_id, branch_id, status, created_at DESC)
  WHERE branch_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.handling_units_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_branch_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'handling_units: organization_id is required' USING ERRCODE = '23502';
  END IF;

  IF NEW.branch_id IS NOT NULL THEN
    SELECT b.organization_id INTO v_branch_org
    FROM public.branches b
    WHERE b.id = NEW.branch_id;

    IF v_branch_org IS NULL THEN
      RAISE EXCEPTION 'handling_units: branch % not found', NEW.branch_id USING ERRCODE = '23503';
    END IF;

    IF v_branch_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'handling_units: organization mismatch (unit org %, branch org %)', NEW.organization_id, v_branch_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_handling_units_enforce_org_match ON public.handling_units;
CREATE TRIGGER trg_handling_units_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.handling_units
  FOR EACH ROW
  EXECUTE FUNCTION public.handling_units_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_handling_units_set_updated_at ON public.handling_units;
CREATE TRIGGER trg_handling_units_set_updated_at
  BEFORE UPDATE ON public.handling_units
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.handling_units ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.handling_units FROM PUBLIC;
REVOKE ALL ON TABLE public.handling_units FROM anon;
REVOKE ALL ON TABLE public.handling_units FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.handling_units TO authenticated;
GRANT ALL ON TABLE public.handling_units TO service_role;

DROP POLICY IF EXISTS handling_units_service_policy ON public.handling_units;
CREATE POLICY handling_units_service_policy ON public.handling_units
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS handling_units_select_policy ON public.handling_units;
CREATE POLICY handling_units_select_policy ON public.handling_units
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS handling_units_write_policy ON public.handling_units;
CREATE POLICY handling_units_write_policy ON public.handling_units
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

-------------------------------------------------------------------------------
-- 3) Warehouse transfers (inter-branch manifests)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.warehouse_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  from_branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  to_branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,

  status TEXT NOT NULL DEFAULT 'draft', -- lookup warehouse_transfer_status
  transfer_code TEXT NULL,

  vehicle_id UUID REFERENCES public.vehicles(id) ON DELETE SET NULL,
  driver_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,

  planned_dispatch_at TIMESTAMPTZ NULL,
  planned_receive_at TIMESTAMPTZ NULL,
  dispatched_at TIMESTAMPTZ NULL,
  received_at TIMESTAMPTZ NULL,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT warehouse_transfers_status_ck CHECK (btrim(status) <> '' AND status = lower(status)),
  CONSTRAINT warehouse_transfers_code_ck CHECK (transfer_code IS NULL OR btrim(transfer_code) <> ''),
  CONSTRAINT warehouse_transfers_from_to_ck CHECK (from_branch_id <> to_branch_id),
  CONSTRAINT warehouse_transfers_planned_range_ck CHECK (
    planned_dispatch_at IS NULL
    OR planned_receive_at IS NULL
    OR planned_receive_at >= planned_dispatch_at
  ),
  CONSTRAINT warehouse_transfers_actual_range_ck CHECK (
    dispatched_at IS NULL
    OR received_at IS NULL
    OR received_at >= dispatched_at
  )
);

COMMENT ON TABLE public.warehouse_transfers
  IS 'Inter-branch transfer manifests. Execution should be task/workflow-driven; evidence links via artifacts.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouse_transfers_org_code
  ON public.warehouse_transfers (organization_id, transfer_code)
  WHERE transfer_code IS NOT NULL AND btrim(transfer_code) <> '';

CREATE INDEX IF NOT EXISTS idx_warehouse_transfers_org_branches_status
  ON public.warehouse_transfers (organization_id, from_branch_id, to_branch_id, status, created_at DESC);

CREATE OR REPLACE FUNCTION public.warehouse_transfers_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_from_org UUID;
  v_to_org UUID;
  v_vehicle_org UUID;
  v_user_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfers: organization_id is required' USING ERRCODE = '23502';
  END IF;

  IF NEW.from_branch_id IS NOT DISTINCT FROM NEW.to_branch_id THEN
    RAISE EXCEPTION 'warehouse_transfers: from_branch_id must differ from to_branch_id' USING ERRCODE = '23514';
  END IF;

  SELECT b.organization_id INTO v_from_org
  FROM public.branches b
  WHERE b.id = NEW.from_branch_id;
  IF v_from_org IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfers: from_branch % not found', NEW.from_branch_id USING ERRCODE = '23503';
  END IF;
  IF v_from_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'warehouse_transfers: organization mismatch (transfer org %, from_branch org %)', NEW.organization_id, v_from_org
      USING ERRCODE = '23514';
  END IF;

  SELECT b.organization_id INTO v_to_org
  FROM public.branches b
  WHERE b.id = NEW.to_branch_id;
  IF v_to_org IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfers: to_branch % not found', NEW.to_branch_id USING ERRCODE = '23503';
  END IF;
  IF v_to_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'warehouse_transfers: organization mismatch (transfer org %, to_branch org %)', NEW.organization_id, v_to_org
      USING ERRCODE = '23514';
  END IF;

  IF NEW.vehicle_id IS NOT NULL THEN
    SELECT v.organization_id INTO v_vehicle_org
    FROM public.vehicles v
    WHERE v.id = NEW.vehicle_id;

    IF v_vehicle_org IS NULL THEN
      RAISE EXCEPTION 'warehouse_transfers: vehicle % not found', NEW.vehicle_id USING ERRCODE = '23503';
    END IF;
    IF v_vehicle_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'warehouse_transfers: organization mismatch (transfer org %, vehicle org %)', NEW.organization_id, v_vehicle_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.driver_user_id IS NOT NULL THEN
    SELECT u.organization_id INTO v_user_org
    FROM public.users u
    WHERE u.id = NEW.driver_user_id;

    IF v_user_org IS NULL THEN
      RAISE EXCEPTION 'warehouse_transfers: user % not found', NEW.driver_user_id USING ERRCODE = '23503';
    END IF;
    IF v_user_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'warehouse_transfers: organization mismatch (transfer org %, user org %)', NEW.organization_id, v_user_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.created_by_user_id IS NOT NULL THEN
    SELECT u.organization_id INTO v_user_org
    FROM public.users u
    WHERE u.id = NEW.created_by_user_id;

    IF v_user_org IS NULL THEN
      RAISE EXCEPTION 'warehouse_transfers: user % not found', NEW.created_by_user_id USING ERRCODE = '23503';
    END IF;
    IF v_user_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'warehouse_transfers: organization mismatch (transfer org %, user org %)', NEW.organization_id, v_user_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_warehouse_transfers_enforce_org_match ON public.warehouse_transfers;
CREATE TRIGGER trg_warehouse_transfers_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.warehouse_transfers
  FOR EACH ROW
  EXECUTE FUNCTION public.warehouse_transfers_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_warehouse_transfers_set_updated_at ON public.warehouse_transfers;
CREATE TRIGGER trg_warehouse_transfers_set_updated_at
  BEFORE UPDATE ON public.warehouse_transfers
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.warehouse_transfers ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.warehouse_transfers FROM PUBLIC;
REVOKE ALL ON TABLE public.warehouse_transfers FROM anon;
REVOKE ALL ON TABLE public.warehouse_transfers FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.warehouse_transfers TO authenticated;
GRANT ALL ON TABLE public.warehouse_transfers TO service_role;

DROP POLICY IF EXISTS warehouse_transfers_service_policy ON public.warehouse_transfers;
CREATE POLICY warehouse_transfers_service_policy ON public.warehouse_transfers
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS warehouse_transfers_select_policy ON public.warehouse_transfers;
CREATE POLICY warehouse_transfers_select_policy ON public.warehouse_transfers
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS warehouse_transfers_write_policy ON public.warehouse_transfers;
CREATE POLICY warehouse_transfers_write_policy ON public.warehouse_transfers
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

-------------------------------------------------------------------------------
-- 4) Warehouse transfer items (manifest membership; partition-safe shipment refs)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.warehouse_transfer_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  transfer_id UUID NOT NULL REFERENCES public.warehouse_transfers(id) ON DELETE CASCADE,

  -- Shipments are HASH partitioned by client_id; store client_id alongside shipment_id for deterministic joins.
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  shipment_id UUID NOT NULL,

  added_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT warehouse_transfer_items_shipment_fk
    FOREIGN KEY (shipment_id, client_id) REFERENCES public.shipments(id, client_id) ON DELETE RESTRICT,
  CONSTRAINT warehouse_transfer_items_unique UNIQUE (transfer_id, client_id, shipment_id)
);

COMMENT ON TABLE public.warehouse_transfer_items
  IS 'Warehouse transfer manifest membership for shipments (partition-safe). Execution state and evidence should be tracked via tasks/workflows + scan_events + artifacts.';

CREATE INDEX IF NOT EXISTS idx_warehouse_transfer_items_org_transfer
  ON public.warehouse_transfer_items (organization_id, transfer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_warehouse_transfer_items_org_shipment
  ON public.warehouse_transfer_items (organization_id, client_id, shipment_id);

CREATE OR REPLACE FUNCTION public.warehouse_transfer_items_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_transfer_org UUID;
  v_client_org UUID;
  v_ship_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfer_items: organization_id is required' USING ERRCODE = '23502';
  END IF;

  SELECT wt.organization_id INTO v_transfer_org
  FROM public.warehouse_transfers wt
  WHERE wt.id = NEW.transfer_id;

  IF v_transfer_org IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfer_items: transfer % not found', NEW.transfer_id USING ERRCODE = '23503';
  END IF;

  IF v_transfer_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'warehouse_transfer_items: organization mismatch (item org %, transfer org %)', NEW.organization_id, v_transfer_org
      USING ERRCODE = '23514';
  END IF;

  SELECT c.organization_id INTO v_client_org
  FROM public.clients c
  WHERE c.id = NEW.client_id;

  IF v_client_org IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfer_items: client % not found', NEW.client_id USING ERRCODE = '23503';
  END IF;

  IF v_client_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'warehouse_transfer_items: organization mismatch (item org %, client org %)', NEW.organization_id, v_client_org
      USING ERRCODE = '23514';
  END IF;

  SELECT s.organization_id INTO v_ship_org
  FROM public.shipments s
  WHERE s.id = NEW.shipment_id
    AND s.client_id = NEW.client_id;

  IF v_ship_org IS NULL THEN
    RAISE EXCEPTION 'warehouse_transfer_items: shipment % not found for client %', NEW.shipment_id, NEW.client_id
      USING ERRCODE = '23503';
  END IF;

  IF v_ship_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'warehouse_transfer_items: organization mismatch (item org %, shipment org %)', NEW.organization_id, v_ship_org
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_warehouse_transfer_items_enforce_org_match ON public.warehouse_transfer_items;
CREATE TRIGGER trg_warehouse_transfer_items_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.warehouse_transfer_items
  FOR EACH ROW
  EXECUTE FUNCTION public.warehouse_transfer_items_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_warehouse_transfer_items_set_updated_at ON public.warehouse_transfer_items;
CREATE TRIGGER trg_warehouse_transfer_items_set_updated_at
  BEFORE UPDATE ON public.warehouse_transfer_items
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.warehouse_transfer_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.warehouse_transfer_items FROM PUBLIC;
REVOKE ALL ON TABLE public.warehouse_transfer_items FROM anon;
REVOKE ALL ON TABLE public.warehouse_transfer_items FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.warehouse_transfer_items TO authenticated;
GRANT ALL ON TABLE public.warehouse_transfer_items TO service_role;

DROP POLICY IF EXISTS warehouse_transfer_items_service_policy ON public.warehouse_transfer_items;
CREATE POLICY warehouse_transfer_items_service_policy ON public.warehouse_transfer_items
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS warehouse_transfer_items_select_policy ON public.warehouse_transfer_items;
CREATE POLICY warehouse_transfer_items_select_policy ON public.warehouse_transfer_items
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS warehouse_transfer_items_write_policy ON public.warehouse_transfer_items;
CREATE POLICY warehouse_transfer_items_write_policy ON public.warehouse_transfer_items
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

-------------------------------------------------------------------------------
-- 5) Table contracts (timestamp + audit SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'handling_units', TRUE, TRUE, TRUE, 'Physical handling units (bags/totes/cages/pallets).'),
  ('public', 'warehouse_transfers', TRUE, TRUE, TRUE, 'Inter-branch warehouse transfer manifests.'),
  ('public', 'warehouse_transfer_items', TRUE, TRUE, TRUE, 'Warehouse transfer manifest membership (shipments).')
ON CONFLICT (table_schema, table_name) DO NOTHING;

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202601251130_warehouse_transfers_handling_units_v1'));
COMMIT;

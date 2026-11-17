-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: Inventory minimal SSOT v1 (items + movement ledger; warehouse locations integration)
-- Date: 2026-01-31
--
-- Goals:
--   - Provide minimal, enterprise-safe inventory primitives for warehouse/branch ops (putaway/pick/stage/cycle-count).
--   - Keep it generic (row-driven) and avoid per-flow hardcoding.
--   - Enforce strict RLS (tenant-only; clients/senders cannot see inventory).
--   - Disable redundant auditing for high-volume ledgers (inventory_movements).
BEGIN;
SELECT pg_advisory_lock(hashtext('202601311810_inventory_foundation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookups (row-driven enums; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('inventory_movement_type', 'Inventory movement types (receive/issue/transfer/adjust/etc.)', 'warehouse', 'tier_1', TRUE)
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
  ('receive',  'Receive',  'Received into inventory (source external/unknown)', 10, TRUE,  '{}' ),
  ('issue',    'Issue',    'Issued/consumed from inventory (destination external/unknown)', 20, FALSE, '{}' ),
  ('transfer', 'Transfer', 'Transferred between warehouse locations', 30, FALSE, '{}' ),
  ('adjust',   'Adjust',   'Adjustment (cycle count / correction)', 40, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'inventory_movement_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) inventory_items (catalog / projection)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  unit TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inventory_items_key_ck CHECK (btrim(key) <> '' AND key = lower(key)),
  CONSTRAINT inventory_items_name_ck CHECK (btrim(name) <> '')
);

COMMENT ON TABLE public.inventory_items IS
  'Inventory item catalog (org-scoped). Used for warehouse/branch inventory tracking. Generic by design.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_items_org_key
  ON public.inventory_items (organization_id, key);

CREATE INDEX IF NOT EXISTS idx_inventory_items_org_active
  ON public.inventory_items (organization_id, is_active, key);

ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.inventory_items FROM PUBLIC;
REVOKE ALL ON TABLE public.inventory_items FROM anon;
REVOKE ALL ON TABLE public.inventory_items FROM authenticated;

DROP POLICY IF EXISTS inventory_items_select ON public.inventory_items;
CREATE POLICY inventory_items_select ON public.inventory_items
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS inventory_items_service_policy ON public.inventory_items;
CREATE POLICY inventory_items_service_policy ON public.inventory_items
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.inventory_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_items TO service_role;

DROP TRIGGER IF EXISTS trg_inventory_items_set_updated_at ON public.inventory_items;
CREATE TRIGGER trg_inventory_items_set_updated_at
  BEFORE UPDATE ON public.inventory_items
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 3) inventory_movements (immutable ledger)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  from_location_id UUID REFERENCES public.warehouse_locations(id) ON DELETE SET NULL,
  to_location_id UUID REFERENCES public.warehouse_locations(id) ON DELETE SET NULL,

  movement_type TEXT NOT NULL, -- lookup inventory_movement_type
  quantity NUMERIC NOT NULL,
  unit TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,

  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_system TEXT,

  artifact_id UUID REFERENCES public.artifacts(id) ON DELETE SET NULL,

  -- Soft links (no FK): task_id is a projection table; scan_events is HASH+RANGE partitioned.
  related_task_id UUID,
  related_scan_event_id UUID,

  idempotency_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT inventory_movements_movement_type_ck CHECK (btrim(movement_type) <> '' AND movement_type = lower(movement_type)),
  CONSTRAINT inventory_movements_quantity_ck CHECK (quantity > 0),
  CONSTRAINT inventory_movements_idempotency_ck CHECK (idempotency_key IS NULL OR btrim(idempotency_key) <> ''),
  CONSTRAINT inventory_movements_location_ck CHECK (from_location_id IS NOT NULL OR to_location_id IS NOT NULL)
);

COMMENT ON TABLE public.inventory_movements IS
  'Inventory movement ledger (SSOT). High-volume; do not double-audit. Use tasks/workflows to govern business rules.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_movements_org_idempotency
  ON public.inventory_movements (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

CREATE INDEX IF NOT EXISTS idx_inventory_movements_org_occurred
  ON public.inventory_movements (organization_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_item_occurred
  ON public.inventory_movements (item_id, occurred_at DESC);

-- FK supporting indexes (enterprise hygiene; non-partial).
CREATE INDEX IF NOT EXISTS idx_inventory_movements__item_id__fk
  ON public.inventory_movements (item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements__from_location_id__fk
  ON public.inventory_movements (from_location_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements__to_location_id__fk
  ON public.inventory_movements (to_location_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements__actor_user_id__fk
  ON public.inventory_movements (actor_user_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements__artifact_id__fk
  ON public.inventory_movements (artifact_id);

CREATE OR REPLACE FUNCTION public.inventory_movements_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_item_org UUID;
  v_from_org UUID;
  v_to_org UUID;
  v_user_org UUID;
  v_artifact_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'inventory_movements: organization_id is required' USING ERRCODE = '23502';
  END IF;

  SELECT i.organization_id INTO v_item_org
  FROM public.inventory_items i
  WHERE i.id = NEW.item_id;

  IF v_item_org IS NULL THEN
    RAISE EXCEPTION 'inventory_movements: item % not found', NEW.item_id USING ERRCODE = '23503';
  END IF;

  IF v_item_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'inventory_movements: organization mismatch (movement org %, item org %)', NEW.organization_id, v_item_org
      USING ERRCODE = '23514';
  END IF;

  IF NEW.from_location_id IS NOT NULL THEN
    SELECT wl.organization_id INTO v_from_org
    FROM public.warehouse_locations wl
    WHERE wl.id = NEW.from_location_id;

    IF v_from_org IS NULL THEN
      RAISE EXCEPTION 'inventory_movements: from_location % not found', NEW.from_location_id USING ERRCODE = '23503';
    END IF;

    IF v_from_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'inventory_movements: organization mismatch (movement org %, from_location org %)', NEW.organization_id, v_from_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.to_location_id IS NOT NULL THEN
    SELECT wl.organization_id INTO v_to_org
    FROM public.warehouse_locations wl
    WHERE wl.id = NEW.to_location_id;

    IF v_to_org IS NULL THEN
      RAISE EXCEPTION 'inventory_movements: to_location % not found', NEW.to_location_id USING ERRCODE = '23503';
    END IF;

    IF v_to_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'inventory_movements: organization mismatch (movement org %, to_location org %)', NEW.organization_id, v_to_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.actor_user_id IS NOT NULL THEN
    SELECT u.organization_id INTO v_user_org
    FROM public.users u
    WHERE u.id = NEW.actor_user_id;

    IF v_user_org IS NULL THEN
      RAISE EXCEPTION 'inventory_movements: actor_user % not found', NEW.actor_user_id USING ERRCODE = '23503';
    END IF;

    IF v_user_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'inventory_movements: organization mismatch (movement org %, actor_user org %)', NEW.organization_id, v_user_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.artifact_id IS NOT NULL THEN
    SELECT a.organization_id INTO v_artifact_org
    FROM public.artifacts a
    WHERE a.id = NEW.artifact_id;

    IF v_artifact_org IS NULL THEN
      RAISE EXCEPTION 'inventory_movements: artifact % not found', NEW.artifact_id USING ERRCODE = '23503';
    END IF;

    IF v_artifact_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'inventory_movements: organization mismatch (movement org %, artifact org %)', NEW.organization_id, v_artifact_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_inventory_movements_enforce_org_match ON public.inventory_movements;
CREATE TRIGGER trg_inventory_movements_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.inventory_movements
  FOR EACH ROW
  EXECUTE FUNCTION public.inventory_movements_enforce_org_match_v1();

ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.inventory_movements FROM PUBLIC;
REVOKE ALL ON TABLE public.inventory_movements FROM anon;
REVOKE ALL ON TABLE public.inventory_movements FROM authenticated;

DROP POLICY IF EXISTS inventory_movements_select ON public.inventory_movements;
CREATE POLICY inventory_movements_select ON public.inventory_movements
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS inventory_movements_service_policy ON public.inventory_movements;
CREATE POLICY inventory_movements_service_policy ON public.inventory_movements
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.inventory_movements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_movements TO service_role;

-------------------------------------------------------------------------------
-- 4) Contracts + apply
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'inventory_items', TRUE, TRUE, TRUE, 'Inventory item catalog (org-scoped; user-facing).'),
  ('public', 'inventory_movements', TRUE, FALSE, FALSE, 'Inventory movements ledger (SSOT; high-volume; disable double-audit).')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

-- API contract views are derived from user-facing grants (public.security_rls_user_facing).
SELECT public.refresh_api_contract_views_v1();

SELECT pg_advisory_unlock(hashtext('202601311810_inventory_foundation_v1'));
COMMIT;


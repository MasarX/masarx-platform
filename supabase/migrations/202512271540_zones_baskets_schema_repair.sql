-- Migration: Zones + Baskets schema repair (org-scoped)
-- Purpose:
--   - Re-assert zones/baskets base schema and seeds when drift/missing objects are detected.
--   - Idempotent reapply of zones/baskets objects, RLS, and lookup seeds.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO-HARDCODING | RLS
-- Date: 2025-12-27

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- Zones (org-scoped)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT zones_slug_ck CHECK (slug ~ '^[a-z0-9-]+$'),
  CONSTRAINT zones_unique_org_slug UNIQUE (organization_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_zones_org ON public.zones(organization_id);
CREATE INDEX IF NOT EXISTS idx_zones_org_active ON public.zones(organization_id, is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_zones_org_sort ON public.zones(organization_id, sort_order) WHERE sort_order IS NOT NULL;

COMMENT ON TABLE public.zones IS 'Org-scoped zones (service areas) defined as an explicit mapping to canonical districts.';
COMMENT ON COLUMN public.zones.slug IS 'URL-safe identifier unique within an organization.';
COMMENT ON COLUMN public.zones.metadata IS 'Optional metadata for routing/ops tooling (row-driven consumers).';

DROP TRIGGER IF EXISTS trg_zones_set_updated_at ON public.zones;
CREATE TRIGGER trg_zones_set_updated_at
  BEFORE UPDATE ON public.zones
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Zone membership: explicit mapping to canonical districts (one district -> one zone baseline).
CREATE TABLE IF NOT EXISTS public.zone_districts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id UUID NOT NULL REFERENCES public.zones(id) ON DELETE CASCADE,
  canonical_district_id UUID NOT NULL REFERENCES public.canonical_districts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT zone_districts_unique_zone_district UNIQUE (zone_id, canonical_district_id),
  CONSTRAINT zone_districts_unique_district UNIQUE (canonical_district_id)
);

CREATE INDEX IF NOT EXISTS idx_zone_districts_zone ON public.zone_districts(zone_id);
CREATE INDEX IF NOT EXISTS idx_zone_districts_district ON public.zone_districts(canonical_district_id);

COMMENT ON TABLE public.zone_districts IS 'Zone membership mapping: each canonical district is assigned to at most one zone.';

CREATE OR REPLACE FUNCTION public.zone_districts_enforce_org_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_zone_org UUID;
  v_district_org UUID;
BEGIN
  SELECT z.organization_id
  INTO v_zone_org
  FROM public.zones z
  WHERE z.id = NEW.zone_id;

  IF v_zone_org IS NULL THEN
    RAISE EXCEPTION 'zone_districts: zone % not found', NEW.zone_id;
  END IF;

  SELECT d.organization_id
  INTO v_district_org
  FROM public.canonical_districts d
  WHERE d.id = NEW.canonical_district_id;

  IF v_district_org IS NULL THEN
    RAISE EXCEPTION 'zone_districts: canonical_district % not found', NEW.canonical_district_id;
  END IF;

  IF v_zone_org IS DISTINCT FROM v_district_org THEN
    RAISE EXCEPTION 'zone_districts: organization mismatch (zone org %, district org %)', v_zone_org, v_district_org;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_zone_districts_enforce_org_match ON public.zone_districts;
CREATE TRIGGER trg_zone_districts_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.zone_districts
  FOR EACH ROW
  EXECUTE FUNCTION public.zone_districts_enforce_org_match();

-- Shipment optional zone assignment pointer (Phase 2 primitive; can be backfilled by workflow/ops).
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS zone_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conname = 'shipments_zone_id_fkey'
      AND c.conrelid = 'public.shipments'::regclass
  ) THEN
    ALTER TABLE public.shipments
      ADD CONSTRAINT shipments_zone_id_fkey
      FOREIGN KEY (zone_id)
      REFERENCES public.zones(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shipments_zone_id
  ON public.shipments(zone_id)
  WHERE zone_id IS NOT NULL;

COMMENT ON COLUMN public.shipments.zone_id IS 'Resolved zone assignment for routing/sorting (Phase 2).';

CREATE OR REPLACE FUNCTION public.resolve_zone_id_for_canonical_district(
  p_organization_id UUID,
  p_canonical_district_id UUID
)
RETURNS UUID
LANGUAGE sql
STABLE
AS $function$
  SELECT zd.zone_id
  FROM public.zone_districts zd
  JOIN public.zones z ON z.id = zd.zone_id
  WHERE z.organization_id = p_organization_id
    AND z.is_active = TRUE
    AND zd.canonical_district_id = p_canonical_district_id
  LIMIT 1;
$function$;

COMMENT ON FUNCTION public.resolve_zone_id_for_canonical_district(UUID, UUID) IS
  'Resolve zone_id for an org + canonical_district_id using zone_districts mapping (returns NULL when unmapped).';

-- ---------------------------------------------------------------------------
-- Baskets (org-scoped)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.baskets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  zone_id UUID REFERENCES public.zones(id) ON DELETE SET NULL,
  basket_type TEXT, -- lookup category 'basket_type'
  state TEXT NOT NULL, -- lookup category 'basket_state'
  current_count INTEGER NOT NULL DEFAULT 0,
  capacity_count INTEGER,
  expires_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT baskets_current_count_ck CHECK (current_count >= 0),
  CONSTRAINT baskets_capacity_count_ck CHECK (capacity_count IS NULL OR capacity_count >= current_count),
  CONSTRAINT baskets_version_ck CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS idx_baskets_org ON public.baskets(organization_id);
CREATE INDEX IF NOT EXISTS idx_baskets_org_state ON public.baskets(organization_id, state);
CREATE INDEX IF NOT EXISTS idx_baskets_org_zone ON public.baskets(organization_id, zone_id) WHERE zone_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_baskets_expires_at ON public.baskets(expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON TABLE public.baskets IS 'Org-scoped shipment groupings for warehouse sorting/dispatch workflows.';
COMMENT ON COLUMN public.baskets.basket_type IS 'Classification (lookup category basket_type); capacity defaults can be driven from lookup metadata.';
COMMENT ON COLUMN public.baskets.state IS 'Lifecycle state (lookup category basket_state).';
COMMENT ON COLUMN public.baskets.current_count IS 'Cached active item count (synced from basket_items by trigger).';
COMMENT ON COLUMN public.baskets.version IS 'Optimistic locking token for concurrent updates.';

CREATE OR REPLACE FUNCTION public.baskets_apply_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_basket_state_default TEXT;
  v_basket_type_default TEXT;
  v_capacity INT;
BEGIN
  -- basket_state default (required)
  IF NEW.state IS NULL OR btrim(NEW.state) = '' THEN
    SELECT lv.value
    INTO v_basket_state_default
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'basket_state'
      AND lv.status = 'active'
      AND lv.is_default = TRUE
      AND (lv.effective_from IS NULL OR lv.effective_from <= now())
      AND (lv.effective_until IS NULL OR lv.effective_until > now())
    ORDER BY lv.sort_order NULLS LAST, lv.value
    LIMIT 1;

    IF v_basket_state_default IS NULL THEN
      SELECT lv.value
      INTO v_basket_state_default
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
      WHERE ld.category = 'basket_state'
        AND lv.status = 'active'
        AND (lv.effective_from IS NULL OR lv.effective_from <= now())
        AND (lv.effective_until IS NULL OR lv.effective_until > now())
      ORDER BY lv.sort_order NULLS LAST, lv.value
      LIMIT 1;
    END IF;

    IF v_basket_state_default IS NULL THEN
      RAISE EXCEPTION 'baskets: basket_state defaults missing (configure lookup_values for category basket_state)';
    END IF;

    NEW.state := v_basket_state_default;
  END IF;

  -- basket_type default (optional)
  IF NEW.basket_type IS NULL OR btrim(NEW.basket_type) = '' THEN
    SELECT lv.value
    INTO v_basket_type_default
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'basket_type'
      AND lv.status = 'active'
      AND lv.is_default = TRUE
      AND (lv.effective_from IS NULL OR lv.effective_from <= now())
      AND (lv.effective_until IS NULL OR lv.effective_until > now())
    ORDER BY lv.sort_order NULLS LAST, lv.value
    LIMIT 1;

    IF v_basket_type_default IS NOT NULL THEN
      NEW.basket_type := v_basket_type_default;
    END IF;
  END IF;

  -- capacity default from basket_type metadata (optional)
  IF NEW.capacity_count IS NULL AND NEW.basket_type IS NOT NULL AND btrim(NEW.basket_type) <> '' THEN
    SELECT CASE
      WHEN (lv.metadata ? 'default_capacity')
        AND (lv.metadata->>'default_capacity') ~ '^[0-9]+$'
      THEN NULLIF((lv.metadata->>'default_capacity')::INT, 0)
      ELSE NULL
    END
    INTO v_capacity
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'basket_type'
      AND lv.status = 'active'
      AND lv.value = NEW.basket_type
    ORDER BY lv.updated_at DESC NULLS LAST
    LIMIT 1;

    IF v_capacity IS NOT NULL THEN
      NEW.capacity_count := v_capacity;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_baskets_apply_defaults ON public.baskets;
CREATE TRIGGER trg_baskets_apply_defaults
  BEFORE INSERT ON public.baskets
  FOR EACH ROW
  EXECUTE FUNCTION public.baskets_apply_defaults();

CREATE OR REPLACE FUNCTION public.baskets_enforce_zone_org_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_zone_org UUID;
BEGIN
  IF NEW.zone_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT z.organization_id
  INTO v_zone_org
  FROM public.zones z
  WHERE z.id = NEW.zone_id;

  IF v_zone_org IS NULL THEN
    RAISE EXCEPTION 'baskets: zone % not found', NEW.zone_id;
  END IF;

  IF v_zone_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'baskets: organization mismatch (basket org %, zone org %)', NEW.organization_id, v_zone_org;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_baskets_enforce_zone_org_match ON public.baskets;
CREATE TRIGGER trg_baskets_enforce_zone_org_match
  BEFORE INSERT OR UPDATE ON public.baskets
  FOR EACH ROW
  EXECUTE FUNCTION public.baskets_enforce_zone_org_match();

CREATE OR REPLACE FUNCTION public.baskets_bump_version()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.version := COALESCE(OLD.version, 1) + 1;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_baskets_bump_version ON public.baskets;
CREATE TRIGGER trg_baskets_bump_version
  BEFORE UPDATE ON public.baskets
  FOR EACH ROW
  EXECUTE FUNCTION public.baskets_bump_version();

DROP TRIGGER IF EXISTS trg_baskets_set_updated_at ON public.baskets;
CREATE TRIGGER trg_baskets_set_updated_at
  BEFORE UPDATE ON public.baskets
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Basket membership (partition-safe FK to shipments via (id, client_id)).
CREATE TABLE IF NOT EXISTS public.basket_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  basket_id UUID NOT NULL REFERENCES public.baskets(id) ON DELETE CASCADE,
  shipment_id UUID NOT NULL,
  shipment_client_id UUID NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,

  CONSTRAINT basket_items_unique_basket_shipment UNIQUE (basket_id, shipment_id, shipment_client_id),
  CONSTRAINT basket_items_removed_at_ck CHECK (removed_at IS NULL OR removed_at >= added_at),
  CONSTRAINT basket_items_shipments_fk FOREIGN KEY (shipment_id, shipment_client_id)
    REFERENCES public.shipments(id, client_id) ON DELETE RESTRICT
);

-- One active basket per shipment (allows historical removed rows).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_basket_items_one_active_basket_per_shipment
  ON public.basket_items (shipment_id, shipment_client_id)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_basket_items_basket_active ON public.basket_items(basket_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_basket_items_basket_all ON public.basket_items(basket_id, added_at DESC);
CREATE INDEX IF NOT EXISTS idx_basket_items_shipment ON public.basket_items(shipment_id, shipment_client_id);

COMMENT ON TABLE public.basket_items IS 'Basket membership rows; shipments join uses (shipment_id, shipment_client_id) due to partitioning.';

CREATE OR REPLACE FUNCTION public.basket_items_enforce_org_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_basket_org UUID;
  v_capacity_count INT;
  v_shipment_org UUID;
  v_is_activating BOOLEAN := FALSE;
  v_active_count INT;
BEGIN
  -- Capacity enforcement applies when the row is becoming active (removed_at = NULL).
  v_is_activating := (NEW.removed_at IS NULL) AND (
    TG_OP = 'INSERT'
    OR (TG_OP = 'UPDATE' AND OLD.removed_at IS NOT NULL)
  );

  IF v_is_activating THEN
    SELECT b.organization_id, b.capacity_count
    INTO v_basket_org, v_capacity_count
    FROM public.baskets b
    WHERE b.id = NEW.basket_id
    FOR UPDATE;
  ELSE
    SELECT b.organization_id, b.capacity_count
    INTO v_basket_org, v_capacity_count
    FROM public.baskets b
    WHERE b.id = NEW.basket_id;
  END IF;

  IF v_basket_org IS NULL THEN
    RAISE EXCEPTION 'basket_items: basket % not found', NEW.basket_id;
  END IF;

  IF v_is_activating AND v_capacity_count IS NOT NULL AND v_capacity_count > 0 THEN
    SELECT COUNT(*)::INT
    INTO v_active_count
    FROM public.basket_items bi
    WHERE bi.basket_id = NEW.basket_id
      AND bi.removed_at IS NULL;

    IF v_active_count >= v_capacity_count THEN
      RAISE EXCEPTION 'basket_items: basket % at capacity (%/%), cannot add shipment', NEW.basket_id, v_active_count, v_capacity_count;
    END IF;
  END IF;

  SELECT s.organization_id
  INTO v_shipment_org
  FROM public.shipments s
  WHERE s.id = NEW.shipment_id
    AND s.client_id = NEW.shipment_client_id;

  IF v_shipment_org IS NULL THEN
    RAISE EXCEPTION 'basket_items: shipment (%,%) not found', NEW.shipment_id, NEW.shipment_client_id;
  END IF;

  IF v_basket_org IS DISTINCT FROM v_shipment_org THEN
    RAISE EXCEPTION 'basket_items: organization mismatch (basket org %, shipment org %)', v_basket_org, v_shipment_org;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_basket_items_enforce_org_match ON public.basket_items;
CREATE TRIGGER trg_basket_items_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.basket_items
  FOR EACH ROW
  EXECUTE FUNCTION public.basket_items_enforce_org_match();

CREATE OR REPLACE FUNCTION public.basket_items_sync_basket_counts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_basket_id UUID := COALESCE(NEW.basket_id, OLD.basket_id);
  v_count INT;
BEGIN
  IF v_basket_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*)::INT
  INTO v_count
  FROM public.basket_items bi
  WHERE bi.basket_id = v_basket_id
    AND bi.removed_at IS NULL;

  UPDATE public.baskets b
  SET current_count = v_count
  WHERE b.id = v_basket_id;

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_basket_items_sync_basket_counts ON public.basket_items;
CREATE TRIGGER trg_basket_items_sync_basket_counts
  AFTER INSERT OR UPDATE OR DELETE ON public.basket_items
  FOR EACH ROW
  EXECUTE FUNCTION public.basket_items_sync_basket_counts();

-- Basket state transitions (auditable, append-only).
CREATE TABLE IF NOT EXISTS public.basket_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  basket_id UUID NOT NULL REFERENCES public.baskets(id) ON DELETE CASCADE,
  previous_state TEXT,
  new_state TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by UUID REFERENCES public.users(id),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_basket_transitions_basket ON public.basket_transitions(basket_id, changed_at DESC);

COMMENT ON TABLE public.basket_transitions IS 'Audit trail for basket lifecycle state changes.';

CREATE OR REPLACE FUNCTION public.baskets_log_state_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_user UUID := NULL;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_user := auth.uid();
  EXCEPTION
    WHEN others THEN
      v_user := NULL;
  END;

  INSERT INTO public.basket_transitions (basket_id, previous_state, new_state, changed_by, notes)
  VALUES (NEW.id, OLD.state, NEW.state, v_user, NULL);

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_baskets_log_state_transition ON public.baskets;
CREATE TRIGGER trg_baskets_log_state_transition
  AFTER UPDATE OF state ON public.baskets
  FOR EACH ROW
  EXECUTE FUNCTION public.baskets_log_state_transition();

-- ---------------------------------------------------------------------------
-- RLS + least-privilege grants (user-facing tables)
-- ---------------------------------------------------------------------------

ALTER TABLE public.zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zone_districts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baskets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.basket_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.basket_transitions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.zones FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.zone_districts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.baskets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.basket_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.basket_transitions FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zones TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zone_districts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.baskets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.basket_items TO authenticated;
GRANT SELECT ON TABLE public.basket_transitions TO authenticated;

GRANT ALL ON TABLE public.zones TO service_role;
GRANT ALL ON TABLE public.zone_districts TO service_role;
GRANT ALL ON TABLE public.baskets TO service_role;
GRANT ALL ON TABLE public.basket_items TO service_role;
GRANT ALL ON TABLE public.basket_transitions TO service_role;

DROP POLICY IF EXISTS zones_service_policy ON public.zones;
CREATE POLICY zones_service_policy ON public.zones
  FOR ALL TO service_role
  USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS zones_org_policy ON public.zones;
CREATE POLICY zones_org_policy ON public.zones
  FOR ALL TO authenticated
  USING (organization_id = current_user_org_id())
  WITH CHECK (organization_id = current_user_org_id());

DROP POLICY IF EXISTS zone_districts_service_policy ON public.zone_districts;
CREATE POLICY zone_districts_service_policy ON public.zone_districts
  FOR ALL TO service_role
  USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS zone_districts_org_policy ON public.zone_districts;
CREATE POLICY zone_districts_org_policy ON public.zone_districts
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.zones z
      WHERE z.id = public.zone_districts.zone_id
        AND z.organization_id = current_user_org_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.zones z
      WHERE z.id = zone_id
        AND z.organization_id = current_user_org_id()
    )
  );

DROP POLICY IF EXISTS baskets_service_policy ON public.baskets;
CREATE POLICY baskets_service_policy ON public.baskets
  FOR ALL TO service_role
  USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS baskets_org_policy ON public.baskets;
CREATE POLICY baskets_org_policy ON public.baskets
  FOR ALL TO authenticated
  USING (organization_id = current_user_org_id())
  WITH CHECK (organization_id = current_user_org_id());

DROP POLICY IF EXISTS basket_items_service_policy ON public.basket_items;
CREATE POLICY basket_items_service_policy ON public.basket_items
  FOR ALL TO service_role
  USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS basket_items_org_policy ON public.basket_items;
CREATE POLICY basket_items_org_policy ON public.basket_items
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.baskets b
      WHERE b.id = public.basket_items.basket_id
        AND b.organization_id = current_user_org_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.baskets b
      WHERE b.id = basket_id
        AND b.organization_id = current_user_org_id()
    )
  );

DROP POLICY IF EXISTS basket_transitions_service_policy ON public.basket_transitions;
CREATE POLICY basket_transitions_service_policy ON public.basket_transitions
  FOR ALL TO service_role
  USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS basket_transitions_org_select ON public.basket_transitions;
CREATE POLICY basket_transitions_org_select ON public.basket_transitions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.baskets b
      WHERE b.id = public.basket_transitions.basket_id
        AND b.organization_id = current_user_org_id()
    )
  );

-- ---------------------------------------------------------------------------
-- Lookup seeds (dynamic enums)
-- ---------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('basket_state', 'Basket lifecycle states', 'operations', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

-- basket_state values (forming -> ready -> reserved -> dispatched; expired for timeouts)
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
  ('forming', 'Forming', 'Actively being filled with shipments', 1, TRUE,  '{}' ),
  ('ready', 'Ready', 'Ready for assignment/dispatch', 2, FALSE, '{}' ),
  ('reserved', 'Reserved', 'Reserved for a driver/route/window', 3, FALSE, '{}' ),
  ('dispatched', 'Dispatched', 'Handed off for execution', 4, FALSE, '{}' ),
  ('expired', 'Expired', 'Reservation expired; requires reassignment', 5, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'basket_state'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- basket_type values (definition is seeded earlier; keep idempotent)
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
  ('zone_based', 'Zone-Based Basket', 'Basket grouped by zone', 1, TRUE,  '{"icon":"map","default_capacity":50,"priority_weight":1.0}' ),
  ('driver_specific', 'Driver-Specific Basket', 'Basket reserved/owned by a specific driver', 2, FALSE, '{"icon":"user","default_capacity":30,"priority_weight":1.5}' ),
  ('hub_pickup', 'Hub Pickup Basket', 'Customer pickup basket at hub', 3, FALSE, '{"icon":"warehouse","default_capacity":100,"priority_weight":0.8}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'basket_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

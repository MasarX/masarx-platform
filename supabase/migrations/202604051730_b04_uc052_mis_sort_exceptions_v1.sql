-- Plan: B04 UC052 mis-sort exceptions
-- Migration: durable mis-sort exception lane + resolve/reassign RPC
-- Date: 2026-04-05
--
-- Goals:
--   - Surface active basket mis-sorts through a durable RLS-backed relation that
--     generic ui_list_resource_v1 can read.
--   - Keep the resolve action dedicated and resource-specific instead of widening
--     ui_execute_command_v1.
--   - Reassign shipments through the canonical basket-policy substrate rather than
--     direct count/state mutations.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604051730_b04_uc052_mis_sort_exceptions_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

-------------------------------------------------------------------------------
-- 1) Durable active mis-sort relation
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mis_sort_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  shipment_id UUID NOT NULL,
  shipment_client_id UUID NOT NULL,
  basket_item_id UUID NOT NULL UNIQUE REFERENCES public.basket_items(id) ON DELETE CASCADE,
  basket_id UUID NOT NULL REFERENCES public.baskets(id) ON DELETE CASCADE,
  exception_reason TEXT NOT NULL DEFAULT 'basket_assignment_mismatch',
  actual_zone_id UUID REFERENCES public.zones(id) ON DELETE SET NULL,
  expected_zone_id UUID REFERENCES public.zones(id) ON DELETE SET NULL,
  actual_sort_branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  expected_sort_branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  actual_sort_service_key TEXT,
  expected_sort_service_key TEXT,
  actual_sort_route_key TEXT,
  expected_sort_route_key TEXT,
  actual_sort_priority_key TEXT,
  expected_sort_priority_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT mis_sort_exceptions_shipments_fk
    FOREIGN KEY (shipment_id, shipment_client_id)
    REFERENCES public.shipments(id, client_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mis_sort_exceptions_org_detected
  ON public.mis_sort_exceptions (organization_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_mis_sort_exceptions_shipment
  ON public.mis_sort_exceptions (shipment_id, shipment_client_id);

CREATE INDEX IF NOT EXISTS idx_mis_sort_exceptions_basket
  ON public.mis_sort_exceptions (basket_id);

CREATE INDEX IF NOT EXISTS idx_mis_sort_exceptions_actual_zone
  ON public.mis_sort_exceptions (actual_zone_id);

CREATE INDEX IF NOT EXISTS idx_mis_sort_exceptions_expected_zone
  ON public.mis_sort_exceptions (expected_zone_id);

CREATE INDEX IF NOT EXISTS idx_mis_sort_exceptions_actual_sort_branch
  ON public.mis_sort_exceptions (actual_sort_branch_id);

CREATE INDEX IF NOT EXISTS idx_mis_sort_exceptions_expected_sort_branch
  ON public.mis_sort_exceptions (expected_sort_branch_id);

COMMENT ON TABLE public.mis_sort_exceptions IS
  'Active basket-assignment mismatches detected from basket_items versus the canonical basket_policy-derived shipment sort profile.';

COMMENT ON COLUMN public.mis_sort_exceptions.exception_reason IS
  'Stable exception class for the active mis-sort lane.';

DROP TRIGGER IF EXISTS trg_mis_sort_exceptions_set_updated_at ON public.mis_sort_exceptions;
CREATE TRIGGER trg_mis_sort_exceptions_set_updated_at
  BEFORE UPDATE ON public.mis_sort_exceptions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  updated_at_required,
  audit_enabled,
  notes
)
VALUES (
  'public',
  'mis_sort_exceptions',
  TRUE,
  TRUE,
  TRUE,
  'Durable mis-sort exception lane for wrong-basket sortation corrections.'
)
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class rc ON rc.oid = con.confrelid
    WHERE con.contype = 'f'
      AND con.conparentid = 0
      AND n.nspname = 'public'
      AND c.relname = 'mis_sort_exceptions'
      AND rc.relispartition IS TRUE
      AND rc.relname ~ '_p0$'
      AND con.conname = 'mis_sort_exceptions_shipment_id_shipment_client_id_fkey'
  ) THEN
    ALTER TABLE public.mis_sort_exceptions
      DROP CONSTRAINT IF EXISTS mis_sort_exceptions_shipment_id_shipment_client_id_fkey;
  END IF;
END;
$do$;

ALTER TABLE public.mis_sort_exceptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.mis_sort_exceptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.mis_sort_exceptions TO authenticated;
GRANT ALL ON TABLE public.mis_sort_exceptions TO service_role;

DROP POLICY IF EXISTS mis_sort_exceptions_service_policy ON public.mis_sort_exceptions;
CREATE POLICY mis_sort_exceptions_service_policy ON public.mis_sort_exceptions
  FOR ALL TO service_role
  USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS mis_sort_exceptions_org_select ON public.mis_sort_exceptions;
CREATE POLICY mis_sort_exceptions_org_select ON public.mis_sort_exceptions
  FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org_id());

CREATE OR REPLACE VIEW api.mis_sort_exceptions
WITH (security_invoker = true) AS
SELECT * FROM public.mis_sort_exceptions;

REVOKE ALL ON api.mis_sort_exceptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON api.mis_sort_exceptions TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) Canonical basket-profile resolution for durable detection + reassignment
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_shipment_basket_profile_v1(
  p_shipment_id UUID,
  p_shipment_client_id UUID
)
RETURNS TABLE (
  organization_id UUID,
  client_id UUID,
  sender_id UUID,
  zone_id UUID,
  basket_type TEXT,
  open_states TEXT[],
  create_if_missing BOOLEAN,
  capacity_count INTEGER,
  expires_at TIMESTAMPTZ,
  sort_branch_id UUID,
  sort_service_key TEXT,
  sort_route_key TEXT,
  sort_priority_key TEXT,
  reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_ship RECORD;
  v_policy_row RECORD;
  v_has_policy_row BOOLEAN := FALSE;
  v_policy JSONB := '{}'::jsonb;
  v_policy_ctx JSONB := '{}'::jsonb;
  v_enabled BOOLEAN := FALSE;
  v_require_zone BOOLEAN := TRUE;
  v_create_if_missing BOOLEAN := TRUE;
  v_group_by_branch BOOLEAN := FALSE;
  v_group_by_service BOOLEAN := FALSE;
  v_group_by_route BOOLEAN := FALSE;
  v_group_by_priority BOOLEAN := FALSE;
  v_service_match_field TEXT := 'service_level_or_type';
  v_route_key_paths TEXT := NULL;
  v_priority_bands JSONB := '[]'::jsonb;
  v_default_basket_type TEXT := NULL;
  v_default_state TEXT := NULL;
  v_expires_minutes INTEGER := NULL;
  v_capacity_override INTEGER := NULL;
  v_context JSONB := '{}'::jsonb;
  v_priority_band JSONB := NULL;
  v_priority_min NUMERIC := NULL;
  v_priority_max NUMERIC := NULL;
  v_candidate_priority_key TEXT := NULL;
  v_service_level_id UUID := NULL;
  v_has_service_offering BOOLEAN := FALSE;
BEGIN
  SELECT
    s.organization_id,
    s.client_id,
    s.sender_id,
    s.zone_id,
    NULLIF(btrim(s.service_type), '') AS service_type,
    NULLIF(btrim(s.service_level), '') AS service_level,
    s.priority_score,
    COALESCE(s.metadata, '{}'::jsonb) AS metadata
  INTO v_ship
  FROM public.shipments s
  WHERE s.id = p_shipment_id
    AND s.client_id = p_shipment_client_id
  LIMIT 1;

  IF v_ship.organization_id IS NULL THEN
    reason := 'shipment_missing';
    RETURN NEXT;
    RETURN;
  END IF;

  organization_id := v_ship.organization_id;
  client_id := v_ship.client_id;
  sender_id := v_ship.sender_id;
  zone_id := v_ship.zone_id;

  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_ship.organization_id,
    'client_id', v_ship.client_id,
    'sender_id', v_ship.sender_id
  ));

  SELECT *
  INTO v_policy_row
  FROM public.resolve_settings_row_from_context('basket_policy', v_policy_ctx)
  LIMIT 1;

  v_has_policy_row := FOUND;
  IF v_has_policy_row AND v_policy_row.value IS NOT NULL THEN
    v_policy := v_policy_row.value;
  END IF;

  BEGIN
    v_enabled := COALESCE((v_policy->>'enabled')::BOOLEAN, FALSE);
  EXCEPTION WHEN others THEN
    v_enabled := FALSE;
  END;

  IF NOT v_enabled THEN
    reason := 'policy_disabled';
    RETURN NEXT;
    RETURN;
  END IF;

  BEGIN
    v_require_zone := COALESCE((v_policy->>'require_zone')::BOOLEAN, TRUE);
  EXCEPTION WHEN others THEN
    v_require_zone := TRUE;
  END;

  BEGIN
    v_create_if_missing := COALESCE((v_policy->>'create_if_missing')::BOOLEAN, TRUE);
  EXCEPTION WHEN others THEN
    v_create_if_missing := TRUE;
  END;

  BEGIN
    v_group_by_branch := COALESCE((v_policy->>'group_by_branch')::BOOLEAN, FALSE);
  EXCEPTION WHEN others THEN
    v_group_by_branch := FALSE;
  END;

  BEGIN
    v_group_by_service := COALESCE((v_policy->>'group_by_service')::BOOLEAN, FALSE);
  EXCEPTION WHEN others THEN
    v_group_by_service := FALSE;
  END;

  BEGIN
    v_group_by_route := COALESCE((v_policy->>'group_by_route')::BOOLEAN, FALSE);
  EXCEPTION WHEN others THEN
    v_group_by_route := FALSE;
  END;

  BEGIN
    v_group_by_priority := COALESCE((v_policy->>'group_by_priority')::BOOLEAN, FALSE);
  EXCEPTION WHEN others THEN
    v_group_by_priority := FALSE;
  END;

  v_service_match_field := lower(COALESCE(NULLIF(v_policy->>'service_match_field', ''), 'service_level_or_type'));
  IF v_service_match_field NOT IN ('service_level', 'service_type', 'service_level_or_type') THEN
    v_service_match_field := 'service_level_or_type';
  END IF;

  v_route_key_paths := NULLIF(btrim(COALESCE(v_policy->>'route_key_paths', '')), '');

  IF jsonb_typeof(v_policy->'priority_bands') = 'array' THEN
    v_priority_bands := v_policy->'priority_bands';
  END IF;

  BEGIN
    v_expires_minutes := NULLIF(v_policy->>'expires_in_minutes', '')::INT;
  EXCEPTION WHEN others THEN
    v_expires_minutes := NULL;
  END;

  BEGIN
    v_capacity_override := NULLIF(v_policy->>'capacity_count', '')::INT;
  EXCEPTION WHEN others THEN
    v_capacity_override := NULL;
  END;

  basket_type := NULLIF(v_policy->>'basket_type', '');
  IF basket_type IS NULL THEN
    SELECT lv.value
      INTO v_default_basket_type
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'basket_type'
       AND lv.status = 'active'
       AND lv.is_default = TRUE
       AND (lv.effective_from IS NULL OR lv.effective_from <= now())
       AND (lv.effective_until IS NULL OR lv.effective_until > now())
     ORDER BY lv.sort_order NULLS LAST, lv.value
     LIMIT 1;
    basket_type := v_default_basket_type;
  END IF;

  IF v_policy ? 'open_states' AND jsonb_typeof(v_policy->'open_states') = 'array' THEN
    SELECT array_agg(btrim(value))
      INTO open_states
      FROM jsonb_array_elements_text(v_policy->'open_states') AS value
     WHERE btrim(value) <> '';
  END IF;

  IF open_states IS NULL OR array_length(open_states, 1) IS NULL THEN
    SELECT lv.value
      INTO v_default_state
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'basket_state'
       AND lv.status = 'active'
       AND lv.is_default = TRUE
       AND (lv.effective_from IS NULL OR lv.effective_from <= now())
       AND (lv.effective_until IS NULL OR lv.effective_until > now())
     ORDER BY lv.sort_order NULLS LAST, lv.value
     LIMIT 1;

    IF v_default_state IS NULL THEN
      SELECT lv.value
        INTO v_default_state
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'basket_state'
         AND lv.status = 'active'
         AND (lv.effective_from IS NULL OR lv.effective_from <= now())
         AND (lv.effective_until IS NULL OR lv.effective_until > now())
       ORDER BY lv.sort_order NULLS LAST, lv.value
       LIMIT 1;
    END IF;

    IF v_default_state IS NOT NULL THEN
      open_states := ARRAY[v_default_state];
    END IF;
  END IF;

  create_if_missing := v_create_if_missing;
  capacity_count := v_capacity_override;
  expires_at := CASE
    WHEN v_expires_minutes IS NOT NULL AND v_expires_minutes > 0 THEN now() + make_interval(mins => v_expires_minutes)
    ELSE NULL
  END;

  IF v_require_zone AND zone_id IS NULL THEN
    reason := 'zone_missing';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_group_by_branch THEN
    resolve_shipment_basket_profile_v1.sort_branch_id := public.resolve_branch_id_for_zone(resolve_shipment_basket_profile_v1.zone_id);
    IF resolve_shipment_basket_profile_v1.sort_branch_id IS NULL THEN
      reason := 'branch_missing';
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  IF v_group_by_service THEN
    resolve_shipment_basket_profile_v1.sort_service_key := CASE v_service_match_field
      WHEN 'service_level' THEN v_ship.service_level
      WHEN 'service_type' THEN v_ship.service_type
      ELSE COALESCE(v_ship.service_level, v_ship.service_type)
    END;

    IF resolve_shipment_basket_profile_v1.sort_service_key IS NULL THEN
      reason := 'service_missing';
      RETURN NEXT;
      RETURN;
    ELSIF resolve_shipment_basket_profile_v1.sort_branch_id IS NOT NULL AND v_service_match_field <> 'service_type' THEN
      SELECT sl.id
        INTO v_service_level_id
        FROM public.service_levels sl
       WHERE sl.organization_id = v_ship.organization_id
         AND sl.is_active IS TRUE
         AND sl.key = resolve_shipment_basket_profile_v1.sort_service_key
       ORDER BY sl.created_at DESC, sl.id
       LIMIT 1;

      IF v_service_level_id IS NOT NULL THEN
        SELECT EXISTS (
          SELECT 1
            FROM public.service_offerings so
           WHERE so.branch_id = resolve_shipment_basket_profile_v1.sort_branch_id
             AND so.service_level_id = v_service_level_id
             AND so.is_active IS TRUE
             AND so.effective_from <= now()
             AND (so.effective_to IS NULL OR so.effective_to > now())
             AND (
               so.zone_id IS NULL
               OR so.zone_id = resolve_shipment_basket_profile_v1.zone_id
             )
        )
          INTO v_has_service_offering;

        IF NOT v_has_service_offering THEN
          reason := 'branch_service_unavailable';
          RETURN NEXT;
          RETURN;
        END IF;
      END IF;
    END IF;
  END IF;

  IF v_group_by_route THEN
    IF v_route_key_paths IS NULL THEN
      reason := 'route_policy_missing';
      RETURN NEXT;
      RETURN;
    END IF;

    v_context := jsonb_build_object(
      'routing', COALESCE(v_ship.metadata->'routing', '{}'::jsonb),
      'dispatch', COALESCE(v_ship.metadata->'dispatch', '{}'::jsonb),
      'shipment', v_ship.metadata
    );

    resolve_shipment_basket_profile_v1.sort_route_key := NULLIF(
      btrim(COALESCE(workflow_handlers.resolve_path_text(v_context, v_route_key_paths), '')),
      ''
    );

    IF resolve_shipment_basket_profile_v1.sort_route_key IS NULL THEN
      reason := 'route_missing';
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  IF v_group_by_priority THEN
    IF v_ship.priority_score IS NULL THEN
      reason := 'priority_missing';
      RETURN NEXT;
      RETURN;
    ELSIF jsonb_typeof(v_priority_bands) IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_priority_bands) = 0 THEN
      reason := 'priority_policy_missing';
      RETURN NEXT;
      RETURN;
    ELSE
      FOR v_priority_band IN
        SELECT value FROM jsonb_array_elements(v_priority_bands)
      LOOP
        v_candidate_priority_key := NULLIF(btrim(COALESCE(v_priority_band->>'key', '')), '');
        IF v_candidate_priority_key IS NULL THEN
          CONTINUE;
        END IF;

        BEGIN
          v_priority_min := NULLIF(v_priority_band->>'min_score', '')::NUMERIC;
        EXCEPTION WHEN others THEN
          v_priority_min := NULL;
        END;

        BEGIN
          v_priority_max := NULLIF(v_priority_band->>'max_score', '')::NUMERIC;
        EXCEPTION WHEN others THEN
          v_priority_max := NULL;
        END;

        IF (v_priority_min IS NULL OR v_ship.priority_score >= v_priority_min)
           AND (v_priority_max IS NULL OR v_ship.priority_score <= v_priority_max) THEN
          resolve_shipment_basket_profile_v1.sort_priority_key := v_candidate_priority_key;
          EXIT;
        END IF;
      END LOOP;

      IF resolve_shipment_basket_profile_v1.sort_priority_key IS NULL THEN
        reason := 'priority_bucket_missing';
        RETURN NEXT;
        RETURN;
      END IF;
    END IF;
  END IF;

  reason := NULL;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.resolve_shipment_basket_profile_v1(UUID, UUID) IS
  'Resolve the canonical basket-policy profile for a shipment without mutating assignment state.';

CREATE OR REPLACE FUNCTION public.sync_mis_sort_exception_v1(
  p_basket_item_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_item RECORD;
  v_profile RECORD;
  v_mismatch BOOLEAN := FALSE;
  v_exception_id UUID := NULL;
BEGIN
  IF p_basket_item_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT
    bi.id,
    bi.basket_id,
    bi.shipment_id,
    bi.shipment_client_id,
    bi.removed_at,
    b.organization_id,
    b.zone_id AS actual_zone_id,
    b.sort_branch_id AS actual_sort_branch_id,
    b.sort_service_key AS actual_sort_service_key,
    b.sort_route_key AS actual_sort_route_key,
    b.sort_priority_key AS actual_sort_priority_key
  INTO v_item
  FROM public.basket_items bi
  JOIN public.baskets b ON b.id = bi.basket_id
  WHERE bi.id = p_basket_item_id
  LIMIT 1;

  IF v_item.id IS NULL OR v_item.removed_at IS NOT NULL THEN
    DELETE FROM public.mis_sort_exceptions mse
     WHERE mse.basket_item_id = p_basket_item_id;
    RETURN NULL;
  END IF;

  SELECT *
    INTO v_profile
    FROM public.resolve_shipment_basket_profile_v1(v_item.shipment_id, v_item.shipment_client_id)
   LIMIT 1;

  IF v_profile.reason IS NOT NULL THEN
    DELETE FROM public.mis_sort_exceptions mse
     WHERE mse.basket_item_id = p_basket_item_id;
    RETURN NULL;
  END IF;

  v_mismatch :=
    v_item.actual_zone_id IS DISTINCT FROM v_profile.zone_id
    OR v_item.actual_sort_branch_id IS DISTINCT FROM v_profile.sort_branch_id
    OR v_item.actual_sort_service_key IS DISTINCT FROM v_profile.sort_service_key
    OR v_item.actual_sort_route_key IS DISTINCT FROM v_profile.sort_route_key
    OR v_item.actual_sort_priority_key IS DISTINCT FROM v_profile.sort_priority_key;

  IF NOT v_mismatch THEN
    DELETE FROM public.mis_sort_exceptions mse
     WHERE mse.basket_item_id = p_basket_item_id;
    RETURN NULL;
  END IF;

  INSERT INTO public.mis_sort_exceptions (
    organization_id,
    shipment_id,
    shipment_client_id,
    basket_item_id,
    basket_id,
    exception_reason,
    actual_zone_id,
    expected_zone_id,
    actual_sort_branch_id,
    expected_sort_branch_id,
    actual_sort_service_key,
    expected_sort_service_key,
    actual_sort_route_key,
    expected_sort_route_key,
    actual_sort_priority_key,
    expected_sort_priority_key,
    metadata,
    detected_at,
    updated_at
  )
  VALUES (
    v_item.organization_id,
    v_item.shipment_id,
    v_item.shipment_client_id,
    v_item.id,
    v_item.basket_id,
    'basket_assignment_mismatch',
    v_item.actual_zone_id,
    v_profile.zone_id,
    v_item.actual_sort_branch_id,
    v_profile.sort_branch_id,
    v_item.actual_sort_service_key,
    v_profile.sort_service_key,
    v_item.actual_sort_route_key,
    v_profile.sort_route_key,
    v_item.actual_sort_priority_key,
    v_profile.sort_priority_key,
    jsonb_strip_nulls(jsonb_build_object(
      'basket_type', v_profile.basket_type,
      'open_states', v_profile.open_states
    )),
    now(),
    now()
  )
  ON CONFLICT (basket_item_id) DO UPDATE
     SET basket_id = EXCLUDED.basket_id,
         exception_reason = EXCLUDED.exception_reason,
         actual_zone_id = EXCLUDED.actual_zone_id,
         expected_zone_id = EXCLUDED.expected_zone_id,
         actual_sort_branch_id = EXCLUDED.actual_sort_branch_id,
         expected_sort_branch_id = EXCLUDED.expected_sort_branch_id,
         actual_sort_service_key = EXCLUDED.actual_sort_service_key,
         expected_sort_service_key = EXCLUDED.expected_sort_service_key,
         actual_sort_route_key = EXCLUDED.actual_sort_route_key,
         expected_sort_route_key = EXCLUDED.expected_sort_route_key,
         actual_sort_priority_key = EXCLUDED.actual_sort_priority_key,
         expected_sort_priority_key = EXCLUDED.expected_sort_priority_key,
         metadata = EXCLUDED.metadata,
         detected_at = EXCLUDED.detected_at,
         updated_at = now()
  RETURNING id INTO v_exception_id;

  RETURN v_exception_id;
END;
$function$;

COMMENT ON FUNCTION public.sync_mis_sort_exception_v1(UUID) IS
  'Create, refresh, or clear the active mis-sort exception row for one basket_item.';

CREATE OR REPLACE FUNCTION public.sync_shipment_mis_sort_exceptions_v1(
  p_shipment_id UUID,
  p_shipment_client_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_row RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR v_row IN
    SELECT bi.id
      FROM public.basket_items bi
     WHERE bi.shipment_id = p_shipment_id
       AND bi.shipment_client_id = p_shipment_client_id
       AND bi.removed_at IS NULL
  LOOP
    PERFORM public.sync_mis_sort_exception_v1(v_row.id);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_basket_mis_sort_exceptions_v1(
  p_basket_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_row RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR v_row IN
    SELECT bi.id
      FROM public.basket_items bi
     WHERE bi.basket_id = p_basket_id
       AND bi.removed_at IS NULL
  LOOP
    PERFORM public.sync_mis_sort_exception_v1(v_row.id);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_basket_items_sync_mis_sort_exceptions_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.mis_sort_exceptions WHERE basket_item_id = OLD.id;
    RETURN NULL;
  END IF;

  PERFORM public.sync_mis_sort_exception_v1(NEW.id);
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_basket_items_sync_mis_sort_exceptions ON public.basket_items;
CREATE TRIGGER trg_basket_items_sync_mis_sort_exceptions
  AFTER INSERT OR UPDATE OF basket_id, shipment_id, shipment_client_id, removed_at OR DELETE
  ON public.basket_items
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_basket_items_sync_mis_sort_exceptions_v1();

CREATE OR REPLACE FUNCTION public.trg_shipments_sync_mis_sort_exceptions_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
BEGIN
  PERFORM public.sync_shipment_mis_sort_exceptions_v1(NEW.id, NEW.client_id);
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_shipments_sync_mis_sort_exceptions ON public.shipments;
CREATE TRIGGER trg_shipments_sync_mis_sort_exceptions
  AFTER UPDATE OF zone_id, service_type, service_level, priority_score, metadata
  ON public.shipments
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_shipments_sync_mis_sort_exceptions_v1();

CREATE OR REPLACE FUNCTION public.trg_baskets_sync_mis_sort_exceptions_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
BEGIN
  PERFORM public.sync_basket_mis_sort_exceptions_v1(NEW.id);
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_baskets_sync_mis_sort_exceptions ON public.baskets;
CREATE TRIGGER trg_baskets_sync_mis_sort_exceptions
  AFTER UPDATE OF zone_id, sort_branch_id, sort_service_key, sort_route_key, sort_priority_key
  ON public.baskets
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_baskets_sync_mis_sort_exceptions_v1();

-------------------------------------------------------------------------------
-- 3) Resolve/reassign path
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_mis_sort_exception_v1(
  p_exception_id UUID,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  exception_id UUID,
  shipment_id UUID,
  previous_basket_id UUID,
  basket_id UUID,
  basket_item_id UUID,
  status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_exception RECORD;
  v_profile RECORD;
  v_new_basket_id UUID := NULL;
  v_new_basket_item_id UUID := NULL;
  v_existing_basket_id UUID := NULL;
  v_now TIMESTAMPTZ := now();
BEGIN
  SELECT *
    INTO v_exception
    FROM public.mis_sort_exceptions mse
   WHERE mse.id = p_exception_id
   LIMIT 1;

  IF v_exception.id IS NULL THEN
    RAISE EXCEPTION 'resolve_mis_sort_exception_v1 exception % not found', p_exception_id
      USING ERRCODE = '23503';
  END IF;

  SELECT *
    INTO v_profile
    FROM public.resolve_shipment_basket_profile_v1(v_exception.shipment_id, v_exception.shipment_client_id)
   LIMIT 1;

  IF v_profile.reason IS NOT NULL THEN
    RAISE EXCEPTION 'resolve_mis_sort_exception_v1 cannot resolve target: %', v_profile.reason
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.basket_items
     SET removed_at = COALESCE(removed_at, v_now)
   WHERE id = v_exception.basket_item_id
     AND removed_at IS NULL;

  SELECT b.id
    INTO v_new_basket_id
    FROM public.baskets b
   WHERE b.organization_id = v_profile.organization_id
     AND (v_profile.zone_id IS NULL OR b.zone_id = v_profile.zone_id)
     AND (v_profile.basket_type IS NULL OR b.basket_type = v_profile.basket_type)
     AND (v_profile.open_states IS NULL OR b.state = ANY(v_profile.open_states))
     AND (b.expires_at IS NULL OR b.expires_at > v_now)
     AND (b.capacity_count IS NULL OR b.current_count < b.capacity_count)
     AND b.sort_branch_id IS NOT DISTINCT FROM v_profile.sort_branch_id
     AND b.sort_service_key IS NOT DISTINCT FROM v_profile.sort_service_key
     AND b.sort_route_key IS NOT DISTINCT FROM v_profile.sort_route_key
     AND b.sort_priority_key IS NOT DISTINCT FROM v_profile.sort_priority_key
   ORDER BY b.updated_at DESC NULLS LAST, b.created_at DESC, b.id
   LIMIT 1;

  IF v_new_basket_id IS NULL AND COALESCE(v_profile.create_if_missing, TRUE) THEN
    INSERT INTO public.baskets (
      organization_id,
      zone_id,
      basket_type,
      capacity_count,
      expires_at,
      sort_branch_id,
      sort_service_key,
      sort_route_key,
      sort_priority_key
    )
    VALUES (
      v_profile.organization_id,
      v_profile.zone_id,
      v_profile.basket_type,
      v_profile.capacity_count,
      v_profile.expires_at,
      v_profile.sort_branch_id,
      v_profile.sort_service_key,
      v_profile.sort_route_key,
      v_profile.sort_priority_key
    )
    RETURNING id INTO v_new_basket_id;
  END IF;

  IF v_new_basket_id IS NULL THEN
    RAISE EXCEPTION 'resolve_mis_sort_exception_v1 no basket target available'
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    INSERT INTO public.basket_items (
      basket_id,
      shipment_id,
      shipment_client_id
    )
    VALUES (
      v_new_basket_id,
      v_exception.shipment_id,
      v_exception.shipment_client_id
    )
    RETURNING id INTO v_new_basket_item_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT bi.id, bi.basket_id
        INTO v_new_basket_item_id, v_existing_basket_id
        FROM public.basket_items bi
       WHERE bi.shipment_id = v_exception.shipment_id
         AND bi.shipment_client_id = v_exception.shipment_client_id
         AND bi.removed_at IS NULL
       ORDER BY bi.added_at DESC
       LIMIT 1;

      v_new_basket_id := COALESCE(v_existing_basket_id, v_new_basket_id);
  END;

  INSERT INTO public.shipment_actions (
    id,
    shipment_id,
    organization_id,
    client_id,
    action_type,
    action_category,
    action_data,
    timestamp,
    created_at,
    performed_by_system
  )
  VALUES (
    gen_random_uuid(),
    v_exception.shipment_id,
    v_exception.organization_id,
    v_exception.shipment_client_id,
    'mis_sort_resolved',
    'operational',
    jsonb_strip_nulls(jsonb_build_object(
      'mis_sort_exception_id', v_exception.id,
      'previous_basket_id', v_exception.basket_id,
      'basket_id', v_new_basket_id,
      'basket_item_id', v_new_basket_item_id
    )),
    v_now,
    v_now,
    'workflow_engine'
  );

  DELETE FROM public.mis_sort_exceptions mse
   WHERE mse.id = v_exception.id
      OR mse.basket_item_id = v_exception.basket_item_id;

  exception_id := v_exception.id;
  shipment_id := v_exception.shipment_id;
  previous_basket_id := v_exception.basket_id;
  basket_id := v_new_basket_id;
  basket_item_id := v_new_basket_item_id;
  status := 'reassigned';
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.resolve_mis_sort_exception_v1(UUID, JSONB) IS
  'Resolve one active mis-sort exception by clearing the wrong basket membership and reassigning the shipment via basket_policy-derived selection.';

CREATE OR REPLACE FUNCTION public.ui_execute_mis_sort_exception_resolve_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB := NULL;
  v_capability TEXT := NULL;
  v_selection JSONB := '{}'::jsonb;
  v_mode TEXT := '';
  v_min INT := 0;
  v_max INT := NULL;
  v_count INT := 0;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_selection_uuid UUID := NULL;
  v_selection_id_text TEXT := NULL;
  v_results JSONB := '[]'::jsonb;
  v_result RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_mis_sort_exception_resolve_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_mis_sort_exception_resolve_v1 requires action key';
  END IF;
  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_mis_sort_exception_resolve_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_mis_sort_exception_resolve_v1 unknown command %', p_action_key;
  END IF;

  v_capability := NULLIF(v_command->>'capability', '');
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_selection := COALESCE(v_command->'selection', '{}'::jsonb);
  v_mode := lower(COALESCE(NULLIF(v_selection->>'mode', ''), ''));
  v_min := COALESCE(
    NULLIF(v_selection->>'min_count', '')::INT,
    CASE WHEN v_mode IN ('none', 'any') THEN 0 ELSE 1 END
  );
  v_max := COALESCE(
    NULLIF(v_selection->>'max_count', '')::INT,
    CASE WHEN v_mode = 'single' THEN 1 ELSE NULL END
  );

  IF v_id IS NOT NULL AND array_length(v_ids, 1) IS NULL THEN
    v_ids := ARRAY[v_id];
  END IF;

  IF v_ids IS NOT NULL AND array_length(v_ids, 1) IS NOT NULL THEN
    v_count := array_length(v_ids, 1);
  ELSIF v_id IS NOT NULL THEN
    v_count := 1;
  ELSE
    v_count := COALESCE(p_selection_count, 0);
  END IF;

  IF v_min IS NOT NULL AND v_count < v_min THEN
    RAISE EXCEPTION 'ui_execute_mis_sort_exception_resolve_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_mis_sort_exception_resolve_v1 selection above maximum %', v_max;
  END IF;

  FOREACH v_selection_id_text IN ARRAY v_ids LOOP
    BEGIN
      v_selection_uuid := NULLIF(btrim(v_selection_id_text), '')::UUID;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'ui_execute_mis_sort_exception_resolve_v1 invalid exception id %', v_selection_id_text;
    END;

    IF v_selection_uuid IS NULL THEN
      CONTINUE;
    END IF;

    IF public.ui_get_resource_v1(p_resource_key, v_selection_uuid) IS NULL THEN
      RAISE EXCEPTION
        'ui_execute_mis_sort_exception_resolve_v1 exception % is not visible in resource %',
        v_selection_uuid,
        p_resource_key
        USING ERRCODE = '42501';
    END IF;

    SELECT *
      INTO v_result
      FROM public.resolve_mis_sort_exception_v1(v_selection_uuid, COALESCE(p_params, '{}'::jsonb))
     LIMIT 1;

    v_results := v_results || jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'exception_id', v_result.exception_id,
          'shipment_id', v_result.shipment_id,
          'previous_basket_id', v_result.previous_basket_id,
          'basket_id', v_result.basket_id,
          'basket_item_id', v_result.basket_item_id,
          'status', v_result.status
        )
      )
    );
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'resolved',
    'action_key', p_action_key,
    'resource_key', p_resource_key,
    'count', jsonb_array_length(v_results),
    'items', v_results
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_mis_sort_exception_resolve_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) IS
  'Resolve visible mis_sort_exceptions from Console or Portal without widening ui_execute_command_v1.';

CREATE OR REPLACE FUNCTION api.ui_execute_mis_sort_exception_resolve_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
  SELECT public.ui_execute_mis_sort_exception_resolve_v1($1, $2, $3, $4, $5, $6);
$$;

REVOKE ALL ON FUNCTION public.resolve_shipment_basket_profile_v1(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_shipment_basket_profile_v1(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_shipment_basket_profile_v1(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_shipment_basket_profile_v1(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.sync_mis_sort_exception_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_mis_sort_exception_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.sync_mis_sort_exception_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sync_mis_sort_exception_v1(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.sync_shipment_mis_sort_exceptions_v1(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_shipment_mis_sort_exceptions_v1(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.sync_shipment_mis_sort_exceptions_v1(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sync_shipment_mis_sort_exceptions_v1(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.sync_basket_mis_sort_exceptions_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_basket_mis_sort_exceptions_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.sync_basket_mis_sort_exceptions_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sync_basket_mis_sort_exceptions_v1(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.resolve_mis_sort_exception_v1(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_mis_sort_exception_v1(UUID, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_mis_sort_exception_v1(UUID, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_mis_sort_exception_v1(UUID, JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.ui_execute_mis_sort_exception_resolve_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_mis_sort_exception_resolve_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_mis_sort_exception_resolve_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_execute_mis_sort_exception_resolve_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_mis_sort_exception_resolve_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_mis_sort_exception_resolve_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 4) access_control_policy: mis_sort_exceptions resource map
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_resource_map JSONB := '{}'::jsonb;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
    IF jsonb_typeof(v_resource_map) IS DISTINCT FROM 'object' THEN
      v_resource_map := '{}'::jsonb;
    END IF;

    v_resource_map := jsonb_set(
      v_resource_map,
      '{mis_sort_exceptions}',
      jsonb_build_object('read', 'baskets.read', 'write', 'baskets.write'),
      TRUE
    );

    v_next := jsonb_set(v_current, '{resource_map}', v_resource_map, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Wire mis_sort_exceptions through existing baskets capabilities.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

-------------------------------------------------------------------------------
-- 5) ui_read_registry + ui_command_registry
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_resources JSONB := '[]'::jsonb;
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB := NULL;
  v_resource_key TEXT := NULL;
  v_canonical_resource JSONB := jsonb_build_object(
    'key', 'mis_sort_exceptions',
    'label', 'Mis-sort exceptions',
    'relation', 'public.mis_sort_exceptions',
    'id_column', 'id',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'capability_read', 'baskets.read',
    'capability_write', 'baskets.write',
    'select', jsonb_build_array(
      'id',
      'organization_id',
      'shipment_id',
      'shipment_client_id',
      'basket_item_id',
      'basket_id',
      'exception_reason',
      'actual_zone_id',
      'expected_zone_id',
      'actual_sort_branch_id',
      'expected_sort_branch_id',
      'actual_sort_service_key',
      'expected_sort_service_key',
      'actual_sort_route_key',
      'expected_sort_route_key',
      'actual_sort_priority_key',
      'expected_sort_priority_key',
      'detected_at',
      'updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'shipment_id', 'column', 'shipment_id', 'op', 'eq'),
      jsonb_build_object('key', 'basket_id', 'column', 'basket_id', 'op', 'eq'),
      jsonb_build_object('key', 'exception_reason', 'column', 'exception_reason', 'op', 'eq'),
      jsonb_build_object('key', 'actual_sort_route_key', 'column', 'actual_sort_route_key', 'op', 'eq'),
      jsonb_build_object('key', 'expected_sort_route_key', 'column', 'expected_sort_route_key', 'op', 'eq')
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'shipment_id', 'label', 'Shipment', 'render_type', 'id', 'detail_section', 'Shipment'),
      jsonb_build_object('key', 'exception_reason', 'label', 'Exception reason', 'detail_section', 'Summary'),
      jsonb_build_object('key', 'actual_zone_id', 'label', 'Actual zone', 'render_type', 'id', 'detail_section', 'Actual assignment'),
      jsonb_build_object('key', 'expected_zone_id', 'label', 'Expected zone', 'render_type', 'id', 'detail_section', 'Expected assignment'),
      jsonb_build_object('key', 'actual_sort_route_key', 'label', 'Actual route key', 'detail_section', 'Actual assignment'),
      jsonb_build_object('key', 'expected_sort_route_key', 'label', 'Expected route key', 'detail_section', 'Expected assignment'),
      jsonb_build_object('key', 'actual_sort_service_key', 'label', 'Actual service key', 'detail_section', 'Actual assignment'),
      jsonb_build_object('key', 'expected_sort_service_key', 'label', 'Expected service key', 'detail_section', 'Expected assignment'),
      jsonb_build_object('key', 'actual_sort_priority_key', 'label', 'Actual priority key', 'detail_section', 'Actual assignment'),
      jsonb_build_object('key', 'expected_sort_priority_key', 'label', 'Expected priority key', 'detail_section', 'Expected assignment'),
      jsonb_build_object('key', 'detected_at', 'label', 'Detected at', 'detail_section', 'Summary')
    ),
    'column_labels', jsonb_build_object(
      'shipment_id', 'Shipment',
      'exception_reason', 'Exception reason',
      'actual_zone_id', 'Actual zone',
      'expected_zone_id', 'Expected zone',
      'actual_sort_branch_id', 'Actual branch',
      'expected_sort_branch_id', 'Expected branch',
      'actual_sort_service_key', 'Actual service key',
      'expected_sort_service_key', 'Expected service key',
      'actual_sort_route_key', 'Actual route key',
      'expected_sort_route_key', 'Expected route key',
      'actual_sort_priority_key', 'Actual priority key',
      'expected_sort_priority_key', 'Expected priority key',
      'detected_at', 'Detected at'
    ),
    'default_sort', jsonb_build_object('column', 'detected_at', 'direction', 'desc')
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    v_updated_resources := '[]'::jsonb;
    FOR v_resource IN
      SELECT value
      FROM jsonb_array_elements(v_resources) AS value
    LOOP
      v_resource_key := NULLIF(btrim(COALESCE(v_resource->>'key', '')), '');
      IF v_resource_key = 'mis_sort_exceptions' THEN
        v_resource := public.deep_merge_jsonb(v_canonical_resource, v_resource);
      END IF;
      v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_updated_resources) AS item
      WHERE item->>'key' = 'mis_sort_exceptions'
    ) THEN
      v_updated_resources := v_updated_resources || jsonb_build_array(v_canonical_resource);
    END IF;

    v_next := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose mis_sort_exceptions through ui_read_registry.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

DO $do$
DECLARE
  v_canonical_commands JSONB := '{}'::jsonb;
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_commands JSONB := '[]'::jsonb;
  v_next_commands JSONB := '[]'::jsonb;
  v_command JSONB := NULL;
  v_command_key TEXT := NULL;
BEGIN
  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['mis_sort_exceptions.resolve_reassign'],
    jsonb_build_object(
      'key', 'mis_sort_exceptions.resolve_reassign',
      'label', 'Reassign shipment',
      'description', 'Remove the shipment from the wrong basket and move it to the current basket-policy target.',
      'capability', 'baskets.write',
      'schema_category', 'resource:mis_sort_exceptions',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_mis_sort_exception_resolve_v1',
        'confirm', jsonb_build_object(
          'title', 'Reassign mis-sort?',
          'description', 'This removes the shipment from the wrong basket and reassigns it using the current basket policy.',
          'confirm_label', 'Reassign shipment',
          'cancel_label', 'Cancel',
          'tone', 'primary'
        )
      )
    ),
    TRUE
  );

  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      v_commands := '[]'::jsonb;
    END IF;

    v_next_commands := '[]'::jsonb;
    FOR v_command IN
      SELECT value
      FROM jsonb_array_elements(v_commands) AS value
    LOOP
      v_command_key := NULLIF(btrim(COALESCE(v_command->>'key', '')), '');
      IF v_command_key = 'mis_sort_exceptions.resolve_reassign' THEN
        v_command := public.deep_merge_jsonb(v_canonical_commands->v_command_key, v_command);
      END IF;
      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_next_commands) AS item
      WHERE item->>'key' = 'mis_sort_exceptions.resolve_reassign'
    ) THEN
      v_next_commands := v_next_commands || jsonb_build_array(v_canonical_commands->'mis_sort_exceptions.resolve_reassign');
    END IF;

    v_next := jsonb_set(v_current, '{commands}', v_next_commands, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose mis_sort_exceptions resolve command through ui_command_registry.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

-------------------------------------------------------------------------------
-- 6) ui_navigation
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_console_item JSONB := jsonb_build_object(
    'id', 'console-mis-sort-exceptions',
    'label', 'Mis-sort exceptions',
    'href', '/console/operations/exceptions/mis_sort_exceptions',
    'resource', 'mis_sort_exceptions',
    'capability', 'baskets.read'
  );
  v_portal_item JSONB := jsonb_build_object(
    'id', 'portal-mis-sort-exceptions',
    'label', 'Mis-sort exceptions',
    'href', '/portal/operations/exceptions/mis_sort_exceptions',
    'resource', 'mis_sort_exceptions',
    'capability', 'baskets.read'
  );
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_app_key TEXT := NULL;
  v_sections JSONB := '[]'::jsonb;
  v_updated_sections JSONB := '[]'::jsonb;
  v_section JSONB := NULL;
  v_items JSONB := '[]'::jsonb;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value,
      s.scope_type
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_next := v_current;

    FOR v_app_key IN
      SELECT unnest(ARRAY['console', 'portal'])
    LOOP
      v_sections := COALESCE(v_next #> ARRAY['apps', v_app_key, 'sections'], '[]'::jsonb);
      IF jsonb_typeof(v_sections) IS DISTINCT FROM 'array' THEN
        CONTINUE;
      END IF;

      v_updated_sections := '[]'::jsonb;
      FOR v_section IN
        SELECT value
        FROM jsonb_array_elements(v_sections) AS value
      LOOP
        IF v_section->>'id' = 'operations' THEN
          v_items := COALESCE(v_section->'items', '[]'::jsonb);
          IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
            v_items := '[]'::jsonb;
          END IF;

          v_items := (
            SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
            FROM jsonb_array_elements(v_items) AS item
            WHERE COALESCE(item->>'resource', '') <> 'mis_sort_exceptions'
              AND COALESCE(item->>'id', '') <> CASE
                WHEN v_app_key = 'console' THEN 'console-mis-sort-exceptions'
                ELSE 'portal-mis-sort-exceptions'
              END
          );

          v_items := v_items || jsonb_build_array(
            CASE
              WHEN v_app_key = 'console' THEN v_console_item
              ELSE v_portal_item
            END
          );

          v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
        END IF;

        v_updated_sections := v_updated_sections || jsonb_build_array(v_section);
      END LOOP;

      v_next := jsonb_set(v_next, ARRAY['apps', v_app_key, 'sections'], v_updated_sections, TRUE);
    END LOOP;

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose mis_sort_exceptions through ui_navigation.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604051730_b04_uc052_mis_sort_exceptions_v1'));
COMMIT;

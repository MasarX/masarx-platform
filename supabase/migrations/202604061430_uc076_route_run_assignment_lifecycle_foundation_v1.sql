-- Migration: UC076 route run assignment lifecycle foundation v1
-- Purpose:
--   - Establish the authoritative assignment projection + event ledger for route runs.
--   - Keep assignment lifecycle browser-safe through api.route_runs and a dedicated UI RPC.
--   - Sync internal-driver assignment into route_stop_execute tasks through Tasks SSOT.
--   - Leave explicit status vocabulary for UC080 follow-on acceptance/refusal work.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604061430_uc076_route_run_assignment_lifecycle_foundation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookup seeds
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('route_assignment_status', 'Route assignment lifecycle status for dispatch execution ownership.', 'dispatch', 'tier_1', TRUE),
  ('route_assignment_mode', 'Route assignment ownership mode for internal driver vs partner fleet.', 'dispatch', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  seeded.value,
  seeded.label,
  seeded.description,
  seeded.sort_order,
  seeded.is_default,
  seeded.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (
  VALUES
    ('route_assignment_status', 'assigned', 'Assigned', 'Assignment created and awaiting downstream acknowledgement.', 10, TRUE, '{}'),
    ('route_assignment_status', 'accepted', 'Accepted', 'Assignment accepted by the executor.', 20, FALSE, '{}'),
    ('route_assignment_status', 'acknowledged', 'Acknowledged', 'Assignment acknowledged as seen by the executor.', 30, FALSE, '{}'),
    ('route_assignment_status', 'refused', 'Refused', 'Assignment refused and awaiting reassignment.', 40, FALSE, '{}'),
    ('route_assignment_mode', 'internal_driver', 'Internal driver', 'Route run assigned to an internal driver user.', 10, TRUE, '{}'),
    ('route_assignment_mode', 'partner_fleet', 'Partner fleet', 'Route run assigned to an external partner fleet contract.', 20, FALSE, '{}')
) AS seeded(category, value, label, description, sort_order, is_default, metadata)
WHERE ld.category = seeded.category
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Assignment projection + event ledger
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.route_run_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  route_run_id UUID NOT NULL UNIQUE REFERENCES public.route_runs(id) ON DELETE CASCADE,
  assignment_status TEXT NOT NULL DEFAULT 'assigned',
  assignment_mode TEXT NOT NULL,
  driver_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  vehicle_id UUID REFERENCES public.vehicles(id) ON DELETE SET NULL,
  partner JSONB,
  assignment_version INT NOT NULL DEFAULT 1,
  assigned_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT route_run_assignments_status_ck CHECK (btrim(assignment_status) <> '' AND assignment_status = lower(assignment_status)),
  CONSTRAINT route_run_assignments_mode_ck CHECK (btrim(assignment_mode) <> '' AND assignment_mode = lower(assignment_mode)),
  CONSTRAINT route_run_assignments_version_ck CHECK (assignment_version > 0),
  CONSTRAINT route_run_assignments_partner_object_ck CHECK (partner IS NULL OR jsonb_typeof(partner) = 'object'),
  CONSTRAINT route_run_assignments_metadata_object_ck CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT route_run_assignments_internal_driver_ck CHECK (
    (
      assignment_mode = 'internal_driver'
      AND driver_user_id IS NOT NULL
      AND partner IS NULL
    )
    OR assignment_mode <> 'internal_driver'
  ),
  CONSTRAINT route_run_assignments_partner_mode_ck CHECK (
    (
      assignment_mode = 'partner_fleet'
      AND driver_user_id IS NULL
      AND vehicle_id IS NULL
      AND partner IS NOT NULL
      AND jsonb_strip_nulls(partner) <> '{}'::jsonb
    )
    OR assignment_mode <> 'partner_fleet'
  )
);

CREATE INDEX IF NOT EXISTS idx_route_run_assignments_org_status
  ON public.route_run_assignments (organization_id, assignment_status, assigned_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_run_assignments_org_driver
  ON public.route_run_assignments (organization_id, driver_user_id, assigned_at DESC)
  WHERE driver_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.route_run_assignments_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_route_run_org UUID := NULL;
  v_driver_org UUID := NULL;
  v_vehicle_org UUID := NULL;
BEGIN
  SELECT rr.organization_id
    INTO v_route_run_org
    FROM public.route_runs rr
   WHERE rr.id = NEW.route_run_id;

  IF v_route_run_org IS NULL THEN
    RAISE EXCEPTION 'route_run_assignments: route_run % not found', NEW.route_run_id
      USING ERRCODE = '23503';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_route_run_org THEN
    RAISE EXCEPTION 'route_run_assignments: organization mismatch (assignment org %, route_run org %)', NEW.organization_id, v_route_run_org
      USING ERRCODE = '23514';
  END IF;

  IF NEW.driver_user_id IS NOT NULL THEN
    SELECT u.organization_id
      INTO v_driver_org
      FROM public.users u
     WHERE u.id = NEW.driver_user_id;

    IF v_driver_org IS NULL THEN
      RAISE EXCEPTION 'route_run_assignments: driver user % not found', NEW.driver_user_id
        USING ERRCODE = '23503';
    END IF;

    IF v_driver_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'route_run_assignments: organization mismatch (assignment org %, driver org %)', NEW.organization_id, v_driver_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.vehicle_id IS NOT NULL THEN
    SELECT v.organization_id
      INTO v_vehicle_org
      FROM public.vehicles v
     WHERE v.id = NEW.vehicle_id;

    IF v_vehicle_org IS NULL THEN
      RAISE EXCEPTION 'route_run_assignments: vehicle % not found', NEW.vehicle_id
        USING ERRCODE = '23503';
    END IF;

    IF v_vehicle_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'route_run_assignments: organization mismatch (assignment org %, vehicle org %)', NEW.organization_id, v_vehicle_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_route_run_assignments_enforce_org_match ON public.route_run_assignments;
CREATE TRIGGER trg_route_run_assignments_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.route_run_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.route_run_assignments_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_route_run_assignments_set_updated_at ON public.route_run_assignments;
CREATE TRIGGER trg_route_run_assignments_set_updated_at
  BEFORE UPDATE ON public.route_run_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.route_run_assignment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  route_run_assignment_id UUID NOT NULL REFERENCES public.route_run_assignments(id) ON DELETE CASCADE,
  route_run_id UUID NOT NULL REFERENCES public.route_runs(id) ON DELETE CASCADE,
  assignment_version INT NOT NULL,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  assignment_mode TEXT NOT NULL,
  driver_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  vehicle_id UUID REFERENCES public.vehicles(id) ON DELETE SET NULL,
  partner JSONB,
  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_system TEXT,
  notes TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  decision_log_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT route_run_assignment_events_version_ck CHECK (assignment_version > 0),
  CONSTRAINT route_run_assignment_events_type_ck CHECK (btrim(event_type) <> ''),
  CONSTRAINT route_run_assignment_events_to_status_ck CHECK (btrim(to_status) <> '' AND to_status = lower(to_status)),
  CONSTRAINT route_run_assignment_events_mode_ck CHECK (btrim(assignment_mode) <> '' AND assignment_mode = lower(assignment_mode)),
  CONSTRAINT route_run_assignment_events_partner_object_ck CHECK (partner IS NULL OR jsonb_typeof(partner) = 'object'),
  CONSTRAINT route_run_assignment_events_payload_object_ck CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_route_run_assignment_events_route_version
  ON public.route_run_assignment_events (route_run_id, assignment_version);

CREATE UNIQUE INDEX IF NOT EXISTS idx_route_run_assignment_events_route_idempotency
  ON public.route_run_assignment_events (route_run_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

CREATE INDEX IF NOT EXISTS idx_route_run_assignment_events_assignment_created
  ON public.route_run_assignment_events (route_run_assignment_id, created_at DESC);

ALTER TABLE public.route_run_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS route_run_assignments_service_policy ON public.route_run_assignments;
CREATE POLICY route_run_assignments_service_policy
  ON public.route_run_assignments
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

ALTER TABLE public.route_run_assignment_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS route_run_assignment_events_service_policy ON public.route_run_assignment_events;
CREATE POLICY route_run_assignment_events_service_policy
  ON public.route_run_assignment_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

REVOKE ALL ON TABLE public.route_run_assignments FROM PUBLIC;
REVOKE ALL ON TABLE public.route_run_assignments FROM anon;
REVOKE ALL ON TABLE public.route_run_assignments FROM authenticated;
GRANT ALL ON TABLE public.route_run_assignments TO service_role;

REVOKE ALL ON TABLE public.route_run_assignment_events FROM PUBLIC;
REVOKE ALL ON TABLE public.route_run_assignment_events FROM anon;
REVOKE ALL ON TABLE public.route_run_assignment_events FROM authenticated;
GRANT ALL ON TABLE public.route_run_assignment_events TO service_role;

-------------------------------------------------------------------------------
-- 3) Browser-safe route_runs projection
-------------------------------------------------------------------------------

CREATE OR REPLACE VIEW api.route_runs
WITH (security_invoker = true) AS
SELECT
  rr.*,
  COALESCE(rr.metadata->'route_assignment', '{}'::jsonb) AS route_assignment
FROM public.route_runs rr;

REVOKE ALL ON api.route_runs FROM PUBLIC;
REVOKE ALL ON api.route_runs FROM anon;
GRANT SELECT ON api.route_runs TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 4) Service + UI assignment RPCs
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_route_run_actor_context_v1(
  p_action TEXT DEFAULT 'read'
)
RETURNS TABLE (
  user_id UUID,
  organization_id UUID,
  scope_type TEXT,
  scope_id UUID,
  is_platform BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_action TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(p_action, '')), ''), 'read'));
BEGIN
  user_id := auth.uid();
  organization_id := public.current_user_org_id();
  scope_type := COALESCE(public.current_user_scope_type(), 'global');
  scope_id := public.current_user_scope_id();
  is_platform := public.is_platform_user();

  IF user_id IS NULL THEN
    RAISE EXCEPTION 'route ui requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF v_action NOT IN ('read', 'write') THEN
    RAISE EXCEPTION 'ui_route_run_actor_context_v1 invalid action %', v_action
      USING ERRCODE = '23514';
  END IF;

  IF NOT public.user_has_resource_capability_v1('routes', v_action, scope_type, scope_id) THEN
    RAISE EXCEPTION 'route ui requires routes.% capability', v_action
      USING ERRCODE = '42501';
  END IF;

  IF v_action = 'write' THEN
    IF scope_type <> 'tenant' THEN
      RAISE EXCEPTION 'route ui write requires tenant scope'
        USING ERRCODE = '42501';
    END IF;
    IF organization_id IS NULL THEN
      RAISE EXCEPTION 'route ui write requires organization context'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT is_platform AND scope_type <> 'tenant' THEN
      RAISE EXCEPTION 'route ui read requires tenant or platform scope'
        USING ERRCODE = '42501';
    END IF;
    IF NOT is_platform AND organization_id IS NULL THEN
      RAISE EXCEPTION 'route ui read requires organization context'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_route_run_actor_context_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_route_run_actor_context_v1(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.ui_route_run_actor_context_v1(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ui_route_run_actor_context_v1(TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.assign_route_run_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_run_id UUID,
  route_run_assignment_id UUID,
  assignment_status TEXT,
  assignment_mode TEXT,
  assignment_version INT,
  driver_user_id UUID,
  vehicle_id UUID,
  partner JSONB,
  stop_task_count INT,
  assigned_task_count INT,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_scope_type TEXT := NULL;
  v_scope_id UUID := NULL;
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULL;
  v_current_org_id UUID := NULL;
  v_is_service BOOLEAN := FALSE;
  v_is_platform BOOLEAN := FALSE;
  v_route_run_id UUID := NULL;
  v_route_run public.route_runs%ROWTYPE;
  v_current_assignment public.route_run_assignments%ROWTYPE;
  v_assignment_row public.route_run_assignments%ROWTYPE;
  v_requested_driver_user_id UUID := NULL;
  v_requested_vehicle_id UUID := NULL;
  v_requested_partner JSONB := NULL;
  v_requested_notes TEXT := NULL;
  v_requested_metadata JSONB := '{}'::jsonb;
  v_requested_status TEXT := 'assigned';
  v_requested_mode TEXT := NULL;
  v_idempotency_key TEXT := NULL;
  v_existing_event public.route_run_assignment_events%ROWTYPE;
  v_same_state BOOLEAN := FALSE;
  v_next_version INT := 1;
  v_task RECORD;
  v_stop RECORD;
  v_task_create RECORD;
  v_task_assign RECORD;
  v_decision_id UUID := NULL;
  v_assignment_payload JSONB := '{}'::jsonb;
  v_stop_task_total INT := 0;
  v_assigned_task_total INT := 0;
  v_prev_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_prev_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  v_service_claims JSONB := '{}'::jsonb;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'assign_route_run_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;

  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');
  v_is_service := v_role = 'service_role';
  v_is_platform := public.is_platform_user();
  v_scope_type := public.current_user_scope_type();
  v_scope_id := public.current_user_scope_id();
  v_current_org_id := public.current_user_org_id();

  BEGIN
    v_route_run_id := NULLIF(v_input->>'route_run_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_run_id := NULL;
  END;

  BEGIN
    v_requested_driver_user_id := NULLIF(v_input->>'driver_user_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_requested_driver_user_id := NULL;
  END;

  BEGIN
    v_requested_vehicle_id := NULLIF(v_input->>'vehicle_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_requested_vehicle_id := NULL;
  END;

  BEGIN
    v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_actor_user_id := NULL;
  END;

  v_requested_partner := COALESCE(v_input->'partner', '{}'::jsonb);
  IF jsonb_typeof(v_requested_partner) IS DISTINCT FROM 'object' THEN
    v_requested_partner := '{}'::jsonb;
  END IF;
  v_requested_partner := jsonb_strip_nulls(
    v_requested_partner
    || jsonb_build_object(
      'partner_id', NULLIF(v_input->>'partner_id', ''),
      'partner_name', NULLIF(v_input->>'partner_name', '')
    )
  );
  IF v_requested_partner = '{}'::jsonb THEN
    v_requested_partner := NULL;
  END IF;

  v_requested_notes := NULLIF(btrim(COALESCE(v_input->>'notes', '')), '');
  v_requested_metadata := COALESCE(v_input->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_requested_metadata) IS DISTINCT FROM 'object' THEN
    v_requested_metadata := '{}'::jsonb;
  END IF;
  v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_actor_system := COALESCE(NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), ''), 'route_assignment');

  IF v_route_run_id IS NULL THEN
    RAISE EXCEPTION 'assign_route_run_v1 requires route_run_id'
      USING ERRCODE = '23514';
  END IF;

  IF v_requested_driver_user_id IS NOT NULL AND v_requested_partner IS NOT NULL THEN
    RAISE EXCEPTION 'assign_route_run_v1 accepts either internal driver or partner payload, not both'
      USING ERRCODE = '23514';
  END IF;

  IF v_requested_driver_user_id IS NULL AND v_requested_partner IS NULL THEN
    RAISE EXCEPTION 'assign_route_run_v1 requires driver_user_id or partner payload'
      USING ERRCODE = '23514';
  END IF;

  IF v_requested_partner IS NOT NULL AND v_requested_vehicle_id IS NOT NULL THEN
    RAISE EXCEPTION 'assign_route_run_v1 partner assignment cannot set vehicle_id directly'
      USING ERRCODE = '23514';
  END IF;

  IF NOT v_is_service THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'assign_route_run_v1 requires authenticated user'
        USING ERRCODE = '42501';
    END IF;

    IF NOT public.user_has_resource_capability_v1('routes', 'write', v_scope_type, v_scope_id) THEN
      RAISE EXCEPTION 'assign_route_run_v1 requires routes.write capability'
        USING ERRCODE = '42501';
    END IF;

    IF NOT v_is_platform THEN
      IF v_scope_type IS DISTINCT FROM 'tenant' THEN
        RAISE EXCEPTION 'assign_route_run_v1 requires tenant scope'
          USING ERRCODE = '42501';
      END IF;
      IF v_current_org_id IS NULL THEN
        RAISE EXCEPTION 'assign_route_run_v1 requires organization context'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    v_actor_user_id := COALESCE(v_actor_user_id, auth.uid());
  ELSIF v_actor_user_id IS NULL THEN
    BEGIN
      v_actor_user_id := NULLIF(v_claims->>'sub', '')::uuid;
    EXCEPTION
      WHEN others THEN
        v_actor_user_id := NULL;
    END;
  END IF;

  SELECT *
    INTO v_route_run
    FROM public.route_runs rr
   WHERE rr.id = v_route_run_id
   FOR UPDATE;

  IF v_route_run.id IS NULL THEN
    RAISE EXCEPTION 'route_run % not found', v_route_run_id
      USING ERRCODE = '23503';
  END IF;

  IF NOT v_is_service AND NOT v_is_platform AND v_route_run.organization_id IS DISTINCT FROM v_current_org_id THEN
    RAISE EXCEPTION 'route_run % is outside the current organization', v_route_run_id
      USING ERRCODE = '42501';
  END IF;

  IF v_route_run.status IN ('completed', 'canceled') THEN
    RAISE EXCEPTION 'assign_route_run_v1 cannot mutate terminal route_run status %', v_route_run.status
      USING ERRCODE = '23514';
  END IF;

  IF v_requested_partner IS NOT NULL THEN
    v_requested_mode := 'partner_fleet';
    v_requested_driver_user_id := NULL;
    v_requested_vehicle_id := NULL;
  ELSE
    v_requested_mode := 'internal_driver';
  END IF;

  IF v_requested_mode = 'internal_driver' THEN
    PERFORM 1
      FROM public.users u
     WHERE u.id = v_requested_driver_user_id
       AND u.organization_id = v_route_run.organization_id
       AND COALESCE(u.status, 'active') = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'assign_route_run_v1 driver_user_id % is not active inside organization %', v_requested_driver_user_id, v_route_run.organization_id
        USING ERRCODE = '42501';
    END IF;

    IF v_requested_vehicle_id IS NOT NULL THEN
      PERFORM 1
        FROM public.vehicles v
       WHERE v.id = v_requested_vehicle_id
         AND v.organization_id = v_route_run.organization_id
         AND COALESCE(v.status, 'active') = 'active';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'assign_route_run_v1 vehicle_id % is not active inside organization %', v_requested_vehicle_id, v_route_run.organization_id
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  SELECT *
    INTO v_current_assignment
    FROM public.route_run_assignments rra
   WHERE rra.route_run_id = v_route_run_id
   FOR UPDATE;

  IF v_idempotency_key IS NOT NULL THEN
    SELECT *
      INTO v_existing_event
      FROM public.route_run_assignment_events ev
     WHERE ev.route_run_id = v_route_run_id
      AND ev.idempotency_key = v_idempotency_key
     LIMIT 1;

    IF v_existing_event.id IS NOT NULL THEN
      SELECT *
        INTO v_assignment_row
        FROM public.route_run_assignments rra
       WHERE rra.route_run_id = v_route_run_id;

      IF v_assignment_row.id IS NULL THEN
        RAISE EXCEPTION 'assign_route_run_v1 idempotency replay missing assignment projection for route_run %', v_route_run_id
          USING ERRCODE = '23514';
      END IF;

      route_run_assignment_id := v_assignment_row.id;
      assignment_status := v_assignment_row.assignment_status;
      assignment_mode := v_assignment_row.assignment_mode;
      assignment_version := v_assignment_row.assignment_version;
      driver_user_id := v_assignment_row.driver_user_id;
      vehicle_id := v_assignment_row.vehicle_id;
      partner := COALESCE(v_assignment_row.partner, '{}'::jsonb);

      SELECT COUNT(*)::int
        INTO stop_task_count
        FROM public.route_stops rs
       WHERE rs.route_run_id = v_route_run_id;

      SELECT COUNT(*)::int
        INTO assigned_task_count
        FROM public.tasks t
        JOIN public.task_types tt
          ON tt.id = t.task_type_id
       WHERE t.resource_type = 'route_stop'
         AND tt.organization_id = v_route_run.organization_id
         AND tt.key = 'route_stop_execute'
         AND t.assigned_to IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM public.route_stops rs
            WHERE rs.id = t.resource_id
              AND rs.route_run_id = v_route_run_id
         );

      created := FALSE;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  IF v_current_assignment.id IS NOT NULL THEN
    v_same_state :=
      v_current_assignment.assignment_status = v_requested_status
      AND v_current_assignment.assignment_mode = v_requested_mode
      AND v_current_assignment.driver_user_id IS NOT DISTINCT FROM v_requested_driver_user_id
      AND v_current_assignment.vehicle_id IS NOT DISTINCT FROM v_requested_vehicle_id
      AND COALESCE(v_current_assignment.partner, '{}'::jsonb) = COALESCE(v_requested_partner, '{}'::jsonb)
      AND COALESCE(v_current_assignment.notes, '') = COALESCE(v_requested_notes, '')
      AND COALESCE(v_current_assignment.metadata, '{}'::jsonb) = COALESCE(v_requested_metadata, '{}'::jsonb);
  END IF;

  IF v_same_state THEN
    route_run_assignment_id := v_current_assignment.id;
    assignment_status := v_current_assignment.assignment_status;
    assignment_mode := v_current_assignment.assignment_mode;
    assignment_version := v_current_assignment.assignment_version;
    driver_user_id := v_current_assignment.driver_user_id;
    vehicle_id := v_current_assignment.vehicle_id;
    partner := COALESCE(v_current_assignment.partner, '{}'::jsonb);

    SELECT COUNT(*)::int
      INTO stop_task_count
      FROM public.route_stops rs
     WHERE rs.route_run_id = v_route_run_id;

    SELECT COUNT(*)::int
      INTO assigned_task_count
      FROM public.tasks t
      JOIN public.task_types tt
        ON tt.id = t.task_type_id
     WHERE t.resource_type = 'route_stop'
       AND tt.organization_id = v_route_run.organization_id
       AND tt.key = 'route_stop_execute'
       AND t.assigned_to IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM public.route_stops rs
          WHERE rs.id = t.resource_id
            AND rs.route_run_id = v_route_run_id
       );

    created := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_requested_mode = 'partner_fleet' THEN
    PERFORM 1
      FROM public.tasks t
      JOIN public.task_types tt
        ON tt.id = t.task_type_id
     WHERE t.resource_type = 'route_stop'
       AND tt.organization_id = v_route_run.organization_id
       AND tt.key = 'route_stop_execute'
       AND t.assigned_to IS NOT NULL
       AND COALESCE(t.status, '') NOT IN ('completed', 'canceled')
       AND EXISTS (
         SELECT 1
           FROM public.route_stops rs
          WHERE rs.id = t.resource_id
            AND rs.route_run_id = v_route_run_id
       );
    IF FOUND THEN
      RAISE EXCEPTION 'assign_route_run_v1 partner_fleet handoff requires explicit downstream unassign flow before replacing assigned route_stop tasks'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  v_service_claims := COALESCE(v_claims, '{}'::jsonb);
  IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
    v_service_claims := '{}'::jsonb;
  END IF;
  v_service_claims := (v_service_claims - 'sub') || jsonb_build_object('role', 'service_role');

  PERFORM set_config('app.actor_system', v_actor_system, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', v_service_claims::text, true);

  BEGIN
    FOR v_stop IN
      SELECT rs.id, rs.client_id, rs.shipment_id
        FROM public.route_stops rs
       WHERE rs.route_run_id = v_route_run_id
       ORDER BY rs.sequence_order, rs.created_at, rs.id
    LOOP
      v_stop_task_total := v_stop_task_total + 1;

      SELECT t.id, t.assigned_to, t.status
        INTO v_task
        FROM public.tasks t
        JOIN public.task_types tt
          ON tt.id = t.task_type_id
       WHERE t.resource_type = 'route_stop'
         AND t.resource_id = v_stop.id
         AND tt.organization_id = v_route_run.organization_id
         AND tt.key = 'route_stop_execute'
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT 1;

      IF v_task.id IS NULL THEN
        SELECT *
          INTO v_task_create
          FROM public.create_task_system_v1(
            jsonb_build_object(
              'task_type_key', 'route_stop_execute',
              'resource_type', 'route_stop',
              'resource_id', v_stop.id,
              'context', jsonb_strip_nulls(jsonb_build_object(
                'organization_id', v_route_run.organization_id,
                'route_run_id', v_route_run_id,
                'route_stop_id', v_stop.id,
                'shipment_id', v_stop.shipment_id,
                'client_id', v_stop.client_id
              )),
              'idempotency_key', format('route-run-assignment:create-task:%s:%s', v_route_run_id, v_stop.id),
              'metadata', jsonb_strip_nulls(jsonb_build_object(
                'route_run_id', v_route_run_id,
                'route_stop_id', v_stop.id,
                'assignment_mode', v_requested_mode
              )),
              'actor_system', v_actor_system
            )
          )
         LIMIT 1;

        v_task.id := v_task_create.task_id;
        v_task.assigned_to := NULL;
        v_task.status := 'open';
      END IF;

      IF v_requested_mode = 'internal_driver'
         AND v_task.id IS NOT NULL
         AND COALESCE(v_task.status, '') NOT IN ('completed', 'canceled')
         AND v_task.assigned_to IS DISTINCT FROM v_requested_driver_user_id THEN
        SELECT *
          INTO v_task_assign
          FROM public.assign_task_system_v1(
            v_task.id,
            v_requested_driver_user_id,
            format('route-run-assignment:assign-task:%s:%s:%s', v_route_run_id, COALESCE(v_current_assignment.assignment_version, 0) + 1, v_stop.id),
            v_requested_notes,
            v_actor_system
          )
         LIMIT 1;
      END IF;

      IF v_requested_mode = 'internal_driver'
         AND v_task.id IS NOT NULL
         AND COALESCE(v_task.status, '') NOT IN ('completed', 'canceled') THEN
        v_assigned_task_total := v_assigned_task_total + 1;
      END IF;
    END LOOP;
  EXCEPTION
    WHEN others THEN
      PERFORM set_config('request.jwt.claims', v_prev_claims, true);
      PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
      PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
      PERFORM set_config('app.actor_system', v_prev_actor_system, true);
      RAISE;
  END;

  PERFORM set_config('request.jwt.claims', v_prev_claims, true);
  PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
  PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
  PERFORM set_config('app.actor_system', v_prev_actor_system, true);

  v_next_version := COALESCE(v_current_assignment.assignment_version, 0) + 1;

  INSERT INTO public.route_run_assignments (
    organization_id,
    route_run_id,
    assignment_status,
    assignment_mode,
    driver_user_id,
    vehicle_id,
    partner,
    assignment_version,
    assigned_by_user_id,
    assigned_at,
    notes,
    metadata
  )
  VALUES (
    v_route_run.organization_id,
    v_route_run_id,
    v_requested_status,
    v_requested_mode,
    v_requested_driver_user_id,
    v_requested_vehicle_id,
    v_requested_partner,
    v_next_version,
    v_actor_user_id,
    now(),
    v_requested_notes,
    v_requested_metadata
  )
  ON CONFLICT ON CONSTRAINT route_run_assignments_route_run_id_key DO UPDATE
    SET assignment_status = EXCLUDED.assignment_status,
        assignment_mode = EXCLUDED.assignment_mode,
        driver_user_id = EXCLUDED.driver_user_id,
        vehicle_id = EXCLUDED.vehicle_id,
        partner = EXCLUDED.partner,
        assignment_version = EXCLUDED.assignment_version,
        assigned_by_user_id = EXCLUDED.assigned_by_user_id,
        assigned_at = EXCLUDED.assigned_at,
        notes = EXCLUDED.notes,
        metadata = EXCLUDED.metadata
  RETURNING *
    INTO v_assignment_row;

  v_decision_id := public.log_decision(
    p_organization_id := v_route_run.organization_id,
    p_decision_category := 'dispatch',
    p_resource_type := 'route_run',
    p_resource_id := v_route_run_id,
    p_decision_point := 'assign',
    p_decision_outcome := 'assigned',
    p_performed_by_system := v_actor_system,
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'assignment_mode', v_requested_mode,
      'assignment_status', v_requested_status,
      'driver_user_id', v_requested_driver_user_id,
      'vehicle_id', v_requested_vehicle_id,
      'partner', v_requested_partner,
      'notes', v_requested_notes,
      'metadata', NULLIF(v_requested_metadata, '{}'::jsonb),
      'idempotency_key', v_idempotency_key
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  INSERT INTO public.route_run_assignment_events (
    organization_id,
    route_run_assignment_id,
    route_run_id,
    assignment_version,
    event_type,
    from_status,
    to_status,
    assignment_mode,
    driver_user_id,
    vehicle_id,
    partner,
    actor_user_id,
    actor_system,
    notes,
    payload,
    idempotency_key,
    decision_log_id
  )
  VALUES (
    v_route_run.organization_id,
    v_assignment_row.id,
    v_route_run_id,
    v_assignment_row.assignment_version,
    'assigned',
    v_current_assignment.assignment_status,
    v_assignment_row.assignment_status,
    v_assignment_row.assignment_mode,
    v_assignment_row.driver_user_id,
    v_assignment_row.vehicle_id,
    v_assignment_row.partner,
    v_actor_user_id,
    v_actor_system,
    v_assignment_row.notes,
    jsonb_strip_nulls(jsonb_build_object(
      'stop_task_count', v_stop_task_total,
      'assigned_task_count', v_assigned_task_total,
      'correlation_id', public.current_correlation_id(),
      'metadata', NULLIF(v_assignment_row.metadata, '{}'::jsonb)
    )),
    v_idempotency_key,
    v_decision_id
  );

  v_assignment_payload := jsonb_strip_nulls(
    jsonb_build_object(
      'route_run_assignment_id', v_assignment_row.id,
      'assignment_status', v_assignment_row.assignment_status,
      'assignment_mode', v_assignment_row.assignment_mode,
      'assignment_version', v_assignment_row.assignment_version,
      'driver_user_id', v_assignment_row.driver_user_id,
      'vehicle_id', v_assignment_row.vehicle_id,
      'partner', v_assignment_row.partner,
      'assigned_by_user_id', v_assignment_row.assigned_by_user_id,
      'assigned_at', v_assignment_row.assigned_at,
      'notes', v_assignment_row.notes
    )
  );

  UPDATE public.route_runs rr
     SET driver_user_id = v_assignment_row.driver_user_id,
         vehicle_id = v_assignment_row.vehicle_id,
         metadata = jsonb_set(COALESCE(rr.metadata, '{}'::jsonb), '{route_assignment}', v_assignment_payload, true)
   WHERE rr.id = v_route_run_id;

  UPDATE public.shipments s
     SET driver_user_id = v_assignment_row.driver_user_id,
         metadata = jsonb_set(COALESCE(s.metadata, '{}'::jsonb), '{route_assignment}', v_assignment_payload, true)
    FROM public.route_stops rs
   WHERE rs.route_run_id = v_route_run_id
     AND s.id = rs.shipment_id
     AND s.client_id = rs.client_id;

  route_run_id := v_assignment_row.route_run_id;
  route_run_assignment_id := v_assignment_row.id;
  assignment_status := v_assignment_row.assignment_status;
  assignment_mode := v_assignment_row.assignment_mode;
  assignment_version := v_assignment_row.assignment_version;
  driver_user_id := v_assignment_row.driver_user_id;
  vehicle_id := v_assignment_row.vehicle_id;
  partner := COALESCE(v_assignment_row.partner, '{}'::jsonb);
  stop_task_count := v_stop_task_total;
  assigned_task_count := v_assigned_task_total;
  created := TRUE;

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.assign_route_run_v1(JSONB)
  IS 'Canonical route-run assignment projection + event ledger. Internal-driver assignments sync route_stop_execute tasks through Tasks SSOT; partner assignments leave explicit status vocabulary for later UC080 acknowledgement flows.';

REVOKE ALL ON FUNCTION public.assign_route_run_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_route_run_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.assign_route_run_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.assign_route_run_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_run_id UUID,
  route_run_assignment_id UUID,
  assignment_status TEXT,
  assignment_mode TEXT,
  assignment_version INT,
  driver_user_id UUID,
  vehicle_id UUID,
  partner JSONB,
  stop_task_count INT,
  assigned_task_count INT,
  created BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT * FROM public.assign_route_run_v1($1);
$fn$;

REVOKE ALL ON FUNCTION api.assign_route_run_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.assign_route_run_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.assign_route_run_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_execute_route_run_assign_v1(
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
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_ctx RECORD;
  v_registry JSONB := public.resolve_settings_merged(
    'ui_command_registry',
    public.current_user_scope_type(),
    public.current_user_scope_id()
  );
  v_command JSONB := NULL;
  v_params JSONB := COALESCE(p_params, '{}'::jsonb);
  v_selection JSONB := '{}'::jsonb;
  v_mode TEXT := '';
  v_min INT := 0;
  v_max INT := NULL;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_count INT := 0;
  v_route_run_id UUID := NULL;
  v_partner JSONB := '{}'::jsonb;
  v_result RECORD;
BEGIN
  SELECT *
    INTO v_ctx
    FROM public.ui_route_run_actor_context_v1('write')
   LIMIT 1;

  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 requires action key';
  END IF;
  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 unknown command %', p_action_key;
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
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 selection above maximum %', v_max;
  END IF;

  BEGIN
    v_route_run_id := NULLIF(COALESCE(v_id, v_ids[1]), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_run_id := NULL;
  END;

  IF v_route_run_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 invalid route id %', COALESCE(v_id, v_ids[1], '')
      USING ERRCODE = '23514';
  END IF;

  IF public.ui_get_resource_v1(p_resource_key, v_route_run_id) IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_run_assign_v1 route % is not visible in resource %', v_route_run_id, p_resource_key
      USING ERRCODE = '42501';
  END IF;

  v_partner := COALESCE(v_params->'partner', '{}'::jsonb);
  IF jsonb_typeof(v_partner) IS DISTINCT FROM 'object' THEN
    v_partner := '{}'::jsonb;
  END IF;
  v_partner := jsonb_strip_nulls(
    v_partner
    || jsonb_build_object(
      'partner_id', NULLIF(v_params->>'partner_id', ''),
      'partner_name', NULLIF(v_params->>'partner_name', '')
    )
  );

  SELECT *
    INTO v_result
    FROM public.assign_route_run_v1(
      jsonb_strip_nulls(
        v_params
        || jsonb_build_object(
          'route_run_id', v_route_run_id,
          'driver_user_id', NULLIF(v_params->>'driver_user_id', ''),
          'vehicle_id', NULLIF(v_params->>'vehicle_id', ''),
          'partner', CASE WHEN v_partner = '{}'::jsonb THEN NULL ELSE v_partner END,
          'partner_id', NULLIF(v_params->>'partner_id', ''),
          'partner_name', NULLIF(v_params->>'partner_name', ''),
          'notes', NULLIF(v_params->>'notes', ''),
          'idempotency_key', NULLIF(v_params->>'idempotency_key', ''),
          'metadata', COALESCE(v_params->'metadata', '{}'::jsonb),
          'actor_user_id', v_ctx.user_id,
          'actor_system', 'route_assignment_ui'
        )
      )
    )
   LIMIT 1;

  RETURN jsonb_build_object(
    'status', 'assigned',
    'action_key', p_action_key,
    'resource_key', p_resource_key,
    'count', 1,
    'items', jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'route_run_id', v_result.route_run_id,
          'route_run_assignment_id', v_result.route_run_assignment_id,
          'assignment_status', v_result.assignment_status,
          'assignment_mode', v_result.assignment_mode,
          'assignment_version', v_result.assignment_version,
          'driver_user_id', v_result.driver_user_id,
          'vehicle_id', v_result.vehicle_id,
          'partner', v_result.partner,
          'stop_task_count', v_result.stop_task_count,
          'assigned_task_count', v_result.assigned_task_count,
          'created', v_result.created
        )
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Dedicated UI command executor for route assignment. Keeps route assignment off the generic ui_execute_command_v1 path while preserving the standard bulk-action payload contract.';

REVOKE ALL ON FUNCTION public.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_execute_route_run_assign_v1(
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
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT public.ui_execute_route_run_assign_v1($1, $2, $3, $4, $5, $6);
$fn$;

REVOKE ALL ON FUNCTION api.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_route_run_assign_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 5) access_control_policy: add routes capabilities/resource map
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_caps JSONB := '[]'::jsonb;
  v_role_source JSONB := '[]'::jsonb;
  v_roles JSONB := '[]'::jsonb;
  v_resource_map JSONB := '{}'::jsonb;
  v_cap JSONB;
  v_role JSONB;
  v_new_caps JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'routes.read',
      'label', 'Routes read',
      'category', 'operations',
      'description', 'Read route run projections, assignments, and route-level execution ownership.'
    ),
    jsonb_build_object(
      'key', 'routes.write',
      'label', 'Routes write',
      'category', 'operations',
      'description', 'Assign route runs to internal drivers or partner fleets.'
    )
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id,
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
 
    v_caps := COALESCE(v_current->'capabilities', '[]'::jsonb);
    IF jsonb_typeof(v_caps) IS DISTINCT FROM 'array' THEN
      v_caps := '[]'::jsonb;
    END IF;

    FOR v_cap IN
      SELECT value
      FROM jsonb_array_elements(v_new_caps) AS value
    LOOP
      IF NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_caps) AS item(value)
         WHERE item.value->>'key' = v_cap->>'key'
      ) THEN
        v_caps := v_caps || jsonb_build_array(v_cap);
      END IF;
    END LOOP;

    v_role_source := COALESCE(v_current->'roles', '[]'::jsonb);
    IF jsonb_typeof(v_role_source) IS DISTINCT FROM 'array' THEN
      v_role_source := '[]'::jsonb;
    END IF;

    v_roles := '[]'::jsonb;
    FOR v_role IN
      SELECT value
      FROM jsonb_array_elements(v_role_source) AS value
    LOOP
      IF v_role->>'key' = 'ops_admin' THEN
        v_role := jsonb_set(
          v_role,
          '{capability_keys}',
          to_jsonb(ARRAY(
            SELECT DISTINCT cap
              FROM (
                SELECT jsonb_array_elements_text(COALESCE(v_role->'capability_keys', '[]'::jsonb)) AS cap
                UNION ALL
                SELECT unnest(ARRAY['routes.read', 'routes.write']) AS cap
              ) AS caps
             ORDER BY cap
          )),
          FALSE
        );
      END IF;

      v_roles := v_roles || jsonb_build_array(v_role);
    END LOOP;

    v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
    IF jsonb_typeof(v_resource_map) IS DISTINCT FROM 'object' THEN
      v_resource_map := '{}'::jsonb;
    END IF;

    v_resource_map := jsonb_set(
      v_resource_map,
      '{routes}',
      jsonb_build_object(
        'read', 'routes.read',
        'write', 'routes.write'
      ),
      TRUE
    );

    v_next := jsonb_set(v_current, '{capabilities}', v_caps, FALSE);
    v_next := jsonb_set(v_next, '{roles}', v_roles, FALSE);
    v_next := jsonb_set(v_next, '{resource_map}', v_resource_map, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'uc076 route assignment capabilities',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.id;
    END IF;
  END LOOP;
END;
$do$;

-------------------------------------------------------------------------------
-- 6) ui_read_registry + ui_command_registry + ui_navigation wiring
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_resources JSONB := '[]'::jsonb;
  v_commands JSONB := '[]'::jsonb;
  v_next JSONB := NULL;
BEGIN
  FOR v_row IN
    SELECT
      s.id,
      s.category,
      s.settings_version_id,
      sv.version,
      sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category IN ('ui_read_registry', 'ui_command_registry', 'ui_navigation')
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    IF v_row.category = 'ui_read_registry' THEN
      v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
      IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
        v_resources := '[]'::jsonb;
      END IF;

      v_resources := (
        SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
          FROM jsonb_array_elements(v_resources) AS value
         WHERE value->>'key' <> 'routes'
      );
      v_resources := v_resources || jsonb_build_array(
        jsonb_build_object(
          'key', 'routes',
          'label', 'Routes',
          'relation', 'public.route_runs',
          'capability_read', 'routes.read',
          'primary_key', 'id',
          'default_sort', jsonb_build_array(
            jsonb_build_object('key', 'created_at', 'direction', 'desc')
          ),
          'select_fields', jsonb_build_array(
            'id',
            'organization_id',
            'branch_id',
            'driver_user_id',
            'vehicle_id',
            'status',
            'planned_date',
            'planned_start_at',
            'planned_end_at',
            'route_plan_id',
            'metadata',
            'created_at',
            'updated_at'
          ),
          'filters', jsonb_build_array(
            jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
            jsonb_build_object('key', 'driver_user_id', 'column', 'driver_user_id', 'op', 'eq'),
            jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq')
          )
        )
      );

      v_next := jsonb_set(v_current, '{resources}', v_resources, TRUE);
    ELSIF v_row.category = 'ui_command_registry' THEN
      v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
      IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
        v_commands := '[]'::jsonb;
      END IF;

      v_commands := (
        SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
          FROM jsonb_array_elements(v_commands) AS value
         WHERE value->>'key' <> 'routes.assign'
      );
      v_commands := v_commands || jsonb_build_array(
        jsonb_build_object(
          'key', 'routes.assign',
          'label', 'Assign route',
          'schema_category', 'resource:routes',
          'capability', 'routes.write',
          'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
          'execution', jsonb_build_object(
            'type', 'rpc',
            'rpc', 'ui_execute_route_run_assign_v1'
          ),
          'input_schema', jsonb_build_object(
            'type', 'object',
            'properties', jsonb_build_object(
              'driver_user_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
              'vehicle_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
              'partner_id', jsonb_build_object('type', 'string'),
              'partner_name', jsonb_build_object('type', 'string'),
              'notes', jsonb_build_object('type', 'string')
            )
          )
        )
      );

      v_next := jsonb_set(v_current, '{commands}', v_commands, TRUE);
    ELSE
      v_next := jsonb_set(v_current, '{apps,console,sections}', COALESCE((
        SELECT jsonb_agg(
          CASE
            WHEN value->>'id' = 'operations' THEN
              jsonb_set(
                value,
                '{items}',
                (
                  SELECT COALESCE(jsonb_agg(item.value), '[]'::jsonb) || jsonb_build_array(
                    jsonb_build_object(
                      'id', 'routes',
                      'label', 'Routes',
                      'href', '/console/resources/routes',
                      'resource', 'routes',
                      'capability', 'routes.read'
                    )
                  )
                  FROM jsonb_array_elements(COALESCE(value->'items', '[]'::jsonb)) AS item(value)
                  WHERE item.value->>'resource' <> 'routes'
                ),
                TRUE
              )
            ELSE value
          END
        )
        FROM jsonb_array_elements(COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb)) AS value
      ), '[]'::jsonb), TRUE);

      v_next := jsonb_set(v_next, '{apps,portal,sections}', COALESCE((
        SELECT jsonb_agg(
          CASE
            WHEN value->>'id' = 'operations' THEN
              jsonb_set(
                value,
                '{items}',
                (
                  SELECT COALESCE(jsonb_agg(item.value), '[]'::jsonb) || jsonb_build_array(
                    jsonb_build_object(
                      'id', 'routes',
                      'label', 'Routes',
                      'href', '/portal/resources/routes',
                      'resource', 'routes',
                      'capability', 'routes.read'
                    )
                  )
                  FROM jsonb_array_elements(COALESCE(value->'items', '[]'::jsonb)) AS item(value)
                  WHERE item.value->>'resource' <> 'routes'
                ),
                TRUE
              )
            ELSE value
          END
        )
        FROM jsonb_array_elements(COALESCE(v_next#>'{apps,portal,sections}', '[]'::jsonb)) AS value
      ), '[]'::jsonb), TRUE);
    END IF;

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'uc076 route assignment ui wiring',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604061430_uc076_route_run_assignment_lifecycle_foundation_v1'));
COMMIT;

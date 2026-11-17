-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Ops sessions v1 (sessions SSOT + ledger)
-- Date: 2026-01-27
--
-- Goals:
--   - Add generic ops_sessions projection + ops_session_events ledger.
--   - Provide idempotent RPCs for open + status transitions.
--   - Enable linking scan_events to ops sessions (schema only; scan RPC updated in follow-up migration).
--   - Dynamic enums via lookup_definitions/lookup_values (no hardcoded status lists).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601271110_ops_sessions_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookup seeds (dynamic enums; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('ops_session_type', 'Operational session types (driver_shift, branch_cash_drawer, warehouse_scan, etc.)', 'ops', 'tier_1', TRUE),
  ('ops_session_status', 'Operational session statuses (open/closed/canceled)', 'ops', 'tier_1', TRUE)
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
  ('driver_shift', 'Driver Shift', 'Driver shift session (cash responsibility + route execution window)', 10, FALSE, '{}' ),
  ('branch_cash_drawer', 'Branch Cash Drawer', 'Branch cashier cash drawer session (handover/count/deposit)', 20, FALSE, '{}' ),
  ('warehouse_scan', 'Warehouse Scan', 'Warehouse scan session (scan burst/sessionization)', 30, TRUE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'ops_session_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

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
  ('open', 'Open', 'Session is open/active', 10, TRUE, '{}' ),
  ('closed', 'Closed', 'Session is closed/completed', 20, FALSE, '{}' ),
  ('canceled', 'Canceled', 'Session canceled/voided', 30, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'ops_session_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Ops sessions (projection) + ledger
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ops_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  session_type TEXT NOT NULL,
  status TEXT NOT NULL,

  branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  actor_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES public.user_devices(id) ON DELETE SET NULL,

  session_code TEXT NULL,
  idempotency_key TEXT NULL,

  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ NULL,

  version INT NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ops_sessions_session_type_ck CHECK (btrim(session_type) <> '' AND session_type = lower(session_type)),
  CONSTRAINT ops_sessions_status_ck CHECK (btrim(status) <> '' AND status = lower(status)),
  CONSTRAINT ops_sessions_code_ck CHECK (session_code IS NULL OR btrim(session_code) <> ''),
  CONSTRAINT ops_sessions_idempotency_ck CHECK (idempotency_key IS NULL OR btrim(idempotency_key) <> ''),
  CONSTRAINT ops_sessions_version_ck CHECK (version > 0),
  CONSTRAINT ops_sessions_closed_range_ck CHECK (closed_at IS NULL OR closed_at >= opened_at)
);

COMMENT ON TABLE public.ops_sessions
  IS 'Operational sessions projection (query-optimized). Canonical ledger is ops_session_events; scans can link to ops_session_id.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_sessions_org_code
  ON public.ops_sessions (organization_id, session_code)
  WHERE session_code IS NOT NULL AND btrim(session_code) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_sessions_org_idempotency
  ON public.ops_sessions (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

CREATE INDEX IF NOT EXISTS idx_ops_sessions_org_actor_opened
  ON public.ops_sessions (organization_id, actor_user_id, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_sessions_org_branch_opened
  ON public.ops_sessions (organization_id, branch_id, opened_at DESC)
  WHERE branch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.ops_session_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ops_session_id UUID NOT NULL REFERENCES public.ops_sessions(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,

  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_system TEXT,

  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  session_version INT NOT NULL,

  decision_log_id UUID,
  settings_resolution_id UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ops_session_events_event_type_ck CHECK (btrim(event_type) <> '' AND event_type = lower(event_type)),
  CONSTRAINT ops_session_events_session_version_ck CHECK (session_version > 0)
);

COMMENT ON TABLE public.ops_session_events
  IS 'Immutable ops session event ledger (SSOT). Event trail is authoritative; ops_sessions is the projection.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_session_events_session_version
  ON public.ops_session_events (ops_session_id, session_version);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_session_events_idempotency
  ON public.ops_session_events (ops_session_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

CREATE INDEX IF NOT EXISTS idx_ops_session_events_org_created
  ON public.ops_session_events (organization_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.ops_sessions_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_branch_org UUID;
  v_user_org UUID;
  v_device_org UUID;
  v_device_user UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'ops_sessions: organization_id is required' USING ERRCODE = '23502';
  END IF;

  IF NEW.branch_id IS NOT NULL THEN
    SELECT b.organization_id INTO v_branch_org
    FROM public.branches b
    WHERE b.id = NEW.branch_id;
    IF v_branch_org IS NULL THEN
      RAISE EXCEPTION 'ops_sessions: branch % not found', NEW.branch_id USING ERRCODE = '23503';
    END IF;
    IF v_branch_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'ops_sessions: organization mismatch (session org %, branch org %)', NEW.organization_id, v_branch_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT u.organization_id INTO v_user_org
  FROM public.users u
  WHERE u.id = NEW.actor_user_id;
  IF v_user_org IS NULL THEN
    RAISE EXCEPTION 'ops_sessions: actor_user % not found', NEW.actor_user_id USING ERRCODE = '23503';
  END IF;
  IF v_user_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'ops_sessions: organization mismatch (session org %, user org %)', NEW.organization_id, v_user_org
      USING ERRCODE = '23514';
  END IF;

  IF NEW.device_id IS NOT NULL THEN
    SELECT d.organization_id, d.user_id INTO v_device_org, v_device_user
    FROM public.user_devices d
    WHERE d.id = NEW.device_id;
    IF v_device_org IS NULL THEN
      RAISE EXCEPTION 'ops_sessions: device % not found', NEW.device_id USING ERRCODE = '23503';
    END IF;
    IF v_device_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'ops_sessions: organization mismatch (session org %, device org %)', NEW.organization_id, v_device_org
        USING ERRCODE = '23514';
    END IF;
    IF v_device_user IS DISTINCT FROM NEW.actor_user_id THEN
      RAISE EXCEPTION 'ops_sessions: device % is not owned by actor_user %', NEW.device_id, NEW.actor_user_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_ops_sessions_enforce_org_match ON public.ops_sessions;
CREATE TRIGGER trg_ops_sessions_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.ops_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.ops_sessions_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_ops_sessions_set_updated_at ON public.ops_sessions;
CREATE TRIGGER trg_ops_sessions_set_updated_at
  BEFORE UPDATE ON public.ops_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 3) RLS + least-privilege grants
-------------------------------------------------------------------------------

ALTER TABLE public.ops_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ops_session_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ops_sessions FROM PUBLIC;
REVOKE ALL ON TABLE public.ops_sessions FROM anon;
REVOKE ALL ON TABLE public.ops_sessions FROM authenticated;

REVOKE ALL ON TABLE public.ops_session_events FROM PUBLIC;
REVOKE ALL ON TABLE public.ops_session_events FROM anon;
REVOKE ALL ON TABLE public.ops_session_events FROM authenticated;

DROP POLICY IF EXISTS ops_sessions_select ON public.ops_sessions;
CREATE POLICY ops_sessions_select ON public.ops_sessions
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS ops_sessions_service_policy ON public.ops_sessions;
CREATE POLICY ops_sessions_service_policy ON public.ops_sessions
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS ops_session_events_select ON public.ops_session_events;
CREATE POLICY ops_session_events_select ON public.ops_session_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS ops_session_events_service_policy ON public.ops_session_events;
CREATE POLICY ops_session_events_service_policy ON public.ops_session_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.ops_sessions TO authenticated;
GRANT SELECT ON public.ops_session_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ops_sessions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ops_session_events TO service_role;

-------------------------------------------------------------------------------
-- 4) RPCs: open_ops_session_v1 / transition_ops_session_v1 (idempotent)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.open_ops_session_v1(
  p_input JSONB
)
RETURNS TABLE (
  ops_session_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := public.current_user_org_id();
  v_in JSONB := COALESCE(p_input, '{}'::jsonb);

  v_session_type TEXT := NULL;
  v_default_status TEXT := NULL;
  v_branch_id UUID := NULL;
  v_device_id UUID := NULL;
  v_session_code TEXT := NULL;
  v_idempotency TEXT := NULL;
  v_opened_at TIMESTAMPTZ := NULL;
  v_meta JSONB := '{}'::jsonb;

  v_id UUID := gen_random_uuid();
  v_existing_id UUID := NULL;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'open_ops_session_v1 requires an authenticated user';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'open_ops_session_v1 could not resolve organization_id';
  END IF;

  IF NOT public.is_platform_user()
    AND public.current_user_scope_type() IS DISTINCT FROM 'tenant'
  THEN
    RAISE EXCEPTION 'open_ops_session_v1 requires tenant scope' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_in) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'open_ops_session_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  v_session_type := lower(NULLIF(btrim(COALESCE(v_in->>'session_type', '')), ''));
  v_idempotency := NULLIF(btrim(COALESCE(v_in->>'idempotency_key', '')), '');
  v_session_code := NULLIF(btrim(COALESCE(v_in->>'session_code', '')), '');

  BEGIN v_branch_id := NULLIF(btrim(COALESCE(v_in->>'branch_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_branch_id := NULL; END;
  BEGIN v_device_id := NULLIF(btrim(COALESCE(v_in->>'device_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_device_id := NULL; END;
  BEGIN v_opened_at := NULLIF(btrim(COALESCE(v_in->>'opened_at', '')), '')::timestamptz; EXCEPTION WHEN others THEN v_opened_at := NULL; END;
  v_opened_at := COALESCE(v_opened_at, now());

  v_meta := COALESCE(v_in->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_meta) IS DISTINCT FROM 'object' THEN v_meta := '{}'::jsonb; END IF;

  IF v_session_type IS NULL THEN
    RAISE EXCEPTION 'open_ops_session_v1 requires session_type' USING ERRCODE = '23514';
  END IF;
  IF v_idempotency IS NULL THEN
    RAISE EXCEPTION 'open_ops_session_v1 requires idempotency_key' USING ERRCODE = '23514';
  END IF;

  -- Resolve default status via lookup (dynamic; no hardcoded enum values).
  SELECT lv.value
    INTO v_default_status
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'ops_session_status'
     AND lv.is_default IS TRUE
   ORDER BY lv.sort_order NULLS LAST, lv.value
   LIMIT 1;

  IF v_default_status IS NULL THEN
    RAISE EXCEPTION 'open_ops_session_v1 could not resolve default ops_session_status' USING ERRCODE = '23503';
  END IF;

  -- Validate session_type via lookup (dynamic; no hardcoded enum).
  PERFORM 1
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'ops_session_type'
    AND lv.value = v_session_type
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'open_ops_session_v1 invalid session_type: %', v_session_type USING ERRCODE = '23514';
  END IF;

  -- Create session projection (idempotent by org+idempotency_key).
  INSERT INTO public.ops_sessions (
    id,
    organization_id,
    session_type,
    status,
    branch_id,
    actor_user_id,
    device_id,
    session_code,
    idempotency_key,
    opened_at,
    closed_at,
    version,
    metadata,
    created_at,
    updated_at
  )
  VALUES (
    v_id,
    v_org,
    v_session_type,
    v_default_status,
    v_branch_id,
    v_user,
    v_device_id,
    v_session_code,
    v_idempotency,
    v_opened_at,
    NULL,
    1,
    v_meta,
    now(),
    now()
  )
  ON CONFLICT (organization_id, idempotency_key) DO NOTHING;

  IF FOUND THEN
    ops_session_id := v_id;
    created := TRUE;

    INSERT INTO public.ops_session_events (
      ops_session_id,
      organization_id,
      event_type,
      from_status,
      to_status,
      actor_user_id,
      actor_system,
      payload,
      idempotency_key,
      session_version,
      decision_log_id,
      settings_resolution_id,
      created_at
    )
    VALUES (
      ops_session_id,
      v_org,
      'opened',
      NULL,
      v_default_status,
      v_user,
      'open_ops_session_v1',
      jsonb_strip_nulls(jsonb_build_object(
        'session_type', v_session_type,
        'status', v_default_status,
        'branch_id', v_branch_id,
        'device_id', v_device_id,
        'session_code', v_session_code,
        'opened_at', v_opened_at
      )),
      v_idempotency,
      1,
      NULL,
      NULL,
      now()
    )
    ON CONFLICT (ops_session_id, idempotency_key) DO NOTHING;
  ELSE
    SELECT s.id INTO v_existing_id
    FROM public.ops_sessions s
    WHERE s.organization_id = v_org
      AND s.idempotency_key = v_idempotency
    LIMIT 1;

    IF v_existing_id IS NULL THEN
      RAISE EXCEPTION 'open_ops_session_v1 idempotency replay could not find session row' USING ERRCODE = '23503';
    END IF;

    ops_session_id := v_existing_id;
    created := FALSE;
  END IF;

  PERFORM public.log_decision(
    p_organization_id := v_org,
    p_decision_category := 'ops',
    p_resource_type := 'ops_session',
    p_resource_id := ops_session_id,
    p_decision_point := 'open',
    p_decision_outcome := CASE WHEN created IS TRUE THEN 'created' ELSE 'replayed' END,
    p_performed_by_system := 'open_ops_session_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'session_type', v_session_type,
      'branch_id', v_branch_id,
      'device_id', v_device_id,
      'session_code', v_session_code,
      'opened_at', v_opened_at,
      'idempotency_key', v_idempotency
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.open_ops_session_v1(JSONB)
  IS 'Create an ops session (projection + open event) idempotently by org+idempotency_key. Intended for driver/warehouse/branch sessionization.';

REVOKE ALL ON FUNCTION public.open_ops_session_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.open_ops_session_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.open_ops_session_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.transition_ops_session_v1(
  p_input JSONB
)
RETURNS TABLE (
  ops_session_id UUID,
  updated BOOLEAN,
  status TEXT,
  closed_at TIMESTAMPTZ,
  session_version INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := public.current_user_org_id();
  v_in JSONB := COALESCE(p_input, '{}'::jsonb);

  v_session_id UUID := NULL;
  v_to_status TEXT := NULL;
  v_idempotency TEXT := NULL;
  v_effective_at TIMESTAMPTZ := NULL;
  v_set_closed BOOLEAN := FALSE;
  v_actor_system TEXT := NULL;
  v_payload JSONB := '{}'::jsonb;

  v_before public.ops_sessions%ROWTYPE;
  v_new_version INT := NULL;
  v_event_id UUID := NULL;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'transition_ops_session_v1 requires an authenticated user';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'transition_ops_session_v1 could not resolve organization_id';
  END IF;

  IF NOT public.is_platform_user()
    AND public.current_user_scope_type() IS DISTINCT FROM 'tenant'
  THEN
    RAISE EXCEPTION 'transition_ops_session_v1 requires tenant scope' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_in) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'transition_ops_session_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_session_id := NULLIF(btrim(COALESCE(v_in->>'ops_session_id', v_in->>'session_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_session_id := NULL; END;
  v_to_status := lower(NULLIF(btrim(COALESCE(v_in->>'to_status', '')), ''));
  v_idempotency := NULLIF(btrim(COALESCE(v_in->>'idempotency_key', '')), '');
  v_actor_system := NULLIF(btrim(COALESCE(v_in->>'actor_system', '')), '');
  v_payload := COALESCE(v_in->'payload', '{}'::jsonb);
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN v_payload := '{}'::jsonb; END IF;

  BEGIN v_effective_at := NULLIF(btrim(COALESCE(v_in->>'effective_at', '')), '')::timestamptz; EXCEPTION WHEN others THEN v_effective_at := NULL; END;
  v_effective_at := COALESCE(v_effective_at, now());

  BEGIN v_set_closed := COALESCE((v_in->>'set_closed_at')::boolean, FALSE); EXCEPTION WHEN others THEN v_set_closed := FALSE; END;

  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'transition_ops_session_v1 requires ops_session_id' USING ERRCODE = '23514';
  END IF;
  IF v_to_status IS NULL THEN
    RAISE EXCEPTION 'transition_ops_session_v1 requires to_status' USING ERRCODE = '23514';
  END IF;
  IF v_idempotency IS NULL THEN
    RAISE EXCEPTION 'transition_ops_session_v1 requires idempotency_key' USING ERRCODE = '23514';
  END IF;

  -- Validate status via lookup (dynamic; no hardcoded enum).
  PERFORM 1
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'ops_session_status'
    AND lv.value = v_to_status
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_ops_session_v1 invalid to_status: %', v_to_status USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_before
  FROM public.ops_sessions s
  WHERE s.id = v_session_id
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_ops_session_v1 ops_session not found: %', v_session_id USING ERRCODE = '23503';
  END IF;

  IF v_before.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'transition_ops_session_v1: organization mismatch (session org %, actor org %)', v_before.organization_id, v_org
      USING ERRCODE = '23514';
  END IF;

  IF NOT public.is_platform_user() AND v_before.actor_user_id IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'transition_ops_session_v1: actor_user mismatch (session actor %, current user %)', v_before.actor_user_id, v_user
      USING ERRCODE = '42501';
  END IF;

  -- Idempotency: replay existing event (no-op).
  PERFORM 1
  FROM public.ops_session_events e
  WHERE e.ops_session_id = v_session_id
    AND e.idempotency_key = v_idempotency
  LIMIT 1;
  IF FOUND THEN
    ops_session_id := v_before.id;
    status := v_before.status;
    closed_at := v_before.closed_at;
    session_version := v_before.version;
    updated := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  v_new_version := v_before.version + 1;

  UPDATE public.ops_sessions s
     SET status = v_to_status,
         closed_at = CASE WHEN v_set_closed IS TRUE THEN COALESCE(s.closed_at, v_effective_at) ELSE s.closed_at END,
         version = v_new_version,
         updated_at = now()
   WHERE s.id = v_session_id;

  INSERT INTO public.ops_session_events (
    ops_session_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    actor_system,
    payload,
    idempotency_key,
    session_version,
    decision_log_id,
    settings_resolution_id,
    created_at
  )
  VALUES (
    v_session_id,
    v_org,
    'status_transition',
    v_before.status,
    v_to_status,
    v_user,
    COALESCE(v_actor_system, 'transition_ops_session_v1'),
    jsonb_strip_nulls(jsonb_build_object(
      'effective_at', v_effective_at,
      'set_closed_at', v_set_closed,
      'payload', v_payload
    )),
    v_idempotency,
    v_new_version,
    NULL,
    NULL,
    now()
  )
  RETURNING id INTO v_event_id;

  ops_session_id := v_session_id;
  status := v_to_status;
  closed_at := (SELECT s.closed_at FROM public.ops_sessions s WHERE s.id = v_session_id);
  session_version := v_new_version;
  updated := TRUE;

  PERFORM public.log_decision(
    p_organization_id := v_org,
    p_decision_category := 'ops',
    p_resource_type := 'ops_session',
    p_resource_id := v_session_id,
    p_decision_point := 'transition',
    p_decision_outcome := 'applied',
    p_performed_by_system := 'transition_ops_session_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'ops_session_id', v_session_id,
      'from_status', v_before.status,
      'to_status', v_to_status,
      'effective_at', v_effective_at,
      'set_closed_at', v_set_closed,
      'idempotency_key', v_idempotency,
      'event_id', v_event_id
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.transition_ops_session_v1(JSONB)
  IS 'Transition ops session status (ledgered). Idempotent by ops_session_id + idempotency_key; tenant actors can transition only their own sessions.';

REVOKE ALL ON FUNCTION public.transition_ops_session_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_ops_session_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.transition_ops_session_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 5) scan_events: add optional ops_session_id link (schema only)
-------------------------------------------------------------------------------

ALTER TABLE public.scan_events
  ADD COLUMN IF NOT EXISTS ops_session_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'scan_events'
      AND c.conname = 'scan_events_ops_session_id_fkey'
  ) THEN
    ALTER TABLE public.scan_events
      ADD CONSTRAINT scan_events_ops_session_id_fkey
      FOREIGN KEY (ops_session_id)
      REFERENCES public.ops_sessions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_scan_events_ops_session_time
  ON public.scan_events (ops_session_id, captured_at DESC)
  WHERE ops_session_id IS NOT NULL;

-------------------------------------------------------------------------------
-- 6) Table contracts (timestamp + audit SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'ops_sessions', TRUE, TRUE, TRUE, 'Operational sessions (projection) for driver/warehouse/branch sessionization.'),
  ('public', 'ops_session_events', TRUE, FALSE, FALSE, 'Ops session event ledger (immutable); audit disabled by contract.')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202601271110_ops_sessions_v1'));
COMMIT;

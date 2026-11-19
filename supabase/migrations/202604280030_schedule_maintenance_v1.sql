-- Plan: PHASE B / B2 — Backend RPC contract gap-fill (FLEET)
-- Migration: schedule_maintenance_v1 — insert a maintenance window
-- Date: 2026-04-28
--
-- Notes:
--   - Adds maintenance_window_status lookup + a status column on
--     public.vehicle_maintenance_windows (defaults to 'scheduled') to support
--     the canonical scheduled / completed / cancelled lifecycle.
--   - All schema changes are additive and non-breaking (existing rows default to 'scheduled').

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280030_schedule_maintenance_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- 1) Add maintenance_window_status lookup (idempotent)
INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('maintenance_window_status', 'Vehicle maintenance window status (scheduled/completed/cancelled)', 'fleet', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('scheduled', 'Scheduled', 'Window is scheduled', 10, TRUE,  '{}'),
  ('completed', 'Completed', 'Window completed',     20, FALSE, '{}'),
  ('cancelled', 'Cancelled', 'Window cancelled',     30, FALSE, '{}')
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'maintenance_window_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- 2) Additive column on vehicle_maintenance_windows
ALTER TABLE public.vehicle_maintenance_windows
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'scheduled';

ALTER TABLE public.vehicle_maintenance_windows
  ADD COLUMN IF NOT EXISTS scheduled_by_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.vehicle_maintenance_windows
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ NULL;

ALTER TABLE public.vehicle_maintenance_windows
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ NULL;

-- Constraint: status must be lowercase non-empty
DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'vehicle_maintenance_windows_status_ck'
       AND conrelid = 'public.vehicle_maintenance_windows'::regclass
  ) THEN
    ALTER TABLE public.vehicle_maintenance_windows
      ADD CONSTRAINT vehicle_maintenance_windows_status_ck
      CHECK (btrim(status) <> '' AND status = lower(status));
  END IF;
END
$constraint$;

CREATE INDEX IF NOT EXISTS idx_vehicle_maintenance_windows_org_status_start
  ON public.vehicle_maintenance_windows (organization_id, status, window_start_at DESC);

-- 3) Canonical RPC
CREATE OR REPLACE FUNCTION public.schedule_maintenance_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();

  v_vehicle_id UUID;
  v_window_start TIMESTAMPTZ;
  v_window_end TIMESTAMPTZ;
  v_reason TEXT;
  v_notes TEXT;
  v_metadata JSONB;

  v_vehicle public.vehicles%ROWTYPE;
  v_window_id UUID := gen_random_uuid();
  v_correlation_id UUID := gen_random_uuid();
  v_resolved_settings JSONB;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'schedule_maintenance_v1: p_args must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'schedule_maintenance_v1: authenticated tenant user required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  v_vehicle_id := NULLIF(p_args->>'vehicle_id', '')::UUID;
  v_window_start := NULLIF(p_args->>'window_start_at', '')::TIMESTAMPTZ;
  v_window_end := NULLIF(p_args->>'window_end_at', '')::TIMESTAMPTZ;
  v_reason := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_notes := NULLIF(btrim(COALESCE(p_args->>'notes', '')), '');
  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);

  IF v_vehicle_id IS NULL THEN
    RAISE EXCEPTION 'schedule_maintenance_v1: vehicle_id is required' USING ERRCODE = '22023';
  END IF;
  IF v_window_start IS NULL OR v_window_end IS NULL THEN
    RAISE EXCEPTION 'schedule_maintenance_v1: window_start_at and window_end_at are required' USING ERRCODE = '22023';
  END IF;
  IF v_window_end < v_window_start THEN
    RAISE EXCEPTION 'schedule_maintenance_v1: window_end_at must be >= window_start_at' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_vehicle
    FROM public.vehicles
   WHERE id = v_vehicle_id
   FOR UPDATE;
  IF v_vehicle.id IS NULL THEN
    RAISE EXCEPTION 'schedule_maintenance_v1: vehicle % not found', v_vehicle_id USING ERRCODE = 'P0002';
  END IF;
  IF v_vehicle.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'schedule_maintenance_v1: vehicle % belongs to another organization', v_vehicle_id USING ERRCODE = '42501';
  END IF;

  v_resolved_settings := public.resolve_settings_merged('fleet_policy', 'tenant', v_org_id);

  INSERT INTO public.vehicle_maintenance_windows (
    id,
    organization_id,
    vehicle_id,
    window_start_at,
    window_end_at,
    reason,
    notes,
    status,
    scheduled_by_user_id,
    metadata
  )
  VALUES (
    v_window_id,
    v_org_id,
    v_vehicle_id,
    v_window_start,
    v_window_end,
    v_reason,
    v_notes,
    'scheduled',
    auth.uid(),
    v_metadata
      || jsonb_build_object(
           'correlation_id', v_correlation_id,
           'fleet_policy_resolution', COALESCE(v_resolved_settings, '{}'::jsonb)
         )
  );

  PERFORM public.enqueue_domain_event(
    v_org_id,
    'fleet.maintenance_scheduled',
    'vehicle_maintenance_window',
    v_window_id,
    jsonb_build_object(
      'vehicle_id', v_vehicle_id,
      'window_start_at', v_window_start,
      'window_end_at', v_window_end,
      'reason', v_reason,
      'requested_by', auth.uid()
    ),
    v_correlation_id
  );

  PERFORM public.log_decision(
    v_org_id,
    'fleet.maintenance_scheduled',
    'vehicle_maintenance_window',
    v_window_id,
    'rpc_dispatch',
    'scheduled',
    'schedule_maintenance_v1',
    v_correlation_id,
    jsonb_build_object(
      'vehicle_id', v_vehicle_id,
      'window_start_at', v_window_start,
      'window_end_at', v_window_end,
      'fleet_policy', COALESCE(v_resolved_settings, '{}'::jsonb)
    ),
    v_reason
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'vehicle_maintenance_window_id', v_window_id,
    'vehicle_id', v_vehicle_id,
    'status', 'scheduled',
    'window_start_at', v_window_start,
    'window_end_at', v_window_end,
    'correlation_id', v_correlation_id,
    'resolved_from', 'fleet_policy/tenant'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.schedule_maintenance_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.schedule_maintenance_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.schedule_maintenance_v1(JSONB)
  IS 'Canonical RPC: insert vehicle_maintenance_windows row with status=scheduled. Capability-gated (fleet.write).';

-- 4) Update table contract for new columns
INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES ('public', 'vehicle_maintenance_windows', TRUE, TRUE, TRUE, 'Vehicle maintenance windows (org-scoped) — extended with status lifecycle column.')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET notes = EXCLUDED.notes,
    updated_at = now();

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202604280030_schedule_maintenance_v1'));
COMMIT;

-- Plan: Console V2 operations lifecycle closure
-- Step: Backend-backed support roster + warehouse checkpoint scan resources
-- Migration: console_v2_support_warehouse_live_views_v1
--
-- Goals:
--   - Replace Console V2 seed-only support_users with a registry-readable
--     backend resource sourced from public.users and row-driven roster policy.
--   - Replace Console V2 seed-only warehouse_checkpoint_scans with a
--     registry-readable backend resource derived from canonical scan_events
--     where scan_type = 'warehouse_checkpoint'.
--   - Keep shared UI reads fail-closed: security_invoker views, RLS-backed
--     source tables, explicit ui_read_registry resources, no app-side DB
--     fallback.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605041400_console_v2_support_warehouse_live_views_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Row-driven support roster policy
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.support_user_roster_policy (
  user_type TEXT PRIMARY KEY,
  role_label TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 100,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT support_user_roster_policy_user_type_ck CHECK (btrim(user_type) <> '' AND user_type = lower(user_type)),
  CONSTRAINT support_user_roster_policy_role_label_ck CHECK (btrim(role_label) <> '')
);

DROP TRIGGER IF EXISTS trg_support_user_roster_policy_set_updated_at ON public.support_user_roster_policy;
CREATE TRIGGER trg_support_user_roster_policy_set_updated_at
  BEFORE UPDATE ON public.support_user_roster_policy
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.support_user_roster_policy ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.support_user_roster_policy FROM PUBLIC;
REVOKE ALL ON TABLE public.support_user_roster_policy FROM anon;
REVOKE ALL ON TABLE public.support_user_roster_policy FROM authenticated;

GRANT SELECT ON TABLE public.support_user_roster_policy TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_user_roster_policy TO service_role;

DROP POLICY IF EXISTS support_user_roster_policy_select ON public.support_user_roster_policy;
CREATE POLICY support_user_roster_policy_select
  ON public.support_user_roster_policy
  FOR SELECT
  TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS support_user_roster_policy_service_policy ON public.support_user_roster_policy;
CREATE POLICY support_user_roster_policy_service_policy
  ON public.support_user_roster_policy
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

INSERT INTO public.support_user_roster_policy (user_type, role_label, is_active, sort_order, metadata)
VALUES
  ('super_admin', 'super_admin', TRUE, 10, jsonb_build_object('bootstrap_default', TRUE, 'source', 'access_control_policy.user_type')),
  ('ops_admin', 'ops_admin', TRUE, 20, jsonb_build_object('bootstrap_default', TRUE, 'source', 'access_control_policy.user_type')),
  ('account_manager', 'account_manager', TRUE, 30, jsonb_build_object('bootstrap_default', TRUE, 'source', 'access_control_policy.user_type'))
ON CONFLICT (user_type) DO UPDATE
SET
  role_label = EXCLUDED.role_label,
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order,
  metadata = public.support_user_roster_policy.metadata || EXCLUDED.metadata,
  updated_at = now();

COMMENT ON TABLE public.support_user_roster_policy IS
  'Row-driven policy for Console V2 support assignee roster membership. support_users view reads this policy and public.users; edit rows instead of hardcoding app-side rosters.';

-------------------------------------------------------------------------------
-- 2) support_users backend projection
-------------------------------------------------------------------------------

DROP VIEW IF EXISTS public.support_users;

CREATE VIEW public.support_users
  WITH (security_invoker = true)
AS
SELECT
  u.id,
  u.organization_id,
  u.full_name AS name,
  p.role_label AS role,
  u.email,
  u.user_type,
  u.status,
  p.sort_order,
  jsonb_strip_nulls(
    jsonb_build_object(
      'source', 'public.users',
      'policy_source', 'support_user_roster_policy',
      'user_type', u.user_type
    ) || COALESCE(p.metadata, '{}'::jsonb)
  ) AS metadata,
  u.created_at,
  u.last_login_at
FROM public.users u
JOIN public.support_user_roster_policy p
  ON p.user_type = lower(u.user_type)
 AND p.is_active IS TRUE
WHERE u.status = 'active';

COMMENT ON VIEW public.support_users IS
  'Console V2 support assignee roster. Backend-backed projection from public.users filtered by row-driven support_user_roster_policy. Read-only; support assignment mutations stay on support case RPCs.';

REVOKE ALL ON public.support_users FROM PUBLIC;
REVOKE ALL ON public.support_users FROM anon;
GRANT SELECT ON public.support_users TO authenticated;
GRANT SELECT ON public.support_users TO service_role;

-------------------------------------------------------------------------------
-- 3) warehouse_checkpoint_scans backend projection from scan_events SSOT
-------------------------------------------------------------------------------

DROP VIEW IF EXISTS public.warehouse_checkpoint_scans;

CREATE VIEW public.warehouse_checkpoint_scans
  WITH (security_invoker = true)
AS
SELECT
  se.id,
  se.organization_id,
  se.warehouse_transfer_id AS transfer_id,
  se.warehouse_transfer_id,
  se.shipment_id,
  COALESCE(
    NULLIF(btrim(se.checkpoint_key), ''),
    NULLIF(btrim(se.metadata->>'checkpoint'), ''),
    NULLIF(btrim(se.metadata->>'checkpoint_key'), '')
  ) AS checkpoint,
  COALESCE(
    se.checkpoint_sequence,
    CASE
      WHEN COALESCE(se.metadata->>'sequence', '') ~ '^[0-9]+$'
        THEN (se.metadata->>'sequence')::INT
      ELSE NULL
    END
  ) AS sequence,
  se.captured_at AS occurred_at,
  se.captured_at,
  se.actor_user_id AS user_id,
  se.actor_user_id,
  se.branch_id,
  se.client_id,
  se.barcode,
  se.correction_of_scan_event_id,
  se.correction_reason,
  se.correction_approval_task_id,
  se.metadata,
  se.received_at,
  se.created_at
FROM public.scan_events se
WHERE se.scan_type = 'warehouse_checkpoint';

COMMENT ON VIEW public.warehouse_checkpoint_scans IS
  'Console V2 warehouse checkpoint projection derived from canonical scan_events where scan_type=warehouse_checkpoint. Read-only; checkpoint writes stay on record_scan_event_v1 / record_scan_events_batch_v1 and warehouse transfer workflow RPCs.';

REVOKE ALL ON public.warehouse_checkpoint_scans FROM PUBLIC;
REVOKE ALL ON public.warehouse_checkpoint_scans FROM anon;
GRANT SELECT ON public.warehouse_checkpoint_scans TO authenticated;
GRANT SELECT ON public.warehouse_checkpoint_scans TO service_role;

DROP POLICY IF EXISTS scan_events_warehouse_checkpoint_select ON public.scan_events;
CREATE POLICY scan_events_warehouse_checkpoint_select
  ON public.scan_events
  FOR SELECT
  TO authenticated
  USING (
    scan_type = 'warehouse_checkpoint'
    AND (
      public.is_platform_user()
      OR (
        organization_id = public.current_user_org_id()
        AND public.user_has_capability_v1('warehouse.read', 'tenant', organization_id)
      )
    )
  );

-------------------------------------------------------------------------------
-- 4) Console V2 ui_read_registry resources
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_settings_version_id UUID;
  v_current JSONB;
  v_resource JSONB;
  v_resources JSONB := '[
    {
      "key": "support_users",
      "relation": "public.support_users",
      "id_column": "id",
      "capability_read": "support.read",
      "scope_columns": {"tenant": "organization_id"},
      "select": ["id","organization_id","name","role","email","user_type","status","sort_order","metadata","created_at","last_login_at"],
      "filters": [
        {"key": "role", "column": "role", "op": "eq"},
        {"key": "status", "column": "status", "op": "eq"},
        {"key": "name", "column": "name", "op": "ilike"}
      ],
      "default_sort": {"column": "sort_order", "direction": "asc"}
    },
    {
      "key": "warehouse_checkpoint_scans",
      "relation": "public.warehouse_checkpoint_scans",
      "id_column": "id",
      "capability_read": "warehouse.read",
      "scope_columns": {"tenant": "organization_id"},
      "select": ["id","organization_id","transfer_id","warehouse_transfer_id","shipment_id","checkpoint","sequence","occurred_at","captured_at","user_id","actor_user_id","branch_id","client_id","barcode","correction_of_scan_event_id","correction_reason","correction_approval_task_id","metadata","received_at","created_at"],
      "filters": [
        {"key": "transfer_id", "column": "transfer_id", "op": "eq"},
        {"key": "shipment_id", "column": "shipment_id", "op": "eq"},
        {"key": "checkpoint", "column": "checkpoint", "op": "eq"}
      ],
      "default_sort": {"column": "occurred_at", "direction": "desc"}
    }
  ]'::jsonb;
  v_filtered JSONB;
BEGIN
  SELECT s.settings_version_id, s.cached_value
    INTO v_settings_version_id, v_current
    FROM public.settings s
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_current := COALESCE(v_current, '{"resources":[]}'::jsonb);

  FOR v_resource IN
    SELECT value FROM jsonb_array_elements(v_resources) AS value
  LOOP
    SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS value
     WHERE value->>'key' <> v_resource->>'key';

    v_current := jsonb_set(v_current, '{resources}', v_filtered || jsonb_build_array(v_resource), TRUE);
  END LOOP;

  UPDATE public.settings_versions
     SET value = v_current,
         updated_at = now(),
         change_reason = 'Back Console V2 support roster and warehouse checkpoint scan resources with live backend views'
   WHERE id = v_settings_version_id;

  UPDATE public.settings
     SET cached_value = v_current,
         last_updated = now()
   WHERE settings_version_id = v_settings_version_id;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605041400_console_v2_support_warehouse_live_views_v1'));
COMMIT;

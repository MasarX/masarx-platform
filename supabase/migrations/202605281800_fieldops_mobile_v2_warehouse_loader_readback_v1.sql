-- Migration: fieldops_mobile_v2_warehouse_loader_readback_v1
-- Date: 2026-05-28
-- Scope: Mobile V2 warehouse/loader bounded readiness slice.
--
-- Goals:
-- - Make loader scan submit routing policy-driven: only actions with a
--   row-declared submit_rpc may write.
-- - Wire the existing sort action to the existing induct_fieldops_parcel_v1
--   RPC without routing load/unload/receive through induction.
-- - Back the Mobile V2 sortation resolver with fieldops_v2_inductions so
--   the app can refetch same-context backend readback after scan submit.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605281800_fieldops_mobile_v2_warehouse_loader_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Document the optional action-level executor on the policy schema. The
-- schema remains forward-compatible because additionalProperties is true.
UPDATE public.schema_registry
   SET schema = jsonb_set(
                schema,
                '{properties,actions,items,properties,submit_rpc}',
                jsonb_build_object(
                  'type', 'string',
                  'description', 'Backend RPC executor for production-wired loader actions.'
                ),
                TRUE
              )
 WHERE category = 'mobile_loader_policy'
   AND version = 1;

UPDATE public.schema_registry
   SET schema = jsonb_set(
                schema,
                '{properties,session_context}',
                jsonb_build_object(
                  'type', 'object',
                  'description', 'Row-driven default warehouse scan session context for Mobile V2 loader sessions.',
                  'properties', jsonb_build_object(
                    'bay', jsonb_build_object('type', 'string'),
                    'wave_label', jsonb_build_object('type', 'string'),
                    'route_label', jsonb_build_object('type', 'string'),
                    'cut_off', jsonb_build_object('type', 'string')
                  )
                ),
                TRUE
              )
 WHERE category = 'mobile_loader_policy'
   AND version = 1;

-- Current policy rows: sort is the only shipped backend-backed warehouse
-- action in this slice. Other visible actions stay selectable but do not
-- submit until their own RPCs are present in policy. Keep this executor
-- wiring generic; first-tenant proof context is materialized below as a
-- tenant-scoped override so FT-LIVE values cannot leak into global defaults.
WITH updated_versions AS (
  UPDATE public.settings_versions sv
     SET value = jsonb_set(
                   jsonb_set(
                     sv.value,
                     '{actions}',
                     (
                       SELECT COALESCE(
                         jsonb_agg(
                           CASE
                             WHEN action->>'key' = 'sort'
                               THEN action || jsonb_build_object('submit_rpc', 'induct_fieldops_parcel_v1')
                             ELSE action
                           END
                           ORDER BY ord
                         ),
                         sv.value->'actions'
                       )
                       FROM jsonb_array_elements(sv.value->'actions') WITH ORDINALITY AS t(action, ord)
                     ),
                     TRUE
                   ),
                   '{default_action}',
                   to_jsonb('sort'::text),
                   TRUE
                 )
   WHERE sv.category = 'mobile_loader_policy'
     AND sv.effective_until IS NULL
     AND sv.approved_at IS NOT NULL
     AND jsonb_typeof(sv.value->'actions') = 'array'
   RETURNING sv.id, sv.value
)
UPDATE public.settings s
   SET cached_value = uv.value,
       last_updated = now()
  FROM updated_versions uv
 WHERE s.settings_version_id = uv.id
   AND s.category = 'mobile_loader_policy';

-- Idempotent repair for any environment that previously applied this slice
-- while the FT-LIVE proof context was still broad. Only the proof context is
-- stripped, and only outside the selected first-tenant row.
WITH first_tenant AS (
  SELECT candidate.id
    FROM (
      SELECT o.id, 0 AS priority, o.created_at
        FROM public.organizations o
       WHERE o.name ILIKE 'First Tenant Readiness Logistics%'
         AND o.id <> '00000000-0000-0000-0000-000000000000'::uuid
      UNION ALL
      SELECT o.id, 1 AS priority, o.created_at
        FROM public.organizations o
       WHERE o.id <> '00000000-0000-0000-0000-000000000000'::uuid
    ) AS candidate
   ORDER BY candidate.priority, candidate.created_at DESC
   LIMIT 1
),
stripped_versions AS (
  UPDATE public.settings_versions sv
     SET value = sv.value - 'session_context',
         change_reason = COALESCE(sv.change_reason, 'Mobile V2 loader policy update') || '; strip non-tenant FT-LIVE proof session_context'
   WHERE sv.category = 'mobile_loader_policy'
     AND sv.effective_until IS NULL
     AND sv.approved_at IS NOT NULL
     AND sv.value ? 'session_context'
     AND (
       sv.value#>>'{session_context,bay}' = 'FT-LIVE-BAY-01'
       OR sv.value#>>'{session_context,wave_label}' = 'FT-LIVE-WAVE'
       OR sv.value#>>'{session_context,route_label}' = 'FT-LIVE-ROUTE'
     )
     AND NOT (
       sv.scope_type = 'tenant'
       AND sv.scope_id = (SELECT id FROM first_tenant)
     )
   RETURNING sv.id, sv.value
)
UPDATE public.settings s
   SET cached_value = sv.value,
       last_updated = now()
  FROM stripped_versions sv
 WHERE s.settings_version_id = sv.id
   AND s.category = 'mobile_loader_policy';

-- First-tenant live proof needs a row-driven loader session context, but
-- proof labels are tenant data. Resolve the current winning loader policy for
-- the first-tenant candidate and materialize a tenant-scoped override through
-- the canonical settings upsert helper.
DO $do$
DECLARE
  v_first_tenant_id UUID;
  v_policy_value JSONB;
  v_next_value JSONB;
  v_schema_version INT := 1;
BEGIN
  SELECT candidate.id
    INTO v_first_tenant_id
    FROM (
      SELECT o.id, 0 AS priority, o.created_at
        FROM public.organizations o
       WHERE o.name ILIKE 'First Tenant Readiness Logistics%'
         AND o.id <> '00000000-0000-0000-0000-000000000000'::uuid
      UNION ALL
      SELECT o.id, 1 AS priority, o.created_at
        FROM public.organizations o
       WHERE o.id <> '00000000-0000-0000-0000-000000000000'::uuid
    ) AS candidate
   ORDER BY candidate.priority, candidate.created_at DESC
   LIMIT 1;

  IF v_first_tenant_id IS NULL THEN
    RETURN;
  END IF;

  SELECT r.value,
         COALESCE(sv.schema_version, sr.version, 1)
    INTO v_policy_value,
         v_schema_version
    FROM public.resolve_settings_row_from_policy_context_v1(
           'mobile_loader_policy',
           jsonb_build_object('organization_id', v_first_tenant_id)
         ) r
    LEFT JOIN public.settings_versions sv
      ON sv.id = r.settings_version_id
    LEFT JOIN LATERAL (
      SELECT x.version
        FROM public.schema_registry x
       WHERE x.category = 'mobile_loader_policy'
         AND x.is_active = TRUE
       ORDER BY x.version DESC
       LIMIT 1
    ) sr ON TRUE
   LIMIT 1;

  IF v_policy_value IS NULL THEN
    RAISE EXCEPTION 'Cannot materialize first-tenant mobile_loader_policy session_context, missing source policy'
      USING ERRCODE = '23514';
  END IF;

  v_next_value := jsonb_set(
    v_policy_value,
    '{session_context}',
    jsonb_build_object(
      'bay', 'FT-LIVE-BAY-01',
      'wave_label', 'FT-LIVE-WAVE',
      'route_label', 'FT-LIVE-ROUTE',
      'cut_off', '23:30'
    ),
    TRUE
  );

  IF v_next_value IS DISTINCT FROM v_policy_value THEN
    PERFORM *
      FROM public.upsert_settings_value_v1(
        'mobile_loader_policy',
        'tenant',
        v_first_tenant_id,
        v_next_value,
        COALESCE(v_schema_version, 1),
        'FieldOps Mobile V2 warehouse loader first-tenant session context.'
      );
  END IF;
END;
$do$;

-- The production RBAC role is warehouse_operator, while the Mobile V2
-- persona/nav role is loader. Keep the alias row-driven in role metadata so
-- the drawer can expose a loader persona without duplicating RBAC roles.
UPDATE public.rbac_role_templates
   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('mobile_v2_role', 'loader'),
       updated_at = now()
 WHERE key = 'warehouse_operator';

UPDATE public.rbac_roles
   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('mobile_v2_role', 'loader'),
       updated_at = now()
 WHERE key = 'warehouse_operator';

UPDATE public.rbac_role_templates
   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('mobile_v2_role', 'driver'),
       updated_at = now()
 WHERE key = 'fieldops_money_driver';

UPDATE public.rbac_roles
   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('mobile_v2_role', 'driver'),
       updated_at = now()
 WHERE key = 'fieldops_money_driver';

CREATE OR REPLACE FUNCTION public.provision_rbac_roles_from_templates_v1(
  p_organization_id UUID,
  p_template_keys TEXT[] DEFAULT NULL,
  p_granted_by_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  template_key TEXT,
  role_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'provision_rbac_roles_from_templates_v1: organization_id is required' USING ERRCODE = '23502';
  END IF;

  RETURN QUERY
  WITH templates AS (
    SELECT t.id, t.key, t.name, t.description, COALESCE(t.metadata, '{}'::jsonb) AS metadata
    FROM public.rbac_role_templates t
    WHERE t.is_active IS TRUE
      AND (p_template_keys IS NULL OR t.key = ANY(p_template_keys))
  ),
  upserted_roles AS (
    INSERT INTO public.rbac_roles (organization_id, key, name, description, metadata)
    SELECT
      p_organization_id,
      t.key,
      t.name,
      t.description,
      t.metadata || jsonb_build_object('provisioned_from_template', TRUE, 'template_key', t.key)
    FROM templates t
    ON CONFLICT (organization_id, key) DO UPDATE
    SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      metadata = public.rbac_roles.metadata || EXCLUDED.metadata,
      updated_at = now()
    RETURNING public.rbac_roles.id AS created_role_id, public.rbac_roles.key AS role_key, (xmax = 0) AS created
  ),
  seeded_perms AS (
    INSERT INTO public.rbac_role_permissions (
      organization_id,
      role_id,
      permission_id,
      granted_by_user_id,
      metadata
    )
    SELECT
      p_organization_id,
      r.created_role_id,
      tp.permission_id,
      p_granted_by_user_id,
      jsonb_build_object('source', 'template', 'template_key', r.role_key)
    FROM upserted_roles r
    JOIN public.rbac_role_templates t ON t.key = r.role_key
    JOIN public.rbac_role_template_permissions tp ON tp.role_template_id = t.id
    ON CONFLICT ON CONSTRAINT rbac_role_permissions_unique DO NOTHING
    RETURNING 1
  )
  SELECT r.role_key, r.created_role_id, r.created
  FROM upserted_roles r;
END;
$function$;

REVOKE ALL ON FUNCTION public.provision_rbac_roles_from_templates_v1(UUID, TEXT[], UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.provision_rbac_roles_from_templates_v1(UUID, TEXT[], UUID) FROM anon;
REVOKE ALL ON FUNCTION public.provision_rbac_roles_from_templates_v1(UUID, TEXT[], UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.provision_rbac_roles_from_templates_v1(UUID, TEXT[], UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.auth_set_active_role_v1(p_role_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_caller_org UUID;
  v_normalized_role TEXT;
  v_assignment_count INT;
  v_capability_keys TEXT[];
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_existing_role TEXT;
  v_outcome TEXT;
  v_switched_at TIMESTAMPTZ;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'auth_set_active_role_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_normalized_role := lower(btrim(COALESCE(p_role_key, '')));
  IF v_normalized_role = '' THEN
    RAISE EXCEPTION 'auth_set_active_role_v1: role_key required'
      USING ERRCODE = '22023';
  END IF;

  v_caller_org := public.current_user_org_id();
  IF v_caller_org IS NULL THEN
    RAISE EXCEPTION 'auth_set_active_role_v1: caller has no organization context'
      USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(*)
    INTO v_assignment_count
    FROM public.rbac_user_role_assignments ura
    JOIN public.rbac_roles r ON r.id = ura.role_id
   WHERE ura.user_id = v_user_id
     AND ura.organization_id = v_caller_org
     AND ura.revoked_at IS NULL
     AND lower(COALESCE(NULLIF(r.metadata->>'mobile_v2_role', ''), r.key)) = v_normalized_role;

  IF v_assignment_count = 0 THEN
    PERFORM public.log_decision(
      p_organization_id := v_caller_org,
      p_decision_category := 'fieldops_role_set',
      p_resource_type := 'mobile_v2_active_role',
      p_resource_id := v_user_id,
      p_decision_point := 'auth_set_active_role_v1',
      p_decision_outcome := 'denied_role_not_assigned',
      p_performed_by_system := 'auth_set_active_role_v1',
      p_correlation_id := v_correlation_id,
      p_decision_inputs := jsonb_build_object(
        'requested_role', v_normalized_role,
        'caller_user_id', v_user_id
      ),
      p_decision_reason := 'requested role is not in caller active rbac assignments'
    );
    RAISE EXCEPTION 'auth_set_active_role_v1: role % not assigned to caller', v_normalized_role
      USING ERRCODE = '42501';
  END IF;

  SELECT role_key INTO v_existing_role
    FROM public.mobile_v2_active_role
   WHERE user_id = v_user_id;

  BEGIN
    SELECT ARRAY_AGG(DISTINCT cap)
      INTO v_capability_keys
      FROM (
        SELECT jsonb_array_elements_text(
                 COALESCE(role_def->'capability_keys', '[]'::jsonb)
               ) AS cap
          FROM public.settings s
          JOIN public.settings_versions sv
            ON sv.id = s.settings_version_id,
               jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) AS role_def
         WHERE s.category = 'access_control_policy'
           AND s.scope_type IN ('global', 'tenant')
           AND (s.scope_id IS NULL OR s.scope_id = v_caller_org)
           AND lower(COALESCE(NULLIF(role_def->>'mobile_v2_role', ''), role_def->>'key')) = v_normalized_role
      ) caps;
  EXCEPTION WHEN OTHERS THEN
    v_capability_keys := ARRAY[]::TEXT[];
  END;

  v_capability_keys := COALESCE(v_capability_keys, ARRAY[]::TEXT[]);

  INSERT INTO public.mobile_v2_active_role (
    user_id, organization_id, role_key, switched_at
  ) VALUES (
    v_user_id, v_caller_org, v_normalized_role, now()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      role_key = EXCLUDED.role_key,
      switched_at = CASE
        WHEN public.mobile_v2_active_role.role_key = EXCLUDED.role_key
          THEN public.mobile_v2_active_role.switched_at
        ELSE EXCLUDED.switched_at
      END
  RETURNING switched_at INTO v_switched_at;

  IF v_existing_role IS NULL THEN
    v_outcome := 'role_set';
  ELSIF v_existing_role = v_normalized_role THEN
    v_outcome := 'role_unchanged';
  ELSE
    v_outcome := 'role_switched';
  END IF;

  v_decision_log_id := public.log_decision(
    p_organization_id := v_caller_org,
    p_decision_category := 'fieldops_role_set',
    p_resource_type := 'mobile_v2_active_role',
    p_resource_id := v_user_id,
    p_decision_point := 'auth_set_active_role_v1',
    p_decision_outcome := v_outcome,
    p_performed_by_system := 'auth_set_active_role_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_build_object(
      'previous_role', v_existing_role,
      'requested_role', v_normalized_role,
      'capability_count', COALESCE(array_length(v_capability_keys, 1), 0)
    ),
    p_decision_reason := 'mobile-v2 drawer role switch'
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'active_role', v_normalized_role,
    'previous_role', v_existing_role,
    'organization_id', v_caller_org,
    'capability_keys', to_jsonb(v_capability_keys),
    'switched_at', v_switched_at,
    'correlation_id', v_correlation_id,
    'decision_log_id', v_decision_log_id,
    'outcome', v_outcome
  );
END;
$$;

REVOKE ALL ON FUNCTION public.auth_set_active_role_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_set_active_role_v1(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.auth_set_active_role_v1(TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.auth_set_active_role_v1(TEXT) IS
  'Mobile V2 drawer role switch. Validates the requested mobile persona against caller active RBAC assignments, including role metadata mobile_v2_role aliases such as warehouse_operator -> loader.';

CREATE OR REPLACE FUNCTION api.auth_set_active_role_v1(p_role_key TEXT)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.auth_set_active_role_v1(p_role_key);
$$;

REVOKE ALL ON FUNCTION api.auth_set_active_role_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.auth_set_active_role_v1(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION api.auth_set_active_role_v1(TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION api.auth_set_active_role_v1(TEXT) IS
  'Browser/mobile-safe API wrapper for Mobile V2 active role switching.';

CREATE OR REPLACE FUNCTION public.auth_get_active_role_v1()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_active_role TEXT;
  v_organization_id UUID;
  v_switched_at TIMESTAMPTZ;
  v_assigned_roles TEXT[];
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'auth_get_active_role_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  SELECT role_key, organization_id, switched_at
    INTO v_active_role, v_organization_id, v_switched_at
    FROM public.mobile_v2_active_role
   WHERE user_id = v_user_id
   LIMIT 1;

  SELECT ARRAY_AGG(DISTINCT lower(COALESCE(NULLIF(r.metadata->>'mobile_v2_role', ''), r.key)))
    INTO v_assigned_roles
    FROM public.rbac_user_role_assignments ura
    JOIN public.rbac_roles r ON r.id = ura.role_id
   WHERE ura.user_id = v_user_id
     AND ura.revoked_at IS NULL
     AND lower(COALESCE(NULLIF(r.metadata->>'mobile_v2_role', ''), r.key))
         IN ('driver', 'loader', 'rider', 'supervisor');

  RETURN jsonb_build_object(
    'active_role', v_active_role,
    'organization_id', v_organization_id,
    'switched_at', v_switched_at,
    'assigned_roles', to_jsonb(COALESCE(v_assigned_roles, ARRAY[]::TEXT[]))
  );
END;
$$;

REVOKE ALL ON FUNCTION public.auth_get_active_role_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_get_active_role_v1() FROM anon;
GRANT EXECUTE ON FUNCTION public.auth_get_active_role_v1() TO authenticated, service_role;

COMMENT ON FUNCTION public.auth_get_active_role_v1() IS
  'Returns the caller current Mobile V2 persona plus assigned personas derived from RBAC roles and mobile_v2_role aliases.';

CREATE OR REPLACE FUNCTION api.auth_get_active_role_v1()
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.auth_get_active_role_v1();
$$;

REVOKE ALL ON FUNCTION api.auth_get_active_role_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION api.auth_get_active_role_v1() FROM anon;
GRANT EXECUTE ON FUNCTION api.auth_get_active_role_v1() TO authenticated, service_role;

COMMENT ON FUNCTION api.auth_get_active_role_v1() IS
  'Browser/mobile-safe API wrapper for Mobile V2 active role readback.';

CREATE OR REPLACE FUNCTION public.resolve_fieldops_loader_today_v1(
  p_active_role TEXT DEFAULT 'loader',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_first_name TEXT;
  v_total_parcels INT := 0;
  v_scanned_parcels INT := 0;
  v_cold_chain INT := 0;
  v_live_routes INT := 0;
  v_drivers_waiting INT := 0;
  v_drivers JSONB := '[]'::jsonb;
  v_quick_actions JSONB;
  v_active_ops_session_id UUID;
  v_wave_label TEXT;
  v_bay TEXT;
  v_route_label TEXT;
  v_cut_off TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_loader_today_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();

  v_quick_actions := jsonb_build_array(
    jsonb_build_object('id','loader-scan','icon','scan','label','Scan-out','sub','Induct parcels'),
    jsonb_build_object('id','loader-manifest','icon','list','label','Manifest','sub','Route manifest'),
    jsonb_build_object('id','bay-board','icon','package','label','Bay board','sub','Driver queue - cages'),
    jsonb_build_object('id','inbound','icon','truck','label','Inbound dock','sub','Arrivals'),
    jsonb_build_object('id','hold','icon','flag','label','Hold queue','sub','Exceptions'),
    jsonb_build_object('id','sync','icon','cloud-up','label','Sync','sub','Outbox')
  );

  IF v_org IS NULL THEN
    RETURN jsonb_build_object(
      'greeting_name', NULL,
      'active_ops_session_id', NULL,
      'wave_label', NULL,
      'bay', NULL,
      'route_label', NULL,
      'cut_off', NULL,
      'cold_chain_count', 0,
      'live_routes', 0,
      'total_parcels', 0,
      'scanned_parcels', 0,
      'drivers_waiting', 0,
      'quick_actions', v_quick_actions,
      'drivers', '[]'::jsonb
    );
  END IF;

  v_first_name := public.fieldops_v2_user_first_name_v1(v_user_id);

  -- Loader session context is canonicalized through ops_sessions. A loader
  -- with an open warehouse_scan session can induct against its backend-read
  -- bay; no fixture bay is ever substituted when no session exists.
  SELECT
    os.id,
    NULLIF(btrim(COALESCE(os.metadata->>'wave_label', os.metadata->>'wave', '')), ''),
    NULLIF(btrim(COALESCE(os.metadata->>'bay', os.metadata->>'active_bay', os.metadata->>'bay_id', '')), ''),
    NULLIF(btrim(COALESCE(os.metadata->>'route_label', os.metadata->>'route', os.metadata->>'route_id', '')), ''),
    NULLIF(btrim(COALESCE(os.metadata->>'cut_off', os.metadata->>'cutoff', os.metadata->>'cut_off_at', '')), '')
    INTO v_active_ops_session_id, v_wave_label, v_bay, v_route_label, v_cut_off
    FROM public.ops_sessions os
   WHERE os.organization_id = v_org
     AND os.actor_user_id = v_user_id
     AND os.session_type = 'warehouse_scan'
     AND os.status = 'open'
   ORDER BY os.opened_at DESC, os.created_at DESC
   LIMIT 1;

  SELECT COUNT(*)::int
    INTO v_live_routes
    FROM public.route_runs rr
   WHERE rr.organization_id = v_org
     AND rr.status IN ('planned', 'loading', 'staged', 'started', 'in_progress');

  SELECT
    COALESCE(COUNT(*), 0)::int,
    COALESCE(SUM(CASE WHEN COALESCE(rs.metadata->>'scan_state', '') IN ('scanned', 'inducted', 'loaded')
                      THEN 1 ELSE 0 END), 0)::int,
    COALESCE(SUM(CASE WHEN COALESCE((rs.metadata->>'cold_chain')::boolean, FALSE)
                      THEN 1 ELSE 0 END), 0)::int
    INTO v_total_parcels, v_scanned_parcels, v_cold_chain
    FROM public.route_stops rs
    JOIN public.route_runs rr
      ON rr.id = rs.route_run_id
     AND rr.organization_id = rs.organization_id
   WHERE rr.organization_id = v_org
     AND rr.status IN ('planned', 'loading', 'staged', 'started', 'in_progress');

  WITH run_progress AS (
    SELECT
      rr.id AS run_id,
      rr.driver_user_id,
      rr.status AS run_status,
      COUNT(rs.id) AS stop_total,
      SUM(CASE WHEN COALESCE(rs.metadata->>'scan_state', '') IN ('scanned', 'inducted', 'loaded')
               THEN 1 ELSE 0 END) AS stop_scanned
    FROM public.route_runs rr
    LEFT JOIN public.route_stops rs
      ON rs.route_run_id = rr.id
     AND rs.organization_id = rr.organization_id
    WHERE rr.organization_id = v_org
      AND rr.status IN ('planned', 'loading', 'staged', 'started', 'in_progress')
      AND rr.driver_user_id IS NOT NULL
    GROUP BY rr.id, rr.driver_user_id, rr.status
  )
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'name',   COALESCE(u.full_name, '-'),
          'route',  COALESCE('RT-' || substr(rp.run_id::text, 1, 8), '-'),
          'pct',    CASE WHEN rp.stop_total > 0
                         THEN ROUND((rp.stop_scanned::numeric / rp.stop_total) * 100)::int
                         ELSE 0 END,
          'status', CASE WHEN COALESCE(rp.stop_scanned, 0) > 0 THEN 'loading' ELSE 'waiting' END
        )
        ORDER BY u.full_name
      ),
      '[]'::jsonb
    ),
    COALESCE(SUM(CASE WHEN COALESCE(rp.stop_scanned, 0) = 0 THEN 1 ELSE 0 END), 0)::int
    INTO v_drivers, v_drivers_waiting
    FROM run_progress rp
    LEFT JOIN public.users u
      ON u.id = rp.driver_user_id
     AND u.organization_id = v_org;

  RETURN jsonb_build_object(
    'greeting_name', v_first_name,
    'active_ops_session_id', v_active_ops_session_id,
    'wave_label', v_wave_label,
    'bay', v_bay,
    'route_label', v_route_label,
    'cut_off', v_cut_off,
    'cold_chain_count', v_cold_chain,
    'live_routes', v_live_routes,
    'total_parcels', v_total_parcels,
    'scanned_parcels', v_scanned_parcels,
    'drivers_waiting', v_drivers_waiting,
    'quick_actions', v_quick_actions,
    'drivers', v_drivers
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_loader_today_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_loader_today_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_loader_today_v1(TEXT, JSONB) IS
  'Mobile V2 loader warehouse-home aggregator. Counts + driver queue resolve from route_runs + route_stops; active ops_session id and bay/wave/route context resolve from the caller open warehouse_scan ops_session metadata, never from fixtures.';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_loader_today_v1(
  p_active_role TEXT DEFAULT 'loader',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.resolve_fieldops_loader_today_v1(p_active_role, p_context);
$$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_loader_today_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_loader_today_v1(TEXT, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_fieldops_sortation_v1(
  p_active_role TEXT DEFAULT 'loader',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_context JSONB;
  v_policy JSONB := '{}'::jsonb;
  v_window_minutes INT := 5;
  v_exception_bay TEXT := 'EX';
  v_transfer_bay TEXT := 'TX';
  v_recent JSONB := '[]'::jsonb;
  v_bays JSONB := '[]'::jsonb;
  v_inducted INT := 0;
  v_minutes_elapsed INT := 0;
  v_throughput_per_hour INT := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_sortation_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RETURN jsonb_build_object(
      'bays', '[]'::jsonb,
      'recent', '[]'::jsonb,
      'inducted', 0,
      'throughput_per_hour', 0,
      'minutes_elapsed', 0
    );
  END IF;

  v_context :=
    CASE
      WHEN jsonb_typeof(COALESCE(p_context, '{}'::jsonb)) = 'object'
        THEN COALESCE(p_context, '{}'::jsonb)
      ELSE '{}'::jsonb
    END || jsonb_build_object('organization_id', v_org);

  BEGIN
    SELECT r.value
      INTO v_policy
      FROM public.resolve_settings_row_from_policy_context_v1('mobile_sortation_policy', v_context) r
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_policy := '{}'::jsonb;
  END;

  BEGIN
    v_window_minutes := COALESCE(NULLIF(v_policy->>'throughput_window_minutes', '')::INT, 5);
  EXCEPTION WHEN OTHERS THEN
    v_window_minutes := 5;
  END;
  v_window_minutes := LEAST(GREATEST(v_window_minutes, 1), 60);
  v_exception_bay := COALESCE(NULLIF(btrim(v_policy->>'exception_bay'), ''), 'EX');
  v_transfer_bay := COALESCE(NULLIF(btrim(v_policy->>'transfer_bay'), ''), 'TX');

  WITH scoped AS (
    SELECT
      i.id,
      i.tracking_number,
      i.bay,
      i.created_at,
      COALESCE(
        NULLIF(s.metadata->>'area', ''),
        NULLIF(s.metadata->>'destination', ''),
        NULLIF(s.metadata->>'recipient_city', ''),
        NULLIF(s.status, ''),
        ''
      ) AS dest
    FROM public.fieldops_v2_inductions i
    LEFT JOIN public.shipments s
      ON s.id = i.shipment_id
     AND s.client_id = i.client_id
     AND s.organization_id = i.organization_id
    WHERE i.organization_id = v_org
    ORDER BY i.created_at DESC
    LIMIT 20
  )
  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id', id::text,
               'parcel', tracking_number,
               'bay', bay,
               'dest', dest,
               'at', to_char(created_at, 'HH24:MI')
             )
             ORDER BY created_at DESC
           ),
           '[]'::jsonb
         )
    INTO v_recent
    FROM scoped;

  WITH bay_counts AS (
    SELECT
      i.bay,
      COUNT(*)::INT AS parcel_count
    FROM public.fieldops_v2_inductions i
    WHERE i.organization_id = v_org
    GROUP BY i.bay
  )
  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id', bay,
               'label', 'Bay ' || bay,
               'routeId', NULL,
               'transfer', bay = v_transfer_bay,
               'exception', bay = v_exception_bay,
               'count', parcel_count,
               'capacity', GREATEST(parcel_count, 1)
             )
             ORDER BY bay
           ),
           '[]'::jsonb
         )
    INTO v_bays
    FROM bay_counts;

  SELECT
    COUNT(*)::INT,
    COALESCE(FLOOR(EXTRACT(EPOCH FROM (now() - MIN(i.created_at))) / 60)::INT, 0)
    INTO v_inducted, v_minutes_elapsed
    FROM public.fieldops_v2_inductions i
   WHERE i.organization_id = v_org
     AND i.created_at >= now() - make_interval(mins => v_window_minutes);

  IF v_inducted > 0 THEN
    v_minutes_elapsed := GREATEST(v_minutes_elapsed, 1);
    v_throughput_per_hour := CEIL((v_inducted::NUMERIC * 60) / v_minutes_elapsed)::INT;
  END IF;

  RETURN jsonb_build_object(
    'bays', v_bays,
    'recent', v_recent,
    'inducted', v_inducted,
    'throughput_per_hour', v_throughput_per_hour,
    'minutes_elapsed', v_minutes_elapsed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_sortation_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_sortation_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_sortation_v1(TEXT, JSONB) IS
  'Mobile V2 sortation bays + recent inductions aggregator. Reads fieldops_v2_inductions for backend-backed same-context loader scan readback and resolves throughput policy from mobile_sortation_policy.';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_sortation_v1(
  p_active_role TEXT DEFAULT 'loader',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.resolve_fieldops_sortation_v1(p_active_role, p_context);
$$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_sortation_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_sortation_v1(TEXT, JSONB) TO authenticated, service_role;

SELECT pg_notify('pgrst', 'reload schema');

SELECT pg_advisory_unlock(hashtext('202605281800_fieldops_mobile_v2_warehouse_loader_readback_v1'));
COMMIT;

BEGIN;
SELECT pg_advisory_lock(hashtext('202605272130_fieldops_mobile_v2_returns_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Mobile V2 returns readback: keep the existing resolver contract but expose
-- the canonical route_stop id on returned rows so the native app can reconcile
-- a mark-returned write from backend readback in the same screen context.

CREATE OR REPLACE FUNCTION public.resolve_fieldops_returns_v1(
  p_active_role TEXT DEFAULT 'driver',
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
  v_failed JSONB := '[]'::jsonb;
  v_returned JSONB := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_returns_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RETURN jsonb_build_object('failed', '[]'::jsonb, 'returned', '[]'::jsonb, 'cod_collected_sar', 0);
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',         rs.id::text,
        'seq',        rs.sequence_order,
        'customer',   COALESCE(rs.metadata->>'customer_name', '-'),
        'addr',       COALESCE(rs.metadata->>'address', ''),
        'parcels',    COALESCE((rs.metadata->>'parcels')::int, 1),
        'failReason', COALESCE(rs.metadata->>'fail_reason', 'Customer unreachable')
      )
      ORDER BY rs.sequence_order
    ),
    '[]'::jsonb
  )
  INTO v_failed
  FROM public.route_stops rs
  JOIN public.route_runs rr
    ON rr.id = rs.route_run_id
   AND rr.organization_id = rs.organization_id
  WHERE rr.organization_id = v_org
    AND COALESCE(rs.metadata->>'status', '') = 'failed'
    AND rr.driver_user_id = v_user_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',       'RTO-' || substr(rs.id::text, 1, 8),
        'stop_id',  rs.id::text,
        'customer', COALESCE(rs.metadata->>'customer_name', '-'),
        'parcels',  COALESCE((rs.metadata->>'parcels')::int, 1)
      )
      ORDER BY rs.sequence_order
    ),
    '[]'::jsonb
  )
  INTO v_returned
  FROM public.route_stops rs
  JOIN public.route_runs rr
    ON rr.id = rs.route_run_id
   AND rr.organization_id = rs.organization_id
  WHERE rr.organization_id = v_org
    AND COALESCE(rs.metadata->>'status', '') = 'rto'
    AND rr.driver_user_id = v_user_id;

  RETURN jsonb_build_object(
    'failed', v_failed,
    'returned', v_returned,
    'cod_collected_sar', 0
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_returns_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_returns_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_returns_v1(TEXT, JSONB) IS
  'Mobile V2 returns-to-hub aggregator. Returns failed + RTO route_stops scoped to the calling driver, with returned stop lineage for same-context native readback. Driver-scope only; supervisors get an empty payload here (use ops console).';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_returns_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT public.resolve_fieldops_returns_v1(p_active_role, p_context); $$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_returns_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_returns_v1(TEXT, JSONB) TO authenticated, service_role;

-- Keep the Mobile V2 Returns lane reachable through row-driven access policy.
-- The UI navigation item already exists and is gated by returns.read; driver
-- runtime roles need the matching read/write capabilities to use the backend
-- resolver + mark-returned RPC from the visible shell.
CREATE OR REPLACE FUNCTION pg_temp.fieldops_mobile_v2_returns_driver_policy_v1(p_policy JSONB)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_policy JSONB := COALESCE(p_policy, '{}'::jsonb);
  v_caps JSONB := COALESCE(p_policy->'capabilities', '[]'::jsonb);
  v_roles JSONB := COALESCE(p_policy->'roles', '[]'::jsonb);
  v_assignments JSONB := COALESCE(p_policy->'assignments', '{}'::jsonb);
  v_user_type_assignments JSONB := COALESCE(p_policy#>'{assignments,user_type}', '{}'::jsonb);
  v_role JSONB;
  v_role_keys JSONB;
  v_role_idx INTEGER;
  v_role_name TEXT;
  v_cap TEXT;
BEGIN
  FOREACH v_cap IN ARRAY ARRAY['returns.read', 'returns.write'] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_caps) cap
       WHERE cap->>'key' = v_cap
    ) THEN
      v_caps := v_caps || jsonb_build_array(jsonb_build_object(
        'key', v_cap,
        'label', initcap(replace(v_cap, '.', ' ')),
        'category', 'operate'
      ));
    END IF;
  END LOOP;

  FOREACH v_role_name IN ARRAY ARRAY['driver', 'fieldops_money_driver'] LOOP
    IF NOT (v_user_type_assignments ? v_role_name) THEN
      v_user_type_assignments := jsonb_set(
        v_user_type_assignments,
        ARRAY[v_role_name],
        jsonb_build_array(v_role_name),
        true
      );
    END IF;
  END LOOP;

  FOR v_role_idx IN 0 .. GREATEST(jsonb_array_length(v_roles) - 1, -1) LOOP
    v_role := v_roles->v_role_idx;
    IF v_role->>'key' IN ('driver', 'fieldops_money_driver') THEN
      v_role_keys := COALESCE(v_role->'capability_keys', '[]'::jsonb);
      FOREACH v_cap IN ARRAY ARRAY['returns.read', 'returns.write'] LOOP
        IF NOT (v_role_keys @> to_jsonb(v_cap))
           AND NOT (v_role_keys @> to_jsonb('*'::text)) THEN
          v_role_keys := v_role_keys || to_jsonb(v_cap);
        END IF;
      END LOOP;
      v_role := jsonb_set(v_role, '{capability_keys}', v_role_keys, true);
      v_roles := jsonb_set(v_roles, ARRAY[v_role_idx::text], v_role, true);
    END IF;
  END LOOP;

  v_assignments := jsonb_set(v_assignments, '{user_type}', v_user_type_assignments, true);
  v_policy := jsonb_set(v_policy, '{capabilities}', v_caps, true);
  v_policy := jsonb_set(v_policy, '{roles}', v_roles, true);
  v_policy := jsonb_set(v_policy, '{assignments}', v_assignments, true);
  RETURN v_policy;
END;
$$;

DO $do$
DECLARE
  v_rec RECORD;
  v_next JSONB;
  v_new_settings_version_id UUID;
  v_next_version INTEGER;
BEGIN
  FOR v_rec IN
    SELECT id, category, scope_type, scope_id, value
      FROM public.settings_versions
     WHERE category = 'access_control_policy'
       AND approved_at IS NOT NULL
       AND effective_until IS NULL
     ORDER BY scope_type, scope_id NULLS FIRST, version
  LOOP
    v_next := pg_temp.fieldops_mobile_v2_returns_driver_policy_v1(v_rec.value);
    IF v_next IS NOT DISTINCT FROM v_rec.value THEN
      CONTINUE;
    END IF;

    UPDATE public.settings_versions
       SET effective_until = GREATEST(now(), effective_from + interval '1 millisecond')
     WHERE id = v_rec.id;

    SELECT COALESCE(MAX(version), 0) + 1
      INTO v_next_version
      FROM public.settings_versions
     WHERE category = v_rec.category
       AND scope_type = v_rec.scope_type
       AND COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
           = COALESCE(v_rec.scope_id, '00000000-0000-0000-0000-000000000000'::uuid);

    INSERT INTO public.settings_versions (
      category,
      scope_type,
      scope_id,
      version,
      value,
      schema_version,
      change_reason,
      approved_at
    ) VALUES (
      v_rec.category,
      v_rec.scope_type,
      v_rec.scope_id,
      v_next_version,
      v_next,
      1,
      'FieldOps Mobile V2 returns readback: grant returns read/write access to driver runtime roles.',
      now()
    )
    RETURNING id INTO v_new_settings_version_id;

    UPDATE public.settings
       SET settings_version_id = v_new_settings_version_id,
           cached_value = v_next,
           last_updated = now()
     WHERE category = v_rec.category
       AND scope_type = v_rec.scope_type
       AND COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
           = COALESCE(v_rec.scope_id, '00000000-0000-0000-0000-000000000000'::uuid);
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'access_control_policy:%'
      OR cache_key LIKE 'ui_navigation:%';
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605272130_fieldops_mobile_v2_returns_readback_v1'));
COMMIT;

BEGIN;

CREATE OR REPLACE FUNCTION public.marketplace_refresh_reputation_snapshots_for_visible_v1(
  p_participant_profile_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_is_platform BOOLEAN := public.is_platform_user();
  v_profile_id UUID;
  v_result JSONB;
  v_refreshed_count INTEGER := 0;
  v_error_count INTEGER := 0;
  v_errors JSONB := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_user_required' USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_platform AND v_org_id IS NULL THEN
    RAISE EXCEPTION 'tenant_scope_required' USING ERRCODE = '42501';
  END IF;

  IF v_is_platform THEN
    PERFORM public.assert_capability_v1(
      'marketplace_participant_requests.review',
      'global',
      NULL
    );
  ELSE
    PERFORM public.assert_capability_v1(
      'marketplace_participants.write',
      'tenant',
      v_org_id
    );
  END IF;

  FOR v_profile_id IN
    SELECT p.id
      FROM public.marketplace_participant_profiles p
     WHERE (p_participant_profile_id IS NULL OR p.id = p_participant_profile_id)
       AND (v_is_platform OR p.organization_id = v_org_id)
     ORDER BY p.created_at NULLS LAST, p.id
  LOOP
    v_result := public.marketplace_refresh_reputation_snapshot_v1(v_profile_id);
    IF COALESCE((v_result->>'ok')::BOOLEAN, FALSE) THEN
      v_refreshed_count := v_refreshed_count + 1;
    ELSE
      v_error_count := v_error_count + 1;
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'participant_profile_id', v_profile_id,
        'result', v_result
      ));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', v_error_count = 0,
    'refreshed_count', v_refreshed_count,
    'error_count', v_error_count,
    'errors', v_errors
  );
END;
$function$;

COMMENT ON FUNCTION public.marketplace_refresh_reputation_snapshots_for_visible_v1(UUID) IS
  'Console-safe reputation refresh wrapper. Authenticated tenant users may refresh visible participant profiles via marketplace_participants.write; platform reviewers may refresh global profiles via marketplace_participant_requests.review. Delegates scoring to the canonical service-only marketplace_refresh_reputation_snapshot_v1(uuid).';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION api.marketplace_refresh_reputation_snapshots_for_visible_v1(
  p_participant_profile_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.marketplace_refresh_reputation_snapshots_for_visible_v1(p_participant_profile_id);
$function$;

REVOKE ALL ON FUNCTION public.marketplace_refresh_reputation_snapshots_for_visible_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_refresh_reputation_snapshots_for_visible_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.marketplace_refresh_reputation_snapshots_for_visible_v1(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.marketplace_refresh_reputation_snapshots_for_visible_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.marketplace_refresh_reputation_snapshots_for_visible_v1(UUID) FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.marketplace_refresh_reputation_snapshots_for_visible_v1(UUID) TO authenticated, service_role;

COMMIT;

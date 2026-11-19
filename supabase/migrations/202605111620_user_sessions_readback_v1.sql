-- Console V2 user session readback.
-- Purpose:
--   The Users drawer needs backend-backed session visibility and revoke
--   evidence without exposing auth.sessions as a raw table or requiring a
--   browser reload after revoke_session_v1 enqueues its audit intent.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605111620_user_sessions_readback_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.ui_list_user_sessions_v1(
  p_target_user_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 50
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_target_org UUID;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_claims JSONB := COALESCE(NULLIF(current_setting('request.jwt.claims', TRUE), '')::jsonb, '{}'::jsonb);
  v_current_session_id TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.session_id', TRUE), ''),
    NULLIF(v_claims->>'session_id', '')
  );
  v_rows JSONB := '[]'::jsonb;
  v_total BIGINT := 0;
BEGIN
  IF v_scope_type = 'tenant' AND v_scope_id IS NULL THEN
    v_scope_id := public.current_user_org_id();
  END IF;

  PERFORM public.assert_capability_v1('users.read', v_scope_type, v_scope_id);

  IF p_target_user_id IS NULL THEN
    PERFORM public.assert_capability_v1('users.manage', v_scope_type, v_scope_id);
  ELSE
    SELECT u.organization_id
      INTO v_target_org
      FROM public.users u
     WHERE u.id = p_target_user_id;

    IF v_target_org IS NULL THEN
      RAISE EXCEPTION 'ui_list_user_sessions_v1 user % not found', p_target_user_id
        USING ERRCODE = '23503';
    END IF;

    IF NOT public.is_platform_user()
       AND COALESCE(v_scope_id, public.current_user_org_id()) IS DISTINCT FROM v_target_org THEN
      RAISE EXCEPTION 'ui_list_user_sessions_v1 target user % outside tenant scope', p_target_user_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  WITH visible_sessions AS (
    SELECT
      s.id,
      s.user_id,
      u.organization_id,
      u.email AS user_email,
      s.user_agent,
      s.ip,
      s.aal,
      s.factor_id,
      s.created_at,
      s.updated_at,
      s.not_after,
      ra.id AS revocation_audit_id,
      ra.status AS revocation_status,
      ra.reason AS revocation_reason,
      ra.created_at AS revocation_requested_at,
      ra.processed_at AS revocation_processed_at,
      ra.correlation_id AS revocation_correlation_id
    FROM auth.sessions s
    JOIN public.users u ON u.id = s.user_id
    LEFT JOIN LATERAL (
      SELECT latest.*
        FROM public.revocation_audit latest
       WHERE latest.target_user_id = s.user_id
         AND (latest.session_id IS NULL OR latest.session_id = s.id::text)
       ORDER BY latest.created_at DESC
       LIMIT 1
    ) ra ON TRUE
    WHERE (p_target_user_id IS NULL OR s.user_id = p_target_user_id)
      AND (
        public.is_platform_user()
        OR COALESCE(v_scope_id, public.current_user_org_id()) = u.organization_id
      )
  )
  SELECT COUNT(*) INTO v_total FROM visible_sessions;

  WITH visible_sessions AS (
    SELECT
      s.id,
      s.user_id,
      u.organization_id,
      u.email AS user_email,
      s.user_agent,
      s.ip,
      s.aal,
      s.factor_id,
      s.created_at,
      s.updated_at,
      s.not_after,
      ra.id AS revocation_audit_id,
      ra.status AS revocation_status,
      ra.reason AS revocation_reason,
      ra.created_at AS revocation_requested_at,
      ra.processed_at AS revocation_processed_at,
      ra.correlation_id AS revocation_correlation_id
    FROM auth.sessions s
    JOIN public.users u ON u.id = s.user_id
    LEFT JOIN LATERAL (
      SELECT latest.*
        FROM public.revocation_audit latest
       WHERE latest.target_user_id = s.user_id
         AND (latest.session_id IS NULL OR latest.session_id = s.id::text)
       ORDER BY latest.created_at DESC
       LIMIT 1
    ) ra ON TRUE
    WHERE (p_target_user_id IS NULL OR s.user_id = p_target_user_id)
      AND (
        public.is_platform_user()
        OR COALESCE(v_scope_id, public.current_user_org_id()) = u.organization_id
      )
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.last_seen_at DESC, row_data.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        vs.id::text AS id,
        vs.user_id,
        vs.organization_id,
        vs.user_email,
        vs.user_agent,
        vs.ip::text AS ip,
        vs.aal::text AS aal,
        vs.factor_id,
        vs.created_at,
        vs.updated_at,
        COALESCE(vs.updated_at, vs.created_at) AS last_seen_at,
        vs.not_after,
        (vs.id::text = v_current_session_id) AS is_current,
        vs.revocation_audit_id,
        vs.revocation_status,
        vs.revocation_reason,
        vs.revocation_requested_at,
        vs.revocation_processed_at,
        vs.revocation_correlation_id
      FROM visible_sessions vs
      ORDER BY COALESCE(vs.updated_at, vs.created_at) DESC NULLS LAST, vs.created_at DESC NULLS LAST
      LIMIT v_limit
    ) AS row_data;

  RETURN jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'limit', v_limit,
    'offset', 0,
    'page', 0,
    'page_size', v_limit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_list_user_sessions_v1(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_list_user_sessions_v1(UUID, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_list_user_sessions_v1(UUID, INTEGER) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_list_user_sessions_v1(
  p_target_user_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 50
)
RETURNS JSONB
LANGUAGE SQL
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_list_user_sessions_v1($1, $2);
$$;

REVOKE ALL ON FUNCTION api.ui_list_user_sessions_v1(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_list_user_sessions_v1(UUID, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_list_user_sessions_v1(UUID, INTEGER) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_list_user_sessions_v1(UUID, INTEGER)
  IS 'Console V2 backend-backed user-session readback over auth.sessions plus revocation_audit evidence. Scoped by users.read/users.manage without exposing auth.sessions as a raw UI relation.';
COMMENT ON FUNCTION api.ui_list_user_sessions_v1(UUID, INTEGER)
  IS 'API-schema wrapper for Console V2 user-session readback.';

SELECT pg_advisory_unlock(hashtext('202605111620_user_sessions_readback_v1'));
COMMIT;

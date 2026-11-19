-- FieldOps Mobile V2 settlement visibility/readback.
--
-- The mobile navigation already exposes /mobile/settlements. This resolver
-- provides the native V2 shell with driver-scoped, backend-confirmed
-- settlement batches through the existing settlement access helper and the
-- canonical settlement summary projection.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605292356_fieldops_mobile_v2_settlement_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.resolve_fieldops_settlements_v1(
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
  v_org_id UUID := public.current_user_org_id();
  v_active_role TEXT := lower(NULLIF(btrim(COALESCE(p_active_role, '')), ''));
  v_context JSONB := COALESCE(p_context, '{}'::jsonb);
  v_limit INT := 25;
  v_rows JSONB := '[]'::jsonb;
  v_summary JSONB := jsonb_build_object(
    'count', 0,
    'expected_amount', 0,
    'collected_amount', 0,
    'remitted_amount', 0,
    'variance_amount', 0,
    'currency', 'SAR'
  );
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_settlements_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_settlements_v1 requires organization context'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_context) IS DISTINCT FROM 'object' THEN
    v_context := '{}'::jsonb;
  END IF;

  IF COALESCE(v_context->>'limit', '') ~ '^[0-9]+$' THEN
    v_limit := LEAST(50, GREATEST(1, (v_context->>'limit')::INT));
  END IF;

  WITH readable AS (
    SELECT
      sb.id,
      sb.kind,
      sb.scope_type,
      sb.status,
      sb.window_start_at,
      sb.window_end_at,
      sb.updated_at,
      COALESCE(NULLIF(sb.metadata->>'currency', ''), 'SAR') AS currency,
      COALESCE(NULLIF(sb.metadata->>'title', ''), NULL) AS explicit_title,
      vs.expected_amount,
      vs.collected_amount,
      vs.remitted_amount
    FROM public.settlement_batches sb
    LEFT JOIN public.v_settlement_batch_summary vs
      ON vs.id = sb.id
     AND vs.organization_id = sb.organization_id
    WHERE sb.organization_id = v_org_id
      AND public.can_read_settlement_batch_v1(
        sb.organization_id,
        sb.id,
        sb.subject_type,
        sb.subject_id
      )
    ORDER BY sb.updated_at DESC, sb.created_at DESC
    LIMIT v_limit
  ),
  projected AS (
    SELECT
      r.*,
      COALESCE(r.collected_amount, 0) - COALESCE(r.expected_amount, 0) AS variance_amount,
      COALESCE(
        r.explicit_title,
        initcap(replace(COALESCE(r.scope_type, 'settlement'), '_', ' ')) || ' ' || left(r.id::text, 8)
      ) AS title
    FROM readable r
  )
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', id,
          'title', title,
          'kind', kind,
          'scope_type', scope_type,
          'status', status,
          'expected_amount', COALESCE(expected_amount, 0),
          'collected_amount', COALESCE(collected_amount, 0),
          'remitted_amount', COALESCE(remitted_amount, 0),
          'variance_amount', variance_amount,
          'currency', currency,
          'window_start_at', window_start_at,
          'window_end_at', window_end_at,
          'updated_at', updated_at
        )
        ORDER BY updated_at DESC NULLS LAST, id
      ),
      '[]'::jsonb
    ),
    jsonb_build_object(
      'count', COUNT(*),
      'expected_amount', COALESCE(SUM(COALESCE(expected_amount, 0)), 0),
      'collected_amount', COALESCE(SUM(COALESCE(collected_amount, 0)), 0),
      'remitted_amount', COALESCE(SUM(COALESCE(remitted_amount, 0)), 0),
      'variance_amount', COALESCE(SUM(variance_amount), 0),
      'currency', COALESCE(MIN(currency), 'SAR')
    )
  INTO v_rows, v_summary
  FROM projected;

  RETURN jsonb_build_object(
    'settlements', v_rows,
    'summary', v_summary,
    'readback', jsonb_build_object(
      'source', 'resolve_fieldops_settlements_v1',
      'active_role', v_active_role,
      'count', COALESCE((v_summary->>'count')::INT, 0),
      'resolved_at', now()
    )
  );
END;
$$;

COMMENT ON FUNCTION public.resolve_fieldops_settlements_v1(TEXT, JSONB) IS
  'Mobile V2 settlement ledger resolver. Returns settlement batches visible to the authenticated FieldOps user through can_read_settlement_batch_v1 plus v_settlement_batch_summary totals.';

REVOKE ALL ON FUNCTION public.resolve_fieldops_settlements_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_settlements_v1(TEXT, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_fieldops_settlements_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.resolve_fieldops_settlements_v1(p_active_role, p_context);
$$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_settlements_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_settlements_v1(TEXT, JSONB) TO authenticated, service_role;

DO $$
BEGIN
  IF to_regprocedure('public.resolve_fieldops_settlements_v1(text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'public.resolve_fieldops_settlements_v1 missing';
  END IF;
  IF to_regprocedure('api.resolve_fieldops_settlements_v1(text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'api.resolve_fieldops_settlements_v1 missing';
  END IF;
END $$;

SELECT pg_advisory_unlock(hashtext('202605292356_fieldops_mobile_v2_settlement_readback_v1'));
COMMIT;

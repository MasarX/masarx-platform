-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: SaaS usage metering read surface (service-only ledger + authenticated read RPC)
-- Date: 2026-01-31
--
-- Why:
--   - Partitioned ledgers registered in partitioning_config are treated as log/ops tables:
--       - No anon/authenticated table privileges on parents or partitions (pgTAP enforced).
--   - Provide an authenticated read path via RBAC-gated SECURITY DEFINER RPC instead of table grants.
--
-- What:
--   - Revoke anon/authenticated privileges for usage_events across the partition tree.
--   - Drop the auto-generated api.usage_events view (invoker-based view cannot work without base table grants).
--   - Add `list_usage_events_v1` RPC (RBAC `usage.read` + org isolation).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601312140_saas_usage_metering_read_api_fixup'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Enforce log posture: no anon/auth privileges anywhere in the partition tree.
REVOKE ALL ON TABLE public.usage_events FROM authenticated;
REVOKE ALL ON TABLE public.usage_events FROM anon;

DO $$
BEGIN
  IF to_regclass('public.usage_events'::text) IS NOT NULL THEN
    PERFORM public.enforce_partition_tree_service_only_v1('public.usage_events'::regclass);
  END IF;
END $$;

-- Remove the invoker-based api view (would require base table SELECT grants).
DROP VIEW IF EXISTS api.usage_events;

-------------------------------------------------------------------------------
-- Authenticated read RPC (RBAC-gated; service-only table access)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_usage_events_v1(
  p_organization_id UUID,
  p_metric_key TEXT DEFAULT NULL,
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to TIMESTAMPTZ DEFAULT NULL,
  p_limit INT DEFAULT 100,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  organization_id UUID,
  client_id UUID,
  sender_id UUID,
  metric_key TEXT,
  quantity NUMERIC,
  unit TEXT,
  subject_type TEXT,
  subject_id UUID,
  actor_user_id UUID,
  metadata JSONB,
  occurred_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := p_organization_id;
  v_metric TEXT := lower(NULLIF(btrim(COALESCE(p_metric_key, '')), ''));
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 100), 0), 1000);
  v_offset INT := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'list_usage_events_v1 requires an authenticated user' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'list_usage_events_v1 requires organization_id' USING ERRCODE = '23502';
  END IF;

  IF NOT public.is_platform_user() THEN
    IF public.current_user_scope_type() IS DISTINCT FROM 'tenant' THEN
      RAISE EXCEPTION 'list_usage_events_v1 requires tenant-scoped user' USING ERRCODE = '42501';
    END IF;

    IF public.current_user_org_id() IS DISTINCT FROM v_org THEN
      RAISE EXCEPTION 'list_usage_events_v1 organization mismatch' USING ERRCODE = '42501';
    END IF;

    IF NOT public.user_has_permission_v1('usage.read', v_org) THEN
      RAISE EXCEPTION 'list_usage_events_v1 requires usage.read' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    e.id,
    e.organization_id,
    e.client_id,
    e.sender_id,
    e.metric_key,
    e.quantity,
    e.unit,
    e.subject_type,
    e.subject_id,
    e.actor_user_id,
    e.metadata,
    e.occurred_at,
    e.received_at,
    e.created_at
  FROM public.usage_events e
  WHERE e.organization_id = v_org
    AND (v_metric IS NULL OR e.metric_key = v_metric)
    AND (p_from IS NULL OR e.occurred_at >= p_from)
    AND (p_to IS NULL OR e.occurred_at < p_to)
  ORDER BY e.occurred_at DESC
  LIMIT v_limit OFFSET v_offset;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_usage_events_v1(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_usage_events_v1(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_usage_events_v1(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT) TO authenticated, service_role;

COMMENT ON FUNCTION public.list_usage_events_v1(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT) IS
  'Authenticated read path for usage_events (service-only ledger). Enforces RBAC usage.read + org isolation; supports basic filters + pagination.';

SELECT pg_advisory_unlock(hashtext('202601312140_saas_usage_metering_read_api_fixup'));
COMMIT;


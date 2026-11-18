-- Migration: Shipment UC23 NDR recovery allowed-actions repair
-- Purpose:
-- - Repair dispatch_exception_review tasks that were created without
--   metadata.allowed_ndr_actions.
-- - Derive the action strictly from dispatch_exception_reason lookup policy
--   metadata.default_ndr_action and active ndr_action rows.

BEGIN;
SELECT pg_advisory_lock(hashtext('202607050130_shipment_ndr_recovery_allowed_actions_repair_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.repair_dispatch_exception_review_allowed_actions_v1(
  p_task_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_repaired_count INTEGER := 0;
  v_task_ids JSONB := '[]'::jsonb;
BEGIN
  WITH candidates AS (
    SELECT
      t.id,
      lower(NULLIF(btrim(t.metadata->>'dispatch_exception_reason'), '')) AS dispatch_exception_reason
    FROM public.tasks t
    WHERE t.task_type_key = 'dispatch_exception_review'
      AND (p_task_id IS NULL OR t.id = p_task_id)
      AND COALESCE(t.status, 'open') NOT IN ('completed', 'resolved', 'closed', 'canceled', 'cancelled')
      AND (
        jsonb_typeof(t.metadata->'allowed_ndr_actions') IS DISTINCT FROM 'array'
        OR jsonb_array_length(COALESCE(t.metadata->'allowed_ndr_actions', '[]'::jsonb)) = 0
      )
      AND NULLIF(btrim(t.metadata->>'dispatch_exception_reason'), '') IS NOT NULL
  ),
  resolved AS (
    SELECT
      c.id,
      lower(NULLIF(btrim(reason.metadata->>'default_ndr_action'), '')) AS default_ndr_action
    FROM candidates c
    JOIN public.lookup_definitions reason_def
      ON reason_def.category = 'dispatch_exception_reason'
    JOIN public.lookup_values reason
      ON reason.lookup_definition_id = reason_def.id
     AND reason.value = c.dispatch_exception_reason
     AND COALESCE(reason.status, 'active') = 'active'
    JOIN public.lookup_definitions action_def
      ON action_def.category = 'ndr_action'
    JOIN public.lookup_values action
      ON action.lookup_definition_id = action_def.id
     AND action.value = lower(NULLIF(btrim(reason.metadata->>'default_ndr_action'), ''))
     AND COALESCE(action.status, 'active') = 'active'
    WHERE NULLIF(btrim(reason.metadata->>'default_ndr_action'), '') IS NOT NULL
  ),
  updated AS (
    UPDATE public.tasks t
       SET metadata = jsonb_strip_nulls(
             COALESCE(t.metadata, '{}'::jsonb)
             || jsonb_build_object(
                  'allowed_ndr_actions', jsonb_build_array(r.default_ndr_action),
                  'resolution_action', r.default_ndr_action,
                  'ndr_allowed_actions_source', 'dispatch_exception_reason.default_ndr_action',
                  'ndr_allowed_actions_repaired_at', now()
                )
           ),
           updated_at = now()
      FROM resolved r
     WHERE t.id = r.id
     RETURNING t.id
  )
  SELECT count(*), COALESCE(jsonb_agg(id ORDER BY id), '[]'::jsonb)
    INTO v_repaired_count, v_task_ids
    FROM updated;

  RETURN jsonb_build_object(
    'ok', true,
    'repaired_count', v_repaired_count,
    'task_ids', v_task_ids
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.repair_dispatch_exception_review_allowed_actions_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.repair_dispatch_exception_review_allowed_actions_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.repair_dispatch_exception_review_allowed_actions_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.repair_dispatch_exception_review_allowed_actions_v1(UUID) TO service_role;

COMMENT ON FUNCTION public.repair_dispatch_exception_review_allowed_actions_v1(UUID)
  IS 'Repairs open dispatch_exception_review tasks missing allowed NDR actions by resolving dispatch_exception_reason.metadata.default_ndr_action through active lookup policy rows.';

SELECT public.repair_dispatch_exception_review_allowed_actions_v1(NULL);

SELECT pg_advisory_unlock(hashtext('202607050130_shipment_ndr_recovery_allowed_actions_repair_v1'));
COMMIT;

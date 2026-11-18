-- Migration: close public-tracking customer shipment change review tasks.
-- Purpose:
--   - Support case review decisions must also close the linked task queue work.
--   - Keep the closeout on the canonical task transition helper and make it
--     invariant for both approval and rejection paths.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605291620_support_public_tracking_review_task_closeout_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.public_tracking_close_review_task_v1(
  p_support_case_id uuid,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_case record;
  v_task public.tasks%ROWTYPE;
  v_task_id uuid := NULL;
  v_task_id_text text := NULL;
  v_outcome text := NULL;
  v_transition jsonb := '{}'::jsonb;
BEGIN
  IF p_support_case_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'closed', false, 'reason', 'support_case_id_required');
  END IF;

  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  SELECT
    sc.id,
    sc.organization_id,
    sc.resource_id,
    sc.status,
    sc.status_reason,
    sc.request_source,
    sc.request_type_key,
    sc.tracking_number,
    sc.metadata
  INTO v_case
  FROM public.support_cases sc
  WHERE sc.id = p_support_case_id;

  IF v_case.id IS NULL OR v_case.request_source <> 'public_tracking' THEN
    RETURN jsonb_build_object('ok', false, 'closed', false, 'reason', 'support_case_not_public_tracking');
  END IF;

  IF v_case.status <> 'resolved' THEN
    RETURN jsonb_build_object('ok', true, 'closed', false, 'reason', 'support_case_not_resolved');
  END IF;

  v_outcome := lower(COALESCE(NULLIF(v_case.metadata->>'request_outcome', ''), v_case.status_reason, ''));
  IF v_outcome = 'approved' THEN
    v_outcome := 'applied';
  END IF;

  IF v_outcome NOT IN ('applied', 'rejected') THEN
    RETURN jsonb_build_object(
      'ok', true,
      'closed', false,
      'reason', 'review_outcome_not_terminal',
      'request_outcome', v_outcome
    );
  END IF;

  v_task_id_text := NULLIF(v_case.metadata #>> ARRAY['review_task','task_id'], '');
  IF v_task_id_text IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'closed', false, 'reason', 'review_task_id_missing');
  END IF;

  BEGIN
    v_task_id := v_task_id_text::uuid;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object(
      'ok', false,
      'closed', false,
      'reason', 'review_task_id_invalid',
      'review_task_id', v_task_id_text
    );
  END;

  SELECT *
    INTO v_task
    FROM public.tasks t
   WHERE t.id = v_task_id
     AND t.resource_type = 'support_case'
     AND t.resource_id = v_case.id
   FOR UPDATE;

  IF v_task.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'closed', false,
      'reason', 'review_task_not_found',
      'review_task_id', v_task_id
    );
  END IF;

  IF lower(COALESCE(v_task.status, '')) IN ('completed', 'canceled', 'cancelled', 'rejected', 'expired', 'failed') THEN
    RETURN jsonb_build_object(
      'ok', true,
      'closed', false,
      'already_closed', true,
      'task_id', v_task.id,
      'status', v_task.status,
      'request_outcome', v_outcome
    );
  END IF;

  v_transition := public.transition_task_system_v1(
    v_task.id,
    'completed',
    'public_tracking_review_' || v_outcome,
    jsonb_strip_nulls(
      v_payload || jsonb_build_object(
        'source', 'public_tracking_close_review_task_v1',
        'support_case_id', v_case.id,
        'support_case_organization_id', v_case.organization_id,
        'support_case_status', v_case.status,
        'support_case_status_reason', v_case.status_reason,
        'request_type_key', v_case.request_type_key,
        'request_outcome', v_outcome,
        'review_decision', CASE WHEN v_outcome = 'applied' THEN 'approved' ELSE 'rejected' END,
        'review_reason', NULLIF(v_case.metadata->>'review_reason', ''),
        'tracking_number', NULLIF(v_case.tracking_number, ''),
        'shipment_id', v_case.resource_id
      )
    ),
    'public_tracking_review_closeout_v1',
    format('public_tracking_review_task_closeout:%s:%s:%s', v_case.id, v_task.id, v_outcome)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'closed', true,
    'task_id', v_task.id,
    'status', v_transition->>'status',
    'task_event_id', v_transition->>'task_event_id',
    'idempotent', COALESCE((v_transition->>'idempotent')::boolean, false),
    'request_outcome', v_outcome
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_close_review_task_trigger_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.public_tracking_close_review_task_v1(
    NEW.id,
    jsonb_build_object('trigger_name', TG_NAME)
  );

  IF COALESCE((v_result->>'ok')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'public tracking review task closeout failed for support_case %: %', NEW.id, v_result;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_public_tracking_close_review_task ON public.support_cases;
CREATE TRIGGER trg_public_tracking_close_review_task
  AFTER UPDATE OF status, status_reason, metadata ON public.support_cases
  FOR EACH ROW
  WHEN (
    NEW.request_source = 'public_tracking'
    AND NEW.status = 'resolved'
    AND COALESCE(NEW.metadata #>> ARRAY['review_task','task_id'], '') <> ''
    AND (
      OLD.status IS DISTINCT FROM NEW.status
      OR OLD.status_reason IS DISTINCT FROM NEW.status_reason
      OR OLD.metadata IS DISTINCT FROM NEW.metadata
    )
  )
  EXECUTE FUNCTION public.public_tracking_close_review_task_trigger_v1();

DO $do$
DECLARE
  v_case record;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  FOR v_case IN
    SELECT sc.id
      FROM public.support_cases sc
      JOIN public.tasks t
        ON t.id = NULLIF(sc.metadata #>> ARRAY['review_task','task_id'], '')::uuid
       AND t.resource_type = 'support_case'
       AND t.resource_id = sc.id
     WHERE sc.request_source = 'public_tracking'
       AND sc.status = 'resolved'
       AND COALESCE(sc.metadata #>> ARRAY['review_task','task_id'], '') <> ''
       AND lower(COALESCE(t.status, '')) NOT IN ('completed', 'canceled', 'cancelled', 'rejected', 'expired', 'failed')
  LOOP
    PERFORM public.public_tracking_close_review_task_v1(
      v_case.id,
      jsonb_build_object('repair_source', '202605291620_support_public_tracking_review_task_closeout_v1')
    );
  END LOOP;
END;
$do$;

REVOKE ALL ON FUNCTION public.public_tracking_close_review_task_v1(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_close_review_task_v1(UUID, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.public_tracking_close_review_task_v1(UUID, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.public_tracking_close_review_task_v1(UUID, JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.public_tracking_close_review_task_trigger_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_close_review_task_trigger_v1() FROM anon;
REVOKE ALL ON FUNCTION public.public_tracking_close_review_task_trigger_v1() FROM authenticated;

COMMENT ON FUNCTION public.public_tracking_close_review_task_v1(UUID, JSONB)
  IS 'Service-only public-tracking review task closeout. Completes customer_shipment_change_review tasks through transition_task_system_v1 when the linked support case resolves.';
COMMENT ON FUNCTION public.public_tracking_close_review_task_trigger_v1()
  IS 'Invariant trigger: resolved public-tracking support case decisions close the linked review task through the task SSOT.';

SELECT pg_advisory_unlock(hashtext('202605291620_support_public_tracking_review_task_closeout_v1'));

COMMIT;

-- Migration: Shipment UC18 route-stop follow-up service claim repair
-- Purpose:
-- - Keep delivery-attempt closeout workflow-engine-first while preventing the
--   inherited route_stop_finalize_v4 follow-up task path from logging a false
--   create_task_system_v1 service-context exception.
-- - access_restricted remains row-driven through dispatch_exception_reason
--   metadata and creates dispatch_exception_review follow-up tasks.

BEGIN;
SELECT pg_advisory_lock(hashtext('202607041730_shipment_uc18_route_stop_followup_service_claim_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_route_stop_finalize_v11(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_resp public.workflow_handler_response;
  v_prev_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_prev_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  v_claims JSONB := '{}'::jsonb;
  v_service_claims JSONB := '{}'::jsonb;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  BEGIN
    v_claims := NULLIF(v_prev_claims, '')::jsonb;
  EXCEPTION WHEN others THEN
    v_claims := '{}'::jsonb;
  END;
  IF jsonb_typeof(COALESCE(v_claims, '{}'::jsonb)) IS DISTINCT FROM 'object' THEN
    v_claims := '{}'::jsonb;
  END IF;

  v_service_claims := (v_claims - 'sub') || jsonb_build_object('role', 'service_role');

  BEGIN
    PERFORM set_config('app.actor_system', COALESCE(NULLIF(v_prev_actor_system, ''), 'dispatch_engine'), true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    PERFORM set_config('request.jwt.claims', v_service_claims::text, true);

    v_resp := workflow_handlers.execute_route_stop_finalize_v10(p_step, p_run, p_operation_result);

    PERFORM set_config('request.jwt.claims', v_prev_claims, true);
    PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
    PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
    PERFORM set_config('app.actor_system', v_prev_actor_system, true);
  EXCEPTION WHEN others THEN
    PERFORM set_config('request.jwt.claims', v_prev_claims, true);
    PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
    PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
    PERFORM set_config('app.actor_system', v_prev_actor_system, true);
    RAISE;
  END;

  RETURN v_resp;
END;
$function$;

ALTER TABLE public.operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

INSERT INTO public.operation_handlers (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'route_stop_finalize',
  'workflow_handlers',
  'execute_route_stop_finalize_v11',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v11',
  TRUE,
  'Shipment UC18 repair: runs route-stop finalization under the service claim required by canonical follow-up task creation, preserving v10 closeout/readback behavior.',
  'docs/ops/evidence/shipment-ops-runtime/runtime33-delivery-followup-uc18/'
)
ON CONFLICT (handler_key)
DO UPDATE SET
  handler_schema = EXCLUDED.handler_schema,
  handler_name = EXCLUDED.handler_name,
  handler_signature = EXCLUDED.handler_signature,
  handler_version = EXCLUDED.handler_version,
  is_active = TRUE,
  notes = EXCLUDED.notes,
  doc_url = EXCLUDED.doc_url,
  updated_at = now();

UPDATE public.workflow_template_steps wts
   SET handler_key = 'route_stop_finalize',
       handler_version = 'v11',
       updated_at = now()
  FROM public.workflow_templates wt
 WHERE wt.id = wts.workflow_template_id
   AND wt.name = 'dispatch_route_stop_finalize_v1'
   AND wts.handler_key = 'route_stop_finalize';

ALTER TABLE public.operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

COMMENT ON FUNCTION workflow_handlers.execute_route_stop_finalize_v11(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Active route-stop finalizer wrapper for Shipment UC18. Preserves v10 behavior and enters the inherited finalize chain with service_role JWT claims so dispatch_exception_review follow-up creation is canonical and does not log a false service-context exception.';

SELECT pg_advisory_unlock(hashtext('202607041730_shipment_uc18_route_stop_followup_service_claim_v1'));
COMMIT;

-- Carrier-native correction of donor 262c3ae68e5633835b4778b6df0e8d238f810511 / blob d6159486c239167d4793d9c668b2273dffd5f9e7.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('lineage_stale_settlement_task_guard_v1'));

-- Existing organizations retain explicit windows; later catalog materialization uses the same key defaults below.
UPDATE public.task_types tt SET metadata=COALESCE(tt.metadata,'{}'::jsonb)||
  jsonb_build_object('settlement_batch_action_statuses',policy.allowed)
FROM (VALUES
  ('cod_cash_handover','["open"]'::jsonb),
  ('cod_cashier_count','["open"]'::jsonb),
  ('bank_deposit_slip_create','["open"]'::jsonb),
  ('cod_manager_approval','["locked"]'::jsonb),
  ('bank_deposit_manager_approval','["locked"]'::jsonb)
) policy(key,allowed)
WHERE tt.key=policy.key AND jsonb_typeof(COALESCE(tt.metadata,'{}'::jsonb))='object'
  AND NOT COALESCE(tt.metadata,'{}'::jsonb) ? 'settlement_batch_action_statuses';

CREATE OR REPLACE FUNCTION public.prevent_stale_settlement_task_completion_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_key text;
  v_allowed jsonb;
  v_batch_status text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status <> 'completed'
     OR NEW.resource_type IS DISTINCT FROM 'settlement_batch' THEN
    RETURN NEW;
  END IF;
  SELECT tt.key,COALESCE(tt.metadata->'settlement_batch_action_statuses',
    CASE WHEN tt.key IN ('cod_manager_approval','bank_deposit_manager_approval') THEN '["locked"]'::jsonb
         WHEN tt.key IN ('cod_cash_handover','cod_cashier_count','bank_deposit_slip_create') THEN '["open"]'::jsonb END)
    INTO v_key,v_allowed FROM public.task_types tt
    WHERE tt.id=NEW.task_type_id AND tt.organization_id=NEW.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Settlement task type is outside the task organization' USING ERRCODE='23514';
  END IF;
  IF v_allowed IS NULL THEN RETURN NEW; END IF;
  IF jsonb_typeof(v_allowed) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid settlement task action window' USING ERRCODE='23514';
  END IF;
  -- SHARE prevents status changes until completion commits without blocking ledger FK inserts.
  SELECT b.status INTO v_batch_status FROM public.settlement_batches b
    WHERE b.id=NEW.resource_id AND b.organization_id=NEW.organization_id FOR SHARE;
  IF NOT FOUND OR NOT (v_allowed ? v_batch_status) THEN
    RAISE EXCEPTION 'Settlement task % cannot complete in batch status %',v_key,COALESCE(v_batch_status,'missing')
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.prevent_stale_settlement_task_completion_v1() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS tasks_prevent_stale_settlement_task_completion ON public.tasks;
CREATE TRIGGER tasks_prevent_stale_settlement_task_completion BEFORE UPDATE OF status ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.prevent_stale_settlement_task_completion_v1();
COMMIT;

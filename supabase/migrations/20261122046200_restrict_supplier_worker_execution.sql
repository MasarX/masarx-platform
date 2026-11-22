BEGIN;
SET LOCAL lock_timeout = '30s';

REVOKE EXECUTE ON FUNCTION public.worker_action_call_supplier_api(uuid, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;

COMMIT;

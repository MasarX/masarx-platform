BEGIN;
SET LOCAL lock_timeout = '30s';

REVOKE EXECUTE ON FUNCTION public.enqueue_outbound_call_from_operation_template_v1(uuid, jsonb, jsonb, uuid, integer, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_outbound_call_from_operation_template_v1(uuid, jsonb, jsonb, uuid, integer, integer, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.build_outbound_call_dispatch_from_operation_template_v1(uuid, jsonb, jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.build_outbound_call_dispatch_from_operation_template_v1(uuid, jsonb, jsonb, jsonb, text)
  TO service_role;

COMMIT;

-- Keep the marketplace finance writer service-only.

BEGIN;

REVOKE EXECUTE ON FUNCTION public.marketplace_record_finance_event_v1(
  uuid, text, text, numeric, text, text, uuid, jsonb, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.marketplace_record_finance_event_v1(
  uuid, text, text, numeric, text, text, uuid, jsonb, text
) TO service_role;

COMMIT;

-- The canonical history-writing helper is service-only, not a caller-authorized UI RPC.
BEGIN;
REVOKE ALL ON FUNCTION public.upsert_settings_value_v1(TEXT,TEXT,UUID,JSONB,INT,TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_settings_value_v1(TEXT,TEXT,UUID,JSONB,INT,TEXT)
  TO service_role;
COMMIT;

-- All six immutable seven-argument calls have completed; retain only the SSOT API.
BEGIN;
SET LOCAL lock_timeout = '30s';
DROP FUNCTION public.upsert_settings_value_v1(TEXT,TEXT,UUID,JSONB,INT,TEXT,TEXT);
-- No CASCADE: an unexpected dependency must block retirement instead of being removed.
COMMIT;

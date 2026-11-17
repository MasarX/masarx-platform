-- DRAFT: append-only migration; timestamp assigned after canonical inventory admission.
-- Preserve the current core, including later entry-response ownership repairs.
BEGIN;
SET LOCAL lock_timeout = '30s';
DO $repair$
DECLARE
  v_def text;
  v_old_bytes constant text := $old$v_computed := hmac(coalesce(p_raw_body, '')::bytea, v_secret::bytea, CASE WHEN v_algorithm = 'HMAC-SHA512' THEN 'sha512' ELSE 'sha256' END);$old$;
  v_new_bytes constant text := $new$v_computed := hmac(convert_to(coalesce(p_raw_body, ''), 'UTF8'), convert_to(v_secret, 'UTF8'), CASE WHEN v_algorithm = 'HMAC-SHA512' THEN 'sha512' ELSE 'sha256' END);$new$;
  v_old_base64 constant text := $old$v_expected := encode(v_computed, 'base64');$old$;
  v_new_base64 constant text := $new$v_expected := replace(encode(v_computed, 'base64'), E'\n', '');$new$;
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure) INTO v_def;
  IF (length(v_def) - length(replace(v_def, v_old_bytes, ''))) <> length(v_old_bytes)
     OR (length(v_def) - length(replace(v_def, v_old_base64, ''))) <> length(v_old_base64) THEN
    RAISE EXCEPTION 'Unexpected webhook HMAC verifier definition shape';
  END IF;
  EXECUTE replace(replace(v_def, v_old_bytes, v_new_bytes), v_old_base64, v_new_base64);
END;
$repair$;
COMMIT;

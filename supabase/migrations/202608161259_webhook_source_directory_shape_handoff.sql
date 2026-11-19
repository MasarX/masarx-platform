BEGIN;
SET LOCAL lock_timeout = '30s';

-- The next migration restores the security-invoker view with the canonical columns and grants.
DO $handoff$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.v_webhook_source_directory')
      AND attname IN ('rule_count', 'active_rule_count')
      AND NOT attisdropped
  ) THEN
    DROP VIEW public.v_webhook_source_directory RESTRICT;
  END IF;
END;
$handoff$;

COMMIT;

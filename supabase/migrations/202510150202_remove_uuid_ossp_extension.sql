-- Remove unused uuid-ossp extension to prevent Supabase reset conflicts.
-- Ensure pgcrypto is available for gen_random_uuid().

BEGIN;

DO $$
DECLARE
  v_dep_count INT;
BEGIN
  SELECT count(*) INTO v_dep_count
  FROM pg_depend d
  JOIN pg_extension e ON e.oid = d.refobjid
  WHERE e.extname = 'uuid-ossp';

  IF v_dep_count = 0 THEN
    EXECUTE 'DROP EXTENSION IF EXISTS "uuid-ossp"';
  ELSE
    RAISE NOTICE 'uuid-ossp has % dependent objects; skipping drop', v_dep_count;
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

COMMIT;

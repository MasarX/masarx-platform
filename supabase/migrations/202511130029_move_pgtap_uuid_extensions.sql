-- Migration: Move select extensions to extensions schema

BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pgtap') THEN
    ALTER EXTENSION pgtap SET SCHEMA extensions;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='uuid-ossp') THEN
    ALTER EXTENSION "uuid-ossp" SET SCHEMA extensions;
  END IF;
END $$;

COMMIT;


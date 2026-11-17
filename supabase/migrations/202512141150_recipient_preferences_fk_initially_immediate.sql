-- Migration: recipient_preferences FK initially immediate
-- Purpose:
--   Avoid deferred FK trigger events blocking CREATE INDEX on recipients in
--   recipient phone canonicalization (202512141200_*).
-- Date: 2025-12-14

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'recipient_preferences_recipient_fk'
      AND conrelid = 'public.recipient_preferences'::regclass
      AND contype = 'f'
  ) THEN
    EXECUTE 'ALTER TABLE public.recipient_preferences ALTER CONSTRAINT recipient_preferences_recipient_fk DEFERRABLE INITIALLY IMMEDIATE';
  END IF;
END $$;

COMMIT;


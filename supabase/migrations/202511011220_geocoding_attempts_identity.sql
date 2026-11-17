-- Migration: Ensure geocoding_attempts rows have stable identifiers
-- Purpose: Add a UUID primary key to align with workflow handlers expecting attempt_id references.

BEGIN;

-- Add id column with UUID default for all partitions.
ALTER TABLE public.geocoding_attempts
    ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();

-- Backfill any existing rows missing identifiers.
UPDATE public.geocoding_attempts
SET id = gen_random_uuid()
WHERE id IS NULL;

-- Enforce NOT NULL once backfilled.
ALTER TABLE public.geocoding_attempts
    ALTER COLUMN id SET NOT NULL;

-- Ensure primary key is present and compatible with hash partitioning.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'geocoding_attempts_pkey'
          AND conrelid = 'public.geocoding_attempts'::regclass
    ) THEN
        ALTER TABLE public.geocoding_attempts
            ADD CONSTRAINT geocoding_attempts_pkey
            PRIMARY KEY (id, address_id);
    END IF;
END
$$;

COMMENT ON COLUMN public.geocoding_attempts.id
    IS 'Stable identifier for workflow references; pairs with address_id for partitioned primary key.';

COMMIT;

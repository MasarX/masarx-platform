-- Migration: Providers scoped uniqueness
-- Purpose: Ensure provider names are unique within an organization to avoid ambiguous resolution.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM providers
    GROUP BY organization_id, name
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate providers detected for (organization_id, name); resolve duplicates before applying uniqueness.';
  END IF;
END;
$$;

ALTER TABLE public.providers
  DROP CONSTRAINT IF EXISTS providers_org_name_unique;

ALTER TABLE public.providers
  ADD CONSTRAINT providers_org_name_unique UNIQUE (organization_id, name);

COMMIT;


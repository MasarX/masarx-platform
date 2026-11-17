-- Migration: Saudi short national address short-code schema + SSOT registry
-- Purpose:
--   - Store Saudi short national address codes (format ABCD1234) in a standalone column on addresses.
--   - Provide a system-wide SSOT cache (address_code_registry) keyed by (country_code, code_type, code_value)
--     to prevent redundant provider calls across org/client/sender/recipient scopes.
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - SSOT - ZERO HARD CODING (policy-driven usage) - RLS enforced.
-- Date: 2025-12-25

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 1) addresses.sa_short_code (standalone Saudi national short code)
-- ---------------------------------------------------------------------------
ALTER TABLE public.addresses
  ADD COLUMN IF NOT EXISTS sa_short_code TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'addresses_sa_short_code_format_check'
      AND conrelid = 'public.addresses'::regclass
  ) THEN
    ALTER TABLE public.addresses
      ADD CONSTRAINT addresses_sa_short_code_format_check
      CHECK (
        sa_short_code IS NULL
        OR (
          sa_short_code = upper(sa_short_code)
          AND sa_short_code ~ '^[A-Z]{4}[0-9]{4}$'
        )
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_addresses_sa_short_code
  ON public.addresses (sa_short_code)
  WHERE sa_short_code IS NOT NULL;

COMMENT ON COLUMN public.addresses.sa_short_code IS 'Saudi short national address code (format ABCD1234), stored standalone for workflow-driven geocoding.';

-- ---------------------------------------------------------------------------
-- 2) public.address_code_registry: system-wide SSOT cache for address codes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.address_code_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code TEXT NOT NULL,
  code_type TEXT NOT NULL,
  code_value TEXT NOT NULL,
  coordinates geography(POINT, 4326) NOT NULL,
  formatted_address TEXT,
  street TEXT,
  house_number TEXT,
  district TEXT,
  city TEXT,
  province TEXT,
  postal_code TEXT,
  provider_name TEXT,
  confidence_score NUMERIC(5,4),
  accuracy_type TEXT,
  provider_parsed JSONB,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT address_code_registry_country_code_check CHECK (country_code <> ''),
  CONSTRAINT address_code_registry_code_type_check CHECK (code_type <> ''),
  CONSTRAINT address_code_registry_code_value_check CHECK (code_value <> ''),
  CONSTRAINT address_code_registry_unique UNIQUE (country_code, code_type, code_value),
  CONSTRAINT address_code_registry_provider_parsed_check CHECK (provider_parsed IS NULL OR jsonb_typeof(provider_parsed) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_address_code_registry_lookup
  ON public.address_code_registry (country_code, code_type, code_value);

CREATE INDEX IF NOT EXISTS idx_address_code_registry_updated_at
  ON public.address_code_registry (updated_at DESC);

COMMENT ON TABLE public.address_code_registry IS 'System-wide SSOT cache for address codes (e.g., Saudi short code) to prevent redundant provider geocoding across tenants.';

-- RLS: service-only (system internal SSOT cache)
ALTER TABLE public.address_code_registry ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.address_code_registry FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.address_code_registry TO service_role;

DROP POLICY IF EXISTS address_code_registry_service_role ON public.address_code_registry;
CREATE POLICY address_code_registry_service_role ON public.address_code_registry
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMIT;


-- Migration: Geocoding attempts table
-- Purpose: Provide the minimal table required by observability views and tests
-- Alignment: SIMPLE · SCALABLE · DYNAMIC — schema contains only fields referenced by views/tests

BEGIN;

CREATE TABLE IF NOT EXISTS geocoding_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    client_id UUID REFERENCES clients(id),
    address_id UUID,
    provider_name TEXT,
    status TEXT NOT NULL, -- succeeded | failed | pending
    confidence NUMERIC,   -- 0..1
    duration_ms INTEGER,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_geocoding_attempts_org_client ON geocoding_attempts(organization_id, client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_geocoding_attempts_status ON geocoding_attempts(status);
CREATE INDEX IF NOT EXISTS idx_geocoding_attempts_provider ON geocoding_attempts(provider_name);

COMMENT ON TABLE geocoding_attempts IS 'Attempts to geocode addresses with per-call telemetry for observability.';

COMMIT;


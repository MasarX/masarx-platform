-- Plan: PLAN-202601-label-designer-hardening / Step: S04
-- Migration: Seed missing clients referenced by shipments
-- Purpose:
--   - Backfill clients for orphan shipment client references so the
--     shipments_client_org_fk can be enforced safely.
--   - Keep data deterministic and non-hardcoded.
BEGIN;
SET search_path TO public, extensions, pg_temp;

WITH missing AS (
  SELECT DISTINCT s.client_id, s.organization_id
  FROM shipments AS s
  LEFT JOIN clients AS c ON c.id = s.client_id
  WHERE c.id IS NULL
),
seeded AS (
  INSERT INTO clients (
    id,
    organization_id,
    name,
    slug,
    sla_tier,
    status,
    billing_settings,
    settings_override,
    created_at,
    updated_at
  )
  SELECT
    m.client_id,
    m.organization_id,
    'Auto-seeded client ' || left(m.client_id::text, 8),
    'seed-' || substr(md5(m.organization_id::text || ':' || m.client_id::text), 1, 12),
    'standard',
    'active',
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  FROM missing AS m
  ON CONFLICT (id) DO NOTHING
)
SELECT 1;

COMMIT;

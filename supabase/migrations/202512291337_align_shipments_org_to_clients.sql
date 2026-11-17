-- Plan: PLAN-202601-label-designer-hardening / Step: S04
-- Migration: Align shipment organization_id to client organization_id
-- Purpose:
--   - Fix shipments where client_id exists but organization_id mismatches,
--     ensuring shipments_client_org_fk can be enforced.
--   - Re-sync child tables to keep org/client columns consistent.
BEGIN;
SET search_path TO public, extensions, pg_temp;

WITH mismatched AS (
  SELECT s.id, c.organization_id AS client_org
  FROM shipments AS s
  JOIN clients AS c ON c.id = s.client_id
  WHERE s.organization_id IS DISTINCT FROM c.organization_id
),
updated_shipments AS (
  UPDATE shipments AS s
  SET organization_id = m.client_org
  FROM mismatched AS m
  WHERE s.id = m.id
  RETURNING s.id
),
updated_boxes AS (
  UPDATE shipment_boxes AS sb
  SET organization_id = s.organization_id,
      client_id = s.client_id
  FROM shipments AS s
  WHERE sb.shipment_id = s.id
    AND (sb.organization_id IS DISTINCT FROM s.organization_id OR sb.client_id IS DISTINCT FROM s.client_id)
  RETURNING 1
),
updated_labels AS (
  UPDATE labels AS l
  SET organization_id = s.organization_id,
      client_id = s.client_id
  FROM shipments AS s
  WHERE l.shipment_id = s.id
    AND (l.organization_id IS DISTINCT FROM s.organization_id OR l.client_id IS DISTINCT FROM s.client_id)
  RETURNING 1
),
updated_actions AS (
  UPDATE shipment_actions AS sa
  SET organization_id = s.organization_id,
      client_id = s.client_id
  FROM shipments AS s
  WHERE sa.shipment_id = s.id
    AND (sa.organization_id IS DISTINCT FROM s.organization_id OR sa.client_id IS DISTINCT FROM s.client_id)
  RETURNING 1
)
SELECT 1;

COMMIT;

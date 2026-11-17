-- Migration: Resolve label bundle targets for file_urls with scope enforcement
-- Purpose:
--   - Enforce org/client/sender scope for bundle requests that provide file_urls.
--   - Centralize resolution in a SECURITY DEFINER function so edge_label_renderer_role
--     can run least-privilege DB-JWT without direct table SELECT grants.

BEGIN;

CREATE OR REPLACE FUNCTION resolve_label_bundle_targets_for_file_urls(
    p_org_id UUID,
    p_file_urls TEXT[],
    p_client_id UUID DEFAULT NULL,
    p_sender_id UUID DEFAULT NULL
)
RETURNS TABLE (
    input_index INT,
    input_file_url TEXT,
    file_url TEXT,
    label_id UUID,
    shipment_id UUID,
    shipment_box_id UUID
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
    WITH input AS (
        SELECT
            u.file_url,
            u.ordinality::int AS input_index
        FROM unnest(p_file_urls) WITH ORDINALITY AS u(file_url, ordinality)
    ),
    shipments_scope AS (
        SELECT s.id AS shipment_id
        FROM shipments s
        WHERE s.organization_id = p_org_id
          AND (p_client_id IS NULL OR s.client_id = p_client_id)
          AND (p_sender_id IS NULL OR s.sender_id = p_sender_id)
    ),
    label_matches AS (
        SELECT
            i.input_index,
            i.file_url AS input_file_url,
            l.file_url,
            l.id AS label_id,
            l.shipment_id,
            sb.id AS shipment_box_id
        FROM input i
        JOIN labels l
          ON l.file_url = i.file_url
        JOIN shipments_scope ss
          ON ss.shipment_id = l.shipment_id
        LEFT JOIN shipment_boxes sb
          ON sb.shipment_id = l.shipment_id
         AND sb.barcode = l.barcode
    ),
    job_matches AS (
        SELECT
            i.input_index,
            i.file_url AS input_file_url,
            j.output_file_url AS file_url,
            j.label_id,
            j.shipment_id,
            j.shipment_box_id
        FROM input i
        JOIN label_jobs j
          ON j.output_file_url = i.file_url
        JOIN shipments_scope ss
          ON ss.shipment_id = j.shipment_id
    ),
    combined AS (
        SELECT DISTINCT ON (input_index)
            input_index,
            input_file_url,
            file_url,
            label_id,
            shipment_id,
            shipment_box_id
        FROM (
            SELECT
                input_index,
                input_file_url,
                file_url,
                label_id,
                shipment_id,
                shipment_box_id,
                1 AS precedence
            FROM label_matches
            UNION ALL
            SELECT
                input_index,
                input_file_url,
                file_url,
                label_id,
                shipment_id,
                shipment_box_id,
                2 AS precedence
            FROM job_matches
        ) t
        ORDER BY input_index, precedence
    )
    SELECT
        i.input_index,
        i.file_url AS input_file_url,
        c.file_url,
        c.label_id,
        c.shipment_id,
        c.shipment_box_id
    FROM input i
    LEFT JOIN combined c
      ON c.input_index = i.input_index
    ORDER BY i.input_index;
$$;

COMMENT ON FUNCTION resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID)
    IS 'Resolve bundle targets from file_urls while enforcing org/client/sender scope via shipments join; returns one row per input.';

REVOKE EXECUTE ON FUNCTION resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) FROM authenticated;

GRANT EXECUTE ON FUNCTION resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION resolve_label_bundle_targets_for_file_urls(UUID, TEXT[], UUID, UUID) TO edge_label_renderer_role;
  END IF;
END;
$$;

-- Ensure least-privilege label renderer role can call the canonical bundle resolver too.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) TO edge_label_renderer_role;
  END IF;
END;
$$;

COMMIT;

-- Migration: Unify resolve_label_files_for_bundle signature
-- Purpose: Drop legacy 3-arg overload to avoid ambiguity; keep 5-arg variant with client/sender scope.

BEGIN;

DROP FUNCTION IF EXISTS resolve_label_files_for_bundle(UUID, UUID[], UUID[]);

CREATE OR REPLACE FUNCTION resolve_label_files_for_bundle(
    p_org_id UUID,
    p_shipment_ids UUID[] DEFAULT NULL,
    p_label_ids UUID[] DEFAULT NULL,
    p_client_id UUID DEFAULT NULL,
    p_sender_id UUID DEFAULT NULL
)
RETURNS TABLE (
    label_id UUID,
    shipment_id UUID,
    shipment_box_id UUID,
    file_url TEXT,
    box_number INT,
    label_type TEXT,
    generated_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
    WITH shipments_scope AS (
        SELECT s.id AS shipment_id
        FROM shipments s
        WHERE s.organization_id = p_org_id
          AND (p_client_id IS NULL OR s.client_id = p_client_id)
          AND (p_sender_id IS NULL OR s.sender_id = p_sender_id)
          AND (p_shipment_ids IS NULL OR s.id = ANY(p_shipment_ids))
    ),
    latest_labels AS (
        SELECT DISTINCT ON (l.shipment_id, l.barcode)
            l.id,
            l.shipment_id,
            l.barcode,
            l.file_url,
            l.label_type,
            l.generated_at
        FROM labels l
        JOIN shipments_scope ss ON ss.shipment_id = l.shipment_id
        WHERE p_label_ids IS NULL OR l.id = ANY(p_label_ids)
        ORDER BY l.shipment_id, l.barcode, l.generated_at DESC
    )
    SELECT
        ll.id AS label_id,
        ll.shipment_id,
        sb.id AS shipment_box_id,
        ll.file_url,
        sb.box_number,
        ll.label_type,
        ll.generated_at
    FROM latest_labels ll
    LEFT JOIN shipment_boxes sb
           ON sb.shipment_id = ll.shipment_id
          AND sb.barcode = ll.barcode
    ORDER BY ll.shipment_id, sb.box_number NULLS LAST, ll.generated_at DESC;
$$;

COMMENT ON FUNCTION resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID)
    IS 'Return latest label file references for an organization, optionally scoped to client/sender and filtered by shipments/label_ids.';

GRANT EXECUTE ON FUNCTION resolve_label_files_for_bundle(UUID, UUID[], UUID[], UUID, UUID) TO service_role;

COMMIT;

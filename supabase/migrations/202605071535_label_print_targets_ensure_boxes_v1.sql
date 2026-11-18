-- Migration: Ensure printable label targets for shipment label printing
-- Purpose:
--   Manual/webhook shipment creation stores canonical box_count on shipments.
--   Label printing requires concrete shipment_boxes because label barcodes are
--   box barcodes. Resolve the missing row through the existing reusable
--   ensure_shipment_boxes helper before computing printable targets.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605071535_label_print_targets_ensure_boxes_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.resolve_label_print_targets_v1(
  p_organization_id UUID,
  p_shipments JSONB DEFAULT '[]'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_shipment_id UUID;
BEGIN
  FOR v_shipment_id IN
    WITH shipments_raw AS (
      SELECT
        NULLIF(item->>'shipment_id', '')::uuid AS shipment_id
      FROM jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(COALESCE(p_shipments, '[]'::jsonb)) = 'array' THEN COALESCE(p_shipments, '[]'::jsonb)
               ELSE '[]'::jsonb
             END
           ) AS t(item)
      WHERE item ? 'shipment_id'
    )
    SELECT DISTINCT sr.shipment_id
      FROM shipments_raw sr
      JOIN public.shipments s
        ON s.id = sr.shipment_id
       AND s.organization_id = p_organization_id
     WHERE sr.shipment_id IS NOT NULL
  LOOP
    PERFORM 1
      FROM public.ensure_shipment_boxes(v_shipment_id);
  END LOOP;

  RETURN (
    WITH shipments_raw AS (
      SELECT
        ordinality::int AS shipment_index,
        NULLIF(item->>'shipment_id', '')::uuid AS shipment_id,
        CASE
          WHEN jsonb_typeof(COALESCE(item->'box_ids', '[]'::jsonb)) = 'array' THEN COALESCE(item->'box_ids', '[]'::jsonb)
          ELSE '[]'::jsonb
        END AS box_ids
      FROM jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(COALESCE(p_shipments, '[]'::jsonb)) = 'array' THEN COALESCE(p_shipments, '[]'::jsonb)
               ELSE '[]'::jsonb
             END
           ) WITH ORDINALITY AS t(item, ordinality)
      WHERE item ? 'shipment_id'
    ),
    explicit_boxes AS (
      SELECT
        sr.shipment_index,
        sr.shipment_id,
        box_ordinality::int AS box_index,
        box_text::uuid AS shipment_box_id
      FROM shipments_raw sr
      CROSS JOIN LATERAL jsonb_array_elements_text(sr.box_ids) WITH ORDINALITY AS box(box_text, box_ordinality)
      WHERE box_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
    in_scope_shipments AS (
      SELECT DISTINCT
        sr.shipment_index,
        sr.shipment_id
      FROM shipments_raw sr
      JOIN public.shipments s
        ON s.id = sr.shipment_id
       AND s.organization_id = p_organization_id
    ),
    out_of_scope AS (
      SELECT DISTINCT
        sr.shipment_index,
        sr.shipment_id
      FROM shipments_raw sr
      LEFT JOIN in_scope_shipments iss
        ON iss.shipment_id = sr.shipment_id
      WHERE iss.shipment_id IS NULL
    ),
    shipment_boxes_in_scope AS (
      SELECT
        iss.shipment_index,
        iss.shipment_id,
        sb.id AS shipment_box_id,
        sb.box_number
      FROM in_scope_shipments iss
      JOIN public.shipment_boxes sb
        ON sb.shipment_id = iss.shipment_id
       AND sb.organization_id = p_organization_id
    ),
    invalid_boxes AS (
      SELECT DISTINCT
        eb.shipment_index,
        eb.shipment_id,
        eb.shipment_box_id
      FROM explicit_boxes eb
      LEFT JOIN shipment_boxes_in_scope sb
        ON sb.shipment_box_id = eb.shipment_box_id
       AND sb.shipment_id = eb.shipment_id
      WHERE sb.shipment_box_id IS NULL
    ),
    target_boxes AS (
      SELECT
        iss.shipment_index,
        iss.shipment_id,
        sb.shipment_box_id,
        sb.box_number,
        COALESCE(eb.box_index, row_number() OVER (
          PARTITION BY iss.shipment_id
          ORDER BY sb.box_number, sb.shipment_box_id
        ))::int AS box_sort_index
      FROM in_scope_shipments iss
      JOIN shipment_boxes_in_scope sb
        ON sb.shipment_id = iss.shipment_id
      LEFT JOIN explicit_boxes eb
        ON eb.shipment_id = iss.shipment_id
       AND eb.shipment_box_id = sb.shipment_box_id
      WHERE NOT EXISTS (
              SELECT 1
              FROM explicit_boxes eb_any
              WHERE eb_any.shipment_id = iss.shipment_id
            )
         OR eb.shipment_box_id IS NOT NULL
    ),
    deduped_targets AS (
      SELECT DISTINCT ON (tb.shipment_id, tb.shipment_box_id)
        tb.shipment_index,
        tb.shipment_id,
        tb.shipment_box_id,
        tb.box_number,
        ((tb.shipment_index * 1000) + tb.box_sort_index)::int AS sort_index
      FROM target_boxes tb
      ORDER BY tb.shipment_id, tb.shipment_box_id, tb.shipment_index, tb.box_sort_index
    ),
    grouped_shipments AS (
      SELECT
        dt.shipment_id,
        MIN(dt.sort_index) AS shipment_order,
        array_agg(dt.shipment_box_id ORDER BY dt.sort_index) FILTER (WHERE dt.shipment_box_id IS NOT NULL) AS shipment_box_ids
      FROM deduped_targets dt
      GROUP BY dt.shipment_id
    ),
    counts AS (
      SELECT
        COUNT(DISTINCT sr.shipment_id)::int AS requested,
        COUNT(DISTINCT iss.shipment_id)::int AS in_scope,
        COUNT(*) FILTER (WHERE dt.shipment_box_id IS NOT NULL)::int AS expected,
        COUNT(DISTINCT o.shipment_id)::int AS out_of_scope,
        COUNT(DISTINCT ib.shipment_box_id)::int AS invalid_box_requests
      FROM shipments_raw sr
      LEFT JOIN in_scope_shipments iss ON iss.shipment_id = sr.shipment_id
      LEFT JOIN out_of_scope o ON o.shipment_id = sr.shipment_id
      LEFT JOIN invalid_boxes ib ON ib.shipment_id = sr.shipment_id
      LEFT JOIN deduped_targets dt ON dt.shipment_id = sr.shipment_id
    )
    SELECT jsonb_strip_nulls(
      jsonb_build_object(
        'targets', COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_strip_nulls(
                jsonb_build_object(
                  'shipment_id', dt.shipment_id,
                  'shipment_box_id', dt.shipment_box_id,
                  'box_number', dt.box_number,
                  'status', 'pending'
                )
              )
              ORDER BY dt.sort_index
            )
            FROM deduped_targets dt
          ),
          '[]'::jsonb
        ),
        'grouped_shipments', COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_strip_nulls(
                jsonb_build_object(
                  'shipment_id', gs.shipment_id,
                  'box_ids', CASE
                    WHEN array_length(gs.shipment_box_ids, 1) IS NULL THEN NULL
                    ELSE to_jsonb(gs.shipment_box_ids)
                  END
                )
              )
              ORDER BY gs.shipment_order
            )
            FROM grouped_shipments gs
          ),
          '[]'::jsonb
        ),
        'out_of_scope', COALESCE(
          (
            SELECT jsonb_agg(jsonb_build_object('shipment_id', o.shipment_id) ORDER BY o.shipment_index)
            FROM out_of_scope o
          ),
          '[]'::jsonb
        ),
        'invalid_boxes', COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'shipment_id', ib.shipment_id,
                'shipment_box_id', ib.shipment_box_id
              )
              ORDER BY ib.shipment_index
            )
            FROM invalid_boxes ib
          ),
          '[]'::jsonb
        ),
        'counts', (
          SELECT jsonb_strip_nulls(
            jsonb_build_object(
              'requested', c.requested,
              'in_scope', c.in_scope,
              'expected', c.expected,
              'out_of_scope', c.out_of_scope,
              'invalid_box_requests', c.invalid_box_requests
            )
          )
          FROM counts c
        )
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.resolve_label_print_targets_v1(UUID, JSONB)
  IS 'Resolve label print targets for shipment/box selections and ensure shipment_boxes exist from canonical shipment.box_count before target resolution.';

SELECT pg_advisory_unlock(hashtext('202605071535_label_print_targets_ensure_boxes_v1'));

COMMIT;

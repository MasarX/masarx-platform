-- Console V2 recipient drawers and shipment surfaces need active shipment
-- status rows to carry display tone metadata. Without the row-driven tone,
-- valid statuses such as `pending` render as unknown in strict lookup chips.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605111958_shipment_status_lookup_tones_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH expected(value, tone) AS (
  VALUES
    ('pending', 'info'),
    ('created', 'info'),
    ('pending_dispatch', 'info'),
    ('pickup_requested', 'info'),
    ('pickup_scheduled', 'info'),
    ('in_transit', 'info'),
    ('out_for_delivery', 'info'),
    ('delivered', 'good'),
    ('delivery_failed', 'danger'),
    ('pickup_failed', 'warn'),
    ('return_to_origin', 'warn'),
    ('cancelled', 'neutral')
)
UPDATE public.lookup_values v
   SET metadata = COALESCE(v.metadata, '{}'::jsonb) || jsonb_build_object('tone', expected.tone),
       updated_at = now()
  FROM public.lookup_definitions d,
       expected
 WHERE v.lookup_definition_id = d.id
   AND d.category = 'shipment_status'
   AND v.value = expected.value
   AND COALESCE(v.metadata->>'tone', '') IS DISTINCT FROM expected.tone;

SELECT pg_advisory_unlock(hashtext('202605111958_shipment_status_lookup_tones_v1'));
COMMIT;

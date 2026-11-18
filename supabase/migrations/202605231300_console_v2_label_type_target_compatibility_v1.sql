-- Console V2 Label Designer: label type target compatibility metadata.
-- Keeps target-neutral label generation selectors row-driven so route,
-- container, and transfer targets do not fall back to shipment label types.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605231300_console_v2_label_type_target_compatibility_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH target_compatibility(value, compatible_target_types) AS (
  VALUES
    ('shipping', ARRAY['shipment']::text[]),
    ('route', ARRAY['route_run']::text[]),
    ('container', ARRAY['handling_unit']::text[]),
    ('transfer', ARRAY['warehouse_transfer']::text[])
)
UPDATE public.lookup_values lv
   SET metadata = COALESCE(lv.metadata, '{}'::jsonb)
                  || jsonb_build_object('compatible_target_types', to_jsonb(tc.compatible_target_types)),
       updated_at = now()
  FROM public.lookup_definitions ld
  JOIN target_compatibility tc
    ON TRUE
 WHERE lv.lookup_definition_id = ld.id
   AND ld.category = 'label_type'
   AND lv.value = tc.value
   AND (
     COALESCE(lv.metadata->'compatible_target_types', 'null'::jsonb)
       IS DISTINCT FROM to_jsonb(tc.compatible_target_types)
   );

SELECT pg_advisory_unlock(hashtext('202605231300_console_v2_label_type_target_compatibility_v1'));

COMMIT;

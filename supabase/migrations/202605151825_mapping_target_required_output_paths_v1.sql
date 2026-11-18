-- Console V2 mapping test remediation: mapping targets declare required output paths.
--
-- Mapping Studio reads this row-driven metadata to warn operators when a
-- persisted test report still emits a payload that cannot satisfy the target
-- lifecycle, for example a shipment-create mapping output with null recipient
-- or destination address fields.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605151825_mapping_target_required_output_paths_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH target AS (
  SELECT lv.id
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'mapping_target'
     AND lv.value = 'shipments.create'
)
UPDATE public.lookup_values lv
   SET metadata = COALESCE(lv.metadata, '{}'::jsonb)
     || jsonb_build_object(
          'required_output_paths',
          jsonb_build_array(
            jsonb_build_object('path', 'recipient.name', 'label', 'Recipient name'),
            jsonb_build_object('path', 'recipient.phone', 'label', 'Recipient phone'),
            jsonb_build_object('path', 'address.line1', 'label', 'Address line 1'),
            jsonb_build_object('path', 'address.city', 'label', 'Address city'),
            jsonb_build_object('path', 'address.country_code', 'label', 'Address country')
          )
        ),
       updated_at = now()
  FROM target
 WHERE lv.id = target.id;

SELECT pg_advisory_unlock(hashtext('202605151825_mapping_target_required_output_paths_v1'));
COMMIT;

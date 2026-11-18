-- Console V2 manual shipment creation must accept every service level that
-- first-tenant onboarding can provision into active service offerings.
-- The live Browser flow found Same-day delivery resolving to service_levels.key
-- `same_day`, then failing the shipments.service_level lookup contract.

BEGIN;

SET search_path TO public, extensions, pg_temp;

UPDATE public.lookup_definitions
   SET description = 'Shipment service level (economy/standard/premium/express/same_day/white_glove)',
       updated_at = now()
 WHERE category = 'service_level'
   AND description IS DISTINCT FROM 'Shipment service level (economy/standard/premium/express/same_day/white_glove)';

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status, metadata)
SELECT d.id, v.value, v.label, v.sort_order, FALSE, 'active', v.metadata
  FROM public.lookup_definitions d
  JOIN (
    VALUES
      ('same_day', 'Same day', 50, jsonb_build_object('tone', 'warn', 'source', 'console_v2_manual_shipment_same_day_service_level_lookup_v1')),
      ('white_glove', 'White glove', 60, jsonb_build_object('tone', 'danger', 'source', 'console_v2_manual_shipment_same_day_service_level_lookup_v1'))
  ) AS v(value, label, sort_order, metadata)
    ON d.category = 'service_level'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
   SET label = EXCLUDED.label,
       sort_order = EXCLUDED.sort_order,
       status = 'active',
       retired_at = NULL,
       metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
       updated_at = now();

COMMIT;

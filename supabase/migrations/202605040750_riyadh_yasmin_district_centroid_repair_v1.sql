-- 202605031720_riyadh_yasmin_district_centroid_repair_v1.sql
--
-- W53 backfilled centroid coordinates for the Console V2 tracking-map labels
-- only when the target canonical district row already existed. Some seeded
-- databases have Riyadh Olaya, Sulaimaniyah, Malqa, and Hiteen but are missing
-- Riyadh/Yasmin. Add the missing global district row so the intended five-label
-- operational map contract is complete.

WITH global_riyadh AS (
  SELECT id, organization_id
  FROM public.canonical_cities
  WHERE name_canonical = 'Riyadh'
    -- objectives:allow TENANT_LITERAL Justification: global Riyadh centroid repair uses the zero UUID organization sentinel, not tenant/client/sender routing.
    AND organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  ORDER BY created_at NULLS LAST, id
  LIMIT 1
)
INSERT INTO public.canonical_districts (
  id,
  organization_id,
  city_id,
  name_canonical,
  name_arabic,
  alternate_names,
  source,
  metadata,
  is_active,
  centroid_lat,
  centroid_lng
)
SELECT
  gen_random_uuid(),
  gr.organization_id,
  gr.id,
  'Al Yasmin Dist.',
  NULL,
  ARRAY['Yasmin', 'Al Yasmin', 'Al-Yasmin']::text[],
  'manual_seed',
  jsonb_build_object('console_v2_seed_key', 'ruh_yasmin'),
  TRUE,
  24.76,
  46.69
FROM global_riyadh gr
WHERE NOT EXISTS (
  SELECT 1
  FROM public.canonical_districts cd
  WHERE cd.city_id = gr.id
    AND lower(cd.name_canonical) LIKE '%yasmin%'
);

WITH global_riyadh AS (
  SELECT id
  FROM public.canonical_cities
  WHERE name_canonical = 'Riyadh'
    -- objectives:allow TENANT_LITERAL Justification: global Riyadh centroid repair uses the zero UUID organization sentinel, not tenant/client/sender routing.
    AND organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  ORDER BY created_at NULLS LAST, id
  LIMIT 1
)
UPDATE public.canonical_districts cd
SET centroid_lat = COALESCE(cd.centroid_lat, 24.76),
    centroid_lng = COALESCE(cd.centroid_lng, 46.69),
    updated_at = now()
FROM global_riyadh gr
WHERE cd.city_id = gr.id
  AND lower(cd.name_canonical) LIKE '%yasmin%'
  AND (cd.centroid_lat IS NULL OR cd.centroid_lng IS NULL);

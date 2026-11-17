-- Migration: Geocoding canonical geography seed (cities + districts) with centroids
-- Synthetic example geography; no upstream dataset is included.
-- Purpose: Seed canonical_cities and canonical_districts with Saudi reference data, add coordinates, and enforce RLS.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Add centroid + source columns for canonical geography tables
ALTER TABLE IF EXISTS public.canonical_cities
    ADD COLUMN IF NOT EXISTS centroid geography(POINT, 4326),
    ADD COLUMN IF NOT EXISTS source_city_id BIGINT,
    ADD COLUMN IF NOT EXISTS source_region_id INT,
    ADD COLUMN IF NOT EXISTS region_code TEXT;

ALTER TABLE IF EXISTS public.canonical_districts
    ADD COLUMN IF NOT EXISTS centroid geography(POINT, 4326),
    ADD COLUMN IF NOT EXISTS source_district_id BIGINT,
    ADD COLUMN IF NOT EXISTS source_region_id INT;

-- Replace uniqueness to allow multiple cities with the same name across regions
ALTER TABLE IF EXISTS public.canonical_cities
    DROP CONSTRAINT IF EXISTS canonical_cities_unique;

ALTER TABLE IF EXISTS public.canonical_districts
    DROP CONSTRAINT IF EXISTS canonical_districts_unique;

CREATE UNIQUE INDEX IF NOT EXISTS canonical_cities_source_uidx
    ON public.canonical_cities (organization_id, source_city_id)
    WHERE source_city_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS canonical_cities_name_null_source_uidx
    ON public.canonical_cities (organization_id, name_canonical)
    WHERE source_city_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS canonical_districts_source_uidx
    ON public.canonical_districts (organization_id, source_district_id)
    WHERE source_district_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS canonical_districts_name_null_source_uidx
    ON public.canonical_districts (organization_id, city_id, name_canonical)
    WHERE source_district_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_canonical_cities_name_trgm
    ON public.canonical_cities USING GIN (name_canonical gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_canonical_cities_arabic_trgm
    ON public.canonical_cities USING GIN (name_arabic gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_canonical_cities_alt_gin
    ON public.canonical_cities USING GIN (alternate_names);

CREATE INDEX IF NOT EXISTS idx_canonical_districts_name_trgm
    ON public.canonical_districts USING GIN (name_canonical gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_canonical_districts_arabic_trgm
    ON public.canonical_districts USING GIN (name_arabic gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_canonical_districts_alt_gin
    ON public.canonical_districts USING GIN (alternate_names);

-- Enable RLS and least-privilege policies
ALTER TABLE IF EXISTS public.canonical_cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.canonical_districts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS canonical_cities_service_policy ON public.canonical_cities;
CREATE POLICY canonical_cities_service_policy ON public.canonical_cities
    FOR ALL TO service_role
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS canonical_cities_org_select ON public.canonical_cities;
CREATE POLICY canonical_cities_org_select ON public.canonical_cities
    FOR SELECT TO authenticated
    USING (organization_id = current_user_org_id());

DROP POLICY IF EXISTS canonical_districts_service_policy ON public.canonical_districts;
CREATE POLICY canonical_districts_service_policy ON public.canonical_districts
    FOR ALL TO service_role
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS canonical_districts_org_select ON public.canonical_districts;
CREATE POLICY canonical_districts_org_select ON public.canonical_districts
    FOR SELECT TO authenticated
    USING (organization_id = current_user_org_id());

-- Seed canonical cities with centroids per organization
WITH city_seed AS (
    SELECT * FROM jsonb_to_recordset($$[{"city_id":1,"region_id":1,"region_code":"EX","region_name":"Example Region","name_en":"Example City","name_ar":"Example City","lat":0.0,"lon":0.0}]$$::jsonb) AS (
        city_id INT,
        region_id INT,
        region_code TEXT,
        region_name TEXT,
        name_en TEXT,
        name_ar TEXT,
        lat NUMERIC,
        lon NUMERIC
    )
), orgs AS (
    SELECT id AS organization_id FROM public.organizations
)
INSERT INTO public.canonical_cities AS cc (
    organization_id,
    name_canonical,
    name_arabic,
    alternate_names,
    province,
    country_code,
    source,
    metadata,
    centroid,
    source_city_id,
    source_region_id,
    region_code
)
SELECT
    o.organization_id,
    cs.name_en,
    cs.name_ar,
    ARRAY_REMOVE(ARRAY[cs.name_en, cs.name_ar], NULL),
    cs.region_name,
    'SA',
    'manual_seed',
    jsonb_strip_nulls(jsonb_build_object(
        'city_id', cs.city_id,
        'region_id', cs.region_id,
        'region_code', cs.region_code,
        'region_name', cs.region_name,
        'source', 'saudi_reference_v1'
    )),
    CASE WHEN cs.lat IS NOT NULL AND cs.lon IS NOT NULL
         THEN ST_SetSRID(ST_MakePoint(cs.lon, cs.lat), 4326)::geography
         ELSE NULL END,
    cs.city_id,
    cs.region_id,
    cs.region_code
FROM orgs o
JOIN city_seed cs ON TRUE
ON CONFLICT (organization_id, source_city_id) WHERE source_city_id IS NOT NULL DO UPDATE
SET
    name_arabic = EXCLUDED.name_arabic,
    alternate_names = EXCLUDED.alternate_names,
    province = EXCLUDED.province,
    region_code = EXCLUDED.region_code,
    source_region_id = EXCLUDED.source_region_id,
    metadata = COALESCE(cc.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    centroid = COALESCE(EXCLUDED.centroid, cc.centroid),
    updated_at = now();

-- Seed canonical districts with centroids per organization
WITH district_seed AS (
    SELECT * FROM jsonb_to_recordset($$[{"district_id":1,"city_id":1,"region_id":1,"name_en":"Example District","name_ar":"Example District","lat":0.0,"lon":0.0}]$$::jsonb) AS (
        district_id BIGINT,
        city_id INT,
        region_id INT,
        name_en TEXT,
        name_ar TEXT,
        lat NUMERIC,
        lon NUMERIC
    )
), orgs AS (
    SELECT id AS organization_id FROM public.organizations
), city_map AS (
    SELECT organization_id, source_city_id, id AS city_pk
    FROM public.canonical_cities
)
INSERT INTO public.canonical_districts AS cd (
    organization_id,
    city_id,
    name_canonical,
    name_arabic,
    alternate_names,
    source,
    metadata,
    centroid,
    source_district_id,
    source_region_id
)
SELECT
    o.organization_id,
    cm.city_pk,
    ds.name_en,
    ds.name_ar,
    ARRAY_REMOVE(ARRAY[ds.name_en, ds.name_ar], NULL),
    'manual_seed',
    jsonb_strip_nulls(jsonb_build_object(
        'district_id', ds.district_id,
        'city_id', ds.city_id,
        'region_id', ds.region_id,
        'source', 'saudi_reference_v1'
    )),
    CASE WHEN ds.lat IS NOT NULL AND ds.lon IS NOT NULL
         THEN ST_SetSRID(ST_MakePoint(ds.lon, ds.lat), 4326)::geography
         ELSE NULL END,
    ds.district_id,
    ds.region_id
FROM orgs o
JOIN district_seed ds ON TRUE
JOIN city_map cm
  ON cm.organization_id = o.organization_id
 AND cm.source_city_id = ds.city_id
WHERE ds.name_en IS NOT NULL
ON CONFLICT (organization_id, source_district_id) WHERE source_district_id IS NOT NULL DO UPDATE
SET
    name_arabic = EXCLUDED.name_arabic,
    alternate_names = EXCLUDED.alternate_names,
    metadata = COALESCE(cd.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    centroid = COALESCE(EXCLUDED.centroid, cd.centroid),
    updated_at = now();

COMMIT;

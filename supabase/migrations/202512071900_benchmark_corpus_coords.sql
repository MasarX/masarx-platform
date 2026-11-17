-- Migration: Benchmark corpus generator - include centroids for all categories
-- Purpose: Ensure every synthetic benchmark sample carries coordinates (district centroid) so provider/reverse mapping can resolve SA polygons deterministically.

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.benchmark_generate_corpus(
    p_target_per_category JSONB DEFAULT jsonb_build_object(
        'perfect', 1200,
        'typo', 1200,
        'long_line', 1200,
        'partial', 1200,
        'short_code', 1200,
        'reverse_local', 1200,
        'border', 1200
    ),
    p_reset BOOLEAN DEFAULT FALSE,
    p_seed INTEGER DEFAULT 42
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_summary JSONB := '{}'::jsonb;
    v_cat TEXT;
    v_target INT;
    v_existing INT;
    v_needed INT;
BEGIN
    PERFORM setseed(p_seed / 1000.0); -- deterministic-ish, but still varied

    IF p_reset THEN
        DELETE FROM public.benchmark_geocoding_samples;
    END IF;

    FOR v_cat IN SELECT jsonb_object_keys(p_target_per_category)
    LOOP
        v_target := COALESCE((p_target_per_category->>v_cat)::INT, 0);
        IF v_target <= 0 THEN
            CONTINUE;
        END IF;

        SELECT COUNT(*) INTO v_existing FROM public.benchmark_geocoding_samples WHERE category = v_cat;
        v_needed := GREATEST(v_target - v_existing, 0);

        IF v_needed > 0 THEN
            WITH base AS (
                SELECT
                    d.id AS sa_district_id,
                    c.id AS sa_city_id,
                    r.id AS sa_region_id,
                    COALESCE(d.name_en, d.name_ar) AS district_name,
                    COALESCE(c.name_en, c.name_ar) AS city_name,
                    COALESCE(r.name_en, r.name_ar) AS region_name,
                    ST_Y(d.centroid)::numeric AS latitude,
                    ST_X(d.centroid)::numeric AS longitude
                FROM public.sa_districts d
                JOIN public.sa_cities c ON c.id = d.city_id
                JOIN public.sa_regions r ON r.id = d.region_id
                WHERE d.centroid IS NOT NULL
            ),
            gen AS (
                SELECT
                    gen_random_uuid() AS id,
                    v_cat AS category,
                    CASE WHEN (hashtext(v_cat || gs::text) % 3) = 0 THEN 'ar' ELSE 'en' END AS language,
                    CASE
                        WHEN v_cat = 'perfect' THEN format('%s %s main st %s', b.district_name, b.city_name, gs)
                        WHEN v_cat = 'typo' THEN regexp_replace(format('%s %s', b.district_name, b.city_name), '[aeiou]', '', 'gi') || ' strt ' || gs
                        WHEN v_cat = 'long_line' THEN format('%s %s delivery hub building %s extra tokens noise filler parcel shipment road', b.district_name, b.city_name, gs)
                        WHEN v_cat = 'partial' THEN format('%s block %s', b.city_name, gs)
                        WHEN v_cat = 'short_code' THEN substring(md5(b.district_name || gs), 1, 4) || '+99 ' || b.city_name
                        ELSE NULL
                    END AS line1,
                    NULL::text AS line2,
                    CASE WHEN v_cat = 'partial' THEN NULL ELSE b.city_name END AS city,
                    CASE WHEN v_cat IN ('partial', 'short_code') THEN NULL ELSE b.district_name END AS district,
                    b.region_name AS province,
                    'SA' AS country,
                    b.latitude AS latitude,
                    b.longitude AS longitude,
                    b.sa_city_id AS expected_sa_city_id,
                    b.sa_district_id AS expected_sa_district_id,
                    b.sa_region_id AS expected_sa_region_id,
                    CASE
                        WHEN v_cat = 'perfect' THEN 'perfect'
                        WHEN v_cat = 'typo' THEN 'fuzzy'
                        WHEN v_cat = 'long_line' THEN 'long_line'
                        WHEN v_cat = 'partial' THEN 'fuzzy'
                        WHEN v_cat = 'short_code' THEN 'provider'
                        WHEN v_cat = 'reverse_local' THEN 'reverse_local'
                        WHEN v_cat = 'border' THEN 'provider'
                        ELSE NULL
                    END AS expected_plugin,
                    CASE
                        WHEN v_cat = 'border' THEN 'should_fail'
                        WHEN v_cat = 'short_code' THEN 'should_fallback'
                        ELSE 'should_match'
                    END AS expected_outcome,
                    (v_cat = 'typo') AS has_typos,
                    (v_cat = 'long_line') AS has_extra_tokens,
                    (v_cat = 'partial') AS missing_city,
                    (v_cat IN ('partial', 'short_code')) AS missing_district,
                    1::numeric AS weight
                FROM generate_series(1, v_needed) gs
                CROSS JOIN LATERAL (
                    SELECT *
                    FROM base
                    ORDER BY hashtext(v_cat || gs::text || base.sa_district_id::text)
                    LIMIT 1
                ) b
            )
            INSERT INTO public.benchmark_geocoding_samples (
                id,
                category,
                language,
                line1,
                line2,
                city,
                district,
                province,
                country,
                latitude,
                longitude,
                expected_city_id,
                expected_district_id,
                expected_sa_region_id,
                expected_sa_city_id,
                expected_sa_district_id,
                expected_plugin,
                expected_outcome,
                has_typos,
                has_extra_tokens,
                missing_city,
                missing_district,
                weight
            )
            SELECT
                id,
                category,
                language,
                line1,
                line2,
                city,
                district,
                province,
                country,
                CASE WHEN category = 'border' THEN latitude + 5 ELSE latitude END,
                CASE WHEN category = 'border' THEN longitude + 5 ELSE longitude END,
                NULL::uuid,
                NULL::uuid,
                expected_sa_region_id,
                expected_sa_city_id,
                expected_sa_district_id,
                expected_plugin,
                expected_outcome,
                has_typos,
                has_extra_tokens,
                missing_city,
                missing_district,
                weight
            FROM gen;
        END IF;

        v_summary := v_summary || jsonb_build_object(
            v_cat,
            jsonb_build_object(
                'existing', v_existing,
                'added', v_needed,
                'target', v_target
            )
        );
    END LOOP;

    RETURN jsonb_build_object(
        'per_category', v_summary,
        'total_rows', (SELECT COUNT(*) FROM public.benchmark_geocoding_samples)
    );
END;
$$;

COMMENT ON FUNCTION public.benchmark_generate_corpus(JSONB, BOOLEAN, INTEGER) IS
  'Generates synthetic benchmark samples per category (polygon-driven) to reach target counts; now assigns coordinates to all categories for deterministic polygon mapping.';

COMMIT;

-- Migration: Saudi polygons schema (regions/cities/districts)
-- Purpose: Create tables and indexes for Saudi administrative polygons to support local reverse geocoding.
-- Data load is handled via seed file supabase/seed/sa_polygons.sql to keep migration size small.

BEGIN;

CREATE TABLE IF NOT EXISTS public.sa_regions (
    id integer PRIMARY KEY,
    name_ar text,
    name_en text,
    geom geometry(Polygon,4326),
    bbox geometry(Polygon,4326),
    centroid geometry(Point,4326),
    source varchar(32) default 'sa_geojson',
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

CREATE TABLE IF NOT EXISTS public.sa_cities (
    id integer PRIMARY KEY,
    region_id integer REFERENCES public.sa_regions(id),
    name_ar text,
    name_en text,
    geom geometry(Point,4326),
    bbox geometry(Polygon,4326),
    centroid geometry(Point,4326),
    source varchar(32) default 'sa_geojson',
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

CREATE TABLE IF NOT EXISTS public.sa_districts (
    id integer PRIMARY KEY,
    city_id integer REFERENCES public.sa_cities(id),
    region_id integer REFERENCES public.sa_regions(id),
    name_ar text,
    name_en text,
    geom geometry(Polygon,4326),
    bbox geometry(Polygon,4326),
    centroid geometry(Point,4326),
    source varchar(32) default 'sa_geojson',
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

CREATE INDEX IF NOT EXISTS sa_regions_gix ON public.sa_regions USING GIST (geom);
CREATE INDEX IF NOT EXISTS sa_regions_bbox_gix ON public.sa_regions USING GIST (bbox);
CREATE INDEX IF NOT EXISTS sa_cities_gix ON public.sa_cities USING GIST (geom);
CREATE INDEX IF NOT EXISTS sa_cities_bbox_gix ON public.sa_cities USING GIST (bbox);
CREATE INDEX IF NOT EXISTS sa_districts_gix ON public.sa_districts USING GIST (geom);
CREATE INDEX IF NOT EXISTS sa_districts_bbox_gix ON public.sa_districts USING GIST (bbox);

ALTER TABLE public.sa_regions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sa_cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sa_districts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sa_regions' AND policyname = 'sa_regions_service_role_select'
  ) THEN
    EXECUTE 'CREATE POLICY sa_regions_service_role_select ON public.sa_regions FOR SELECT TO service_role USING (true)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sa_cities' AND policyname = 'sa_cities_service_role_select'
  ) THEN
    EXECUTE 'CREATE POLICY sa_cities_service_role_select ON public.sa_cities FOR SELECT TO service_role USING (true)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sa_districts' AND policyname = 'sa_districts_service_role_select'
  ) THEN
    EXECUTE 'CREATE POLICY sa_districts_service_role_select ON public.sa_districts FOR SELECT TO service_role USING (true)';
  END IF;
END$$;

COMMIT;

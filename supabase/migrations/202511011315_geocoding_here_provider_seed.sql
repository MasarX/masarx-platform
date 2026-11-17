-- Migration: Seed HERE geocoding provider record
-- Purpose: Ensure canonical provider row exists for policy-driven dispatch.

BEGIN;

WITH upsert_global_root AS (
    INSERT INTO public.organizations (id, name, slug, timezone, locale, billing_status)
    VALUES ('00000000-0000-0000-0000-000000000000'::uuid, 'Global', 'global-root', 'UTC', 'en-US', 'active')
    ON CONFLICT (id) DO NOTHING
    RETURNING id
),
target_org AS (
    SELECT o.id
    FROM public.organizations o
    WHERE o.id = '00000000-0000-0000-0000-000000000000'::uuid
       OR o.slug = 'global-root'
    ORDER BY CASE WHEN o.id = '00000000-0000-0000-0000-000000000000'::uuid THEN 0 ELSE 1 END
    LIMIT 1
)
INSERT INTO public.providers AS p (
    id,
    organization_id,
    name,
    provider_type,
    enabled,
    priority_rank,
    metadata
)
SELECT
    'f36008ee-9f91-4f28-a1d4-ae331a42bdfc'::uuid,
    target_org.id,
    'here_geocoding',
    'geocoding',
    TRUE,
    90,
    jsonb_build_object(
        'base_url', 'https://geocode.search.hereapi.com/v1',
        'description', 'HERE geocoding provider (primary)'
    )
FROM target_org
ON CONFLICT (id) DO UPDATE
SET
    organization_id = EXCLUDED.organization_id,
    name = EXCLUDED.name,
    provider_type = EXCLUDED.provider_type,
    enabled = EXCLUDED.enabled,
    priority_rank = EXCLUDED.priority_rank,
    metadata = jsonb_strip_nulls(COALESCE(p.metadata, '{}'::jsonb) || EXCLUDED.metadata),
    updated_at = now();

COMMIT;

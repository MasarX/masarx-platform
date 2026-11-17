-- Migration: Ensure cache_config exists
-- Purpose:
--   - Prevent downstream migrations/functions (e.g. ensure_audit_triggers) from failing
--     if cache_config was removed during pre-production cleanup.
-- Notes:
--   - Idempotent: safe to run even when cache_config already exists.
BEGIN;
SELECT pg_advisory_lock(hashtext('202512301150_cache_config_ensure_exists'));
SET search_path TO public, pg_temp;

CREATE TABLE IF NOT EXISTS public.cache_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cache_key TEXT NOT NULL UNIQUE,
    cache_type TEXT NOT NULL,
    ttl_seconds INTEGER NOT NULL DEFAULT 3600,
    max_entries INTEGER,
    eviction_policy TEXT NOT NULL DEFAULT 'LRU',
    enabled BOOLEAN NOT NULL DEFAULT true,
    warmup_on_startup BOOLEAN NOT NULL DEFAULT false,
    description TEXT,
    config JSONB,
    stats JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT cache_config_ttl_check CHECK (ttl_seconds > 0),
    CONSTRAINT cache_config_max_entries_check CHECK (max_entries IS NULL OR max_entries > 0)
);

CREATE INDEX IF NOT EXISTS idx_cache_config_type ON public.cache_config(cache_type);
CREATE INDEX IF NOT EXISTS idx_cache_config_enabled ON public.cache_config(enabled) WHERE enabled = true;

COMMENT ON TABLE public.cache_config IS 'Caching strategy configuration for performance optimization (global, non-partitioned)';
COMMENT ON COLUMN public.cache_config.cache_key IS 'Unique identifier for this cache instance';
COMMENT ON COLUMN public.cache_config.cache_type IS 'Category of cached data (e.g., geocoding, pricing, routing, settings)';
COMMENT ON COLUMN public.cache_config.ttl_seconds IS 'Time-to-live in seconds before cache invalidation';
COMMENT ON COLUMN public.cache_config.eviction_policy IS 'Cache eviction strategy: LRU, LFU, FIFO, TTL';
COMMENT ON COLUMN public.cache_config.stats IS 'Runtime statistics: {hits, misses, hit_rate, last_reset_at}';

ALTER TABLE public.cache_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cache_config_select ON public.cache_config;
DROP POLICY IF EXISTS cache_config_insert ON public.cache_config;
DROP POLICY IF EXISTS cache_config_update ON public.cache_config;
DROP POLICY IF EXISTS cache_config_delete ON public.cache_config;

CREATE POLICY cache_config_select ON public.cache_config
  FOR SELECT
  TO authenticated
  USING (public.is_platform_user());

CREATE POLICY cache_config_insert ON public.cache_config
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_platform_user());

CREATE POLICY cache_config_update ON public.cache_config
  FOR UPDATE
  TO authenticated
  USING (public.is_platform_user())
  WITH CHECK (public.is_platform_user());

CREATE POLICY cache_config_delete ON public.cache_config
  FOR DELETE
  TO authenticated
  USING (public.is_platform_user());

SELECT pg_advisory_unlock(hashtext('202512301150_cache_config_ensure_exists'));
COMMIT;

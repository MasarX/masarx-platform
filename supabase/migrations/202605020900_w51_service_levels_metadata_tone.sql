-- 202605020900_w51_service_levels_metadata_tone.sql
-- Backend mirror for the W50/W51 console-v2 closure
-- (apps/console-v2/src/lib/seed-raw/catalog-offerings.js +
-- apps/console-v2/src/modules/catalog/service-offerings.tsx tierTone).
--
-- Closes the inline magic-number ladder (>= 50/40/30/20) in the catalog
-- service-offerings tier badges by persisting an explicit `metadata.tone`
-- token on each canonical `public.service_levels` row. The audit recommends
-- sourcing tone from `service_levels.metadata` (already declared but unused
-- for tone). This migration backfills `metadata.tone` for the canonical
-- five-tier set (economy / standard / express / same_day / white_glove).
--
-- AGENTS.md alignment:
--   §1 SIMPLE/SCALABLE — adding a new tier or changing tier tone is a single
--      `UPDATE service_levels` rather than a code change.
--   §2 ZERO HARDCODING — removes the inline `>= 50/40/30/20` ladder.
--   §3 ROW-DRIVEN — tier visual is a row attribute, not a literal.
--   §4 SSOT — `service_levels.metadata.tone` is the canonical token consumed
--      by `apps/console-v2/.../service-offerings.tsx#tierTone(level)`.
--   §5 APPEND-ONLY — additive jsonb merge; the originating
--      202601212700_branch_capacity_catalog.sql migration is untouched.
--
-- Backfill targets the canonical per-organization `key` (lowercase enum) so
-- the update is deterministic regardless of organization scope. New levels
-- created via `service_level_create_v1` should set `metadata.tone` directly;
-- this migration is a one-shot backfill for pre-existing rows.

-- ---------------------------------------------------------------------------
-- 1. Backfill metadata.tone for canonical tier keys (idempotent)
-- ---------------------------------------------------------------------------
-- jsonb_set with create-if-missing=TRUE guarantees the key lands even when
-- `metadata` is NULL or empty. WHERE clause is fail-closed: only touches
-- rows whose `tone` is currently absent so re-runs are no-ops and tenants
-- that intentionally override tone keep their custom value.

UPDATE public.service_levels
SET
  metadata = jsonb_set(
    COALESCE(metadata, '{}'::jsonb),
    '{tone}',
    to_jsonb('neutral'::text),
    TRUE
  ),
  updated_at = now()
WHERE key = 'economy'
  AND (metadata IS NULL OR (metadata -> 'tone') IS NULL);

UPDATE public.service_levels
SET
  metadata = jsonb_set(
    COALESCE(metadata, '{}'::jsonb),
    '{tone}',
    to_jsonb('info'::text),
    TRUE
  ),
  updated_at = now()
WHERE key = 'standard'
  AND (metadata IS NULL OR (metadata -> 'tone') IS NULL);

UPDATE public.service_levels
SET
  metadata = jsonb_set(
    COALESCE(metadata, '{}'::jsonb),
    '{tone}',
    to_jsonb('good'::text),
    TRUE
  ),
  updated_at = now()
WHERE key = 'express'
  AND (metadata IS NULL OR (metadata -> 'tone') IS NULL);

UPDATE public.service_levels
SET
  metadata = jsonb_set(
    COALESCE(metadata, '{}'::jsonb),
    '{tone}',
    to_jsonb('warn'::text),
    TRUE
  ),
  updated_at = now()
WHERE key = 'same_day'
  AND (metadata IS NULL OR (metadata -> 'tone') IS NULL);

UPDATE public.service_levels
SET
  metadata = jsonb_set(
    COALESCE(metadata, '{}'::jsonb),
    '{tone}',
    to_jsonb('danger'::text),
    TRUE
  ),
  updated_at = now()
WHERE key = 'white_glove'
  AND (metadata IS NULL OR (metadata -> 'tone') IS NULL);

COMMENT ON COLUMN public.service_levels.metadata IS
  'Service level presentation/policy metadata. Canonical keys include `tier`, `priority_rank`, `sla_minutes`, `sla_label`, `color_token`, and `tone` (chip kind: good|warn|danger|info|neutral). The `tone` token is the SSOT consumed by the operator console catalog tier badge — see W51.';

-- Spec-Issue: W28 PLATFORM gap closure (paired projection views)
-- Step: W28-VIEW-2
-- Migration: Canonical projection view public.v_label_template_directory.
-- Capability: labels.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-template derived projections + lifecycle counters used by
--   `apps/console-v2/src/modules/platform/labels.tsx` (LabelSpec):
--     - dimensions          : derived projection (renderer_config->>'dimensions')
--                               — closes the W10-5 §8 REMOVE deferral by
--                               surfacing the canonical jsonb-extracted column
--                               shadow under a stable view key.
--     - dpi                 : derived projection (renderer_config->>'dpi'::INT)
--                               — closes the W10-5 §8 REMOVE deferral.
--     - barcode_format      : derived projection (renderer_config->>'barcode_format')
--                               — closes the W10-5 §8 REMOVE deferral.
--     - active_version_id   : derived projection (renderer_config->>'active_version_id')
--                               — closes the W14-7 closure path; canonical
--                               schema stores `version INT` directly and the
--                               active-version pointer lives in renderer_config.
--     - tenant_label        : human-readable tenant label resolved via
--                               organizations.name (FK join).
--     - created_by_label    : human-readable user label resolved via
--                               public.users.full_name (FK join).
--     - render_count        : derived COUNT(label_jobs WHERE template_id = id)
--                               — historical render volume per template.
--     - render_count_24h    : derived COUNT(label_jobs WHERE template_id = id
--                                AND scheduled_at >= now() - INTERVAL '24 hours').
--     - last_used_at        : derived MAX(label_jobs.scheduled_at) per template
--                               (closes the W18 deferral by surfacing the
--                               actual last-used timestamp without FE-side
--                               aggregation).
--     - completed_count     : derived COUNT(label_jobs WHERE status='succeeded'
--                                AND template_id = id).
--     - failed_count        : derived COUNT(label_jobs WHERE status='failed'
--                                AND template_id = id).
--     - version_count       : derived COUNT(label_template_specs sharing same
--                                template_key AND organization_id) — captures
--                                the version multiplicity since the canonical
--                                schema stores each version as a separate row
--                                keyed (organization_id, template_key, version).
--     - is_active_version   : derived BOOLEAN — TRUE when this row's
--                               (template_key, version) pair is the highest
--                               version for that template_key in the org.
--     - asset_count         : derived COUNT of jsonb array elements in
--                               asset_refs (NULL-safe).
--
--   The FE `LabelSpec` interface at apps/console-v2/src/modules/platform/labels.tsx
--   currently extracts dimensions/dpi/barcode_format from renderer_config jsonb
--   client-side, and renders active_version_id by reading
--   renderer_config.active_version_id manually. Moving to a canonical view
--   exposes the canonical SSOT columns AND the FE-shaped projection
--   aliases on the same seam, so the production cutover becomes a single
--   getSupabaseClient() branch flip in
--   `ui_list_resource_v1('label_template_directory')`.
--
-- Notes:
--   * SSOT remains public.label_template_specs; this view is read-only.
--   * RLS is enforced by the underlying tables (label_template_specs,
--     label_jobs, organizations, users) via security_invoker = true.
--   * Service-role + authenticated SELECT (mirrors W22-W27 paired projection
--     grants).
--   * Idempotent: pure view; safe to re-run.
--
-- Cross-references:
--   - SSOT inventory: apps/console-v2/__audit__/SCHEMA-DRIFT/PLATFORM.md §8
--   - FE shape: apps/console-v2/src/modules/platform/labels.tsx:34
--   - Canonical table: 202510200001_label_generation_core.sql:337

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302610_v_label_template_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_label_template_directory;

CREATE VIEW public.v_label_template_directory
  WITH (security_invoker = true)
  AS
WITH job_agg AS (
  SELECT
    lj.template_id,
    COUNT(*)                                                              AS render_count,
    COUNT(*) FILTER (
      WHERE lj.scheduled_at >= now() - INTERVAL '24 hours'
    )                                                                     AS render_count_24h,
    MAX(lj.scheduled_at)                                                  AS last_used_at,
    COUNT(*) FILTER (WHERE lj.status = 'succeeded')                       AS completed_count,
    COUNT(*) FILTER (WHERE lj.status = 'failed')                          AS failed_count
  FROM public.label_jobs lj
  GROUP BY lj.template_id
),
version_agg AS (
  SELECT
    lts.organization_id,
    lts.template_key,
    COUNT(*)                                                              AS version_count,
    MAX(lts.version)                                                      AS max_version
  FROM public.label_template_specs lts
  GROUP BY lts.organization_id, lts.template_key
)
SELECT
  lts.id,
  lts.organization_id,
  lts.template_key,
  lts.version,
  lts.template_scope_type,
  lts.template_scope_id,
  lts.renderer_config,
  lts.asset_refs,
  lts.created_by,
  lts.created_at,
  -- Derived: jsonb-path projections (renderer_config jsonb extracts).
  lts.renderer_config->>'dimensions'                                      AS dimensions,
  NULLIF(lts.renderer_config->>'dpi', '')::INT                            AS dpi,
  lts.renderer_config->>'barcode_format'                                  AS barcode_format,
  lts.renderer_config->>'active_version_id'                               AS active_version_id,
  -- Derived: organization label
  o.name                                                                  AS tenant_label,
  o.slug                                                                  AS tenant_slug,
  -- Derived: created_by user label
  u.full_name                                                             AS created_by_label,
  u.email                                                                 AS created_by_email,
  -- Derived: job-lifecycle aggregates
  COALESCE(job_agg.render_count, 0)::INT                                  AS render_count,
  COALESCE(job_agg.render_count_24h, 0)::INT                              AS render_count_24h,
  job_agg.last_used_at                                                    AS last_used_at,
  COALESCE(job_agg.completed_count, 0)::INT                               AS completed_count,
  COALESCE(job_agg.failed_count, 0)::INT                                  AS failed_count,
  -- Derived: version multiplicity
  COALESCE(version_agg.version_count, 1)::INT                             AS version_count,
  (lts.version = COALESCE(version_agg.max_version, lts.version))          AS is_active_version,
  -- Derived: asset_refs jsonb array length (NULL-safe).
  COALESCE(jsonb_array_length(lts.asset_refs), 0)::INT                    AS asset_count
FROM public.label_template_specs lts
LEFT JOIN public.organizations o ON o.id = lts.organization_id
LEFT JOIN public.users u ON u.id = lts.created_by
LEFT JOIN job_agg ON job_agg.template_id = lts.id
LEFT JOIN version_agg
  ON version_agg.organization_id = lts.organization_id
 AND version_agg.template_key    = lts.template_key;

COMMENT ON VIEW public.v_label_template_directory IS
  'FE-friendly projection of label_template_specs with renderer_config jsonb-path projections (dimensions, dpi, barcode_format, active_version_id), organization join (tenant_label / tenant_slug), created_by user join (created_by_label / created_by_email), job-lifecycle aggregates (render_count, render_count_24h, last_used_at, completed_count, failed_count via label_jobs), and version multiplicity (version_count, is_active_version per template_key). Sources: label_template_specs + label_jobs + organizations + users. Read-only; SSOT remains label_template_specs; mutations go through create_label_template_spec_v1 / update_label_template_spec_v1 / activate_label_template_version_v1.';

REVOKE ALL ON public.v_label_template_directory FROM PUBLIC;
REVOKE ALL ON public.v_label_template_directory FROM anon;
GRANT SELECT ON public.v_label_template_directory TO authenticated;
GRANT SELECT ON public.v_label_template_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302610_v_label_template_directory'));
COMMIT;

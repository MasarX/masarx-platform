-- Spec-Issue: W27 INTEGRATIONS gap closure (paired projection views)
-- Step: W27-VIEW-5
-- Migration: Canonical projection view public.v_integration_plugin_directory.
-- Capability: integration_plugins.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-plugin derived joins + counters used by
--   `apps/console-v2/src/modules/integrations/catalog.tsx`
--   (IntegrationPlugin) and webhook-tester.tsx (read seam):
--     - vendor               : derived projection (metadata->>'vendor') —
--                                closes the W18-4 §7 deferral by surfacing the
--                                canonical jsonb-extracted column shadow under
--                                a stable view key.
--     - version_label        : derived display label from active version's
--                                version_no (`v{version_no}`)
--     - version_count        : derived COUNT(integration_plugin_versions) per
--                                plugin
--     - latest_version_status: derived status of plugin's most-recent version
--     - latest_version_no    : derived version_no of plugin's most-recent
--                                version
--     - active_version_status: derived status of the active_version_id row
--     - binding_count        : derived COUNT(integration_plugin_bindings) per
--                                plugin (across all versions)
--     - active_binding_count : derived COUNT(integration_plugin_bindings WHERE
--                                enabled=true)
--     - has_active_version   : derived flag (active_version_id IS NOT NULL)
--     - is_pending_review    : derived flag (latest_version_status IN
--                                ('draft','submitted'))
--     - install_count        : alias of binding_count (FE display vocabulary)
--
--   The FE `IntegrationPlugin` interface at
--   apps/console-v2/src/modules/integrations/catalog.tsx carries:
--     - vendor, version, health, last_event_at, events_24h, binding as derived
--       projection annotations (W18-4 §7 deferrals). This view closes the
--       vendor + version + binding count deferrals; health and event metrics
--       remain DEFERRED (require provider_health_logs aggregation + per-plugin
--       webhook_inbox routing, which is not currently materialised in the
--       canonical schema).
--
-- Notes:
--   * SSOT remains public.integration_plugins; this view is read-only.
--   * RLS enforced via `security_invoker = true`.
--   * Service-role + authenticated SELECT.
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302540_v_integration_plugin_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_integration_plugin_directory;

CREATE VIEW public.v_integration_plugin_directory
  WITH (security_invoker = true)
  AS
SELECT
  ip.id,
  ip.organization_id,
  ip.plugin_key,
  ip.name,
  ip.description,
  ip.plugin_kind,
  ip.status,
  ip.rollout_tier,
  ip.reusable_within_tenant,
  ip.base_plugin_id,
  ip.active_version_id,
  ip.managed_by,
  ip.metadata,
  ip.created_by,
  ip.updated_by,
  ip.created_at,
  ip.updated_at,
  -- Derived: vendor jsonb-path projection (W18-4 §7 closure)
  ip.metadata->>'vendor' AS vendor,
  -- Derived: active version label (FE displays as 'v{version_no}')
  CASE
    WHEN active_v.version_no IS NULL THEN NULL
    ELSE 'v' || active_v.version_no::text
  END AS version_label,
  -- Derived: active version status (closes the W18-4 §7 health-related projection)
  active_v.status AS active_version_status,
  -- Derived: latest (most-recent) version metadata
  COALESCE(version_agg.version_count, 0) AS version_count,
  version_agg.latest_version_no,
  version_agg.latest_version_status,
  -- Derived: binding usage counters
  COALESCE(binding_agg.binding_count, 0) AS binding_count,
  COALESCE(binding_agg.binding_count, 0) AS install_count,
  COALESCE(binding_agg.active_binding_count, 0) AS active_binding_count,
  -- Derived: status flags (single SSOT for catalog card chip + lifecycle gating)
  (ip.active_version_id IS NOT NULL) AS has_active_version,
  (COALESCE(version_agg.latest_version_status, '') IN ('draft', 'submitted')) AS is_pending_review
FROM public.integration_plugins ip
LEFT JOIN public.integration_plugin_versions active_v ON active_v.id = ip.active_version_id
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) AS version_count,
    MAX(ipv.version_no) AS latest_version_no,
    (
      SELECT ipv2.status
        FROM public.integration_plugin_versions ipv2
       WHERE ipv2.plugin_id = ip.id
       ORDER BY ipv2.version_no DESC, ipv2.created_at DESC
       LIMIT 1
    ) AS latest_version_status
    FROM public.integration_plugin_versions ipv
   WHERE ipv.plugin_id = ip.id
) version_agg ON TRUE
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) AS binding_count,
    COUNT(*) FILTER (WHERE ipb.enabled = TRUE) AS active_binding_count
    FROM public.integration_plugin_bindings ipb
    JOIN public.integration_plugin_versions ipv ON ipv.id = ipb.plugin_version_id
   WHERE ipv.plugin_id = ip.id
) binding_agg ON TRUE;

COMMENT ON VIEW public.v_integration_plugin_directory IS
  'FE-friendly projection of integration_plugins with derived jsonb-path projections (vendor via metadata.vendor, W18-4 §7 closure), version metadata (version_label as v{version_no}, version_count, latest_version_no, latest_version_status, active_version_status via integration_plugin_versions), binding usage counters (binding_count + install_count alias, active_binding_count via integration_plugin_bindings), and status flags (has_active_version, is_pending_review). Sources: integration_plugins + integration_plugin_versions + integration_plugin_bindings. Read-only; SSOT remains integration_plugins; mutations go through integration_plugin_generate_draft_v1 / submit / approve / activate / set_binding_v1 / rollback_v1.';

REVOKE ALL ON public.v_integration_plugin_directory FROM PUBLIC;
REVOKE ALL ON public.v_integration_plugin_directory FROM anon;
GRANT SELECT ON public.v_integration_plugin_directory TO authenticated;
GRANT SELECT ON public.v_integration_plugin_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302540_v_integration_plugin_directory'));
COMMIT;

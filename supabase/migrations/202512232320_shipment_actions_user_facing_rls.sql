-- Migration: shipment_actions user-facing read + service-only hardening
-- Purpose: Make shipment_actions readable to authenticated tenants (org-scoped) while keeping writes service-only.
-- Also: Remove accidental anon/authenticated grants from service-only benchmark/SA polygon tables.

BEGIN;

SET search_path TO public, pg_temp;

-- ---------------------------------------------------------------------------
-- Harden service-only tables (RLS already denies, but least-privilege removes grants).
-- ---------------------------------------------------------------------------

REVOKE ALL ON TABLE public.benchmark_geocoding_samples FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.benchmark_results FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.benchmark_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.benchmark_sa_uuid_map FROM PUBLIC, anon, authenticated;

REVOKE ALL ON TABLE public.sa_regions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.sa_cities FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.sa_districts FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- shipment_actions: authenticated read-only, org-scoped.
-- ---------------------------------------------------------------------------

ALTER TABLE public.shipment_actions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.shipment_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.shipment_actions TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'shipment_actions'
      AND policyname = 'shipment_actions_select_authenticated'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY shipment_actions_select_authenticated
      ON public.shipment_actions
      FOR SELECT
      TO authenticated
      USING (organization_id = current_user_org_id())
    $POLICY$;
  END IF;
END$$;

COMMENT ON POLICY shipment_actions_select_authenticated ON public.shipment_actions IS
  'Org-level isolation (SELECT).';

COMMIT;


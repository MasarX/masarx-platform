-- Plan: PLAN-202602-integration-plugin-studio-v1 / Step: S04,S05
-- Migration: Runtime workflow enforcement and tenant-safe route write extension for integration plugins

BEGIN;
SELECT pg_advisory_lock(hashtext('202602220030_integration_plugin_runtime_workflow_enforcement_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Mark runtime artifacts with managed_by metadata (SSOT)
-------------------------------------------------------------------------------

ALTER TABLE public.api_route_packs
  ADD COLUMN IF NOT EXISTS scope_type TEXT NOT NULL DEFAULT 'global',
  ADD COLUMN IF NOT EXISTS scope_id UUID NULL,
  ADD COLUMN IF NOT EXISTS managed_by TEXT NOT NULL DEFAULT 'platform',
  ADD COLUMN IF NOT EXISTS managed_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.api_routes
  ADD COLUMN IF NOT EXISTS managed_by TEXT NOT NULL DEFAULT 'platform',
  ADD COLUMN IF NOT EXISTS managed_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.webhook_sources
  ADD COLUMN IF NOT EXISTS managed_by TEXT NOT NULL DEFAULT 'platform',
  ADD COLUMN IF NOT EXISTS managed_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.mapping_configs
  ADD COLUMN IF NOT EXISTS managed_by TEXT NOT NULL DEFAULT 'platform',
  ADD COLUMN IF NOT EXISTS managed_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_api_route_packs_scope
  ON public.api_route_packs(scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_api_route_packs_managed_by
  ON public.api_route_packs(managed_by);
CREATE INDEX IF NOT EXISTS idx_api_routes_managed_by
  ON public.api_routes(managed_by);
CREATE INDEX IF NOT EXISTS idx_webhook_sources_managed_by
  ON public.webhook_sources(managed_by);
CREATE INDEX IF NOT EXISTS idx_mapping_configs_managed_by
  ON public.mapping_configs(managed_by);

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES
  ('public', 'api_route_packs', 'scope_type', 'scope_type'),
  ('public', 'api_route_packs', 'managed_by', 'integration_managed_by'),
  ('public', 'api_routes', 'managed_by', 'integration_managed_by'),
  ('public', 'webhook_sources', 'managed_by', 'integration_managed_by'),
  ('public', 'mapping_configs', 'managed_by', 'integration_managed_by')
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique DO UPDATE
SET lookup_category = EXCLUDED.lookup_category;

SELECT public.apply_lookup_column_contracts('public');

-------------------------------------------------------------------------------
-- 2) Workflow-only guardrails for Studio-managed API routes
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.integration_plugin_resolve_template_name_v1(p_workflow_binding JSONB)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_template_name TEXT := NULLIF(COALESCE(p_workflow_binding->>'template_name', ''), '');
  v_template_id UUID := NULL;
BEGIN
  IF v_template_name IS NOT NULL THEN
    RETURN v_template_name;
  END IF;

  BEGIN
    v_template_id := NULLIF(COALESCE(p_workflow_binding->>'template_id', ''), '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_template_id := NULL;
  END;

  IF v_template_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT wt.name
    INTO v_template_name
    FROM public.workflow_templates wt
   WHERE wt.id = v_template_id
     AND wt.status = 'active'
   ORDER BY wt.updated_at DESC
   LIMIT 1;

  RETURN v_template_name;
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_plugin_enforce_api_route_pack_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  NEW.managed_by := lower(COALESCE(NULLIF(NEW.managed_by, ''), 'platform'));
  NEW.scope_type := lower(COALESCE(NULLIF(NEW.scope_type, ''), 'global'));
  NEW.managed_metadata := COALESCE(NEW.managed_metadata, '{}'::jsonb);

  IF NEW.managed_by = 'integration_plugin' THEN
    IF NEW.scope_type IN ('global', 'platform') OR NEW.scope_id IS NULL THEN
      RAISE EXCEPTION 'integration_plugin route packs must be scoped (tenant/client/sender/source) with non-null scope_id';
    END IF;

    NEW.managed_metadata := NEW.managed_metadata || jsonb_build_object('managed_by', 'integration_plugin');
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_plugin_enforce_api_route_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB := COALESCE(NEW.policy, '{}'::jsonb);
  v_workflow JSONB := COALESCE(v_policy->'workflow', '{}'::jsonb);
  v_delivery JSONB := COALESCE(v_policy->'delivery', '{}'::jsonb);
  v_workflow_enabled BOOLEAN := FALSE;
  v_template_name TEXT := NULL;
  v_template_id UUID := NULL;
  v_delivery_mode TEXT := NULL;
BEGIN
  NEW.managed_by := lower(COALESCE(NULLIF(NEW.managed_by, ''), 'platform'));
  NEW.managed_metadata := COALESCE(NEW.managed_metadata, '{}'::jsonb);

  IF NEW.managed_by <> 'integration_plugin' THEN
    RETURN NEW;
  END IF;

  IF jsonb_typeof(v_policy) <> 'object' THEN
    RAISE EXCEPTION 'integration_plugin api route policy must be a JSON object';
  END IF;

  BEGIN
    v_workflow_enabled := COALESCE((v_workflow->>'enabled')::BOOLEAN, FALSE);
  EXCEPTION
    WHEN others THEN
      v_workflow_enabled := FALSE;
  END;

  IF NOT v_workflow_enabled THEN
    RAISE EXCEPTION 'integration_plugin api routes must enable policy.workflow.enabled=true';
  END IF;

  v_template_name := NULLIF(v_workflow->>'template_name', '');

  BEGIN
    v_template_id := NULLIF(v_workflow->>'template_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_template_id := NULL;
  END;

  IF v_template_name IS NULL AND v_template_id IS NOT NULL THEN
    SELECT wt.name
      INTO v_template_name
      FROM public.workflow_templates wt
     WHERE wt.id = v_template_id
       AND wt.status = 'active'
     ORDER BY wt.updated_at DESC
     LIMIT 1;

    IF v_template_name IS NOT NULL THEN
      v_workflow := jsonb_set(v_workflow, '{template_name}', to_jsonb(v_template_name), TRUE);
    END IF;
  END IF;

  IF v_template_name IS NULL THEN
    RAISE EXCEPTION 'integration_plugin api routes require workflow.template_name or resolvable workflow.template_id';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.workflow_templates wt
     WHERE wt.name = v_template_name
       AND wt.status = 'active'
     LIMIT 1
  ) THEN
    RAISE EXCEPTION 'integration_plugin api route workflow template % is missing or inactive', v_template_name;
  END IF;

  v_delivery_mode := lower(COALESCE(NULLIF(v_delivery->>'mode', ''), 'accepted_async'));
  IF v_delivery_mode = 'proxy' THEN
    RAISE EXCEPTION 'integration_plugin api routes cannot use delivery.mode=proxy';
  END IF;

  v_delivery := jsonb_set(v_delivery, '{mode}', to_jsonb(v_delivery_mode), TRUE);
  IF (v_delivery ? 'status_code') IS FALSE THEN
    v_delivery := jsonb_set(v_delivery, '{status_code}', '202'::jsonb, TRUE);
  END IF;

  v_policy := jsonb_set(v_policy, '{workflow}', v_workflow, TRUE);
  v_policy := jsonb_set(v_policy, '{delivery}', v_delivery, TRUE);
  NEW.policy := v_policy;

  NEW.managed_metadata := NEW.managed_metadata || jsonb_build_object('managed_by', 'integration_plugin');

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_api_route_packs_integration_plugin_guard ON public.api_route_packs;
CREATE TRIGGER trg_api_route_packs_integration_plugin_guard
  BEFORE INSERT OR UPDATE ON public.api_route_packs
  FOR EACH ROW
  EXECUTE FUNCTION public.integration_plugin_enforce_api_route_pack_v1();

DROP TRIGGER IF EXISTS trg_api_routes_integration_plugin_guard ON public.api_routes;
CREATE TRIGGER trg_api_routes_integration_plugin_guard
  BEFORE INSERT OR UPDATE ON public.api_routes
  FOR EACH ROW
  EXECUTE FUNCTION public.integration_plugin_enforce_api_route_v1();

-------------------------------------------------------------------------------
-- 3) Extend API route pack/route policies for tenant-safe Studio-managed writes
-------------------------------------------------------------------------------

DROP POLICY IF EXISTS api_route_packs_select ON public.api_route_packs;
DROP POLICY IF EXISTS api_route_packs_insert ON public.api_route_packs;
DROP POLICY IF EXISTS api_route_packs_update ON public.api_route_packs;
DROP POLICY IF EXISTS api_route_packs_delete ON public.api_route_packs;

CREATE POLICY api_route_packs_select
  ON public.api_route_packs
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('api_route_packs','read')
    AND (
      public.is_platform_user()
      OR EXISTS (
        SELECT 1
        FROM public.api_routes r
        WHERE r.pack_id = public.api_route_packs.id
          AND public.api_route_visible_v1(r.scope_type, r.scope_id)
      )
      OR (
        public.api_route_packs.managed_by = 'integration_plugin'
        AND public.integration_plugin_scope_belongs_org_v1(
          public.api_route_packs.scope_type,
          public.api_route_packs.scope_id,
          public.current_user_org_id()
        )
      )
    )
  );

CREATE POLICY api_route_packs_insert
  ON public.api_route_packs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('api_route_packs','write')
    AND (
      public.is_platform_user()
      OR (
        public.user_can_write()
        AND public.user_has_resource_capability_v1('integration_plugins','write')
        AND managed_by = 'integration_plugin'
        AND public.integration_plugin_scope_belongs_org_v1(scope_type, scope_id, public.current_user_org_id())
      )
    )
  );

CREATE POLICY api_route_packs_update
  ON public.api_route_packs
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('api_route_packs','write')
    AND (
      public.is_platform_user()
      OR (
        public.user_can_write()
        AND public.user_has_resource_capability_v1('integration_plugins','write')
        AND managed_by = 'integration_plugin'
        AND public.integration_plugin_scope_belongs_org_v1(scope_type, scope_id, public.current_user_org_id())
      )
    )
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('api_route_packs','write')
    AND (
      public.is_platform_user()
      OR (
        public.user_can_write()
        AND public.user_has_resource_capability_v1('integration_plugins','write')
        AND managed_by = 'integration_plugin'
        AND public.integration_plugin_scope_belongs_org_v1(scope_type, scope_id, public.current_user_org_id())
      )
    )
  );

CREATE POLICY api_route_packs_delete
  ON public.api_route_packs
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('api_route_packs','write')
    AND (
      public.is_platform_user()
      OR (
        public.user_can_write()
        AND public.user_has_resource_capability_v1('integration_plugins','write')
        AND managed_by = 'integration_plugin'
        AND public.integration_plugin_scope_belongs_org_v1(scope_type, scope_id, public.current_user_org_id())
      )
    )
  );

DROP POLICY IF EXISTS api_routes_insert ON public.api_routes;
DROP POLICY IF EXISTS api_routes_update ON public.api_routes;
DROP POLICY IF EXISTS api_routes_delete ON public.api_routes;

CREATE POLICY api_routes_insert
  ON public.api_routes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('api_routes','write')
    AND (
      public.is_platform_user()
      OR (
        public.user_can_write()
        AND public.user_has_resource_capability_v1('integration_plugins','write')
        AND managed_by = 'integration_plugin'
        AND public.integration_plugin_scope_belongs_org_v1(scope_type, scope_id, public.current_user_org_id())
        AND EXISTS (
          SELECT 1
          FROM public.api_route_packs p
          WHERE p.id = api_routes.pack_id
            AND p.managed_by = 'integration_plugin'
            AND public.integration_plugin_scope_belongs_org_v1(p.scope_type, p.scope_id, public.current_user_org_id())
        )
      )
    )
  );

CREATE POLICY api_routes_update
  ON public.api_routes
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('api_routes','write')
    AND (
      public.is_platform_user()
      OR (
        public.user_can_write()
        AND public.user_has_resource_capability_v1('integration_plugins','write')
        AND managed_by = 'integration_plugin'
        AND public.integration_plugin_scope_belongs_org_v1(scope_type, scope_id, public.current_user_org_id())
      )
    )
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('api_routes','write')
    AND (
      public.is_platform_user()
      OR (
        public.user_can_write()
        AND public.user_has_resource_capability_v1('integration_plugins','write')
        AND managed_by = 'integration_plugin'
        AND public.integration_plugin_scope_belongs_org_v1(scope_type, scope_id, public.current_user_org_id())
        AND EXISTS (
          SELECT 1
          FROM public.api_route_packs p
          WHERE p.id = api_routes.pack_id
            AND p.managed_by = 'integration_plugin'
            AND public.integration_plugin_scope_belongs_org_v1(p.scope_type, p.scope_id, public.current_user_org_id())
        )
      )
    )
  );

CREATE POLICY api_routes_delete
  ON public.api_routes
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('api_routes','write')
    AND (
      public.is_platform_user()
      OR (
        public.user_can_write()
        AND public.user_has_resource_capability_v1('integration_plugins','write')
        AND managed_by = 'integration_plugin'
        AND public.integration_plugin_scope_belongs_org_v1(scope_type, scope_id, public.current_user_org_id())
      )
    )
  );

-------------------------------------------------------------------------------
-- 4) Contracts update for modified runtime tables
-------------------------------------------------------------------------------

UPDATE public.table_contracts
   SET notes = 'API route packs support managed_by metadata + scoped plugin-managed write path (workflow-only for integration_plugin).',
       updated_at = now()
 WHERE table_schema = 'public'
   AND table_name = 'api_route_packs';

UPDATE public.table_contracts
   SET notes = 'API routes support managed_by metadata; integration_plugin routes enforce workflow-only policy contract.',
       updated_at = now()
 WHERE table_schema = 'public'
   AND table_name = 'api_routes';

UPDATE public.table_contracts
   SET notes = 'Webhook sources support managed_by metadata for plugin materialization provenance.',
       updated_at = now()
 WHERE table_schema = 'public'
   AND table_name = 'webhook_sources';

UPDATE public.table_contracts
   SET notes = 'Mapping configs support managed_by metadata for plugin materialization provenance.',
       updated_at = now()
 WHERE table_schema = 'public'
   AND table_name = 'mapping_configs';

SELECT pg_advisory_unlock(hashtext('202602220030_integration_plugin_runtime_workflow_enforcement_v1'));
COMMIT;

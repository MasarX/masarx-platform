-- Migration: UI resource RLS policies (capability-driven)
BEGIN;
SELECT pg_advisory_lock(hashtext('202601071230_ui_resource_rls_policies'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Zones and baskets
ALTER TABLE public.zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zone_districts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baskets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.basket_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.basket_transitions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.zones FROM PUBLIC;
REVOKE ALL ON TABLE public.zones FROM anon;
REVOKE ALL ON TABLE public.zones FROM authenticated;
REVOKE ALL ON TABLE public.zone_districts FROM PUBLIC;
REVOKE ALL ON TABLE public.zone_districts FROM anon;
REVOKE ALL ON TABLE public.zone_districts FROM authenticated;
REVOKE ALL ON TABLE public.baskets FROM PUBLIC;
REVOKE ALL ON TABLE public.baskets FROM anon;
REVOKE ALL ON TABLE public.baskets FROM authenticated;
REVOKE ALL ON TABLE public.basket_items FROM PUBLIC;
REVOKE ALL ON TABLE public.basket_items FROM anon;
REVOKE ALL ON TABLE public.basket_items FROM authenticated;
REVOKE ALL ON TABLE public.basket_transitions FROM PUBLIC;
REVOKE ALL ON TABLE public.basket_transitions FROM anon;
REVOKE ALL ON TABLE public.basket_transitions FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zones TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zone_districts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.baskets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.basket_items TO authenticated;
GRANT SELECT ON TABLE public.basket_transitions TO authenticated;


GRANT ALL ON TABLE public.zones TO service_role;
GRANT ALL ON TABLE public.zone_districts TO service_role;
GRANT ALL ON TABLE public.baskets TO service_role;
GRANT ALL ON TABLE public.basket_items TO service_role;
GRANT ALL ON TABLE public.basket_transitions TO service_role;

DROP POLICY IF EXISTS zones_service_policy ON public.zones;
DROP POLICY IF EXISTS zones_org_policy ON public.zones;
DROP POLICY IF EXISTS zones_select ON public.zones;
DROP POLICY IF EXISTS zones_insert ON public.zones;
DROP POLICY IF EXISTS zones_update ON public.zones;
DROP POLICY IF EXISTS zones_delete ON public.zones;

CREATE POLICY zones_service_policy
  ON public.zones
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY zones_select
  ON public.zones
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('zones','read')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY zones_insert
  ON public.zones
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('zones','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY zones_update
  ON public.zones
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('zones','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('zones','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY zones_delete
  ON public.zones
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('zones','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );
DROP POLICY IF EXISTS zone_districts_service_policy ON public.zone_districts;
DROP POLICY IF EXISTS zone_districts_org_policy ON public.zone_districts;
DROP POLICY IF EXISTS zone_districts_select ON public.zone_districts;
DROP POLICY IF EXISTS zone_districts_insert ON public.zone_districts;
DROP POLICY IF EXISTS zone_districts_update ON public.zone_districts;
DROP POLICY IF EXISTS zone_districts_delete ON public.zone_districts;

CREATE POLICY zone_districts_service_policy
  ON public.zone_districts
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY zone_districts_select
  ON public.zone_districts
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('zone_districts','read')
    AND EXISTS (
      SELECT 1
      FROM public.zones z
      WHERE z.id = public.zone_districts.zone_id
        AND (public.is_platform_user() OR z.organization_id = public.current_user_org_id())
    )
  );

CREATE POLICY zone_districts_insert
  ON public.zone_districts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('zone_districts','write')
    AND EXISTS (
      SELECT 1
      FROM public.zones z
      WHERE z.id = zone_id
        AND (public.is_platform_user() OR z.organization_id = public.current_user_org_id())
    )
  );

CREATE POLICY zone_districts_update
  ON public.zone_districts
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('zone_districts','write')
    AND EXISTS (
      SELECT 1
      FROM public.zones z
      WHERE z.id = public.zone_districts.zone_id
        AND (public.is_platform_user() OR z.organization_id = public.current_user_org_id())
    )
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('zone_districts','write')
    AND EXISTS (
      SELECT 1
      FROM public.zones z
      WHERE z.id = zone_id
        AND (public.is_platform_user() OR z.organization_id = public.current_user_org_id())
    )
  );

CREATE POLICY zone_districts_delete
  ON public.zone_districts
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('zone_districts','write')
    AND EXISTS (
      SELECT 1
      FROM public.zones z
      WHERE z.id = public.zone_districts.zone_id
        AND (public.is_platform_user() OR z.organization_id = public.current_user_org_id())
    )
  );

DROP POLICY IF EXISTS baskets_service_policy ON public.baskets;
DROP POLICY IF EXISTS baskets_org_policy ON public.baskets;
DROP POLICY IF EXISTS baskets_select ON public.baskets;
DROP POLICY IF EXISTS baskets_insert ON public.baskets;
DROP POLICY IF EXISTS baskets_update ON public.baskets;
DROP POLICY IF EXISTS baskets_delete ON public.baskets;

CREATE POLICY baskets_service_policy
  ON public.baskets
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY baskets_select
  ON public.baskets
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('baskets','read')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY baskets_insert
  ON public.baskets
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('baskets','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY baskets_update
  ON public.baskets
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('baskets','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('baskets','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY baskets_delete
  ON public.baskets
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('baskets','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

DROP POLICY IF EXISTS basket_items_service_policy ON public.basket_items;
DROP POLICY IF EXISTS basket_items_org_policy ON public.basket_items;
DROP POLICY IF EXISTS basket_items_select ON public.basket_items;
DROP POLICY IF EXISTS basket_items_insert ON public.basket_items;
DROP POLICY IF EXISTS basket_items_update ON public.basket_items;
DROP POLICY IF EXISTS basket_items_delete ON public.basket_items;

CREATE POLICY basket_items_service_policy
  ON public.basket_items
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY basket_items_select
  ON public.basket_items
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('basket_items','read')
    AND EXISTS (
      SELECT 1
      FROM public.baskets b
      WHERE b.id = public.basket_items.basket_id
        AND (public.is_platform_user() OR b.organization_id = public.current_user_org_id())
    )
  );

CREATE POLICY basket_items_insert
  ON public.basket_items
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('basket_items','write')
    AND EXISTS (
      SELECT 1
      FROM public.baskets b
      WHERE b.id = basket_id
        AND (public.is_platform_user() OR b.organization_id = public.current_user_org_id())
    )
  );

CREATE POLICY basket_items_update
  ON public.basket_items
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('basket_items','write')
    AND EXISTS (
      SELECT 1
      FROM public.baskets b
      WHERE b.id = public.basket_items.basket_id
        AND (public.is_platform_user() OR b.organization_id = public.current_user_org_id())
    )
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('basket_items','write')
    AND EXISTS (
      SELECT 1
      FROM public.baskets b
      WHERE b.id = basket_id
        AND (public.is_platform_user() OR b.organization_id = public.current_user_org_id())
    )
  );

CREATE POLICY basket_items_delete
  ON public.basket_items
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('basket_items','write')
    AND EXISTS (
      SELECT 1
      FROM public.baskets b
      WHERE b.id = public.basket_items.basket_id
        AND (public.is_platform_user() OR b.organization_id = public.current_user_org_id())
    )
  );

DROP POLICY IF EXISTS basket_transitions_service_policy ON public.basket_transitions;
DROP POLICY IF EXISTS basket_transitions_select ON public.basket_transitions;

CREATE POLICY basket_transitions_service_policy
  ON public.basket_transitions
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY basket_transitions_select
  ON public.basket_transitions
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('basket_transitions','read')
    AND EXISTS (
      SELECT 1
      FROM public.baskets b
      WHERE b.id = public.basket_transitions.basket_id
        AND (public.is_platform_user() OR b.organization_id = public.current_user_org_id())
    )
  );
-- Providers + operation templates
ALTER TABLE public.providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operation_templates ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.providers FROM PUBLIC;
REVOKE ALL ON TABLE public.providers FROM anon;
REVOKE ALL ON TABLE public.providers FROM authenticated;
REVOKE ALL ON TABLE public.operation_templates FROM PUBLIC;
REVOKE ALL ON TABLE public.operation_templates FROM anon;
REVOKE ALL ON TABLE public.operation_templates FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.providers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.operation_templates TO authenticated;


GRANT ALL ON TABLE public.providers TO service_role;
GRANT ALL ON TABLE public.operation_templates TO service_role;

DROP POLICY IF EXISTS providers_service_policy ON public.providers;
DROP POLICY IF EXISTS providers_rls_policy ON public.providers;
DROP POLICY IF EXISTS providers_select ON public.providers;
DROP POLICY IF EXISTS providers_insert ON public.providers;
DROP POLICY IF EXISTS providers_update ON public.providers;
DROP POLICY IF EXISTS providers_delete ON public.providers;

CREATE POLICY providers_service_policy
  ON public.providers
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY providers_select
  ON public.providers
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('providers','read')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY providers_insert
  ON public.providers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('providers','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY providers_update
  ON public.providers
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('providers','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('providers','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY providers_delete
  ON public.providers
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('providers','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

DROP POLICY IF EXISTS operation_templates_service_policy ON public.operation_templates;
DROP POLICY IF EXISTS operation_templates_select ON public.operation_templates;
DROP POLICY IF EXISTS operation_templates_insert ON public.operation_templates;
DROP POLICY IF EXISTS operation_templates_update ON public.operation_templates;
DROP POLICY IF EXISTS operation_templates_delete ON public.operation_templates;

CREATE POLICY operation_templates_service_policy
  ON public.operation_templates
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY operation_templates_select
  ON public.operation_templates
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('operation_templates','read')
    AND (
      public.is_platform_user()
      OR EXISTS (
        SELECT 1
        FROM public.providers p
        WHERE p.id = public.operation_templates.provider_id
          AND p.organization_id = public.current_user_org_id()
      )
    )
  );

CREATE POLICY operation_templates_insert
  ON public.operation_templates
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('operation_templates','write')
    AND (
      public.is_platform_user()
      OR EXISTS (
        SELECT 1
        FROM public.providers p
        WHERE p.id = provider_id
          AND p.organization_id = public.current_user_org_id()
      )
    )
  );

CREATE POLICY operation_templates_update
  ON public.operation_templates
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('operation_templates','write')
    AND (
      public.is_platform_user()
      OR EXISTS (
        SELECT 1
        FROM public.providers p
        WHERE p.id = public.operation_templates.provider_id
          AND p.organization_id = public.current_user_org_id()
      )
    )
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('operation_templates','write')
    AND (
      public.is_platform_user()
      OR EXISTS (
        SELECT 1
        FROM public.providers p
        WHERE p.id = provider_id
          AND p.organization_id = public.current_user_org_id()
      )
    )
  );

CREATE POLICY operation_templates_delete
  ON public.operation_templates
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('operation_templates','write')
    AND (
      public.is_platform_user()
      OR EXISTS (
        SELECT 1
        FROM public.providers p
        WHERE p.id = public.operation_templates.provider_id
          AND p.organization_id = public.current_user_org_id()
      )
    )
  );
-- Mapping configs + field mappings
ALTER TABLE public.mapping_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_mappings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.mapping_configs FROM PUBLIC;
REVOKE ALL ON TABLE public.mapping_configs FROM anon;
REVOKE ALL ON TABLE public.mapping_configs FROM authenticated;
REVOKE ALL ON TABLE public.field_mappings FROM PUBLIC;
REVOKE ALL ON TABLE public.field_mappings FROM anon;
REVOKE ALL ON TABLE public.field_mappings FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mapping_configs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.field_mappings TO authenticated;


GRANT ALL ON TABLE public.mapping_configs TO service_role;
GRANT ALL ON TABLE public.field_mappings TO service_role;

DROP POLICY IF EXISTS mapping_configs_service_policy ON public.mapping_configs;
DROP POLICY IF EXISTS mapping_configs_select ON public.mapping_configs;
DROP POLICY IF EXISTS mapping_configs_insert ON public.mapping_configs;
DROP POLICY IF EXISTS mapping_configs_update ON public.mapping_configs;
DROP POLICY IF EXISTS mapping_configs_delete ON public.mapping_configs;

CREATE POLICY mapping_configs_service_policy
  ON public.mapping_configs
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY mapping_configs_select
  ON public.mapping_configs
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('mapping_configs','read')
    AND (public.is_platform_user() OR public.current_user_scope_type() = 'tenant')
  );

CREATE POLICY mapping_configs_insert
  ON public.mapping_configs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('mapping_configs','write')
    AND public.user_can_write()
  );

CREATE POLICY mapping_configs_update
  ON public.mapping_configs
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('mapping_configs','write')
    AND public.user_can_write()
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('mapping_configs','write')
    AND public.user_can_write()
  );

CREATE POLICY mapping_configs_delete
  ON public.mapping_configs
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('mapping_configs','write')
    AND public.user_can_write()
  );

DROP POLICY IF EXISTS field_mappings_service_policy ON public.field_mappings;
DROP POLICY IF EXISTS field_mappings_select ON public.field_mappings;
DROP POLICY IF EXISTS field_mappings_insert ON public.field_mappings;
DROP POLICY IF EXISTS field_mappings_update ON public.field_mappings;
DROP POLICY IF EXISTS field_mappings_delete ON public.field_mappings;

CREATE POLICY field_mappings_service_policy
  ON public.field_mappings
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY field_mappings_select
  ON public.field_mappings
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('field_mappings','read')
    AND (public.is_platform_user() OR public.current_user_scope_type() = 'tenant')
  );

CREATE POLICY field_mappings_insert
  ON public.field_mappings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('field_mappings','write')
    AND public.user_can_write()
  );

CREATE POLICY field_mappings_update
  ON public.field_mappings
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('field_mappings','write')
    AND public.user_can_write()
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('field_mappings','write')
    AND public.user_can_write()
  );

CREATE POLICY field_mappings_delete
  ON public.field_mappings
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('field_mappings','write')
    AND public.user_can_write()
  );
-- Webhook resources
ALTER TABLE public.webhook_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_inbox ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.webhook_sources FROM PUBLIC;
REVOKE ALL ON TABLE public.webhook_sources FROM anon;
REVOKE ALL ON TABLE public.webhook_sources FROM authenticated;
REVOKE ALL ON TABLE public.webhook_inbox FROM PUBLIC;
REVOKE ALL ON TABLE public.webhook_inbox FROM anon;
REVOKE ALL ON TABLE public.webhook_inbox FROM authenticated;
REVOKE ALL ON TABLE public.webhook_response_events FROM PUBLIC;
REVOKE ALL ON TABLE public.webhook_response_events FROM anon;
REVOKE ALL ON TABLE public.webhook_response_events FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.webhook_sources TO authenticated;
GRANT SELECT ON TABLE public.webhook_inbox TO authenticated;
GRANT SELECT ON TABLE public.webhook_response_events TO authenticated;


GRANT ALL ON TABLE public.webhook_sources TO service_role;
GRANT ALL ON TABLE public.webhook_inbox TO service_role;
GRANT ALL ON TABLE public.webhook_response_events TO service_role;

DROP POLICY IF EXISTS webhook_sources_service_policy ON public.webhook_sources;
DROP POLICY IF EXISTS webhook_sources_rls_policy ON public.webhook_sources;
DROP POLICY IF EXISTS webhook_sources_select ON public.webhook_sources;
DROP POLICY IF EXISTS webhook_sources_insert ON public.webhook_sources;
DROP POLICY IF EXISTS webhook_sources_update ON public.webhook_sources;
DROP POLICY IF EXISTS webhook_sources_delete ON public.webhook_sources;

CREATE POLICY webhook_sources_service_policy
  ON public.webhook_sources
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY webhook_sources_select
  ON public.webhook_sources
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('webhook_sources','read')
    AND (
      public.is_platform_user()
      OR (
        public.current_user_scope_type() = 'tenant'
        AND organization_id = public.current_user_org_id()
      )
      OR (
        public.current_user_scope_type() = 'client'
        AND EXISTS (
          SELECT 1
          FROM public.senders s
          WHERE s.id = public.webhook_sources.sender_id
            AND s.client_id = public.current_user_scope_id()
        )
      )
      OR (
        public.current_user_scope_type() = 'sender'
        AND sender_id = public.current_user_scope_id()
      )
    )
  );

CREATE POLICY webhook_sources_insert
  ON public.webhook_sources
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('webhook_sources','write')
    AND (
      public.is_platform_user()
      OR (
        public.current_user_scope_type() = 'tenant'
        AND organization_id = public.current_user_org_id()
      )
      OR (
        public.current_user_scope_type() = 'client'
        AND EXISTS (
          SELECT 1
          FROM public.senders s
          WHERE s.id = sender_id
            AND s.client_id = public.current_user_scope_id()
        )
      )
      OR (
        public.current_user_scope_type() = 'sender'
        AND sender_id = public.current_user_scope_id()
      )
    )
  );

CREATE POLICY webhook_sources_update
  ON public.webhook_sources
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('webhook_sources','write')
    AND (
      public.is_platform_user()
      OR (
        public.current_user_scope_type() = 'tenant'
        AND organization_id = public.current_user_org_id()
      )
      OR (
        public.current_user_scope_type() = 'client'
        AND EXISTS (
          SELECT 1
          FROM public.senders s
          WHERE s.id = public.webhook_sources.sender_id
            AND s.client_id = public.current_user_scope_id()
        )
      )
      OR (
        public.current_user_scope_type() = 'sender'
        AND sender_id = public.current_user_scope_id()
      )
    )
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('webhook_sources','write')
    AND (
      public.is_platform_user()
      OR (
        public.current_user_scope_type() = 'tenant'
        AND organization_id = public.current_user_org_id()
      )
      OR (
        public.current_user_scope_type() = 'client'
        AND EXISTS (
          SELECT 1
          FROM public.senders s
          WHERE s.id = sender_id
            AND s.client_id = public.current_user_scope_id()
        )
      )
      OR (
        public.current_user_scope_type() = 'sender'
        AND sender_id = public.current_user_scope_id()
      )
    )
  );

CREATE POLICY webhook_sources_delete
  ON public.webhook_sources
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('webhook_sources','write')
    AND (
      public.is_platform_user()
      OR (
        public.current_user_scope_type() = 'tenant'
        AND organization_id = public.current_user_org_id()
      )
      OR (
        public.current_user_scope_type() = 'client'
        AND EXISTS (
          SELECT 1
          FROM public.senders s
          WHERE s.id = public.webhook_sources.sender_id
            AND s.client_id = public.current_user_scope_id()
        )
      )
      OR (
        public.current_user_scope_type() = 'sender'
        AND sender_id = public.current_user_scope_id()
      )
    )
  );
DROP POLICY IF EXISTS webhook_inbox_service_policy ON public.webhook_inbox;
DROP POLICY IF EXISTS webhook_inbox_select ON public.webhook_inbox;

CREATE POLICY webhook_inbox_service_policy
  ON public.webhook_inbox
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY webhook_inbox_select
  ON public.webhook_inbox
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('webhook_inbox','read')
    AND EXISTS (
      SELECT 1
      FROM public.webhook_sources ws
      WHERE ws.id = public.webhook_inbox.webhook_source_id
        AND (
          public.is_platform_user()
          OR (
            public.current_user_scope_type() = 'tenant'
            AND ws.organization_id = public.current_user_org_id()
          )
          OR (
            public.current_user_scope_type() = 'client'
            AND EXISTS (
              SELECT 1
              FROM public.senders s
              WHERE s.id = ws.sender_id
                AND s.client_id = public.current_user_scope_id()
            )
          )
          OR (
            public.current_user_scope_type() = 'sender'
            AND ws.sender_id = public.current_user_scope_id()
          )
        )
    )
  );

-- Logs (webhook_log + api_call_log)
ALTER TABLE public.webhook_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_call_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.webhook_log FROM PUBLIC;
REVOKE ALL ON TABLE public.webhook_log FROM anon;
REVOKE ALL ON TABLE public.webhook_log FROM authenticated;
REVOKE ALL ON TABLE public.api_call_log FROM PUBLIC;
REVOKE ALL ON TABLE public.api_call_log FROM anon;
REVOKE ALL ON TABLE public.api_call_log FROM authenticated;
GRANT SELECT ON TABLE public.webhook_log TO authenticated;
GRANT SELECT ON TABLE public.api_call_log TO authenticated;


GRANT ALL ON TABLE public.webhook_log TO service_role;
GRANT ALL ON TABLE public.api_call_log TO service_role;

DROP POLICY IF EXISTS webhook_log_service_policy ON public.webhook_log;
DROP POLICY IF EXISTS webhook_log_select ON public.webhook_log;

CREATE POLICY webhook_log_service_policy
  ON public.webhook_log
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY webhook_log_select
  ON public.webhook_log
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('webhook_log','read')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

DROP POLICY IF EXISTS api_call_log_service_policy ON public.api_call_log;
DROP POLICY IF EXISTS api_call_log_select ON public.api_call_log;

CREATE POLICY api_call_log_service_policy
  ON public.api_call_log
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY api_call_log_select
  ON public.api_call_log
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('api_call_log','read')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

-- API routes scope helper
CREATE OR REPLACE FUNCTION public.api_route_visible_v1(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_scope TEXT := lower(COALESCE(NULLIF(p_scope_type, ''), 'global'));
  v_user_scope TEXT := public.current_user_scope_type();
  v_org_id UUID := public.current_user_org_id();
  v_client_id UUID := public.current_user_client_id();
  v_sender_id UUID := public.current_user_sender_id();
BEGIN
  IF public.is_platform_user() THEN
    RETURN TRUE;
  END IF;

  IF v_scope = 'global' THEN
    RETURN p_scope_id IS NULL;
  END IF;

  IF v_user_scope = 'tenant' THEN
    IF v_scope = 'tenant' THEN
      RETURN p_scope_id = v_org_id;
    ELSIF v_scope = 'client' THEN
      RETURN EXISTS (
        SELECT 1
        FROM public.clients c
        WHERE c.id = p_scope_id
          AND c.organization_id = v_org_id
      );
    ELSIF v_scope = 'sender' THEN
      RETURN EXISTS (
        SELECT 1
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
        WHERE s.id = p_scope_id
          AND c.organization_id = v_org_id
      );
    ELSIF v_scope = 'source' THEN
      RETURN EXISTS (
        SELECT 1
        FROM public.webhook_sources ws
        WHERE ws.id = p_scope_id
          AND ws.organization_id = v_org_id
      );
    END IF;
  ELSIF v_user_scope = 'client' THEN
    IF v_scope = 'tenant' THEN
      RETURN p_scope_id = v_org_id;
    ELSIF v_scope = 'client' THEN
      RETURN p_scope_id = v_client_id;
    ELSIF v_scope = 'sender' THEN
      RETURN EXISTS (
        SELECT 1
        FROM public.senders s
        WHERE s.id = p_scope_id
          AND s.client_id = v_client_id
      );
    ELSIF v_scope = 'source' THEN
      RETURN EXISTS (
        SELECT 1
        FROM public.webhook_sources ws
        JOIN public.senders s ON s.id = ws.sender_id
        WHERE ws.id = p_scope_id
          AND s.client_id = v_client_id
      );
    END IF;
  ELSIF v_user_scope = 'sender' THEN
    IF v_scope = 'tenant' THEN
      RETURN p_scope_id = v_org_id;
    ELSIF v_scope = 'client' THEN
      RETURN p_scope_id = v_client_id;
    ELSIF v_scope = 'sender' THEN
      RETURN p_scope_id = v_sender_id;
    ELSIF v_scope = 'source' THEN
      RETURN EXISTS (
        SELECT 1
        FROM public.webhook_sources ws
        WHERE ws.id = p_scope_id
          AND ws.sender_id = v_sender_id
      );
    END IF;
  END IF;

  RETURN FALSE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.api_route_visible_v1(TEXT, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.api_route_visible_v1(TEXT, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.api_route_visible_v1(TEXT, UUID) TO authenticated, service_role;
-- API routes + packs
ALTER TABLE public.api_route_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_routes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.api_route_packs FROM PUBLIC;
REVOKE ALL ON TABLE public.api_route_packs FROM anon;
REVOKE ALL ON TABLE public.api_route_packs FROM authenticated;
REVOKE ALL ON TABLE public.api_routes FROM PUBLIC;
REVOKE ALL ON TABLE public.api_routes FROM anon;
REVOKE ALL ON TABLE public.api_routes FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_route_packs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_routes TO authenticated;


GRANT ALL ON TABLE public.api_route_packs TO service_role;
GRANT ALL ON TABLE public.api_routes TO service_role;

DROP POLICY IF EXISTS api_route_packs_service_policy ON public.api_route_packs;
DROP POLICY IF EXISTS api_route_packs_select ON public.api_route_packs;
DROP POLICY IF EXISTS api_route_packs_insert ON public.api_route_packs;
DROP POLICY IF EXISTS api_route_packs_update ON public.api_route_packs;
DROP POLICY IF EXISTS api_route_packs_delete ON public.api_route_packs;

CREATE POLICY api_route_packs_service_policy
  ON public.api_route_packs
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

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
    )
  );

CREATE POLICY api_route_packs_insert
  ON public.api_route_packs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('api_route_packs','write')
    AND public.is_platform_user()
  );

CREATE POLICY api_route_packs_update
  ON public.api_route_packs
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('api_route_packs','write')
    AND public.is_platform_user()
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('api_route_packs','write')
    AND public.is_platform_user()
  );

CREATE POLICY api_route_packs_delete
  ON public.api_route_packs
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('api_route_packs','write')
    AND public.is_platform_user()
  );

DROP POLICY IF EXISTS api_routes_service_policy ON public.api_routes;
DROP POLICY IF EXISTS api_routes_select ON public.api_routes;
DROP POLICY IF EXISTS api_routes_insert ON public.api_routes;
DROP POLICY IF EXISTS api_routes_update ON public.api_routes;
DROP POLICY IF EXISTS api_routes_delete ON public.api_routes;

CREATE POLICY api_routes_service_policy
  ON public.api_routes
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY api_routes_select
  ON public.api_routes
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('api_routes','read')
    AND public.api_route_visible_v1(scope_type, scope_id)
  );

CREATE POLICY api_routes_insert
  ON public.api_routes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('api_routes','write')
    AND public.is_platform_user()
  );

CREATE POLICY api_routes_update
  ON public.api_routes
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('api_routes','write')
    AND public.is_platform_user()
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('api_routes','write')
    AND public.is_platform_user()
  );

CREATE POLICY api_routes_delete
  ON public.api_routes
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('api_routes','write')
    AND public.is_platform_user()
  );
-- Lookups
ALTER TABLE public.lookup_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lookup_values ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.lookup_definitions FROM PUBLIC;
REVOKE ALL ON TABLE public.lookup_definitions FROM anon;
REVOKE ALL ON TABLE public.lookup_definitions FROM authenticated;
REVOKE ALL ON TABLE public.lookup_values FROM PUBLIC;
REVOKE ALL ON TABLE public.lookup_values FROM anon;
REVOKE ALL ON TABLE public.lookup_values FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.lookup_definitions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.lookup_values TO authenticated;


GRANT ALL ON TABLE public.lookup_definitions TO service_role;
GRANT ALL ON TABLE public.lookup_values TO service_role;

DROP POLICY IF EXISTS lookup_definitions_service_policy ON public.lookup_definitions;
DROP POLICY IF EXISTS lookup_definitions_select ON public.lookup_definitions;
DROP POLICY IF EXISTS lookup_definitions_insert ON public.lookup_definitions;
DROP POLICY IF EXISTS lookup_definitions_update ON public.lookup_definitions;
DROP POLICY IF EXISTS lookup_definitions_delete ON public.lookup_definitions;

CREATE POLICY lookup_definitions_service_policy
  ON public.lookup_definitions
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY lookup_definitions_select
  ON public.lookup_definitions
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('lookup_definitions','read')
  );

CREATE POLICY lookup_definitions_insert
  ON public.lookup_definitions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('lookup_definitions','write')
    AND public.user_can_write()
  );

CREATE POLICY lookup_definitions_update
  ON public.lookup_definitions
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('lookup_definitions','write')
    AND public.user_can_write()
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('lookup_definitions','write')
    AND public.user_can_write()
  );

CREATE POLICY lookup_definitions_delete
  ON public.lookup_definitions
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('lookup_definitions','write')
    AND public.user_can_write()
  );

DROP POLICY IF EXISTS lookup_values_service_policy ON public.lookup_values;
DROP POLICY IF EXISTS lookup_values_select ON public.lookup_values;
DROP POLICY IF EXISTS lookup_values_insert ON public.lookup_values;
DROP POLICY IF EXISTS lookup_values_update ON public.lookup_values;
DROP POLICY IF EXISTS lookup_values_delete ON public.lookup_values;

CREATE POLICY lookup_values_service_policy
  ON public.lookup_values
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY lookup_values_select
  ON public.lookup_values
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('lookup_values','read')
  );

CREATE POLICY lookup_values_insert
  ON public.lookup_values
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('lookup_values','write')
    AND public.user_can_write()
  );

CREATE POLICY lookup_values_update
  ON public.lookup_values
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('lookup_values','write')
    AND public.user_can_write()
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('lookup_values','write')
    AND public.user_can_write()
  );

CREATE POLICY lookup_values_delete
  ON public.lookup_values
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('lookup_values','write')
    AND public.user_can_write()
  );
-- Label design
ALTER TABLE public.label_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.label_sections_p0 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.label_design_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.label_design_tokens_p0 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.label_template_validation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.label_template_validation_p0 ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.label_sections FROM PUBLIC;
REVOKE ALL ON TABLE public.label_sections FROM anon;
REVOKE ALL ON TABLE public.label_sections FROM authenticated;
REVOKE ALL ON TABLE public.label_sections_p0 FROM PUBLIC;
REVOKE ALL ON TABLE public.label_sections_p0 FROM anon;
REVOKE ALL ON TABLE public.label_sections_p0 FROM authenticated;
REVOKE ALL ON TABLE public.label_design_tokens FROM PUBLIC;
REVOKE ALL ON TABLE public.label_design_tokens FROM anon;
REVOKE ALL ON TABLE public.label_design_tokens FROM authenticated;
REVOKE ALL ON TABLE public.label_design_tokens_p0 FROM PUBLIC;
REVOKE ALL ON TABLE public.label_design_tokens_p0 FROM anon;
REVOKE ALL ON TABLE public.label_design_tokens_p0 FROM authenticated;
REVOKE ALL ON TABLE public.label_template_validation FROM PUBLIC;
REVOKE ALL ON TABLE public.label_template_validation FROM anon;
REVOKE ALL ON TABLE public.label_template_validation FROM authenticated;
REVOKE ALL ON TABLE public.label_template_validation_p0 FROM PUBLIC;
REVOKE ALL ON TABLE public.label_template_validation_p0 FROM anon;
REVOKE ALL ON TABLE public.label_template_validation_p0 FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.label_sections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.label_sections_p0 TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.label_design_tokens TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.label_design_tokens_p0 TO authenticated;
GRANT SELECT ON TABLE public.label_template_validation TO authenticated;
GRANT SELECT ON TABLE public.label_template_validation_p0 TO authenticated;


GRANT ALL ON TABLE public.label_sections TO service_role;
GRANT ALL ON TABLE public.label_sections_p0 TO service_role;
GRANT ALL ON TABLE public.label_design_tokens TO service_role;
GRANT ALL ON TABLE public.label_design_tokens_p0 TO service_role;
GRANT ALL ON TABLE public.label_template_validation TO service_role;
GRANT ALL ON TABLE public.label_template_validation_p0 TO service_role;

DROP POLICY IF EXISTS label_sections_service_all ON public.label_sections;
DROP POLICY IF EXISTS label_sections_p0_service_all ON public.label_sections_p0;
DROP POLICY IF EXISTS label_sections_select ON public.label_sections;
DROP POLICY IF EXISTS label_sections_insert ON public.label_sections;
DROP POLICY IF EXISTS label_sections_update ON public.label_sections;
DROP POLICY IF EXISTS label_sections_delete ON public.label_sections;
DROP POLICY IF EXISTS label_sections_p0_select ON public.label_sections_p0;
DROP POLICY IF EXISTS label_sections_p0_insert ON public.label_sections_p0;
DROP POLICY IF EXISTS label_sections_p0_update ON public.label_sections_p0;
DROP POLICY IF EXISTS label_sections_p0_delete ON public.label_sections_p0;

CREATE POLICY label_sections_service_all
  ON public.label_sections
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY label_sections_p0_service_all
  ON public.label_sections_p0
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY label_sections_select
  ON public.label_sections
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('label_sections','read')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY label_sections_insert
  ON public.label_sections
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('label_sections','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY label_sections_update
  ON public.label_sections
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('label_sections','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('label_sections','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY label_sections_delete
  ON public.label_sections
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('label_sections','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY label_sections_p0_select
  ON public.label_sections_p0
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('label_sections','read')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY label_sections_p0_insert
  ON public.label_sections_p0
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('label_sections','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY label_sections_p0_update
  ON public.label_sections_p0
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('label_sections','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('label_sections','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY label_sections_p0_delete
  ON public.label_sections_p0
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('label_sections','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

DROP POLICY IF EXISTS label_design_tokens_service_all ON public.label_design_tokens;
DROP POLICY IF EXISTS label_design_tokens_p0_service_all ON public.label_design_tokens_p0;
DROP POLICY IF EXISTS label_design_tokens_select ON public.label_design_tokens;
DROP POLICY IF EXISTS label_design_tokens_insert ON public.label_design_tokens;
DROP POLICY IF EXISTS label_design_tokens_update ON public.label_design_tokens;
DROP POLICY IF EXISTS label_design_tokens_delete ON public.label_design_tokens;
DROP POLICY IF EXISTS label_design_tokens_p0_select ON public.label_design_tokens_p0;
DROP POLICY IF EXISTS label_design_tokens_p0_insert ON public.label_design_tokens_p0;
DROP POLICY IF EXISTS label_design_tokens_p0_update ON public.label_design_tokens_p0;
DROP POLICY IF EXISTS label_design_tokens_p0_delete ON public.label_design_tokens_p0;

CREATE POLICY label_design_tokens_service_all
  ON public.label_design_tokens
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY label_design_tokens_p0_service_all
  ON public.label_design_tokens_p0
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY label_design_tokens_select
  ON public.label_design_tokens
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('label_design_tokens','read')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY label_design_tokens_insert
  ON public.label_design_tokens
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('label_design_tokens','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY label_design_tokens_update
  ON public.label_design_tokens
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('label_design_tokens','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('label_design_tokens','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY label_design_tokens_delete
  ON public.label_design_tokens
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('label_design_tokens','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY label_design_tokens_p0_select
  ON public.label_design_tokens_p0
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('label_design_tokens','read')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY label_design_tokens_p0_insert
  ON public.label_design_tokens_p0
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_resource_capability_v1('label_design_tokens','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY label_design_tokens_p0_update
  ON public.label_design_tokens_p0
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('label_design_tokens','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  )
  WITH CHECK (
    public.user_has_resource_capability_v1('label_design_tokens','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY label_design_tokens_p0_delete
  ON public.label_design_tokens_p0
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('label_design_tokens','write')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

DROP POLICY IF EXISTS label_template_validation_service_all ON public.label_template_validation;
DROP POLICY IF EXISTS label_template_validation_p0_service_all ON public.label_template_validation_p0;
DROP POLICY IF EXISTS label_template_validation_select ON public.label_template_validation;
DROP POLICY IF EXISTS label_template_validation_p0_select ON public.label_template_validation_p0;

CREATE POLICY label_template_validation_service_all
  ON public.label_template_validation
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY label_template_validation_p0_service_all
  ON public.label_template_validation_p0
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE POLICY label_template_validation_select
  ON public.label_template_validation
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('label_template_validation','read')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

CREATE POLICY label_template_validation_p0_select
  ON public.label_template_validation_p0
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('label_template_validation','read')
    AND (public.is_platform_user() OR organization_id = public.current_user_org_id())
  );

SELECT pg_advisory_unlock(hashtext('202601071230_ui_resource_rls_policies'));
COMMIT;

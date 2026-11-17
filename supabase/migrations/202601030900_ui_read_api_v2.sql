-- Migration: UI read API v2 (navigation + registry scaffolding)
-- Plan: PLAN-202601-ui-read-api-v2 / Step: S04
BEGIN;

SELECT pg_advisory_lock(hashtext('202601030900_ui_read_api_v2'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) Settings categories (SSOT)
-- ---------------------------------------------------------------------------
INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES
  ('ui_navigation', 'UI navigation registry (capability gated)', true, true, false, 'hard_fail',
    '["global","tenant","client","sender"]'::jsonb),
  ('ui_read_registry', 'UI read registry (resource definitions)', true, true, false, 'hard_fail',
    '["global","tenant","client","sender"]'::jsonb),
  ('ui_command_registry', 'UI command registry (request actions)', true, true, false, 'hard_fail',
    '["global","tenant","client","sender"]'::jsonb)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes,
    updated_at = now();

-- ---------------------------------------------------------------------------
-- 2) Schema registry (navigation + registry)
-- ---------------------------------------------------------------------------
WITH nav_schema AS (
  SELECT
    'ui_navigation'::text AS category,
    1 AS version,
    '{
      "$schema":"http://json-schema.org/draft-07/schema#",
      "type":"object",
      "properties":{
        "apps":{
          "type":"object",
          "additionalProperties":{
            "type":"object",
            "properties":{
              "sections":{
                "type":"array",
                "items":{
                  "type":"object",
                  "properties":{
                    "id":{"type":"string"},
                    "label":{"type":"string"},
                    "items":{
                      "type":"array",
                      "items":{
                        "type":"object",
                        "properties":{
                          "id":{"type":"string"},
                          "label":{"type":"string"},
                          "href":{"type":"string"},
                          "badge":{"type":"string"},
                          "icon":{"type":"string"},
                          "resource":{"type":"string"},
                          "capability":{"type":"string"},
                          "items":{"type":"array"}
                        },
                        "required":["id","label"]
                      }
                    }
                  },
                  "required":["id","label","items"]
                }
              }
            },
            "required":["sections"]
          }
        }
      },
      "required":["apps"]
    }'::jsonb AS schema,
    'UI navigation registry (v1)'::text AS description
),
read_schema AS (
  SELECT
    'ui_read_registry'::text AS category,
    1 AS version,
    '{
      "$schema":"http://json-schema.org/draft-07/schema#",
      "type":"object",
      "properties":{
        "resources":{
          "type":"array",
          "items":{
            "type":"object",
            "properties":{
              "key":{"type":"string"},
              "label":{"type":"string"},
              "relation":{"type":"string"},
              "id_column":{"type":"string"},
              "scope_columns":{"type":"object","additionalProperties":{"type":"string"}},
              "capability_read":{"type":"string"},
              "select":{"type":"array","items":{"type":"string"}},
              "filters":{
                "type":"array",
                "items":{
                  "type":"object",
                  "properties":{
                    "key":{"type":"string"},
                    "column":{"type":"string"},
                    "op":{"type":"string","enum":["eq","ne","gt","gte","lt","lte","ilike"]}
                  },
                  "required":["key","column"]
                }
              },
              "default_sort":{
                "type":"object",
                "properties":{
                  "column":{"type":"string"},
                  "direction":{"type":"string","enum":["asc","desc"]}
                }
              }
            },
            "required":["key","relation","id_column","capability_read"]
          }
        }
      },
      "required":["resources"]
    }'::jsonb AS schema,
    'UI read registry (v1)'::text AS description
),
command_schema AS (
  SELECT
    'ui_command_registry'::text AS category,
    1 AS version,
    '{
      "$schema":"http://json-schema.org/draft-07/schema#",
      "type":"object",
      "properties":{
        "commands":{
          "type":"array",
          "items":{
            "type":"object",
            "properties":{
              "key":{"type":"string"},
              "label":{"type":"string"},
              "description":{"type":"string"},
              "capability":{"type":"string"},
              "schema_category":{"type":"string"},
              "workflow_key":{"type":"string"}
            },
            "required":["key","label","capability"]
          }
        }
      },
      "required":["commands"]
    }'::jsonb AS schema,
    'UI command registry (v1)'::text AS description
)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
SELECT category, version, schema, description, NULL::jsonb, true FROM nav_schema
UNION ALL
SELECT category, version, schema, description, NULL::jsonb, true FROM read_schema
UNION ALL
SELECT category, version, schema, description, NULL::jsonb, true FROM command_schema
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    is_active = true;

-- ---------------------------------------------------------------------------
-- 3) Seed global defaults for navigation + registries
-- ---------------------------------------------------------------------------
WITH nav_default AS (
  SELECT '{
    "apps": {
      "console": {
        "sections": [
          {
            "id": "home",
            "label": "Home",
            "items": [
              { "id": "console-home", "label": "Overview", "href": "/console" }
            ]
          },
          {
            "id": "workflows",
            "label": "Workflows",
            "items": [
              {
                "id": "manual-review",
                "label": "Manual review queue",
                "href": "/console/resources/manual_review_tasks",
                "resource": "manual_review_tasks",
                "capability": "manual_review.read"
              },
              {
                "id": "workflow-runs",
                "label": "Workflow runs",
                "href": "/console/resources/workflow_runs",
                "resource": "workflow_runs",
                "capability": "workflow_runs.read"
              }
            ]
          },
          {
            "id": "operations",
            "label": "Operations",
            "items": [
              {
                "id": "shipments",
                "label": "Shipments",
                "href": "/console/resources/shipments",
                "resource": "shipments",
                "capability": "shipments.read"
              },
              {
                "id": "labels",
                "label": "Labels",
                "href": "/console/resources/labels",
                "resource": "labels",
                "capability": "labels.read"
              },
              {
                "id": "label-jobs",
                "label": "Label jobs",
                "href": "/console/resources/label_jobs",
                "resource": "label_jobs",
                "capability": "labels.read"
              }
            ]
          },
          {
            "id": "configuration",
            "label": "Configuration",
            "items": [
              {
                "id": "organizations",
                "label": "Organizations",
                "href": "/console/resources/organizations",
                "resource": "organizations",
                "capability": "organizations.read"
              },
              {
                "id": "clients",
                "label": "Clients",
                "href": "/console/resources/clients",
                "resource": "clients",
                "capability": "clients.read"
              },
              {
                "id": "senders",
                "label": "Senders",
                "href": "/console/resources/senders",
                "resource": "senders",
                "capability": "senders.read"
              }
            ]
          }
        ]
      },
      "portal": {
        "sections": [
          {
            "id": "home",
            "label": "Home",
            "items": [
              { "id": "portal-home", "label": "Overview", "href": "/portal" }
            ]
          },
          {
            "id": "shipments",
            "label": "Shipments",
            "items": [
              {
                "id": "portal-shipments",
                "label": "Shipments",
                "href": "/portal/resources/shipments",
                "resource": "shipments",
                "capability": "shipments.read"
              },
              {
                "id": "portal-labels",
                "label": "Labels",
                "href": "/portal/resources/labels",
                "resource": "labels",
                "capability": "labels.download"
              }
            ]
          },
          {
            "id": "help",
            "label": "Help",
            "items": [
              { "id": "portal-help", "label": "Support", "href": "/portal/help" }
            ]
          }
        ]
      }
    }
  }'::jsonb AS body
),
nav_inserted AS (
  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at
  )
  SELECT
    'ui_navigation',
    'global',
    NULL::uuid,
    1,
    nav_default.body,
    1,
    'seed ui_navigation defaults',
    now()
  FROM nav_default
  WHERE NOT EXISTS (
    SELECT 1 FROM public.settings_versions sv
    WHERE sv.category = 'ui_navigation'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (
  category,
  scope_type,
  scope_id,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  'ui_navigation',
  'global',
  NULL::uuid,
  nav_inserted.id,
  nav_inserted.value,
  now()
FROM nav_inserted
WHERE NOT EXISTS (
  SELECT 1 FROM public.settings s
  WHERE s.category = 'ui_navigation'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
);

WITH read_default AS (
  SELECT '{
    "resources": [
      {
        "key": "shipments",
        "label": "Shipments",
        "relation": "public.shipments",
        "id_column": "id",
        "scope_columns": {
          "tenant": "organization_id",
          "client": "client_id",
          "sender": "sender_id"
        },
        "capability_read": "shipments.read",
        "select": ["id","tracking_number","status","created_at","client_id","sender_id","organization_id"],
        "filters": [
          { "key": "status", "column": "status", "op": "eq" },
          { "key": "tracking_number", "column": "tracking_number", "op": "ilike" },
          { "key": "client_id", "column": "client_id", "op": "eq" },
          { "key": "sender_id", "column": "sender_id", "op": "eq" }
        ],
        "default_sort": { "column": "created_at", "direction": "desc" }
      },
      {
        "key": "labels",
        "label": "Labels",
        "relation": "public.labels",
        "id_column": "id",
        "capability_read": "labels.read",
        "select": ["id","shipment_id","label_type","barcode","file_url","generated_at","print_count"],
        "filters": [
          { "key": "shipment_id", "column": "shipment_id", "op": "eq" },
          { "key": "label_type", "column": "label_type", "op": "eq" },
          { "key": "barcode", "column": "barcode", "op": "ilike" }
        ],
        "default_sort": { "column": "generated_at", "direction": "desc" }
      },
      {
        "key": "label_jobs",
        "label": "Label jobs",
        "relation": "public.label_jobs",
        "id_column": "id",
        "scope_columns": {
          "tenant": "organization_id",
          "client": "client_id"
        },
        "capability_read": "labels.read",
        "select": ["id","shipment_id","label_id","label_type","status","job_purpose","attempts","scheduled_at","output_file_url","created_at"],
        "filters": [
          { "key": "status", "column": "status", "op": "eq" },
          { "key": "shipment_id", "column": "shipment_id", "op": "eq" }
        ],
        "default_sort": { "column": "created_at", "direction": "desc" }
      },
      {
        "key": "manual_review_tasks",
        "label": "Manual review tasks",
        "relation": "public.manual_review_tasks",
        "id_column": "id",
        "scope_columns": {
          "tenant": "organization_id",
          "client": "client_id",
          "sender": "sender_id"
        },
        "capability_read": "manual_review.read",
        "select": ["id","task_type","status","reason","queue_assignment","sla_due_at","assigned_to","shipment_id","created_at"],
        "filters": [
          { "key": "status", "column": "status", "op": "eq" },
          { "key": "task_type", "column": "task_type", "op": "eq" }
        ],
        "default_sort": { "column": "created_at", "direction": "desc" }
      },
      {
        "key": "workflow_runs",
        "label": "Workflow runs",
        "relation": "public.workflow_runs",
        "id_column": "id",
        "capability_read": "workflow_runs.read",
        "select": ["id","workflow_template_id","workflow_template_version","workflow_status","entry_point","created_at","started_at","completed_at"],
        "filters": [
          { "key": "workflow_status", "column": "workflow_status", "op": "eq" },
          { "key": "entry_point", "column": "entry_point", "op": "eq" }
        ],
        "default_sort": { "column": "created_at", "direction": "desc" }
      },
      {
        "key": "organizations",
        "label": "Organizations",
        "relation": "public.organizations",
        "id_column": "id",
        "capability_read": "organizations.read",
        "select": ["id","name","slug","timezone","locale","billing_status","created_at"],
        "filters": [
          { "key": "slug", "column": "slug", "op": "ilike" },
          { "key": "billing_status", "column": "billing_status", "op": "eq" }
        ],
        "default_sort": { "column": "created_at", "direction": "desc" }
      },
      {
        "key": "clients",
        "label": "Clients",
        "relation": "public.clients",
        "id_column": "id",
        "scope_columns": {
          "tenant": "organization_id"
        },
        "capability_read": "clients.read",
        "select": ["id","organization_id","name","slug","status","account_manager_id","created_at"],
        "filters": [
          { "key": "status", "column": "status", "op": "eq" },
          { "key": "slug", "column": "slug", "op": "ilike" }
        ],
        "default_sort": { "column": "created_at", "direction": "desc" }
      },
      {
        "key": "senders",
        "label": "Senders",
        "relation": "public.senders",
        "id_column": "id",
        "scope_columns": {
          "client": "client_id"
        },
        "capability_read": "senders.read",
        "select": ["id","client_id","name","brand_name","status","auto_provisioned","created_at"],
        "filters": [
          { "key": "status", "column": "status", "op": "eq" },
          { "key": "client_id", "column": "client_id", "op": "eq" }
        ],
        "default_sort": { "column": "created_at", "direction": "desc" }
      }
    ]
  }'::jsonb AS body
),
read_inserted AS (
  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at
  )
  SELECT
    'ui_read_registry',
    'global',
    NULL::uuid,
    1,
    read_default.body,
    1,
    'seed ui_read_registry defaults',
    now()
  FROM read_default
  WHERE NOT EXISTS (
    SELECT 1 FROM public.settings_versions sv
    WHERE sv.category = 'ui_read_registry'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (
  category,
  scope_type,
  scope_id,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  'ui_read_registry',
  'global',
  NULL::uuid,
  read_inserted.id,
  read_inserted.value,
  now()
FROM read_inserted
WHERE NOT EXISTS (
  SELECT 1 FROM public.settings s
  WHERE s.category = 'ui_read_registry'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
);

WITH command_default AS (
  SELECT '{
    "commands": []
  }'::jsonb AS body
),
command_inserted AS (
  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at
  )
  SELECT
    'ui_command_registry',
    'global',
    NULL::uuid,
    1,
    command_default.body,
    1,
    'seed ui_command_registry defaults',
    now()
  FROM command_default
  WHERE NOT EXISTS (
    SELECT 1 FROM public.settings_versions sv
    WHERE sv.category = 'ui_command_registry'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (
  category,
  scope_type,
  scope_id,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  'ui_command_registry',
  'global',
  NULL::uuid,
  command_inserted.id,
  command_inserted.value,
  now()
FROM command_inserted
WHERE NOT EXISTS (
  SELECT 1 FROM public.settings s
  WHERE s.category = 'ui_command_registry'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
);

-- ---------------------------------------------------------------------------
-- 4) Navigation capability gating helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ui_apply_navigation_items_v1(
  p_items JSONB,
  p_policy JSONB,
  p_scope_type TEXT,
  p_scope_id UUID,
  p_user_id UUID,
  p_user_type TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_item JSONB;
  v_out JSONB := '[]'::jsonb;
  v_cap TEXT;
  v_allowed BOOLEAN;
  v_reason TEXT;
  v_children JSONB;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RETURN '[]'::jsonb;
  END IF;

  FOR v_item IN SELECT jsonb_array_elements(p_items) LOOP
    v_cap := NULLIF(v_item->>'capability', '');
    IF v_cap IS NOT NULL THEN
      SELECT allowed, reason
        INTO v_allowed, v_reason
        FROM public.access_eval_capability_v1(
          p_policy,
          v_cap,
          p_scope_type,
          p_scope_id,
          p_user_id,
          p_user_type
        );
      IF COALESCE(v_allowed, FALSE) = FALSE THEN
        v_item := jsonb_set(
          v_item,
          '{disabled_reason}',
          to_jsonb(COALESCE(v_reason, 'missing_capability')),
          true
        );
      END IF;
    END IF;

    v_children := v_item->'items';
    IF v_children IS NOT NULL THEN
      v_item := jsonb_set(
        v_item,
        '{items}',
        public.ui_apply_navigation_items_v1(
          v_children,
          p_policy,
          p_scope_type,
          p_scope_id,
          p_user_id,
          p_user_type
        ),
        true
      );
    END IF;

    v_out := v_out || jsonb_build_array(v_item);
  END LOOP;

  RETURN v_out;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5) UI read RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ui_me_v1()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_user_id UUID;
  v_user RECORD;
  v_org RECORD;
  v_scope_type TEXT;
  v_scope_id UUID;
  v_scope_label TEXT;
  v_policy JSONB;
  v_resolution_id UUID;
  v_roles TEXT[];
  v_caps TEXT[];
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_me_v1 requires authenticated user';
  END IF;

  SELECT * INTO v_user FROM public.users WHERE id = v_user_id;
  SELECT * INTO v_org FROM public.organizations WHERE id = v_user.organization_id;

  v_scope_type := public.current_user_scope_type();
  v_scope_id := public.current_user_scope_id();

  SELECT policy, settings_resolution_id
    INTO v_policy, v_resolution_id
    FROM public.resolve_access_control_policy_v1(v_scope_type, v_scope_id, TRUE)
    LIMIT 1;

  v_roles := public.resolve_role_keys_v1(v_policy, v_user_id, v_user.user_type);
  v_caps := public.resolve_capabilities_v1(v_policy, v_roles);

  IF v_scope_type = 'tenant' THEN
    v_scope_label := v_org.name;
  ELSIF v_scope_type = 'client' THEN
    SELECT name INTO v_scope_label FROM public.clients WHERE id = v_scope_id;
  ELSIF v_scope_type = 'sender' THEN
    SELECT name INTO v_scope_label FROM public.senders WHERE id = v_scope_id;
  ELSE
    v_scope_label := NULL;
  END IF;

  RETURN jsonb_build_object(
    'user', jsonb_build_object(
      'id', v_user.id,
      'email', v_user.email,
      'name', v_user.full_name,
      'user_type', v_user.user_type
    ),
    'org', jsonb_build_object(
      'id', v_org.id,
      'name', v_org.name
    ),
    'access_scope', jsonb_build_object(
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'scope_label', v_scope_label
    ),
    'locale', COALESCE(v_org.locale, 'en-US'),
    'timezone', COALESCE(v_org.timezone, 'UTC'),
    'capabilities', COALESCE(v_caps, ARRAY[]::text[]),
    'settings_resolution_id', v_resolution_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_navigation_v1(
  p_app TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_user_id UUID;
  v_user_type TEXT;
  v_scope_type TEXT;
  v_scope_id UUID;
  v_policy JSONB;
  v_nav JSONB;
  v_app JSONB;
  v_sections JSONB;
  v_out_sections JSONB := '[]'::jsonb;
  v_section JSONB;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_navigation_v1 requires authenticated user';
  END IF;

  SELECT user_type INTO v_user_type FROM public.users WHERE id = v_user_id;
  v_scope_type := public.current_user_scope_type();
  v_scope_id := public.current_user_scope_id();

  SELECT policy INTO v_policy
    FROM public.resolve_access_control_policy_v1(v_scope_type, v_scope_id, FALSE)
    LIMIT 1;

  v_nav := public.resolve_settings_merged('ui_navigation', v_scope_type, v_scope_id);
  v_app := v_nav #> ARRAY['apps', p_app];
  v_sections := COALESCE(v_app->'sections', '[]'::jsonb);

  FOR v_section IN SELECT jsonb_array_elements(v_sections) LOOP
    v_section := jsonb_set(
      v_section,
      '{items}',
      public.ui_apply_navigation_items_v1(
        v_section->'items',
        v_policy,
        v_scope_type,
        v_scope_id,
        v_user_id,
        v_user_type
      ),
      true
    );
    v_out_sections := v_out_sections || jsonb_build_array(v_section);
  END LOOP;

  RETURN jsonb_build_object(
    'app', p_app,
    'sections', v_out_sections
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_read_registry_v1()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
BEGIN
  RETURN public.resolve_settings_merged('ui_read_registry', v_scope_type, v_scope_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_command_registry_v1()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
BEGIN
  RETURN public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_list_resource_v1(
  p_resource TEXT,
  p_filters JSONB DEFAULT '{}'::jsonb,
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_read_registry', v_scope_type, v_scope_id);
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_id_column TEXT;
  v_scope_column TEXT;
  v_capability TEXT;
  v_select_cols TEXT;
  v_sort_col TEXT;
  v_sort_dir TEXT;
  v_where TEXT := 'TRUE';
  v_filter JSONB;
  v_filter_key TEXT;
  v_filter_column TEXT;
  v_filter_op TEXT;
  v_filter_value TEXT;
  v_filter_sql TEXT;
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_sql TEXT;
  v_items JSONB := '[]'::jsonb;
  v_total BIGINT := 0;
BEGIN
  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_list_resource_v1 requires resource key';
  END IF;

  SELECT value INTO v_resource
    FROM jsonb_array_elements(v_registry->'resources') AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_list_resource_v1 unknown resource %', p_resource;
  END IF;

  v_relation := v_resource->>'relation';
  v_id_column := COALESCE(v_resource->>'id_column', 'id');
  v_capability := v_resource->>'capability_read';

  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_get_resource_v1 resource missing relation';
  END IF;
  v_sort_col := COALESCE(v_resource#>>ARRAY['default_sort','column'], v_id_column);
  v_sort_dir := COALESCE(NULLIF(lower(v_resource#>>ARRAY['default_sort','direction']), ''), 'desc');

  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_list_resource_v1 resource missing relation';
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, v_table)) IS NULL THEN
    RAISE EXCEPTION 'ui_list_resource_v1 relation not found: %', v_relation;    
  END IF;

  SELECT c.relkind, c.relrowsecurity
    INTO v_relkind, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IS NULL OR v_relkind NOT IN ('r','p') THEN
    RAISE EXCEPTION 'ui_list_resource_v1 relation not allowed: %', v_relation;
  END IF;

  IF v_rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_list_resource_v1 relation missing RLS: %', v_relation;
  END IF;

  IF v_scope_type IN ('tenant','client','sender') THEN
    v_scope_column := v_resource#>>ARRAY['scope_columns', v_scope_type];        
    IF v_scope_column IS NOT NULL AND v_scope_column <> '' THEN
      v_where := v_where || format(' AND %I = %L', v_scope_column, v_scope_id);
    END IF;
  END IF;

  IF jsonb_typeof(v_resource->'select') = 'array' THEN
    SELECT string_agg(format('%I', value::text), ', ')
      INTO v_select_cols
      FROM jsonb_array_elements_text(v_resource->'select');
  END IF;
  IF v_select_cols IS NULL OR v_select_cols = '' THEN
    v_select_cols := '*';
  END IF;

  IF jsonb_typeof(v_resource->'filters') = 'array'
     AND jsonb_typeof(p_filters) = 'object' THEN
    FOR v_filter IN SELECT jsonb_array_elements(v_resource->'filters') LOOP
      v_filter_key := NULLIF(v_filter->>'key', '');
      v_filter_column := NULLIF(v_filter->>'column', '');
      IF v_filter_key IS NULL OR v_filter_column IS NULL THEN
        CONTINUE;
      END IF;
      v_filter_value := NULLIF(p_filters->>v_filter_key, '');
      IF v_filter_value IS NULL THEN
        CONTINUE;
      END IF;
      v_filter_op := lower(COALESCE(NULLIF(v_filter->>'op', ''), 'eq'));
      CASE v_filter_op
        WHEN 'eq' THEN v_filter_sql := format('%I = %L', v_filter_column, v_filter_value);
        WHEN 'ne' THEN v_filter_sql := format('%I <> %L', v_filter_column, v_filter_value);
        WHEN 'gt' THEN v_filter_sql := format('%I > %L', v_filter_column, v_filter_value);
        WHEN 'gte' THEN v_filter_sql := format('%I >= %L', v_filter_column, v_filter_value);
        WHEN 'lt' THEN v_filter_sql := format('%I < %L', v_filter_column, v_filter_value);
        WHEN 'lte' THEN v_filter_sql := format('%I <= %L', v_filter_column, v_filter_value);
        WHEN 'ilike' THEN v_filter_sql := format('%I ILIKE %L', v_filter_column, v_filter_value);
        ELSE
          RAISE EXCEPTION 'ui_list_resource_v1 unsupported filter op %', v_filter_op;
      END CASE;
      v_where := v_where || ' AND ' || v_filter_sql;
    END LOOP;
  END IF;

  v_sql := format(
    'SELECT COUNT(*) FROM %I.%I WHERE %s',
    v_schema,
    v_table,
    v_where
  );
  EXECUTE v_sql INTO v_total;

  v_sql := format(
    'SELECT COALESCE(jsonb_agg(row_to_json(t)), ''[]''::jsonb) FROM (SELECT %s FROM %I.%I WHERE %s ORDER BY %I %s LIMIT %s OFFSET %s) t',
    v_select_cols,
    v_schema,
    v_table,
    v_where,
    v_sort_col,
    CASE WHEN v_sort_dir = 'asc' THEN 'ASC' ELSE 'DESC' END,
    LEAST(GREATEST(p_limit, 1), 200),
    GREATEST(p_offset, 0)
  );

  EXECUTE v_sql INTO v_items;

  RETURN jsonb_build_object(
    'resource', p_resource,
    'items', COALESCE(v_items, '[]'::jsonb),
    'limit', LEAST(GREATEST(p_limit, 1), 200),
    'offset', GREATEST(p_offset, 0),
    'total', COALESCE(v_total, 0)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_get_resource_v1(
  p_resource TEXT,
  p_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_read_registry', v_scope_type, v_scope_id);
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_id_column TEXT;
  v_scope_column TEXT;
  v_capability TEXT;
  v_select_cols TEXT;
  v_where TEXT := 'TRUE';
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_sql TEXT;
  v_item JSONB;
BEGIN
  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_get_resource_v1 requires resource key';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'ui_get_resource_v1 requires id';
  END IF;

  SELECT value INTO v_resource
    FROM jsonb_array_elements(v_registry->'resources') AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_get_resource_v1 unknown resource %', p_resource;
  END IF;

  v_relation := v_resource->>'relation';
  v_id_column := COALESCE(v_resource->>'id_column', 'id');
  v_capability := v_resource->>'capability_read';

  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, v_table)) IS NULL THEN
    RAISE EXCEPTION 'ui_get_resource_v1 relation not found: %', v_relation;     
  END IF;

  IF v_scope_type IN ('tenant','client','sender') THEN
    v_scope_column := v_resource#>>ARRAY['scope_columns', v_scope_type];        
    IF v_scope_column IS NOT NULL AND v_scope_column <> '' THEN
      v_where := v_where || format(' AND %I = %L', v_scope_column, v_scope_id);
    END IF;
  END IF;

  SELECT c.relkind, c.relrowsecurity
    INTO v_relkind, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IS NULL OR v_relkind NOT IN ('r','p') THEN
    RAISE EXCEPTION 'ui_get_resource_v1 relation not allowed: %', v_relation;
  END IF;

  IF v_rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_get_resource_v1 relation missing RLS: %', v_relation;
  END IF;

  IF jsonb_typeof(v_resource->'select') = 'array' THEN
    SELECT string_agg(format('%I', value::text), ', ')
      INTO v_select_cols
      FROM jsonb_array_elements_text(v_resource->'select');
  END IF;
  IF v_select_cols IS NULL OR v_select_cols = '' THEN
    v_select_cols := '*';
  END IF;

  v_where := v_where || format(' AND %I = %L', v_id_column, p_id);

  v_sql := format(
    'SELECT row_to_json(t)::jsonb FROM (SELECT %s FROM %I.%I WHERE %s LIMIT 1) t',
    v_select_cols,
    v_schema,
    v_table,
    v_where
  );

  EXECUTE v_sql INTO v_item;
  RETURN v_item;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6) Grants (least privilege)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.ui_apply_navigation_items_v1(JSONB, JSONB, TEXT, UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_me_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_navigation_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_read_registry_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_command_registry_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_list_resource_v1(TEXT, JSONB, INT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_get_resource_v1(TEXT, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.ui_apply_navigation_items_v1(JSONB, JSONB, TEXT, UUID, UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_me_v1() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_navigation_v1(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_read_registry_v1() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_command_registry_v1() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_list_resource_v1(TEXT, JSONB, INT, INT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_get_resource_v1(TEXT, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601030900_ui_read_api_v2'));

COMMIT;
